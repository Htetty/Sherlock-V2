// Bounded reproducer agent loop tests (docs/fable/11). The model, the live
// browser session, and the plan replay are injected: no Claude, no Playwright
// browser, no Docker. validateReproductionPlan is REAL.
delete process.env.ANTHROPIC_API_KEY;

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  REPRODUCER_BUDGETS,
  detectApiIssueSignal,
  runReproducerAgent,
  type ReproducerAgentInput,
} from "../backend/agents/reproducer.js";
import { getPlanMode, type ReproductionPlan } from "../backend/services/plan.js";
import type { CreateModelMessage } from "../backend/agents/fixer.js";
import type { GraphContext } from "../backend/services/graphContext.js";
import type {
  LiveSession,
  ReproductionResult,
  SessionEvidence,
  StepRecord,
} from "../backend/services/playwright.js";

const execFileAsync = promisify(execFile);

const RESTARTED_BASE_URL = "http://localhost:9999";

// --- Fixtures ------------------------------------------------------------------

async function makeGitRepo(): Promise<{ repoPath: string; commit: string }> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "repro-agent-repo-"));

  await writeFile(path.join(repoPath, "server.js"), "// app\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: repoPath });
  await execFileAsync("git", ["add", "."], { cwd: repoPath });
  await execFileAsync(
    "git",
    ["-c", "user.email=test@sherlock.dev", "-c", "user.name=Sherlock Test", "commit", "--quiet", "-m", "seed"],
    { cwd: repoPath },
  );

  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });

  return { repoPath, commit: stdout.trim() };
}

const GRAPH: GraphContext = {
  available: false,
  graphNodes: "",
  graphEdges: "",
  relevantFiles: [],
  commitSha: "",
  notes: "graph unavailable in tests",
};

type MakeInputResult = {
  input: ReproducerAgentInput;
  restartCalls: () => number;
};

async function makeInput(
  issueOverrides: { issueTitle?: string; issueBody?: string } = {},
): Promise<MakeInputResult> {
  const { repoPath, commit } = await makeGitRepo();
  const investigationDir = await mkdtemp(path.join(tmpdir(), "repro-agent-inv-"));
  let restarts = 0;

  const input: ReproducerAgentInput = {
    investigationId: "inv_TESTREPRO0000",
    investigationDir,
    repoPath,
    sourceCommit: commit,
    // Contains an explicit "GET /api/tasks" - a clear API signal, so the
    // UI-first policy is waived for tests that submit without exploring.
    issueTitle: issueOverrides.issueTitle ?? "Archiving completed tasks breaks the task list",
    issueBody: issueOverrides.issueBody ?? "After archiving, GET /api/tasks returns 500.",
    repoUrl: "https://github.com/example/app",
    defaultBranch: "main",
    fileTree: ["server.js"],
    packageJson: null,
    readme: null,
    sandboxResult: { baseUrl: "http://localhost:3000", stdout: "", stderr: "" },
    graphContext: GRAPH,
    initialSourceFiles: [],
    pastInvestigations: "",
    restart: async () => {
      restarts += 1;
      return { ok: true, baseUrl: RESTARTED_BASE_URL };
    },
  };

  return { input, restartCalls: () => restarts };
}

// --- Stubbed model ----------------------------------------------------------------

let messageCounter = 0;

function toolUseMessage(name: string, input: unknown): Anthropic.Messages.Message {
  messageCounter += 1;

  return {
    id: `msg_${messageCounter}`,
    type: "message",
    role: "assistant",
    model: "stub",
    content: [{ type: "tool_use", id: `tu_${messageCounter}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Messages.Message;
}

type RecordedCall = Anthropic.Messages.MessageCreateParamsNonStreaming;

function scriptedModel(script: Anthropic.Messages.Message[]): {
  createMessage: CreateModelMessage;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let cursor = 0;

  return {
    calls,
    createMessage: async (params) => {
      calls.push(params);

      const next = script[cursor];

      if (!next) {
        throw new Error(`Scripted model exhausted after ${cursor} response(s).`);
      }

      cursor += 1;
      return next;
    },
  };
}

function lastToolResultText(params: RecordedCall): string {
  const last = params.messages[params.messages.length - 1];
  const blocks = last.content as Array<{ type: string; content?: unknown }>;
  const block = blocks.find((item) => item.type === "tool_result");

  return typeof block?.content === "string" ? block.content : "";
}

// --- Stubbed live session ------------------------------------------------------------

function emptyEvidence(): SessionEvidence {
  return {
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
    httpResponses: [],
    apiResponses: [],
    events: [],
    screenshots: [],
  };
}

function stepRecord(action: string, outcome: "passed" | "failed", error: string | null = null): StepRecord {
  return {
    id: "live-x",
    action,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outcome,
    error,
    ambiguous: error !== null && error.includes("strict mode violation"),
    screenshot: null,
  };
}

// Sessions share one scripted step queue; each openLiveSession call returns a
// fresh session over the same queue.
function stubSessionFactory(stepQueue: StepRecord[]) {
  let opened = 0;
  let closed = 0;
  let cursor = 0;
  const screenshots: string[] = [];

  const openLiveSession = async (baseUrl: string): Promise<LiveSession> => {
    opened += 1;
    const evidence = emptyEvidence();

    return {
      page: {} as LiveSession["page"],
      baseUrl,
      evidence,
      executeStep: async (step) => {
        const scripted = stepQueue[cursor];
        cursor += 1;

        if (!scripted) {
          return { ...stepRecord(step.action, "passed"), id: step.id };
        }

        return { ...scripted, id: step.id, action: step.action };
      },
      readPageDigest: async () =>
        'URL: http://localhost:3000/\nTitle: Tasks\nInteractive elements:\n- button testId="archive-btn" text="Archive completed"',
      captureScreenshot: async (name) => {
        screenshots.push(name);
        return `screenshots/${name}.png`;
      },
      close: async () => {
        closed += 1;
      },
    };
  };

  return {
    openLiveSession,
    openedCount: () => opened,
    closedCount: () => closed,
    screenshots,
  };
}

// --- Stubbed replay ---------------------------------------------------------------------

function replayResult(
  outcome: ReproductionResult["outcome"],
  reason: string,
): ReproductionResult {
  return {
    planVersion: 1,
    baseUrl: RESTARTED_BASE_URL,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outcome,
    outcomeReason: reason,
    steps: [],
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
    httpResponses: [],
    apiResponses: [],
    screenshots: [],
    assertion: null,
    events: [],
    html: "",
  };
}

const VALID_SUBMISSION = {
  steps: [
    { id: "step-1", action: "request", method: "POST", path: "/api/tasks/archive" },
    { id: "step-2", action: "wait", ms: 2000 },
    { id: "step-3", action: "request", method: "GET", path: "/api/tasks" },
  ],
  expectedBehavior: "The task list loads after archiving.",
  failureCondition: "GET /api/tasks returns Internal Server Error after archiving.",
  assertion: {
    type: "response_body",
    pathPattern: "/api/tasks",
    method: "GET",
    failureContains: "Internal Server Error",
  },
};

const INVALID_SUBMISSION = {
  steps: [{ id: "step-1", action: "request", method: "GET", path: "/api/tasks" }],
  expectedBehavior: "The task list loads.",
  failureCondition: "The task list breaks.",
  // console_error over an API-only plan is rejected by the real validator.
  assertion: { type: "console_error", contains: "boom" },
};

// --- Tests -----------------------------------------------------------------------------------

describe("reproducer agent loop", () => {
  test("explores, submits, and the official replay decides reproduced", async () => {
    const { input, restartCalls } = await makeInput();
    const sessions = stubSessionFactory([
      stepRecord("goto", "passed"),
      stepRecord("click", "passed"),
    ]);
    const model = scriptedModel([
      toolUseMessage("goto", { path: "/" }),
      toolUseMessage("read_page", {}),
      toolUseMessage("click", { target: { testId: "archive-btn" } }),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
    ]);

    const replayedPlans: unknown[] = [];
    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async (plan) => {
        replayedPlans.push(plan);
        return replayResult("reproduced", "Expected failure condition observed: 500.");
      },
    });

    expect(result.status).toBe("reproduced");
    expect(result.result?.outcome).toBe("reproduced");
    expect(result.plan?.baseUrl).toBe(RESTARTED_BASE_URL);
    expect(result.submissions).toEqual([
      expect.objectContaining({ index: 1, valid: true, replayOutcome: "reproduced" }),
    ]);
    expect(restartCalls()).toBe(1);
    expect(replayedPlans).toHaveLength(1);
    // Live session was closed before the official replay.
    expect(sessions.closedCount()).toBeGreaterThanOrEqual(1);

    // read_page result reached the model with the digest vocabulary.
    expect(lastToolResultText(model.calls[2])).toContain('testId="archive-btn"');

    // Artifacts exist.
    const agentDir = path.join(input.investigationDir, "repro-agent");
    const transcript = JSON.parse(
      await readFile(path.join(agentDir, "transcript.json"), "utf8"),
    ) as Array<{ type: string }>;
    expect(transcript.at(-1)).toMatchObject({ type: "final_result", status: "reproduced" });
    await stat(path.join(agentDir, "tool-calls", "001-goto.json"));
    await stat(path.join(agentDir, "summary.json"));
  });

  test("ambiguous click returns diagnostics and the agent retargets", async () => {
    const { input } = await makeInput();
    const diagnostics =
      'strict mode violation: locator resolved to 3 elements\nTarget diagnostics: text="Completed" -> 3 match(es)';
    const sessions = stubSessionFactory([
      stepRecord("click", "failed", diagnostics),
      stepRecord("click", "passed"),
    ]);
    const model = scriptedModel([
      toolUseMessage("click", { target: { text: "Completed" } }),
      toolUseMessage("click", { target: { testId: "archive-btn" } }),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => replayResult("reproduced", "Failure observed."),
    });

    expect(result.status).toBe("reproduced");

    const feedback = lastToolResultText(model.calls[1]);
    expect(feedback).toContain('text="Completed" -> 3 match(es)');
    expect(feedback).toContain("AMBIGUOUS");
  });

  test("invalid submission consumes a submission and returns real validator errors", async () => {
    const { input } = await makeInput();
    const sessions = stubSessionFactory([]);
    const model = scriptedModel([
      toolUseMessage("submit_plan", INVALID_SUBMISSION),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => replayResult("reproduced", "Failure observed."),
    });

    expect(result.status).toBe("reproduced");
    expect(result.submissions).toHaveLength(2);
    expect(result.submissions[0].valid).toBe(false);
    expect(result.submissions[0].validationErrors?.join(" ")).toContain("console_error");
    expect(result.submissions[1].valid).toBe(true);

    expect(lastToolResultText(model.calls[1])).toContain("invalid");
  });

  test("failed replay feeds evidence back; workspace reset + restart before each replay", async () => {
    const { input, restartCalls } = await makeInput();
    const sessions = stubSessionFactory([]);
    const model = scriptedModel([
      toolUseMessage("submit_plan", VALID_SUBMISSION),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
    ]);

    const dirtyFile = path.join(input.repoPath, "tasks-data.json");
    await writeFile(dirtyFile, "{}", "utf8"); // untracked app-written state

    let replays = 0;
    const dirtySeenAtReplay: boolean[] = [];

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => {
        replays += 1;
        dirtySeenAtReplay.push(existsSync(dirtyFile));
        // Simulate the replay itself dirtying the workspace again.
        await writeFile(dirtyFile, "{}", "utf8");

        if (replays === 1) {
          return replayResult("not_reproduced", "Expected behavior observed: list loads.");
        }

        return replayResult("reproduced", "Failure observed on revised plan.");
      },
    });

    expect(result.status).toBe("reproduced");
    expect(result.submissions).toHaveLength(2);
    expect(restartCalls()).toBe(2);
    // git clean ran before EACH replay: the untracked file was gone both times.
    expect(dirtySeenAtReplay).toEqual([false, false]);

    const feedback = lastToolResultText(model.calls[1]);
    expect(feedback).toContain("OFFICIAL REPLAY");
    expect(feedback).toContain("Expected behavior observed: list loads.");
  });

  test("submission budget exhausts; clean not_reproduced replay surfaces as verdict", async () => {
    const { input } = await makeInput();
    const sessions = stubSessionFactory([]);
    const model = scriptedModel([
      toolUseMessage("submit_plan", VALID_SUBMISSION),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
      toolUseMessage("submit_plan", VALID_SUBMISSION), // never reached
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () =>
        replayResult("not_reproduced", "Expected behavior observed."),
    });

    // The last valid plan replayed cleanly showing expected behavior - that
    // IS a deterministic verdict, so it surfaces as not_reproduced.
    expect(result.status).toBe("not_reproduced");
    expect(result.plan).not.toBeNull();
    expect(result.result?.outcome).toBe("not_reproduced");
    expect(result.submissions).toHaveLength(REPRODUCER_BUDGETS.maxPlanSubmissions);
    expect(model.calls).toHaveLength(REPRODUCER_BUDGETS.maxPlanSubmissions);
  });

  test("submission budget exhausts with no clean verdict -> exhausted", async () => {
    const { input } = await makeInput();
    const sessions = stubSessionFactory([]);
    const model = scriptedModel([
      toolUseMessage("submit_plan", VALID_SUBMISSION),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () =>
        replayResult("execution_failed", "Step step-1 failed: connection refused."),
    });

    expect(result.status).toBe("exhausted");
    expect(result.plan).toBeNull();
    expect(result.result).toBeNull();
  });

  test("submit_not_reproducible ends as plan_failed with the reason", async () => {
    const { input, restartCalls } = await makeInput();
    const sessions = stubSessionFactory([]);
    const model = scriptedModel([
      toolUseMessage("submit_not_reproducible", {
        reason: "The reported Archive button does not exist in this app.",
      }),
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => {
        throw new Error("replay must not run in this test");
      },
    });

    expect(result.status).toBe("plan_failed");
    expect(result.reason).toContain("Archive button does not exist");
    expect(restartCalls()).toBe(0);
  });

  test("detectApiIssueSignal recognizes clear API failures and rejects vague text", () => {
    expect(detectApiIssueSignal("GET /api/tasks returns 500")).toContain("GET /api/tasks");
    expect(detectApiIssueSignal("the route /api/tasks/archive breaks")).toContain("/api/tasks/archive");
    expect(detectApiIssueSignal("the archive endpoint is broken")).toContain("endpoint");
    expect(detectApiIssueSignal("the API response is a 500 error")).toContain("status code");
    expect(detectApiIssueSignal("The archive button does nothing when clicked")).toBeNull();
    expect(detectApiIssueSignal("Completed tasks still appear under the Active filter")).toBeNull();
  });

  test("UI-first policy blocks terminals until goto + read_page, without consuming submissions", async () => {
    const { input } = await makeInput({
      issueTitle: "Archive button does nothing",
      issueBody: "Clicking the archive button has no visible effect.",
    });
    const sessions = stubSessionFactory([stepRecord("goto", "passed")]);
    const model = scriptedModel([
      toolUseMessage("submit_plan", VALID_SUBMISSION), // blocked by policy
      toolUseMessage("submit_not_reproducible", { reason: "giving up" }), // blocked too
      toolUseMessage("goto", { path: "/" }),
      toolUseMessage("read_page", {}),
      toolUseMessage("submit_plan", VALID_SUBMISSION), // now allowed
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => replayResult("reproduced", "Failure observed."),
    });

    expect(result.status).toBe("reproduced");
    // Neither blocked terminal consumed a submission.
    expect(result.submissions).toHaveLength(1);
    expect(lastToolResultText(model.calls[1])).toContain("Policy");
    expect(lastToolResultText(model.calls[2])).toContain("Policy");

    const mode = JSON.parse(
      await readFile(path.join(input.investigationDir, "repro-agent", "mode.json"), "utf8"),
    ) as { uiFirstPolicy: Record<string, unknown> };
    expect(mode.uiFirstPolicy).toMatchObject({
      required: true,
      satisfied: true,
      apiIssueSignal: null,
    });
  });

  test("UI-first policy is waived when the issue names an API failure", async () => {
    const { input } = await makeInput(); // default issue contains "GET /api/tasks"
    const sessions = stubSessionFactory([]);
    const model = scriptedModel([toolUseMessage("submit_plan", VALID_SUBMISSION)]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => replayResult("reproduced", "500 observed."),
    });

    expect(result.status).toBe("reproduced");
    expect(result.submissions).toHaveLength(1);

    const mode = JSON.parse(
      await readFile(path.join(input.investigationDir, "repro-agent", "mode.json"), "utf8"),
    ) as { uiFirstPolicy: { required: boolean; apiIssueSignal: string | null } };
    expect(mode.uiFirstPolicy.required).toBe(false);
    expect(mode.uiFirstPolicy.apiIssueSignal).toContain("GET /api/tasks");
  });

  test("getPlanMode classifies api-only, browser, and mixed plans", () => {
    const base = { version: 1, baseUrl: "http://localhost:1", expectedBehavior: "x", failureCondition: "y", assertion: { type: "console_error", contains: "z" } };
    const apiOnly = { ...base, steps: [
      { id: "s1", action: "request", method: "GET", path: "/api" },
      { id: "s2", action: "wait", ms: 100 },
    ] } as unknown as ReproductionPlan;
    const browser = { ...base, steps: [
      { id: "s1", action: "goto", path: "/" },
      { id: "s2", action: "click", target: { testId: "x" } },
    ] } as unknown as ReproductionPlan;
    const mixed = { ...base, steps: [
      { id: "s1", action: "goto", path: "/" },
      { id: "s2", action: "request", method: "GET", path: "/api" },
    ] } as unknown as ReproductionPlan;

    expect(getPlanMode(apiOnly)).toBe("api-only");
    expect(getPlanMode(browser)).toBe("browser");
    expect(getPlanMode(mixed)).toBe("mixed");
  });

  test("api-only run records mode artifacts and takes no exploration screenshots", async () => {
    const { input } = await makeInput();
    const sessions = stubSessionFactory([
      stepRecord("request", "passed"),
      stepRecord("request", "passed"),
    ]);
    const model = scriptedModel([
      toolUseMessage("request", { method: "POST", path: "/api/tasks/archive" }),
      toolUseMessage("request", { method: "GET", path: "/api/tasks" }),
      toolUseMessage("wait", { ms: 500 }),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => replayResult("reproduced", "500 observed."),
    });

    expect(result.status).toBe("reproduced");
    // wait is neutral: two requests + zero page actions -> api-only.
    const mode = JSON.parse(
      await readFile(path.join(input.investigationDir, "repro-agent", "mode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(mode).toMatchObject({
      mode: "api-only",
      browserActions: 0,
      requestActions: 2,
      readPageCalls: 0,
      submittedPlans: 1,
      submittedPlanMode: "api-only",
    });

    // No exploration screenshots for API requests or waits.
    expect(sessions.screenshots).toEqual([]);

    // Submission record carries both the exploration mode at submission time
    // and the submitted plan's mode.
    expect(result.submissions[0].planMode).toBe("api-only");
    expect(result.submissions[0].explorationModeAtSubmission).toBe("api-only");
    expect(result.explorationMode).toBe("api-only");

    // Evidence-split summary artifact.
    const evidence = JSON.parse(
      await readFile(
        path.join(input.investigationDir, "repro-agent", "reproduction-evidence-summary.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      explorationMode: "api-only",
      acceptedPlanMode: "api-only",
      fixerEvidenceMode: "api-only",
    });

    // Per-replay artifacts exist.
    const replayDir = path.join(input.investigationDir, "repro-agent", "replay-1");
    expect(JSON.parse(await readFile(path.join(replayDir, "replay-mode.json"), "utf8"))).toEqual({
      mode: "api-only",
    });
    await stat(path.join(replayDir, "api-trace.json"));
    await stat(path.join(replayDir, "reproduction-result.json"));
  });

  test("browser exploration takes screenshots after page actions, mode is mixed with requests", async () => {
    const { input } = await makeInput();
    const sessions = stubSessionFactory([
      stepRecord("goto", "passed"),
      stepRecord("click", "passed"),
      stepRecord("request", "passed"),
    ]);
    const model = scriptedModel([
      toolUseMessage("goto", { path: "/" }),
      toolUseMessage("read_page", {}),
      toolUseMessage("click", { target: { testId: "archive-btn" } }),
      toolUseMessage("request", { method: "GET", path: "/api/tasks" }),
      toolUseMessage("submit_plan", VALID_SUBMISSION),
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => replayResult("reproduced", "500 observed."),
    });

    expect(result.status).toBe("reproduced");
    expect(sessions.screenshots).toEqual([
      "001-after-goto",
      "002-after-read_page",
      "003-after-click",
    ]);

    const mode = JSON.parse(
      await readFile(path.join(input.investigationDir, "repro-agent", "mode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(mode).toMatchObject({ mode: "mixed", browserActions: 2, requestActions: 1, readPageCalls: 1 });

    // Mixed exploration + api-only plan: the split is explicit in the
    // submission record and the evidence summary explains it.
    expect(result.submissions[0].explorationModeAtSubmission).toBe("mixed");
    expect(result.submissions[0].planMode).toBe("api-only");

    const evidence = JSON.parse(
      await readFile(
        path.join(input.investigationDir, "repro-agent", "reproduction-evidence-summary.json"),
        "utf8",
      ),
    ) as { explorationMode: string; acceptedPlanMode: string; fixerEvidenceMode: string; explanation: string };
    expect(evidence.explorationMode).toBe("mixed");
    expect(evidence.acceptedPlanMode).toBe("api-only");
    expect(evidence.fixerEvidenceMode).toBe("api-only");
    expect(evidence.explanation).toContain("UI and API tools");
    expect(evidence.explanation).toContain("official replay result");
  });

  test("invalid live action is rejected by the real step validator", async () => {
    const { input } = await makeInput();
    const sessions = stubSessionFactory([]);
    const model = scriptedModel([
      toolUseMessage("goto", { path: "not-relative" }),
      toolUseMessage("submit_not_reproducible", { reason: "stop" }),
    ]);

    const result = await runReproducerAgent(input, {
      createMessage: model.createMessage,
      openLiveSession: sessions.openLiveSession,
      executeReproductionPlan: async () => {
        throw new Error("replay must not run in this test");
      },
    });

    expect(result.status).toBe("plan_failed");
    expect(lastToolResultText(model.calls[1])).toContain('start with "/"');
    // The invalid action never reached a live session.
    expect(sessions.openedCount()).toBe(0);
  });
});
