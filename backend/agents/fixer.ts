// Bounded tool-using fixer agent (docs/fable/10).
//
// Fix AUTHORING is agentic: the model decides what to read, search, and try
// next through a small set of tools. Fix JUDGMENT stays deterministic: only
// runFixAttempt() (patch safety validation, exact replay of the saved
// reproduction plan, tests) can mark an attempt "verified". The model never
// declares success; its only terminal moves are propose_patch (judged by the
// verifier) and submit_blocked.
//
// No agent framework: a plain message loop over the Anthropic tools API with
// hard budgets, full artifact transcripts, and an injectable model/verifier
// so tests run without Claude or Docker.

import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { createCompactor } from "./compaction.js";
import { createArtifactStore } from "../services/artifacts.js";
import { truncateWithMarker } from "../services/bounded-text.js";
import {
  MODEL,
  createModelMessage,
  formatGraphSection,
  formatRepoEvidence,
} from "../services/claude.js";
import {
  runFixAttempt,
  type FixAttemptResult,
  type RestartResult,
} from "../services/fix.js";
import type { AppNetworkTarget } from "../services/regression-test.js";
import { FIX_PROPOSAL_VERSION, PATCH_LIMITS } from "../services/fix-proposal.js";
import { queryGraphNeighbors, type GraphContext } from "../services/graphContext.js";
import type { ReproductionPlan } from "../services/plan.js";
import type { ReproductionResult } from "../services/playwright.js";
import type { SourceFile } from "../services/repo.js";
import { redactSecrets } from "../services/report.js";

const execFileAsync = promisify(execFile);

// --- Budgets (docs/fable/10) ------------------------------------------------
//
// Two profiles: cost-conscious "standard" (default) and quality-oriented
// "deep" behind SHERLOCK_DEEP_INVESTIGATION=true. Every tool call consumes a
// model turn, so maxModelTurns must cover the plausible tool-call budget plus
// terminal turns. First-pass numbers — tune from cost-shape.json.

// Limits shared by both profiles (safety caps, not cost knobs).
const FIXER_SHARED_LIMITS = {
  maxWallTimeMs: 15 * 60_000,
  maxResponseTokens: 4_000,
  // Per read_file result.
  maxFileBytes: 64 * 1024,
  // Per grep result.
  maxGrepLines: 50,
  // Truncation for verifier feedback returned to the model.
  maxAttemptFeedbackBytes: 4 * 1024,
  // Cumulative read_file/grep bytes returned to the model.
  maxEvidenceBytes: 300 * 1024,
};

export const STANDARD_FIXER_BUDGETS = {
  ...FIXER_SHARED_LIMITS,
  maxModelTurns: 16,
  maxReadFileCalls: 8,
  maxGrepCalls: 4,
  maxGraphCalls: 4,
  maxPatchAttempts: 2,
};

export const DEEP_FIXER_BUDGETS = {
  ...FIXER_SHARED_LIMITS,
  maxModelTurns: 30,
  maxReadFileCalls: 20,
  maxGrepCalls: 10,
  maxGraphCalls: 10,
  maxPatchAttempts: 3,
};

export type FixerBudgets = typeof STANDARD_FIXER_BUDGETS;

// Stable alias for existing imports; the agent runtime selects a profile via
// getFixerBudgets() at run start instead of using this directly.
export const FIXER_BUDGETS = STANDARD_FIXER_BUDGETS;

export function getFixerBudgets(): FixerBudgets {
  return process.env.SHERLOCK_DEEP_INVESTIGATION === "true"
    ? DEEP_FIXER_BUDGETS
    : STANDARD_FIXER_BUDGETS;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "graphify-out",
]);

// --- Public interface --------------------------------------------------------

export type FixerAgentInput = {
  investigationId: string;
  investigationDir: string;
  repoPath: string;
  sourceCommit: string;
  issueTitle: string;
  issueBody: string;
  repoUrl: string;
  defaultBranch: string;
  fileTree: string[];
  packageJson: string | null;
  readme: string | null;
  sandboxResult: { baseUrl: string; stdout: string; stderr: string };
  plan: ReproductionPlan;
  reproductionResult: ReproductionResult;
  graphContext: GraphContext;
  initialSourceFiles: SourceFile[];
  restart: () => Promise<RestartResult>;
  // --- Verification extras (dev: repo validation + regression tests) ------
  // "owner/name" used in validation artifacts; never a URL or secret.
  repositoryLabel?: string;
  // The ORIGINAL (pre-patch) running app container, for strict-network
  // regression execution against the unpatched source.
  appNetwork?: AppNetworkTarget | null;
  // Binds one patch proposal into a regression-test generator; the verifier
  // calls the returned function at most twice (initial + one refinement).
  // Absent means regression testing is unavailable — reported truthfully.
  buildRegressionTestGenerator?:
    | ((proposal: unknown) => (feedback: string | null) => Promise<unknown>)
    | null;
};

export type FixerAgentStatus = "verified" | "blocked" | "exhausted" | "failed";

export type FixerAgentAttempt = {
  index: number;
  fixAttemptId?: string;
  outcome?: string;
  reason?: string;
  changedFiles?: string[];
};

export type FixerAgentResult = {
  fixAttempt: FixAttemptResult | null;
  status: FixerAgentStatus;
  reason: string;
  attempts: FixerAgentAttempt[];
  // Cost-shape observability (artifacts/<inv_id>/cost-shape.json).
  turns: number;
  compactionEvents: number;
};

export type CreateModelMessage = (
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Messages.Message>;

// Injectable for tests; defaults to the real model and the real verifier.
export type FixerAgentDeps = {
  createMessage: CreateModelMessage;
  runFixAttempt: typeof runFixAttempt;
};

// --- Tools --------------------------------------------------------------------

const FIX_PROPOSAL_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    version: {
      type: "number",
      enum: [FIX_PROPOSAL_VERSION],
      description: `Always ${FIX_PROPOSAL_VERSION}.`,
    },
    summary: { type: "string", description: "One sentence describing the fix." },
    rootCause: {
      type: "string",
      description: "One sentence describing the exact root cause, citing file and function.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the repo root." },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: {
                  type: "string",
                  description:
                    "Exact text currently in the file, copied verbatim including whitespace. Must appear exactly once.",
                },
                newText: { type: "string" },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
    relevantTests: {
      type: "array",
      items: { type: "string" },
      description:
        "Plain npm/npx/node commands, no shell operators. Empty array if the repo has no runnable tests.",
    },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    assumptions: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "rootCause",
    "confidence",
    "files",
    "relevantTests",
    "risk",
    "assumptions",
  ],
};

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "read_file",
    description:
      "Read one file from the repository. Path must be relative to the repo root. Optionally pass startLine/endLine (1-based, inclusive) to read only a span — useful for reading just the source location a graph NODE line points to. Large results are truncated.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        startLine: { type: "number", description: "First line to read (1-based)." },
        endLine: { type: "number", description: "Last line to read (inclusive)." },
      },
      required: ["path"],
    },
  },
  {
    name: "get_graph_neighbors",
    description:
      "Look up a node in the static code graph and return it with its direct neighbors and edges (calls, imports_from, contains, uses, ...). Pass a node label exactly as shown in NODE lines (e.g. \"writeTaskList()\") or a node id. Use this for structural questions like \"who calls X\" instead of grep.",
    input_schema: {
      type: "object" as const,
      properties: { node: { type: "string" } },
      required: ["node"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents in the repository with a regular expression (falls back to literal text if the pattern is invalid). Optional glob filters files, e.g. **/*.js. Returns path:line: snippet, capped.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        glob: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "propose_patch",
    description:
      "Propose a fix. The patch is validated (shape + safety), applied in the workspace, the app is restarted, the EXACT saved reproduction plan is replayed, and relevant tests run. You receive the deterministic verification result. A non-verified attempt is rolled back automatically.",
    input_schema: FIX_PROPOSAL_INPUT_SCHEMA,
  },
  {
    name: "submit_blocked",
    description:
      "Declare that a safe fix is not possible with the available evidence and attempts. Ends the session.",
    input_schema: {
      type: "object" as const,
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

// --- Agent loop ----------------------------------------------------------------

export async function runFixerAgent(
  input: FixerAgentInput,
  deps: Partial<FixerAgentDeps> = {},
): Promise<FixerAgentResult> {
  const createMessage = deps.createMessage ?? createModelMessage;
  const verify = deps.runFixAttempt ?? runFixAttempt;

  // Budget profile is selected once at run start and used for the whole run.
  const budgetProfile =
    process.env.SHERLOCK_DEEP_INVESTIGATION === "true" ? "deep" : "standard";
  const budgets = getFixerBudgets();

  const log = (message: string) => {
    console.log(`[${input.investigationId}] Fixer: ${message}`);
  };

  log(`Fixer budget profile: ${budgetProfile}`);

  const agentDir = path.join(input.investigationDir, "fix-agent");
  const store = await createArtifactStore(input.investigationId, agentDir);
  await mkdir(path.join(agentDir, "tool-calls"), { recursive: true });

  const startedAt = Date.now();
  const counters = {
    turns: 0,
    readFile: 0,
    grep: 0,
    graph: 0,
    patchAttempts: 0,
    evidenceBytes: 0,
  };
  const attempts: FixerAgentAttempt[] = [];
  const transcript: unknown[] = [];
  let toolCallIndex = 0;
  let lastAttempt: FixAttemptResult | null = null;
  let nudged = false;

  // Compaction (SHERLOCK_COMPACTION=true): locally tracked state used to
  // rebuild a compact summary when old history is spliced out.
  const compactor = createCompactor();
  const factLog: string[] = [];
  let lastVerifierFeedback = "";
  let lastAssistantText = "";

  const buildStateSummary = (): string => {
    const sections = [
      factLog.length > 0
        ? `Facts learned (files/graph/grep inspected):\n${factLog.slice(-40).map((line) => `- ${line}`).join("\n")}`
        : "No inspection tool calls yet.",
      attempts.length > 0
        ? `Patch attempts so far (all rolled back unless verified):\n${attempts
            .map(
              (attempt) =>
                `- attempt ${attempt.index}: ${attempt.outcome ?? "?"} — ${(attempt.reason ?? "").slice(0, 300)} (changed: ${(attempt.changedFiles ?? []).join(", ") || "none"})`,
            )
            .join("\n")}`
        : "No patch attempts yet.",
      lastVerifierFeedback ? `Latest verifier feedback:\n${lastVerifierFeedback}` : "",
      lastAssistantText ? `Your last stated reasoning:\n${lastAssistantText.slice(0, 600)}` : "",
      `Remaining budgets: ${budgets.maxModelTurns - counters.turns} model turn(s), ${Math.max(0, budgets.maxReadFileCalls - counters.readFile)} read_file, ${Math.max(0, budgets.maxGrepCalls - counters.grep)} grep, ${Math.max(0, budgets.maxGraphCalls - counters.graph)} get_graph_neighbors, ${budgets.maxPatchAttempts - counters.patchAttempts} patch attempt(s).`,
    ];

    return sections.filter(Boolean).join("\n\n");
  };

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildInitialMessage(input) },
  ];

  const finish = async (
    status: FixerAgentStatus,
    reason: string,
    fixAttempt: FixAttemptResult | null,
  ): Promise<FixerAgentResult> => {
    const result: FixerAgentResult = {
      fixAttempt,
      status,
      reason,
      attempts,
      turns: counters.turns,
      compactionEvents: compactor.events,
    };
    transcript.push({ type: "final_result", status, reason, attempts });
    await store.writeJson("transcript.json", transcript);
    await store.writeJson("summary.json", {
      status,
      reason,
      attempts,
      fixAttemptId: fixAttempt?.fixAttemptId ?? null,
      fixOutcome: fixAttempt?.outcome ?? null,
      counters,
      compactionEvents: compactor.events,
      durationMs: Date.now() - startedAt,
    });
    log(`finished: ${status} — ${reason}`);
    return result;
  };

  const recordToolCall = async (tool: string, request: unknown, result: string) => {
    toolCallIndex += 1;
    const fileName = `tool-calls/${String(toolCallIndex).padStart(3, "0")}-${tool}.json`;
    await store.writeJson(fileName, {
      index: toolCallIndex,
      tool,
      request,
      result: redactSecrets(result),
    });
  };

  try {
    while (true) {
      if (Date.now() - startedAt > budgets.maxWallTimeMs) {
        return await finish("exhausted", "Wall-time budget exhausted.", lastAttempt);
      }

      if (counters.turns >= budgets.maxModelTurns) {
        return await finish("exhausted", "Model turn budget exhausted.", lastAttempt);
      }

      counters.turns += 1;

      // Snapshot: the params must not alias the mutable history array, so
      // recorded/injected createMessage implementations see a stable value.
      const message = await createMessage({
        model: MODEL,
        max_tokens: budgets.maxResponseTokens,
        temperature: 0,
        system: buildSystemPrompt(budgets),
        tools: TOOLS,
        tool_choice: { type: "any", disable_parallel_tool_use: true },
        messages: [...messages],
      });

      const toolUse = message.content.find(
        (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
      );

      if (!toolUse) {
        transcript.push({
          type: "non_tool_response",
          turn: counters.turns,
          stopReason: message.stop_reason,
        });

        if (nudged) {
          return await finish(
            "failed",
            "The model returned two consecutive responses without a tool call.",
            lastAttempt,
          );
        }

        nudged = true;
        messages.push(
          { role: "assistant", content: nonEmptyContent(message.content) },
          { role: "user", content: "Respond with exactly one tool call." },
        );
        continue;
      }

      const textBlock = message.content.find(
        (block): block is Anthropic.Messages.TextBlock => block.type === "text",
      );

      if (textBlock?.text.trim()) {
        lastAssistantText = textBlock.text.trim();
      }

      transcript.push({
        type: "model_action",
        turn: counters.turns,
        tool: toolUse.name,
        input:
          toolUse.name === "propose_patch" ? "(see tool-calls artifact)" : toolUse.input,
      });
      log(`turn ${counters.turns}: ${toolUse.name}`);

      // Terminal action: blocked.
      if (toolUse.name === "submit_blocked") {
        const reason =
          typeof (toolUse.input as { reason?: unknown })?.reason === "string"
            ? (toolUse.input as { reason: string }).reason
            : "(no reason given)";
        await recordToolCall("submit_blocked", toolUse.input, reason);
        return await finish("blocked", reason, lastAttempt);
      }

      // Terminal-capable action: propose_patch.
      if (toolUse.name === "propose_patch") {
        counters.patchAttempts += 1;

        const proposal = {
          version: FIX_PROPOSAL_VERSION,
          ...(toolUse.input as Record<string, unknown>),
        };

        const attempt = await verify({
          investigationId: input.investigationId,
          investigationDir: input.investigationDir,
          repoPath: input.repoPath,
          sourceCommit: input.sourceCommit,
          plan: input.plan,
          originalOutcome: input.reproductionResult.outcome,
          proposal,
          restart: input.restart,
          repositoryLabel: input.repositoryLabel,
          appNetwork: input.appNetwork ?? null,
          generateRegressionTest: input.buildRegressionTestGenerator
            ? input.buildRegressionTestGenerator(proposal)
            : null,
        });

        lastAttempt = attempt;
        attempts.push({
          index: counters.patchAttempts,
          fixAttemptId: attempt.fixAttemptId,
          outcome: attempt.outcome,
          reason: attempt.reason,
          changedFiles: attempt.changedFiles,
        });
        transcript.push({
          type: "fix_attempt",
          turn: counters.turns,
          fixAttemptId: attempt.fixAttemptId,
          outcome: attempt.outcome,
          reason: attempt.reason,
          changedFiles: attempt.changedFiles,
        });
        log(`patch attempt ${counters.patchAttempts}: ${attempt.outcome}`);

        const feedback = formatAttemptFeedback(attempt);
        await recordToolCall("propose_patch", proposal, feedback);

        if (attempt.outcome === "verified") {
          // Keep the patched workspace: the PR flow commits from it.
          return await finish("verified", attempt.reason, attempt);
        }

        // Unconditional rollback after every non-verified attempt. Without
        // this, the next attempt's git diff still contains this patch and
        // changes_within_scope falsely rejects it. Touches only the temporary
        // investigation clone.
        const rollback = await rollbackWorkspace(input.repoPath, input.sourceCommit);

        if (!rollback.ok) {
          return await finish(
            "failed",
            `Workspace rollback failed after a non-verified attempt: ${rollback.error}`,
            lastAttempt,
          );
        }

        if (counters.patchAttempts >= budgets.maxPatchAttempts) {
          return await finish(
            "exhausted",
            `Patch attempt budget exhausted (${budgets.maxPatchAttempts} attempts, none verified).`,
            lastAttempt,
          );
        }

        messages.push(
          { role: "assistant", content: message.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `${feedback}\n\nThe workspace was rolled back to the source commit. ${budgets.maxPatchAttempts - counters.patchAttempts} patch attempt(s) remaining. Revise using this evidence, or call submit_blocked.`,
              },
            ],
          },
        );

        lastVerifierFeedback = feedback;
        compactor.record(feedback.length);

        if (compactor.maybeCompact(messages, buildStateSummary)) {
          transcript.push({ type: "compaction", turn: counters.turns, event: compactor.events });
          log(`compaction event ${compactor.events}: old history replaced with state summary.`);
        }

        continue;
      }

      // Inspection tools: read_file / grep.
      let resultText: string;
      let isError = false;

      if (toolUse.name === "read_file") {
        counters.readFile += 1;
        if (counters.readFile > budgets.maxReadFileCalls) {
          resultText = "read_file budget exhausted — propose a patch or call submit_blocked.";
          isError = true;
        } else if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
          resultText = "Evidence budget exhausted — propose a patch or call submit_blocked.";
          isError = true;
        } else {
          const readInput = toolUse.input as {
            path?: unknown;
            startLine?: unknown;
            endLine?: unknown;
          };
          const outcome = await execReadFile(input.repoPath, readInput?.path, {
            startLine: typeof readInput?.startLine === "number" ? readInput.startLine : undefined,
            endLine: typeof readInput?.endLine === "number" ? readInput.endLine : undefined,
          });
          resultText = outcome.text;
          isError = !outcome.ok;
          if (outcome.ok) {
            counters.evidenceBytes += resultText.length;
          }
        }
      } else if (toolUse.name === "get_graph_neighbors") {
        counters.graph += 1;
        if (counters.graph > budgets.maxGraphCalls) {
          resultText = "get_graph_neighbors budget exhausted — propose a patch or call submit_blocked.";
          isError = true;
        } else if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
          resultText = "Evidence budget exhausted — propose a patch or call submit_blocked.";
          isError = true;
        } else {
          const nodeRef = (toolUse.input as { node?: unknown })?.node;
          const outcome =
            typeof nodeRef === "string"
              ? await queryGraphNeighbors(input.repoPath, nodeRef)
              : { ok: false, text: "get_graph_neighbors requires a string node reference." };
          resultText = outcome.text;
          isError = !outcome.ok;
          if (outcome.ok) {
            counters.evidenceBytes += resultText.length;
          }
        }
      } else if (toolUse.name === "grep") {
        counters.grep += 1;
        if (counters.grep > budgets.maxGrepCalls) {
          resultText = "grep budget exhausted — propose a patch or call submit_blocked.";
          isError = true;
        } else if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
          resultText = "Evidence budget exhausted — propose a patch or call submit_blocked.";
          isError = true;
        } else {
          const grepInput = toolUse.input as { query?: unknown; glob?: unknown };
          const outcome = await execGrep(
            input.repoPath,
            grepInput?.query,
            typeof grepInput?.glob === "string" ? grepInput.glob : undefined,
          );
          resultText = outcome.text;
          isError = !outcome.ok;
          if (outcome.ok) {
            counters.evidenceBytes += resultText.length;
          }
        }
      } else {
        resultText = `Unknown tool "${toolUse.name}".`;
        isError = true;
      }

      await recordToolCall(toolUse.name, toolUse.input, resultText);
      transcript.push({
        type: "tool_result",
        turn: counters.turns,
        tool: toolUse.name,
        isError,
        bytes: resultText.length,
      });

      factLog.push(
        `${toolUse.name} ${JSON.stringify(toolUse.input).slice(0, 160)} -> ${isError ? `error: ${firstLine(resultText)}` : `ok (${resultText.length} bytes)`}`,
      );

      messages.push(
        { role: "assistant", content: message.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: resultText,
              is_error: isError,
            },
          ],
        },
      );

      compactor.record(resultText.length);

      if (compactor.maybeCompact(messages, buildStateSummary)) {
        transcript.push({ type: "compaction", turn: counters.turns, event: compactor.events });
        log(`compaction event ${compactor.events}: old history replaced with state summary.`);
      }
    }
  } catch (error) {
    return await finish(
      "failed",
      `Fixer agent failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      lastAttempt,
    );
  }
}

// --- Workspace rollback ----------------------------------------------------------

async function rollbackWorkspace(
  repoPath: string,
  sourceCommit: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFileAsync("git", ["checkout", "--", "."], { cwd: repoPath });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    const head = stdout.trim();

    if (head !== sourceCommit) {
      return {
        ok: false,
        error: `HEAD is ${head} after reset, expected ${sourceCommit}.`,
      };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Tool implementations ----------------------------------------------------------

type ToolOutcome = { ok: boolean; text: string };

async function execReadFile(
  repoPath: string,
  requestedPath: unknown,
  range: { startLine?: number; endLine?: number } = {},
): Promise<ToolOutcome> {
  if (typeof requestedPath !== "string" || !requestedPath) {
    return { ok: false, text: "read_file requires a non-empty string path." };
  }

  const resolved = await resolveRepoPath(repoPath, requestedPath);

  if (!resolved.ok) {
    return { ok: false, text: resolved.error };
  }

  try {
    const info = await lstat(resolved.absolutePath);

    if (info.isSymbolicLink() || !info.isFile()) {
      return { ok: false, text: `Path ${requestedPath} is not a regular file.` };
    }

    const contents = await readFile(resolved.absolutePath, "utf8");

    if (contents.includes("\0")) {
      return { ok: false, text: `Path ${requestedPath} appears to be binary.` };
    }

    if (range.startLine !== undefined || range.endLine !== undefined) {
      const lines = contents.split("\n");
      const start = Math.floor(range.startLine ?? 1);
      const end = Math.floor(range.endLine ?? lines.length);

      if (start < 1 || end < start) {
        return {
          ok: false,
          text: `Invalid line range ${start}-${end}; lines are 1-based and endLine must be >= startLine.`,
        };
      }

      if (start > lines.length) {
        return {
          ok: false,
          text: `startLine ${start} is past the end of ${requestedPath} (${lines.length} lines).`,
        };
      }

      const clampedEnd = Math.min(end, lines.length);
      const span = lines.slice(start - 1, clampedEnd).join("\n");
      const header = `[${requestedPath} lines ${start}-${clampedEnd} of ${lines.length}]\n`;

      if (span.length > FIXER_BUDGETS.maxFileBytes) {
        return {
          ok: true,
          text: `${header}${span.slice(0, FIXER_BUDGETS.maxFileBytes)}\n[TRUNCATED at 64KB]`,
        };
      }

      return { ok: true, text: `${header}${span || "(empty span)"}` };
    }

    if (contents.length > FIXER_BUDGETS.maxFileBytes) {
      return {
        ok: true,
        text: `${contents.slice(0, FIXER_BUDGETS.maxFileBytes)}\n[TRUNCATED at 64KB]`,
      };
    }

    return { ok: true, text: contents || "(empty file)" };
  } catch {
    return { ok: false, text: `Path ${requestedPath} does not exist in the repository.` };
  }
}

async function resolveRepoPath(
  repoPath: string,
  requestedPath: string,
): Promise<{ ok: true; absolutePath: string } | { ok: false; error: string }> {
  if (path.isAbsolute(requestedPath)) {
    return { ok: false, error: `Path ${requestedPath} is absolute; only repo-relative paths are allowed.` };
  }

  const normalized = path.normalize(requestedPath);

  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    return { ok: false, error: `Path ${requestedPath} escapes the repository.` };
  }

  const repoRoot = path.resolve(repoPath);
  const absolutePath = path.resolve(repoRoot, normalized);

  if (absolutePath !== repoRoot && !absolutePath.startsWith(repoRoot + path.sep)) {
    return { ok: false, error: `Path ${requestedPath} escapes the repository.` };
  }

  // Symlinked parents must not lead outside the repo.
  try {
    const realRoot = await realpath(repoRoot);
    const realParent = await realpath(path.dirname(absolutePath));

    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
      return { ok: false, error: `Path ${requestedPath} escapes the repository via a symlink.` };
    }
  } catch {
    return { ok: false, error: `Path ${requestedPath} does not exist in the repository.` };
  }

  return { ok: true, absolutePath };
}

async function execGrep(
  repoPath: string,
  query: unknown,
  glob: string | undefined,
): Promise<ToolOutcome> {
  if (typeof query !== "string" || !query) {
    return { ok: false, text: "grep requires a non-empty string query." };
  }

  let pattern: RegExp;

  try {
    pattern = new RegExp(query);
  } catch {
    pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }

  const globPattern = glob ? globToRegExp(glob) : null;
  const globOnBasename = glob ? !glob.includes("/") : false;
  const repoRoot = path.resolve(repoPath);
  const lines: string[] = [];
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) {
      return;
    }

    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) {
        return;
      }

      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(absolute);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");

      if (globPattern && !globPattern.test(globOnBasename ? entry.name : relative)) {
        continue;
      }

      let contents: string;

      try {
        const info = await lstat(absolute);

        if (info.size > 1024 * 1024) {
          continue;
        }

        contents = await readFile(absolute, "utf8");
      } catch {
        continue;
      }

      if (contents.includes("\0")) {
        continue;
      }

      const fileLines = contents.split("\n");

      for (let index = 0; index < fileLines.length; index += 1) {
        if (pattern.test(fileLines[index])) {
          lines.push(`${relative}:${index + 1}: ${fileLines[index].slice(0, 300)}`);

          if (lines.length >= FIXER_BUDGETS.maxGrepLines) {
            truncated = true;
            break;
          }
        }
      }
    }
  };

  await walk(repoRoot);

  if (lines.length === 0) {
    return { ok: true, text: "(no matches)" };
  }

  return {
    ok: true,
    text: `${lines.join("\n")}${truncated ? `\n[TRUNCATED at ${FIXER_BUDGETS.maxGrepLines} matches]` : ""}`,
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0002/g, ".*");

  return new RegExp(`^${escaped}$`);
}

// --- Prompt ----------------------------------------------------------------------

const buildSystemPrompt = (budgets: FixerBudgets) => `You are Sherlock's fixer agent. A bug has already been deterministically reproduced in an isolated workspace; your job is to find the root cause and land the smallest safe fix.

Rules:
- Inspect files with read_file and grep. The provided graph context is a map, not the territory — when evidence is missing, read files; never guess.
- For structural questions ("who calls X", "what does this handler import"), prefer get_graph_neighbors over grep: it returns real call/import edges with confidence tags. Follow a NODE line's file:line pointer with a ranged read_file to read just that span.
- Propose the smallest patch that fixes the root cause. No refactors, no new files.
- Each oldText must appear EXACTLY ONCE in the target file, copied verbatim including whitespace.
- Change at most ${PATCH_LIMITS.maxChangedFiles} files and ${PATCH_LIMITS.maxChangedLines} lines. Never touch .env files, keys, lockfiles, GitHub workflows, or deployment configuration. Violations waste a patch attempt.
- Never modify UI text, roles, labels, placeholders, or testids referenced by the saved reproduction plan — the EXACT plan is replayed after every patch, and changing those strings breaks verification.
- relevantTests must be plain npm/npx/node commands (no shell operators); use an empty array if the repository has no runnable tests.
- propose_patch runs the full deterministic verification (safety validation, apply, restart, exact replay, tests) and returns the result. Only that verifier decides success — a failed attempt is rolled back and you receive the evidence. You have at most ${budgets.maxPatchAttempts} patch attempts; revise using the returned evidence.
- If a safe fix is not possible, call submit_blocked with a clear reason.
- Respond with exactly one tool call per turn.`;

function buildInitialMessage(input: FixerAgentInput): string {
  const result = input.reproductionResult;

  return `A bug was reproduced. Investigate and fix it.

Repository commit: ${input.sourceCommit}

Saved reproduction plan (replayed exactly after each patch):
${JSON.stringify(input.plan, null, 2)}

Reproduction outcome: ${result.outcome} — ${result.outcomeReason}
Failed assertion: ${JSON.stringify(result.assertion)}
Console errors:
${result.consoleErrors.join("\n") || "(none)"}
Page errors:
${result.pageErrors.join("\n") || "(none)"}
Failed network requests:
${result.networkFailures.map((failure) => `${failure.method} ${failure.url} -> ${failure.status ?? failure.failure}`).join("\n") || "(none)"}
API responses:
${result.apiResponses.map((response) => `${response.method} ${response.url} -> ${response.status}${response.bodyTruncated ? ` (body truncated from ${response.originalBodyLength ?? "unknown"} chars)` : ""}\n${truncateWithMarker(response.body, 4_000, "API BODY PROMPT TRUNCATED")}`).join("\n\n") || "(none)"}
${formatGraphSection(input.graphContext, "refined by reproduction evidence")}
${formatRepoEvidence({
  issueTitle: input.issueTitle,
  issueBody: input.issueBody,
  repoUrl: input.repoUrl,
  defaultBranch: input.defaultBranch,
  fileTree: input.fileTree,
  packageJson: input.packageJson,
  readme: input.readme,
  sourceFiles: input.initialSourceFiles,
  sandboxResult: input.sandboxResult,
})}`;
}

// --- Verifier feedback --------------------------------------------------------------

function formatAttemptFeedback(attempt: FixAttemptResult): string {
  const failedChecks = attempt.checks
    .filter((item) => !item.passed)
    .map((item) => `  ${item.name}: ${item.detail}`);

  const text = [
    `Verification outcome: ${attempt.outcome}`,
    `Reason: ${attempt.reason}`,
    failedChecks.length > 0 ? `Failed checks:\n${failedChecks.join("\n")}` : "Failed checks: (none)",
    `Changed files: ${attempt.changedFiles.join(", ") || "(none)"}`,
    `Post-patch replay outcome: ${attempt.postPatchOutcome ?? "(replay not reached)"}`,
    attempt.testRuns.length > 0
      ? `Tests:\n${attempt.testRuns.map((run) => `  ${run.command} -> exit ${run.exitCode}${run.timedOut ? " (timed out)" : ""}`).join("\n")}`
      : "Tests: (none run)",
  ].join("\n");

  if (text.length > FIXER_BUDGETS.maxAttemptFeedbackBytes) {
    return `${text.slice(0, FIXER_BUDGETS.maxAttemptFeedbackBytes)}\n[TRUNCATED]`;
  }

  return text;
}

function nonEmptyContent(
  content: Anthropic.Messages.ContentBlock[],
): Anthropic.Messages.MessageParam["content"] {
  if (content.length > 0) {
    return content;
  }

  return [{ type: "text", text: "(no content)" }];
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}
