// Bounded fixer agent loop tests (docs/fable/10). The model and the
// deterministic verifier are injected: no Claude, no Docker, no Playwright.
//
// ANTHROPIC_API_KEY is removed to prove the agent module (and the claude.ts
// helper layer it imports) loads and runs with an injected model only.
delete process.env.ANTHROPIC_API_KEY;

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  FIXER_BUDGETS,
  runFixerAgent,
  type CreateModelMessage,
  type FixerAgentInput,
} from "../backend/agents/fixer.js";
import type { FixAttemptResult } from "../backend/services/fix.js";
import { hashFixProposalEdits, type FixProposal } from "../backend/services/fix-proposal.js";
import type { GraphContext } from "../backend/services/graphContext.js";
import type { ReproductionPlan } from "../backend/services/plan.js";
import type { ReproductionResult } from "../backend/services/playwright.js";
import type { ReproductionEvidenceSummary } from "../backend/services/reproduction-evidence.js";

const execFileAsync = promisify(execFile);

const ORIGINAL_SERVER = `export function login(user) {
  // BUG: returns 500 for unknown users
  return { status: 500 };
}
`;

// --- Fixtures ---------------------------------------------------------------

async function makeGitRepo(): Promise<{ repoPath: string; commit: string }> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "fix-agent-repo-"));

  await writeFile(path.join(repoPath, "server.js"), ORIGINAL_SERVER, "utf8");
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

const PLAN = {
  version: 1,
  baseUrl: "http://localhost:3000",
  steps: [{ id: "step-1", action: "request", method: "POST", path: "/api/login" }],
  expectedBehavior: "Unknown users get 401.",
  failureCondition: "Unknown users get 500.",
  assertion: { type: "response_status", expected: 401, failureValue: 500 },
} as unknown as ReproductionPlan;

const REPRO = {
  outcome: "reproduced",
  outcomeReason: "Assertion matched the failure value.",
  steps: [],
  consoleErrors: [],
  pageErrors: [],
  networkFailures: [],
  apiResponses: [],
  screenshots: [],
  events: [],
  assertion: { matchedFailure: true, matchedExpected: false, detail: "Observed 500." },
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
} as unknown as ReproductionResult;

const GRAPH: GraphContext = {
  available: false,
  graphNodes: "",
  graphEdges: "",
  relevantFiles: [],
  commitSha: "",
  notes: "graph unavailable in tests",
};

async function makeInput(overrides: Partial<FixerAgentInput> = {}): Promise<FixerAgentInput> {
  const { repoPath, commit } = await makeGitRepo();
  const investigationDir = await mkdtemp(path.join(tmpdir(), "fix-agent-inv-"));

  return {
    investigationId: "inv_TESTAGENT0000",
    investigationDir,
    repoPath,
    sourceCommit: commit,
    issueTitle: "Login returns 500 for unknown users",
    issueBody: "Should be 401.",
    repoUrl: "https://github.com/example/app",
    defaultBranch: "main",
    fileTree: ["server.js"],
    packageJson: null,
    readme: null,
    sandboxResult: { baseUrl: "http://localhost:3000", stdout: "", stderr: "" },
    plan: PLAN,
    reproductionResult: REPRO,
    graphContext: GRAPH,
    initialSourceFiles: [],
    restart: async () => ({ ok: true, baseUrl: "http://localhost:3000" }),
    ...overrides,
  };
}

// --- Stubbed model -----------------------------------------------------------

let toolUseCounter = 0;

function toolUseMessage(name: string, input: unknown): Anthropic.Messages.Message {
  toolUseCounter += 1;

  return {
    id: `msg_${toolUseCounter}`,
    type: "message",
    role: "assistant",
    model: "stub",
    content: [{ type: "tool_use", id: `tu_${toolUseCounter}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Messages.Message;
}

function textMessage(text: string): Anthropic.Messages.Message {
  toolUseCounter += 1;

  return {
    id: `msg_${toolUseCounter}`,
    type: "message",
    role: "assistant",
    model: "stub",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
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

// The tool_result the agent sent back for the previous turn is the last
// message of the NEXT call's params.
function lastToolResultText(params: RecordedCall): string {
  const last = params.messages[params.messages.length - 1];
  if (!Array.isArray(last.content)) {
    return "";
  }

  const blocks = last.content as Array<{ type: string; content?: unknown }>;
  const block = blocks.find((item) => item.type === "tool_result");

  return typeof block?.content === "string" ? block.content : "";
}

// --- Stubbed verifier ----------------------------------------------------------

function evidenceSummary(
  signature: string,
  observed: string | null = null,
): ReproductionEvidenceSummary {
  return {
    outcome: "reproduced",
    outcomeReason: "Assertion matched the failure value.",
    assertion: observed
      ? { observed, detail: `Observed ${observed}.`, matchedFailure: true, matchedExpected: false }
      : null,
    failedStep: null,
    consoleErrors: [],
    consoleErrorCount: 0,
    pageErrors: [],
    pageErrorCount: 0,
    networkFailures: [],
    networkFailureCount: 0,
    apiResponses: [],
    apiResponseCount: 0,
    signature,
  };
}

function attemptResult(
  outcome: FixAttemptResult["outcome"],
  reason: string,
  changedFiles: string[] = ["server.js"],
  postPatchEvidence: ReproductionEvidenceSummary | null = null,
): FixAttemptResult {
  return {
    investigationId: "inv_TESTAGENT0000",
    fixAttemptId: `fix_TEST${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    attemptDir: "/tmp/unused",
    outcome,
    reason,
    checks: [
      {
        name: "failure_no_longer_observed",
        status: outcome === "verified" ? "passed" : "failed",
        detail: reason,
      },
    ],
    sourceCommit: "unused",
    changedFiles,
    summary: "stub",
    rootCause: "stub root cause",
    postPatchOutcome: outcome === "verified" ? "not_reproduced" : "reproduced",
    postPatchEvidence,
    testRuns: [],
    repositoryValidation: null,
    regressionTest: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

const PROPOSAL_INPUT = {
  version: 1,
  summary: "Return 401 for unknown users",
  rootCause: "login() in server.js returns 500 for unknown users",
  confidence: 0.9,
  files: [
    {
      path: "server.js",
      edits: [{ oldText: "return { status: 500 };", newText: "return { status: 401 };" }],
    },
  ],
  relevantTests: [],
  risk: "low",
  assumptions: [],
};

const SECOND_PROPOSAL_INPUT = {
  ...PROPOSAL_INPUT,
  summary: "Return 403 for unknown users",
  files: [
    {
      path: "server.js",
      edits: [{ oldText: "return { status: 500 };", newText: "return { status: 403 };" }],
    },
  ],
};

// --- Tests ------------------------------------------------------------------------

describe("fixer agent loop", () => {
  test("inspection test mode blocks an immediate patch until the required inspections succeed", async () => {
    const previous = process.env.SHERLOCK_FIXER_MIN_INSPECTIONS;
    process.env.SHERLOCK_FIXER_MIN_INSPECTIONS = "2";

    try {
      const input = await makeInput();
      const model = scriptedModel([
        toolUseMessage("propose_patch", PROPOSAL_INPUT),
        toolUseMessage("grep", { query: "login", path: "." }),
        toolUseMessage("read_file", { path: "server.js" }),
        toolUseMessage("propose_patch", PROPOSAL_INPUT),
      ]);

      let verifierCalls = 0;
      const result = await runFixerAgent(input, {
        createMessage: model.createMessage,
        runFixAttempt: async () => {
          verifierCalls += 1;
          return attemptResult("verified", "Replay clean, tests passed.");
        },
      });

      expect(result.status).toBe("verified");
      expect(verifierCalls).toBe(1);
      expect(result.attempts).toHaveLength(1);
      expect(result.efficiencyCounters.successfulInspections).toBe(2);
      expect(lastToolResultText(model.calls[1])).toContain("INSPECTION TEST MODE");
      expect(lastToolResultText(model.calls[1])).toContain("2 more successful inspection");
    } finally {
      if (previous === undefined) {
        delete process.env.SHERLOCK_FIXER_MIN_INSPECTIONS;
      } else {
        process.env.SHERLOCK_FIXER_MIN_INSPECTIONS = previous;
      }
    }
  });

  test("reads a file, then proposes a verified patch", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("read_file", { path: "server.js" }),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
    ]);

    const verifierCalls: unknown[] = [];
    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async (attemptInput) => {
        verifierCalls.push(attemptInput.proposal);
        return attemptResult("verified", "Replay clean, tests passed.");
      },
    });

    expect(result.status).toBe("verified");
    expect(result.fixAttempt?.outcome).toBe("verified");
    expect(result.attempts).toHaveLength(1);
    expect(verifierCalls).toHaveLength(1);

    // The file contents reached the model as a tool_result.
    expect(model.calls).toHaveLength(2);
    expect(lastToolResultText(model.calls[1])).toContain("BUG: returns 500");

    // Artifacts: transcript, summary, and per-call records exist.
    const agentDir = path.join(input.investigationDir, "fix-agent");
    const transcript = JSON.parse(
      await readFile(path.join(agentDir, "transcript.json"), "utf8"),
    ) as Array<{ type: string }>;
    expect(transcript.some((entry) => entry.type === "fix_attempt")).toBe(true);
    expect(transcript.at(-1)).toMatchObject({ type: "final_result", status: "verified" });
    await stat(path.join(agentDir, "tool-calls", "001-read_file.json"));
    await stat(path.join(agentDir, "tool-calls", "002-propose_patch.json"));
    await stat(path.join(agentDir, "summary.json"));
  });

  test("revises after failed verification, with workspace rollback between attempts", async () => {
    const input = await makeInput();
    const serverPath = path.join(input.repoPath, "server.js");
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", SECOND_PROPOSAL_INPUT),
    ]);

    const contentsSeenByVerifier: string[] = [];
    let attemptNumber = 0;

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        attemptNumber += 1;
        contentsSeenByVerifier.push(await readFile(serverPath, "utf8"));

        if (attemptNumber === 1) {
          // Simulate an applied-but-wrong patch left in the workspace.
          await writeFile(serverPath, "// wrong patch applied\n", "utf8");
          return attemptResult(
            "rejected_reproduction_still_fails",
            "The original failure still occurs after the patch: observed 500.",
          );
        }

        return attemptResult("verified", "Replay clean on second attempt.");
      },
    });

    expect(result.status).toBe("verified");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].outcome).toBe("rejected_reproduction_still_fails");

    // Rollback ran between attempts: the second verifier call saw the
    // original workspace, not the first failed patch.
    expect(contentsSeenByVerifier[1]).toBe(ORIGINAL_SERVER);

    // The failure evidence was fed back to the model before the revision.
    const feedback = lastToolResultText(model.calls[1]);
    expect(feedback).toContain("rejected_reproduction_still_fails");
    expect(feedback).toContain("observed 500");
    expect(feedback).toContain("rolled back");
  });

  test("after behavior passes but repository validation fails, exposes only patch or stop", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("submit_blocked", {
        reason: "The remaining build failure is unrelated to the behavioral patch.",
      }),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        const failed = attemptResult(
          "rejected_tests_failed",
          "The original failure disappeared, but npm run build failed: TypeError in prerender.",
        );
        failed.postPatchOutcome = "not_reproduced";
        return failed;
      },
    });

    expect(result.status).toBe("blocked");
    expect(model.calls[1].tools?.map((tool) => tool.name).sort()).toEqual([
      "propose_patch",
      "submit_blocked",
    ]);
    expect(model.calls[1].tool_choice).toMatchObject({
      type: "any",
      disable_parallel_tool_use: true,
    });
  });

  test("stops exhausted after max patch attempts, never verified", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", SECOND_PROPOSAL_INPUT),
      // Never reached: the loop must stop at maxPatchAttempts.
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () =>
        attemptResult("rejected_reproduction_still_fails", "Still failing."),
    });

    expect(result.status).toBe("exhausted");
    expect(result.attempts).toHaveLength(FIXER_BUDGETS.maxPatchAttempts);
    expect(model.calls).toHaveLength(FIXER_BUDGETS.maxPatchAttempts);

    // PR gate input: a non-verified fixAttempt never opens a PR
    // (investigation.ts gates on fixAttempt?.outcome === "verified").
    expect(result.fixAttempt).not.toBeNull();
    expect(result.fixAttempt?.outcome).not.toBe("verified");
  });

  test("repairs confidence accidentally embedded in rootCause before verification", async () => {
    const input = await makeInput();
    const malformedProposal = {
      ...PROPOSAL_INPUT,
      confidence: undefined,
      rootCause:
        `${PROPOSAL_INPUT.rootCause}</rootCause>\n<parameter name="confidence">0.85`,
    };
    delete (malformedProposal as Record<string, unknown>).confidence;
    const model = scriptedModel([toolUseMessage("propose_patch", malformedProposal)]);

    const verifierCalls: unknown[] = [];
    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async (attemptInput) => {
        verifierCalls.push(attemptInput.proposal);
        return attemptResult("verified", "Replay clean.");
      },
    });

    expect(result.status).toBe("verified");
    expect(result.failureCode).toBeNull();
    expect(verifierCalls).toHaveLength(1);
    expect(verifierCalls[0]).toMatchObject({
      confidence: 0.85,
      rootCause: PROPOSAL_INPUT.rootCause,
    });
  });

  test("classifies exhausted no-patch exploration as fixer_no_patch_attempt", async () => {
    const input = await makeInput();
    const model = scriptedModel(
      Array.from({ length: FIXER_BUDGETS.maxModelTurns }, () =>
        toolUseMessage("read_file", { path: "server.js" }),
      ),
    );

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        throw new Error("verifier must not run without a patch");
      },
    });

    expect(result.status).toBe("exhausted");
    expect(result.attempts).toHaveLength(0);
    expect(result.failureCode).toBe("fixer_no_patch_attempt");

    const blockedFeedback = model.calls
      .map(lastToolResultText)
      .find((text) => text.includes("Exploration budget exhausted"));
    expect(blockedFeedback).toContain(
      "Exploration budget exhausted. You must now call propose_patch or submit_blocked.",
    );

    const summary = JSON.parse(
      await readFile(path.join(input.investigationDir, "fix-agent", "summary.json"), "utf8"),
    ) as {
      failureCode: string | null;
      patchAttempts: number;
      turns: number;
    };
    expect(summary).toMatchObject({
      failureCode: "fixer_no_patch_attempt",
      patchAttempts: 0,
      turns: FIXER_BUDGETS.maxModelTurns,
    });
  });

  test("rejects path traversal and absolute paths without touching the filesystem", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("read_file", { path: "../.env" }),
      toolUseMessage("read_file", { path: "/etc/passwd" }),
      toolUseMessage("submit_blocked", { reason: "Cannot proceed." }),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        throw new Error("verifier must not run in this test");
      },
    });

    expect(result.status).toBe("blocked");
    expect(lastToolResultText(model.calls[1])).toContain("escapes the repository");
    expect(lastToolResultText(model.calls[2])).toContain("absolute");
  });

  test("grep skips ignored directories and caps output", async () => {
    const input = await makeInput();

    // 60 matching lines in a real source file; a match inside node_modules
    // must never surface.
    const noisy = Array.from({ length: 60 }, (_, i) => `const needle_${i} = "needle";`).join("\n");
    await writeFile(path.join(input.repoPath, "noisy.js"), noisy, "utf8");
    await mkdir(path.join(input.repoPath, "node_modules", "dep"), { recursive: true });
    await writeFile(
      path.join(input.repoPath, "node_modules", "dep", "index.js"),
      "const hidden = 'needle';\n",
      "utf8",
    );

    const model = scriptedModel([
      toolUseMessage("grep", { query: "needle" }),
      toolUseMessage("submit_blocked", { reason: "Done inspecting." }),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        throw new Error("verifier must not run in this test");
      },
    });

    expect(result.status).toBe("blocked");

    const grepResult = lastToolResultText(model.calls[1]);
    const matchLines = grepResult.split("\n").filter((line) => /^[^[]/.test(line));
    expect(matchLines.length).toBeLessThanOrEqual(FIXER_BUDGETS.maxGrepLines);
    expect(grepResult).not.toContain("node_modules");
    // fable/16: capped output reports omitted match/file counts explicitly.
    expect(grepResult).toContain("[OUTPUT CAPPED");
    expect(grepResult).toContain("omitted");
  });

  test("read_file returns only the requested line span", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("read_file", { path: "server.js", startLine: 2, endLine: 3 }),
      toolUseMessage("submit_blocked", { reason: "done" }),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        throw new Error("verifier must not run in this test");
      },
    });

    expect(result.status).toBe("blocked");

    const span = lastToolResultText(model.calls[1]);
    expect(span).toContain("[server.js lines 2-3 of 5]");
    expect(span).toContain("// BUG: returns 500");
    expect(span).toContain("return { status: 500 };");
    expect(span).not.toContain("export function login");
  });

  test("read_file accepts comma string ranges without dumping the full file", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("read_file", { path: "server.js", startLine: "2, 3" }),
      toolUseMessage("submit_blocked", { reason: "done" }),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        throw new Error("verifier must not run in this test");
      },
    });

    expect(result.status).toBe("blocked");

    const span = lastToolResultText(model.calls[1]);
    expect(span).toContain("[server.js lines 2-3 of 5]");
    expect(span).toContain("// BUG: returns 500");
    expect(span).toContain("return { status: 500 };");
    expect(span).not.toContain("export function login");
  });

  test("get_graph_neighbors returns a node with its edges, skipping unrelated ones", async () => {
    const input = await makeInput();

    // Minimal graphify-out fixture: writeTaskList is called by archiveTasks
    // and contained in server.js; an unrelated node must not appear.
    await mkdir(path.join(input.repoPath, "graphify-out"), { recursive: true });
    await writeFile(
      path.join(input.repoPath, "graphify-out", "graph.json"),
      JSON.stringify({
        nodes: [
          { id: "fn:writeTaskList", label: "writeTaskList()", source_file: "server.js", source_location: "10-20" },
          { id: "fn:archiveTasks", label: "archiveTasks()", source_file: "server.js", source_location: "30-45" },
          { id: "file:server.js", label: "server.js", source_file: "server.js" },
          { id: "fn:unrelated", label: "unrelated()", source_file: "other.js" },
        ],
        links: [
          { source: "fn:archiveTasks", target: "fn:writeTaskList", relation: "calls", confidence: "EXTRACTED" },
          { source: "file:server.js", target: "fn:writeTaskList", relation: "contains", confidence: "EXTRACTED" },
          { source: "fn:unrelated", target: "file:other.js", relation: "contains", confidence: "INFERRED" },
        ],
      }),
      "utf8",
    );

    const model = scriptedModel([
      toolUseMessage("get_graph_neighbors", { node: "writeTaskList()" }),
      toolUseMessage("get_graph_neighbors", { node: "doesNotExist()" }),
      toolUseMessage("submit_blocked", { reason: "done" }),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        throw new Error("verifier must not run in this test");
      },
    });

    expect(result.status).toBe("blocked");

    const neighbors = lastToolResultText(model.calls[1]);
    expect(neighbors).toContain("NODE writeTaskList() | server.js:10-20");
    expect(neighbors).toContain("EDGE archiveTasks() --calls--> writeTaskList() [EXTRACTED]");
    expect(neighbors).toContain("EDGE server.js --contains--> writeTaskList() [EXTRACTED]");
    expect(neighbors).not.toContain("unrelated");

    expect(lastToolResultText(model.calls[2])).toContain('No graph node matches "doesNotExist()"');
  });

  test("two consecutive non-tool responses fail the session after one nudge", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      textMessage("Let me think about this."),
      textMessage("Still thinking."),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        throw new Error("verifier must not run in this test");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("without a tool call");

    // The nudge was delivered between the two model calls.
    const secondCall = model.calls[1];
    const nudge = secondCall.messages[secondCall.messages.length - 1];
    expect(nudge.content).toContain("Independent read-only inspections may be called in parallel");
  });

  test("read_file of a fully hydrated file is rejected without consuming budget", async () => {
    const input = await makeInput({
      initialSourceFiles: [
        { path: "server.js", contents: "hydrated contents", truncated: false },
      ],
    });
    const model = scriptedModel([
      toolUseMessage("read_file", { path: "server.js" }),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => attemptResult("verified", "Replay clean."),
    });

    expect(result.status).toBe("verified");

    // The redundant read was rejected with an instructive error...
    const feedback = lastToolResultText(model.calls[1]);
    expect(feedback).toContain("REDUNDANT read_file rejected");
    expect(feedback).toContain("server.js");

    // ...and the read_file budget was NOT consumed.
    const summary = JSON.parse(
      await readFile(
        path.join(input.investigationDir, "fix-agent", "summary.json"),
        "utf8",
      ),
    ) as { counters: { readFile: number } };
    expect(summary.counters.readFile).toBe(0);

    // The hydrated file list and strict rules are in the system prompt.
    expect(String(model.calls[0].system)).toContain("REJECTED automatically: server.js");
  });

  test("truncated hydrated files may still be read", async () => {
    const input = await makeInput({
      initialSourceFiles: [
        { path: "server.js", contents: "partial contents", truncated: true },
      ],
    });
    const model = scriptedModel([
      toolUseMessage("read_file", { path: "server.js" }),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
    ]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => attemptResult("verified", "Replay clean."),
    });

    expect(result.status).toBe("verified");
    expect(lastToolResultText(model.calls[1])).toContain("BUG: returns 500");
  });

  test("pastInvestigations memory reaches the initial message with memory-first rules", async () => {
    const input = await makeInput({
      pastInvestigations:
        'PAST: "Login returns 500 for unknown users" -> verified\n  verified fix diff (patched files are UNCHANGED since this fix — reapply this exact change unless current evidence contradicts it):\n    diff --git a/server.js b/server.js',
    });
    const model = scriptedModel([toolUseMessage("propose_patch", PROPOSAL_INPUT)]);

    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => attemptResult("verified", "Replay clean."),
    });

    expect(result.status).toBe("verified");

    const initial = model.calls[0].messages[0].content as string;
    expect(initial).toContain("PAST INVESTIGATIONS (this repo — READ BEFORE ANY TOOL CALL)");
    expect(initial).toContain("verified fix diff");
    expect(initial).toContain("Adapt it into propose_patch");
    expect(String(model.calls[0].system)).toContain("MEMORY FIRST");
  });

  test("without memory the initial message omits the past section", async () => {
    const input = await makeInput();
    const model = scriptedModel([toolUseMessage("propose_patch", PROPOSAL_INPUT)]);

    await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => attemptResult("verified", "Replay clean."),
    });

    const initial = model.calls[0].messages[0].content as string;
    expect(initial).not.toContain("PAST INVESTIGATIONS");
    expect(String(model.calls[0].system)).not.toContain("MEMORY FIRST");
  });
});

describe("rich retry feedback (evidence delta)", () => {
  test("failed attempt feedback contains before/after signatures and the change verdict", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("submit_blocked", { reason: "giving up for the test" }),
    ]);

    await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () =>
        attemptResult(
          "rejected_reproduction_still_fails",
          "The original failure still occurs after the patch.",
          ["server.js"],
          evidenceSummary('reproduced | assertion observed "500"', "500"),
        ),
    });

    const feedback = lastToolResultText(model.calls[1]);
    expect(feedback).toContain("EVIDENCE DELTA");
    expect(feedback).toContain("Before signature:");
    expect(feedback).toContain("After signature:");
    expect(feedback).toMatch(/Signature changed: (yes|no)/);
    // Existing fields are preserved.
    expect(feedback).toContain("Verification outcome: rejected_reproduction_still_fails");
    expect(feedback).toContain("Changed files: server.js");
  });

  test("missing post-patch evidence is reported truthfully", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("submit_blocked", { reason: "done" }),
    ]);

    await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () =>
        attemptResult("rejected_patch_invalid", "Patch rejected before application.", []),
    });

    const feedback = lastToolResultText(model.calls[1]);
    expect(feedback).toContain("Post-patch replay not reached");
  });

  test("advisory checks are not presented to the fixer as failed checks", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("submit_blocked", { reason: "done" }),
    ]);

    await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        const attempt = attemptResult(
          "rejected_reproduction_still_fails",
          "The exact replay still fails.",
        );
        attempt.checks.push({
          name: "regression_test",
          status: "advisory",
          detail: "Generated regression evidence was blocked but is not a failed check.",
        });
        return attempt;
      },
    });

    const feedback = lastToolResultText(model.calls[1]);
    expect(feedback).toContain("failure_no_longer_observed");
    expect(feedback).not.toContain("Generated regression evidence was blocked");
  });

  test("signature lines survive the feedback byte cap", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("submit_blocked", { reason: "done" }),
    ]);

    const hugeReason = "x".repeat(10_000);
    await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () =>
        attemptResult(
          "rejected_reproduction_still_fails",
          hugeReason,
          ["server.js"],
          evidenceSummary("reproduced | assertion observed \"500\"", "500"),
        ),
    });

    const feedback = lastToolResultText(model.calls[1]);
    expect(Buffer.byteLength(feedback, "utf8")).toBeLessThanOrEqual(
      FIXER_BUDGETS.maxAttemptFeedbackBytes,
    );
    expect(feedback).toContain("Before signature:");
    expect(feedback).toContain("After signature:");
  });
});

describe("compaction preserves attempt signatures", () => {
  test("state summary keeps a before/after signature line per attempt", async () => {
    const previous = process.env.SHERLOCK_COMPACTION;
    process.env.SHERLOCK_COMPACTION = "true";

    try {
      const input = await makeInput();
      const model = scriptedModel([
        toolUseMessage("propose_patch", PROPOSAL_INPUT),
        toolUseMessage("read_file", { path: "server.js" }),
        toolUseMessage("read_file", { path: "server.js", startLine: 1, endLine: 2 }),
        toolUseMessage("read_file", { path: "server.js", startLine: 2, endLine: 3 }),
        toolUseMessage("read_file", { path: "server.js", startLine: 3, endLine: 4 }),
        toolUseMessage("grep", { query: "login" }),
        toolUseMessage("grep", { query: "status" }),
        toolUseMessage("submit_blocked", { reason: "done" }),
      ]);

      const result = await runFixerAgent(input, {
        createMessage: model.createMessage,
        runFixAttempt: async () =>
          attemptResult(
            "rejected_reproduction_still_fails",
            "Still fails.",
            ["server.js"],
            evidenceSummary('reproduced | assertion observed "500"', "500"),
          ),
      });

      expect(result.compactionEvents).toBeGreaterThanOrEqual(1);

      // After compaction, some model call saw the rebuilt state summary with
      // per-attempt signature lines.
      const allMessages = model.calls
        .flatMap((call) => call.messages)
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
        )
        .join("\n");
      expect(allMessages).toContain("Patch attempts so far");
      expect(allMessages).toContain("before: reproduced");
      expect(allMessages).toContain('after: reproduced | assertion observed');
    } finally {
      if (previous === undefined) {
        delete process.env.SHERLOCK_COMPACTION;
      } else {
        process.env.SHERLOCK_COMPACTION = previous;
      }
    }
  });
});

describe("dense inspection budgets", () => {
  test("read_many cannot cross the pre-patch exploration ceiling", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("grep", { query: "login" }),
      toolUseMessage("grep", { query: "status" }),
      toolUseMessage("get_graph_neighbors", { node: "one" }),
      toolUseMessage("get_graph_neighbors", { node: "two" }),
      toolUseMessage("get_graph_neighbors", { node: "three" }),
      toolUseMessage("read_many", {
        files: [
          { path: "server.js", startLine: 1, endLine: 1 },
          { path: "server.js", startLine: 2, endLine: 2 },
          { path: "server.js", startLine: 3, endLine: 3 },
        ],
      }),
      toolUseMessage("submit_blocked", { reason: "done" }),
    ]);

    const result = await runFixerAgent(input, { createMessage: model.createMessage });
    expect(result.efficiencyCounters.filesReadThroughReadMany).toBe(1);
    expect(lastToolResultText(model.calls[6])).toContain("Exploration budget exhausted");
  });
});

describe("duplicate-patch guard", () => {
  test("identical proposal twice reaches the verifier once and keeps the attempt budget", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("submit_blocked", { reason: "done" }),
    ]);

    let verifierCalls = 0;
    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        verifierCalls += 1;
        return attemptResult("rejected_reproduction_still_fails", "Still fails.");
      },
    });

    expect(verifierCalls).toBe(1);
    expect(result.attempts).toHaveLength(1);

    const rejection = lastToolResultText(model.calls[2]);
    expect(rejection).toContain("REJECTED without verification");
    expect(rejection).toContain("attempt 1");

    const summary = JSON.parse(
      await readFile(path.join(input.investigationDir, "fix-agent", "summary.json"), "utf8"),
    ) as { patchAttempts: number; counters: { duplicatePatchRejections: number } };
    expect(summary.patchAttempts).toBe(1);
    expect(summary.counters.duplicatePatchRejections).toBe(1);
  });

  test("reordered files/edits and changed prose still count as duplicates", async () => {
    const twoFileProposal = {
      ...PROPOSAL_INPUT,
      files: [
        { path: "server.js", edits: [{ oldText: "return { status: 500 };", newText: "return { status: 401 };" }] },
        { path: "./other.js", edits: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ] },
      ],
    };
    const reordered = {
      ...twoFileProposal,
      summary: "Completely different explanation",
      rootCause: "Some other prose",
      confidence: 0.4,
      files: [
        { path: "other.js", edits: [
          { oldText: "c", newText: "d" },
          { oldText: "a", newText: "b" },
        ] },
        { path: "server.js", edits: [{ oldText: "return { status: 500 };", newText: "return { status: 401 };" }] },
      ],
    };

    expect(hashFixProposalEdits(twoFileProposal as unknown as FixProposal)).toBe(
      hashFixProposalEdits(reordered as unknown as FixProposal),
    );

    const different = {
      ...twoFileProposal,
      files: [
        { path: "server.js", edits: [{ oldText: "return { status: 500 };", newText: "return { status: 403 };" }] },
      ],
    };
    expect(hashFixProposalEdits(different as unknown as FixProposal)).not.toBe(
      hashFixProposalEdits(twoFileProposal as unknown as FixProposal),
    );
  });

  test("a materially different patch reaches verification", async () => {
    const secondProposal = {
      ...PROPOSAL_INPUT,
      files: [
        {
          path: "server.js",
          edits: [{ oldText: "return { status: 500 };", newText: "return { status: 403 };" }],
        },
      ],
    };
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", secondProposal),
    ]);

    let verifierCalls = 0;
    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        verifierCalls += 1;
        return verifierCalls === 1
          ? attemptResult("rejected_reproduction_still_fails", "Still fails.")
          : attemptResult("verified", "Replay clean.");
      },
    });

    expect(verifierCalls).toBe(2);
    expect(result.status).toBe("verified");
  });

  test("third duplicate rejection ends with fixer_repeated_patch", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
    ]);

    let verifierCalls = 0;
    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        verifierCalls += 1;
        return attemptResult("rejected_reproduction_still_fails", "Still fails.");
      },
    });

    expect(verifierCalls).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("fixer_repeated_patch");
  });

  test("memory-seeded knownFailedProposals reject on the FIRST submission", async () => {
    const seededHash = hashFixProposalEdits(PROPOSAL_INPUT as unknown as FixProposal);
    const input = await makeInput({
      knownFailedProposals: [
        { proposalHash: seededHash, failureReason: "The exact replay still reproduced the issue." },
      ],
    });
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("submit_blocked", { reason: "cannot find a different fix" }),
    ]);

    let verifierCalls = 0;
    const result = await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => {
        verifierCalls += 1;
        return attemptResult("verified", "unexpected");
      },
    });

    expect(verifierCalls).toBe(0);
    expect(result.status).toBe("blocked");

    const rejection = lastToolResultText(model.calls[1]);
    expect(rejection).toContain("REJECTED without verification");
    expect(rejection).toContain("previous investigation");
    expect(rejection).toContain("The exact replay still reproduced the issue.");
  });
});

describe("reproducer findings in the fixer prompt", () => {
  test("findings render as labeled exploration hints", async () => {
    const input = await makeInput({
      reproducerFindings: [
        {
          kind: "response",
          observation: "POST /api/archive -> 500",
          sourceTool: "request",
          sourceStepId: "live-3",
          evidenceClass: "live_exploration",
        },
        {
          kind: "runtime_error",
          observation: "TypeError: Converting circular structure to JSON",
          sourceTool: "read_page",
          sourceStepId: null,
          evidenceClass: "live_exploration",
        },
      ],
    });
    const model = scriptedModel([toolUseMessage("propose_patch", PROPOSAL_INPUT)]);

    await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => attemptResult("verified", "Replay clean."),
    });

    const initial = model.calls[0].messages[0].content as string;
    expect(initial).toContain("REPRODUCER EXPLORATION HINTS");
    expect(initial).toContain("They are not proof");
    expect(initial).toContain("- [response/request] POST /api/archive -> 500");
    expect(initial).toContain("- [runtime_error/read_page] TypeError");
  });

  test("the complete findings section obeys its byte cap", async () => {
    const input = await makeInput({
      reproducerFindings: Array.from({ length: 30 }, (_, index) => ({
        kind: "runtime_error" as const,
        observation: `finding-${index}-${"x".repeat(280)}`,
        sourceTool: "read_page",
        sourceStepId: null,
        evidenceClass: "live_exploration" as const,
      })),
    });
    const model = scriptedModel([toolUseMessage("propose_patch", PROPOSAL_INPUT)]);

    await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => attemptResult("verified", "Replay clean."),
    });

    const initial = model.calls[0].messages[0].content as string;
    const start = initial.indexOf("REPRODUCER EXPLORATION HINTS");
    const end = initial.indexOf("\nSaved reproduction plan", start);
    const section = initial.slice(start, end);
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(2 * 1024);
  });

  test("no findings means no hints section", async () => {
    const input = await makeInput();
    const model = scriptedModel([toolUseMessage("propose_patch", PROPOSAL_INPUT)]);

    await runFixerAgent(input, {
      createMessage: model.createMessage,
      runFixAttempt: async () => attemptResult("verified", "Replay clean."),
    });

    const initial = model.calls[0].messages[0].content as string;
    expect(initial).not.toContain("REPRODUCER EXPLORATION HINTS");
  });
});
