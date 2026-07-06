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
import type { GraphContext } from "../backend/services/graphContext.js";
import type { ReproductionPlan } from "../backend/services/plan.js";
import type { ReproductionResult } from "../backend/services/playwright.js";

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
  const blocks = last.content as Array<{ type: string; content?: unknown }>;
  const block = blocks.find((item) => item.type === "tool_result");

  return typeof block?.content === "string" ? block.content : "";
}

// --- Stubbed verifier ----------------------------------------------------------

function attemptResult(
  outcome: FixAttemptResult["outcome"],
  reason: string,
  changedFiles: string[] = ["server.js"],
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
        passed: outcome === "verified",
        detail: reason,
      },
    ],
    sourceCommit: "unused",
    changedFiles,
    summary: "stub",
    rootCause: "stub root cause",
    postPatchOutcome: outcome === "verified" ? "not_reproduced" : "reproduced",
    testRuns: [],
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

// --- Tests ------------------------------------------------------------------------

describe("fixer agent loop", () => {
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
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
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

  test("stops exhausted after max patch attempts, never verified", async () => {
    const input = await makeInput();
    const model = scriptedModel([
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
      toolUseMessage("propose_patch", PROPOSAL_INPUT),
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
    expect(grepResult).toContain(`[TRUNCATED at ${FIXER_BUDGETS.maxGrepLines} matches]`);
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
    expect(nudge.content).toBe("Respond with exactly one tool call.");
  });
});
