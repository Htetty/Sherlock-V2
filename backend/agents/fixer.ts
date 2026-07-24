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
  formatGraphSection,
  formatRepoEvidence,
} from "../services/claude.js";
import { runInference, type InferenceTelemetry } from "../services/inference.js";
import {
  resolveEfficiencyPolicy,
  type EfficiencyPolicy,
} from "../services/efficiency-policy.js";
import { executeRunCode, RUN_CODE_LIMITS } from "./run-code.js";
import {
  assembleBatchResults,
  parallelReadsEnabled,
  planToolBatch,
} from "./tool-batch.js";
import {
  runFixAttempt,
  type FixAttemptResult,
  type RestartResult,
} from "../services/fix.js";
import type { AppNetworkTarget } from "../services/regression-test.js";
import {
  FIX_PROPOSAL_VERSION,
  PATCH_LIMITS,
  hashFixProposalEdits,
  validateFixProposalShape,
} from "../services/fix-proposal.js";
import {
  formatReproductionEvidenceDelta,
  summarizeReproductionEvidence,
  truncateUtf8Bytes,
  type ReproductionEvidenceSummary,
} from "../services/reproduction-evidence.js";
import { queryGraphNeighbors, type GraphContext } from "../services/graphContext.js";
import type { ReproductionPlan } from "../services/plan.js";
import {
  MAX_RENDERED_REPRODUCER_FINDINGS_BYTES,
  type ReproducerFinding,
} from "./reproducer.js";
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
  // Per read_many call: total bytes across all returned files (fable/16).
  maxReadManyCallBytes: 128 * 1024,
  // Per grep result after context expansion (fable/16).
  maxGrepBytes: 16 * 1024,
};

export const STANDARD_FIXER_BUDGETS = {
  ...FIXER_SHARED_LIMITS,
  maxModelTurns: 10,
  maxReadFileCalls: 4,
  maxGrepCalls: 2,
  maxGraphCalls: 3,
  // run_code Docker exploration calls (fable/16). A new budget, not a raise
  // of any pre-existing one.
  maxRunCodeCalls: 3,
  maxExplorationBeforeFirstPatch: 6,
  maxPatchAttempts: 2,
};

export const DEEP_FIXER_BUDGETS = {
  ...FIXER_SHARED_LIMITS,
  maxModelTurns: 30,
  maxReadFileCalls: 20,
  maxGrepCalls: 10,
  maxGraphCalls: 10,
  maxRunCodeCalls: 8,
  maxExplorationBeforeFirstPatch: 12,
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

export function getFixerMinimumInspections(
  budgets: FixerBudgets,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SHERLOCK_FIXER_MIN_INSPECTIONS?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(budgets.maxExplorationBeforeFirstPatch, Math.floor(parsed));
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
  abortSignal?: AbortSignal;
  graphContext: GraphContext;
  initialSourceFiles: SourceFile[];
  // Rendered PAST INVESTIGATIONS memory (renderPastInvestigations), including
  // verified fix diffs and staleness markers. Empty string when no matches.
  pastInvestigations?: string;
  // Canonical edit hashes of patches that failed in PREVIOUS investigations
  // of this issue (from memory failedAttempts). Seeds the duplicate-patch
  // guard so a known-failed patch is rejected deterministically, before
  // verification, on its first submission.
  knownFailedProposals?: Array<{ proposalHash: string; failureReason: string }>;
  // Structured live-exploration observations from the reproducer agent
  // (Change 4). Present ONLY when reproduction came through the reproducer
  // path — memory replay and one-shot plans must not fabricate findings.
  reproducerFindings?: ReproducerFinding[];
  restart: () => Promise<RestartResult>;
  // Inference telemetry (FABLE_IMPLEMENTATION_PROMPT.md Phase 1.1). Optional:
  // absent means calls run untelemetered, exactly as before the gateway.
  telemetry?: InferenceTelemetry | null;
  // Per-task policy overrides (Phase 2.5). Absent: env-flag defaults.
  budgetProfile?: "standard" | "deep";
  compaction?: boolean;
  // Parallel read-only tool calls (Phase 2 tool-batch contract). Explicit
  // override; absent falls through to `efficiency`, then to the env default.
  parallelReads?: boolean;
  // Resolved per-investigation efficiency policy (fable/16). Immutable for
  // the whole run. Absent (tests/direct callers): resolved from env once at
  // run start — never re-read mid-run.
  efficiency?: EfficiencyPolicy;
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
export type FixerFailureCode =
  | "fixer_no_patch_attempt"
  | "proposal_format_invalid"
  | "fixer_patch_failed_verification"
  | "fixer_patch_rejected_safety"
  | "fixer_patch_failed_tests"
  | "fixer_repeated_patch";

export type FixerAgentAttempt = {
  index: number;
  fixAttemptId?: string;
  // Attempt artifact directory returned by the verifier; the orchestrator
  // reads git-diff.patch only through this, never by reconstructing paths.
  attemptDir?: string;
  outcome?: string;
  reason?: string;
  changedFiles?: string[];
  proposalSummary?: string;
  proposalHash?: string;
  failureSignature?: string | null;
};

export type FixerAgentResult = {
  fixAttempt: FixAttemptResult | null;
  status: FixerAgentStatus;
  reason: string;
  failureCode: FixerFailureCode | null;
  attempts: FixerAgentAttempt[];
  // Cost-shape observability (artifacts/<inv_id>/cost-shape.json).
  turns: number;
  compactionEvents: number;
  // fable/16 efficiency observability.
  efficiencyCounters: {
    parallelBatches: number;
    batchedReads: number;
    readManyCalls: number;
    filesReadThroughReadMany: number;
    runCodeCalls: number;
    runCodeTimeouts: number;
    runCodeInvalidResults: number;
    successfulInspections: number;
  };
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
    name: "read_many",
    description:
      "Read up to 8 files (or file spans) from the repository in ONE call. Each entry: {path, startLine?, endLine?} with repo-relative paths and 1-based inclusive line numbers. Each file consumes one read_file budget unit; the combined result is capped at 128KB (files that do not fit are listed as skipped). Prefer this over several read_file calls when you already know which files you need.",
    input_schema: {
      type: "object" as const,
      properties: {
        files: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              startLine: { type: "number", description: "First line to read (1-based)." },
              endLine: { type: "number", description: "Last line to read (inclusive)." },
            },
            required: ["path"],
          },
        },
      },
      required: ["files"],
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
      "Search file contents in the repository with a regular expression (falls back to literal text if the pattern is invalid). Optional glob filters files, e.g. **/*.js. Returns path:line: match lines with contextLines (default 2, max 5) surrounding lines per match; overlapping context is merged. Set filesOnly=true for a cheap breadth-first scan that returns only matching file paths with match counts. Output is capped; omitted match/file counts are reported explicitly.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        glob: { type: "string" },
        contextLines: {
          type: "number",
          description: "Lines of context around each match (0-5, default 2).",
        },
        filesOnly: {
          type: "boolean",
          description: "Return only matching file paths with match counts.",
        },
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

function scopeReadToolPaths(
  tool: Anthropic.Messages.Tool,
  readableFiles: string[],
): Anthropic.Messages.Tool {
  if (tool.name !== "read_file" && tool.name !== "read_many") {
    return tool;
  }

  const scoped = structuredClone(tool) as Anthropic.Messages.Tool;
  const schema = scoped.input_schema as Record<string, any>;

  if (tool.name === "read_file") {
    schema.properties.path.enum = readableFiles;
  } else {
    schema.properties.files.items.properties.path.enum = readableFiles;
  }

  return scoped;
}

// run_code (fable/16): appended to the tool list only when the resolved
// efficiency policy enables it. The list is fixed at run start, so tool
// definitions stay byte-identical across every turn of one run (cache
// prefix stability).
const RUN_CODE_TOOL: Anthropic.Messages.Tool = {
  name: "run_code",
  description:
    'Run ONE read-only POSIX shell script inside an isolated explorer container (repo mounted read-only at /app, cwd /app, NO network, git and ripgrep available). Use it to answer a broad exploration question in one call instead of many read/grep turns: search, filter, and distill IN the script, then print exactly one JSON object to stdout: {"summary": string, "queriesRun": string[], "filesConsidered": string[], "filesExamined": string[], "evidence": [{"path", "startLine", "endLine", "excerpt", "reason"}], "uncertainties": string[]}. Print distilled conclusions with short cited excerpts — never raw file dumps. Non-JSON output is rejected. Must be called alone, never in a parallel batch.',
  input_schema: {
    type: "object" as const,
    properties: {
      script: { type: "string", description: "POSIX shell script, executed via /bin/sh." },
      timeoutSeconds: {
        type: "number",
        description: `Wall-clock limit in seconds (default ${RUN_CODE_LIMITS.defaultTimeoutSeconds}, max ${RUN_CODE_LIMITS.maxTimeoutSeconds}).`,
      },
    },
    required: ["script"],
  },
};

// --- Agent loop ----------------------------------------------------------------

export async function runFixerAgent(
  input: FixerAgentInput,
  deps: Partial<FixerAgentDeps> = {},
): Promise<FixerAgentResult> {
  // Efficiency policy (fable/16): resolved once per investigation and passed
  // in; resolved from env exactly once here only for tests/direct callers.
  const efficiency = input.efficiency ?? resolveEfficiencyPolicy();
  const createMessage =
    deps.createMessage ??
    ((params) =>
      runInference(
        {
          phase: "fix",
          telemetry: input.telemetry ?? null,
          policy: { cacheMode: efficiency.promptCacheMode },
        },
        params,
      ));
  const verify = deps.runFixAttempt ?? runFixAttempt;

  // Budget profile is selected once at run start and used for the whole run.
  // Per-task policy override first (Phase 2.5), env default second.
  const budgetProfile =
    input.budgetProfile ??
    (process.env.SHERLOCK_DEEP_INVESTIGATION === "true" ? "deep" : "standard");
  const budgets = budgetProfile === "deep" ? DEEP_FIXER_BUDGETS : STANDARD_FIXER_BUDGETS;
  const parallelReads = parallelReadsEnabled(
    input.parallelReads ?? efficiency.fixerParallelReads,
  );
  // Opt-in agent-observation mode. Default zero preserves the cost-conscious
  // behavior where sufficiently grounded fixes may patch immediately.
  const minimumInspections = getFixerMinimumInspections(budgets);
  // Files whose FULL contents are already in the initial message. They are
  // removed from read tool schemas, so the model cannot waste a billed turn
  // requesting a deterministically unusable read.
  const hydratedFullFiles = new Set(
    input.initialSourceFiles
      .filter((file) => !file.truncated)
      .map((file) => path.normalize(file.path).split(path.sep).join("/")),
  );
  const readableFiles = input.fileTree
    .map((file) => path.normalize(file).split(path.sep).join("/"))
    .filter((file) => !hydratedFullFiles.has(file));
  // Fixed at run start: the tool list must be byte-identical on every turn.
  const readScopedTools =
    readableFiles.length === 0
      ? TOOLS.filter((tool) => tool.name !== "read_file" && tool.name !== "read_many")
      : readableFiles.length <= 200
        ? TOOLS.map((tool) => scopeReadToolPaths(tool, readableFiles))
        : TOOLS;
  const tools = efficiency.fixerRunCode
    ? [...readScopedTools, RUN_CODE_TOOL]
    : readScopedTools;

  const log = (message: string) => {
    console.log(`[${input.investigationId}] Fixer: ${message}`);
  };

  log(`Fixer budget profile: ${budgetProfile}`);
  if (minimumInspections > 0) {
    log(
      `Fixer inspection test mode: ${minimumInspections} successful inspection tool call(s) required before propose_patch.`,
    );
  }

  const agentDir = path.join(input.investigationDir, "fix-agent");
  const store = await createArtifactStore(input.investigationId, agentDir);
  await mkdir(path.join(agentDir, "tool-calls"), { recursive: true });
  await mkdir(path.join(agentDir, "run-code"), { recursive: true });

  const startedAt = Date.now();
  const counters = {
    turns: 0,
    readFile: 0,
    grep: 0,
    graph: 0,
    // fable/16 observability: batches and dense-tool usage.
    parallelBatches: 0,
    batchedReads: 0,
    readManyCalls: 0,
    filesReadThroughReadMany: 0,
    runCode: 0,
    runCodeTimeouts: 0,
    runCodeInvalidResults: 0,
    patchAttempts: 0,
    malformedPatchProposals: 0,
    duplicatePatchRejections: 0,
    successfulInspections: 0,
    evidenceBytes: 0,
  };

  const boundAndAccountEvidence = (
    text: string,
  ): { text: string; truncated: boolean } => {
    const remaining = Math.max(0, budgets.maxEvidenceBytes - counters.evidenceBytes);
    if (remaining === 0) {
      return {
        text: "Evidence budget exhausted — propose a patch or call submit_blocked.",
        truncated: true,
      };
    }

    const bounded = truncateUtf8Bytes(text, remaining);
    counters.evidenceBytes += Buffer.byteLength(bounded, "utf8");
    return { text: bounded, truncated: bounded !== text };
  };

  // Change 1: the accepted reproduction's evidence summary, computed once and
  // compared against every attempt's post-patch evidence.
  const beforeEvidence = summarizeReproductionEvidence(input.reproductionResult);

  // Change 3: duplicate-patch guard. Maps canonical edit hashes to a bounded
  // description of the prior failure. Seeded from memory (cross-run), then
  // extended with this run's real attempts.
  const failedPatchHashes = new Map<string, string>();

  for (const known of input.knownFailedProposals ?? []) {
    if (typeof known?.proposalHash === "string" && known.proposalHash) {
      failedPatchHashes.set(
        known.proposalHash,
        `a patch that failed in a previous investigation of this issue: ${truncateUtf8Bytes(redactSecrets(known.failureReason ?? "(no reason recorded)"), 500)}`,
      );
    }
  }
  const attempts: FixerAgentAttempt[] = [];
  const transcript: unknown[] = [];

  let toolCallIndex = 0;
  let lastAttempt: FixAttemptResult | null = null;
  let nudged = false;

  // Compaction: per-task override first, then the resolved efficiency policy
  // (default ON, fable/16). Unchanged triggers (6 tool calls / 60KB).
  const compactor = createCompactor({
    enabled: input.compaction ?? efficiency.compaction,
    allowParallelToolCalls: parallelReads,
  });
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
            .map((attempt) =>
              [
                `- attempt ${attempt.index}: ${attempt.outcome ?? "?"} — ${(attempt.reason ?? "").slice(0, 200)}`,
                `  before: ${truncateUtf8Bytes(beforeEvidence.signature, 200)}`,
                `  after: ${attempt.failureSignature ? truncateUtf8Bytes(attempt.failureSignature, 200) : "(replay not reached or verified)"}`,
                `  changed: ${attempt.failureSignature ? (attempt.failureSignature === beforeEvidence.signature ? "no" : "yes") : "n/a"}`,
                `  files: ${(attempt.changedFiles ?? []).join(", ") || "none"}`,
              ].join("\n"),
            )
            .join("\n")}`
        : "No patch attempts yet.",
      lastVerifierFeedback ? `Latest verifier feedback:\n${lastVerifierFeedback}` : "",
      lastAssistantText ? `Your last stated reasoning:\n${lastAssistantText.slice(0, 600)}` : "",
      `Remaining budgets: ${budgets.maxModelTurns - counters.turns} model turn(s), ${Math.max(0, budgets.maxReadFileCalls - counters.readFile)} read_file, ${Math.max(0, budgets.maxGrepCalls - counters.grep)} grep, ${Math.max(0, budgets.maxGraphCalls - counters.graph)} get_graph_neighbors${efficiency.fixerRunCode ? `, ${Math.max(0, budgets.maxRunCodeCalls - counters.runCode)} run_code` : ""}, ${budgets.maxPatchAttempts - counters.patchAttempts} patch attempt(s).`,
      minimumInspections > 0
        ? `Inspection test mode: ${counters.successfulInspections}/${minimumInspections} required successful inspection tool calls completed.`
        : "",
    ];

    return sections.filter(Boolean).join("\n\n");
  };

  // Executes one read-only inspection tool (read_file / grep /
  // get_graph_neighbors) with all existing gates and budget accounting.
  // Shared by the single-call path and the parallel-reads batch path so the
  // two paths can never drift.
  const executeInspectionToolCore = async (
    block: Anthropic.Messages.ToolUseBlock,
    accountEvidence = true,
  ): Promise<{ resultText: string; isError: boolean }> => {
    const inspectionGate = shouldBlockInspectionTool(block.name, counters, budgets);

    if (inspectionGate.blocked) {
      return { resultText: inspectionGate.reason, isError: true };
    }

    if (block.name === "read_file") {
      const requestedRaw = (block.input as { path?: unknown })?.path;
      const requestedNormalized =
        typeof requestedRaw === "string" && requestedRaw
          ? path.normalize(requestedRaw).split(path.sep).join("/")
          : null;

      if (requestedNormalized && hydratedFullFiles.has(requestedNormalized)) {
        // Deterministic redundancy gate: the full file is in the initial
        // context. Reject without consuming the read_file budget.
        return {
          resultText: `REDUNDANT read_file rejected: ${requestedNormalized} is already provided IN FULL in the initial context under "Selected source/config files with contents", and every non-verified patch is rolled back, so that content is still exact. Use it directly (including for verbatim oldText). If the evidence is sufficient, call propose_patch now.`,
          isError: true,
        };
      }

      counters.readFile += 1;
      if (counters.readFile > budgets.maxReadFileCalls) {
        return {
          resultText: "read_file budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }
      if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
        return {
          resultText: "Evidence budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }

      const readInput = block.input as {
        path?: unknown;
        startLine?: unknown;
        endLine?: unknown;
      };
      const lineRange = parseReadLineRange(readInput?.startLine, readInput?.endLine);
      const outcome = lineRange.ok
        ? await execReadFile(input.repoPath, readInput?.path, lineRange.range)
        : { ok: false, text: lineRange.error };
      if (outcome.ok && accountEvidence) {
        const bounded = boundAndAccountEvidence(outcome.text);
        return { resultText: bounded.text, isError: bounded.truncated };
      }
      return { resultText: outcome.text, isError: !outcome.ok };
    }

    // read_many (fable/16): several files in one call. Each returned file
    // consumes one read_file budget unit; the combined result is capped at
    // maxReadManyCallBytes with an explicit skipped-file report — never a
    // silent truncation of the set.
    if (block.name === "read_many") {
      const files = (block.input as { files?: unknown })?.files;

      if (!Array.isArray(files) || files.length < 1 || files.length > 8) {
        return {
          resultText:
            "read_many requires files: an array of 1-8 {path, startLine?, endLine?} entries.",
          isError: true,
        };
      }

      if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
        return {
          resultText: "Evidence budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }

      counters.readManyCalls += 1;

      const sections: string[] = [];
      const skipped: string[] = [];
      let totalBytes = 0;
      let returnedFiles = 0;

      for (const entry of files) {
        const item = (entry ?? {}) as { path?: unknown; startLine?: unknown; endLine?: unknown };
        const label = typeof item.path === "string" ? item.path : JSON.stringify(item.path);
        const normalized =
          typeof item.path === "string" && item.path
            ? path.normalize(item.path).split(path.sep).join("/")
            : null;

        if (normalized && hydratedFullFiles.has(normalized)) {
          // Redundancy gate, same as read_file: no budget consumed.
          skipped.push(
            `${label}: already provided IN FULL in the initial context — use that content directly.`,
          );
          continue;
        }

        if (counters.readFile >= budgets.maxReadFileCalls) {
          skipped.push(`${label}: read_file budget exhausted.`);
          continue;
        }

        const nestedExplorationGate = shouldBlockInspectionTool("read_file", counters, budgets);
        if (nestedExplorationGate.blocked) {
          skipped.push(`${label}: ${nestedExplorationGate.reason}`);
          continue;
        }

        if (accountEvidence && counters.evidenceBytes >= budgets.maxEvidenceBytes) {
          skipped.push(`${label}: evidence budget exhausted.`);
          continue;
        }

        counters.readFile += 1;

        const lineRange = parseReadLineRange(item.startLine, item.endLine);
        const outcome = lineRange.ok
          ? await execReadFile(input.repoPath, item.path, lineRange.range)
          : { ok: false, text: lineRange.error };

        if (!outcome.ok) {
          skipped.push(`${label}: ${firstLine(outcome.text)}`);
          continue;
        }

        const section = `=== ${label} ===\n${outcome.text}`;

        const perCallRemaining = budgets.maxReadManyCallBytes - totalBytes;
        const globalRemaining = accountEvidence
          ? budgets.maxEvidenceBytes - counters.evidenceBytes - totalBytes
          : Number.POSITIVE_INFINITY;
        const allowedBytes = Math.max(0, Math.min(perCallRemaining, globalRemaining));

        if (allowedBytes === 0 || Buffer.byteLength(section, "utf8") > allowedBytes) {
          skipped.push(
            `${label}: did not fit the remaining read_many/evidence byte budget (read it individually or with a narrower line range).`,
          );
          continue;
        }

        totalBytes += Buffer.byteLength(section, "utf8");
        returnedFiles += 1;
        counters.filesReadThroughReadMany += 1;
        sections.push(section);
      }

      const report =
        skipped.length > 0 ? `\n\nSKIPPED (${skipped.length}):\n${skipped.map((line) => `- ${line}`).join("\n")}` : "";
      const resultText = `${sections.join("\n\n") || "(no files returned)"}${report}`;

      if (accountEvidence) {
        const bounded = boundAndAccountEvidence(resultText);
        return {
          resultText: bounded.text,
          isError: returnedFiles === 0 || bounded.truncated,
        };
      }

      return { resultText, isError: returnedFiles === 0 };
    }

    if (block.name === "get_graph_neighbors") {
      counters.graph += 1;
      if (counters.graph > budgets.maxGraphCalls) {
        return {
          resultText:
            "get_graph_neighbors budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }
      if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
        return {
          resultText: "Evidence budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }

      const nodeRef = (block.input as { node?: unknown })?.node;
      const outcome =
        typeof nodeRef === "string"
          ? await queryGraphNeighbors(input.repoPath, nodeRef)
          : { ok: false, text: "get_graph_neighbors requires a string node reference." };
      if (outcome.ok && accountEvidence) {
        const bounded = boundAndAccountEvidence(outcome.text);
        return { resultText: bounded.text, isError: bounded.truncated };
      }
      return { resultText: outcome.text, isError: !outcome.ok };
    }

    if (block.name === "grep") {
      counters.grep += 1;
      if (counters.grep > budgets.maxGrepCalls) {
        return {
          resultText: "grep budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }
      if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
        return {
          resultText: "Evidence budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }

      const grepInput = block.input as {
        query?: unknown;
        glob?: unknown;
        contextLines?: unknown;
        filesOnly?: unknown;
      };
      const outcome = await execGrep(
        input.repoPath,
        grepInput?.query,
        typeof grepInput?.glob === "string" ? grepInput.glob : undefined,
        {
          contextLines:
            typeof grepInput?.contextLines === "number" ? grepInput.contextLines : undefined,
          filesOnly: grepInput?.filesOnly === true,
        },
      );
      if (outcome.ok && accountEvidence) {
        const bounded = boundAndAccountEvidence(outcome.text);
        return { resultText: bounded.text, isError: bounded.truncated };
      }
      return { resultText: outcome.text, isError: !outcome.ok };
    }

    // run_code (fable/16): Docker-only, read-only mount, no network. Never
    // reached from a parallel batch (not in READ_ONLY_FIXER_TOOLS).
    if (block.name === "run_code") {
      if (!efficiency.fixerRunCode) {
        return {
          resultText: "run_code is disabled for this investigation.",
          isError: true,
        };
      }

      counters.runCode += 1;

      if (counters.runCode > budgets.maxRunCodeCalls) {
        return {
          resultText: "run_code budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }

      if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
        return {
          resultText: "Evidence budget exhausted — propose a patch or call submit_blocked.",
          isError: true,
        };
      }

      const runInput = block.input as { script?: unknown; timeoutSeconds?: unknown };
      const rawArtifactHandle = `run-code/${String(counters.runCode).padStart(2, "0")}-raw.json`;
      const outcome = await executeRunCode({
        repoPath: input.repoPath,
        script: runInput?.script,
        timeoutSeconds: runInput?.timeoutSeconds,
        rawArtifactHandle,
      });

      if (outcome.timedOut) {
        counters.runCodeTimeouts += 1;
      }

      if (outcome.invalidResult) {
        counters.runCodeInvalidResults += 1;
      }

      // Full raw output goes to disk (redacted); the model sees only the
      // validated JSON or the structured error.
      await store.writeJson(rawArtifactHandle, {
        imageId: outcome.imageId,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        invalidResult: outcome.invalidResult,
        sanitizedCommand: outcome.sanitizedCommand,
        rawOutput: redactSecrets(outcome.rawOutput),
      });

      if (outcome.ok && accountEvidence) {
        const bounded = boundAndAccountEvidence(outcome.resultText);
        return { resultText: bounded.text, isError: bounded.truncated };
      }

      return { resultText: outcome.resultText, isError: !outcome.ok };
    }

    return { resultText: `Unknown tool "${block.name}".`, isError: true };
  };

  const executeInspectionTool = async (
    block: Anthropic.Messages.ToolUseBlock,
    accountEvidence = true,
  ): Promise<{ resultText: string; isError: boolean }> => {
    const outcome = await executeInspectionToolCore(block, accountEvidence);
    if (!outcome.isError) {
      counters.successfulInspections += 1;
    }
    return outcome;
  };

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildInitialMessage(input) },
  ];

  const finish = async (
    status: FixerAgentStatus,
    reason: string,
    fixAttempt: FixAttemptResult | null,
  ): Promise<FixerAgentResult> => {
    const failureCode = classifyFixerFailure(
      status,
      counters.patchAttempts,
      counters.malformedPatchProposals,
      counters.duplicatePatchRejections,
      fixAttempt,
    );
    const result: FixerAgentResult = {
      fixAttempt,
      status,
      reason,
      failureCode,
      attempts,
      turns: counters.turns,
      compactionEvents: compactor.events,
      efficiencyCounters: {
        parallelBatches: counters.parallelBatches,
        batchedReads: counters.batchedReads,
        readManyCalls: counters.readManyCalls,
        filesReadThroughReadMany: counters.filesReadThroughReadMany,
        runCodeCalls: counters.runCode,
        runCodeTimeouts: counters.runCodeTimeouts,
        runCodeInvalidResults: counters.runCodeInvalidResults,
        successfulInspections: counters.successfulInspections,
      },
    };
    transcript.push({ type: "final_result", status, reason, failureCode, attempts });
    await store.writeJson("transcript.json", transcript);
    await store.writeJson("summary.json", {
      status,
      reason,
      failureCode,
      attempts,
      fixAttemptId: fixAttempt?.fixAttemptId ?? null,
      fixOutcome: fixAttempt?.outcome ?? null,
      patchAttempts: counters.patchAttempts,
      readFile: counters.readFile,
      grep: counters.grep,
      graph: counters.graph,
      turns: counters.turns,
      counters,
      compactionEvents: compactor.events,
      durationMs: Date.now() - startedAt,
    });
    log(`finished: ${status} — ${reason}`);
    if (failureCode) {
      log(`failure code: ${failureCode}`);
    }
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
      input.abortSignal?.throwIfAborted();
      if (Date.now() - startedAt > budgets.maxWallTimeMs) {
        return await finish("exhausted", "Wall-time budget exhausted.", lastAttempt);
      }

      if (counters.turns >= budgets.maxModelTurns) {
        return await finish("exhausted", "Model turn budget exhausted.", lastAttempt);
      }

      counters.turns += 1;

      const forcePatchRevision =
        minimumInspections === 0 &&
        lastVerifierFeedback.includes("DETERMINISTIC DIAGNOSTIC:");

      // Snapshot: the params must not alias the mutable history array, so
      // recorded/injected createMessage implementations see a stable value.
      const message = await createMessage({
        model: MODEL,
        max_tokens: budgets.maxResponseTokens,
        system: buildSystemPrompt(budgets, {
          hydratedFullFiles: [...hydratedFullFiles],
          hasMemory: Boolean(input.pastInvestigations?.trim()),
          parallelReads,
          runCodeEnabled: efficiency.fixerRunCode,
          minimumInspections,
        }),
        tools,
        // Parallel reads (Phase 2, default OFF): when enabled, the model may
        // emit several READ-ONLY calls per turn under the tool-batch
        // contract; terminal/mutation tools must still be called alone.
        tool_choice: forcePatchRevision
          ? {
              type: "tool",
              name: "propose_patch",
              disable_parallel_tool_use: true,
            }
          : { type: "any", disable_parallel_tool_use: !parallelReads },
        messages: [...messages],
      });

      const toolUses = message.content.filter(
        (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
      );
      const toolUse = toolUses[0];

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
          {
            role: "user",
            content: parallelReads
              ? "Respond with tool calls only. Independent read-only inspections may be called in parallel; mutation and terminal tools must be called alone."
              : "Respond with exactly one tool call.",
          },
        );
        continue;
      }

      const textBlock = message.content.find(
        (block): block is Anthropic.Messages.TextBlock => block.type === "text",
      );

      if (textBlock?.text.trim()) {
        lastAssistantText = textBlock.text.trim();
      }

      // --- Parallel-reads batch path (Phase 2, flag-gated) -----------------
      // Multiple tool_use blocks reach here only when parallelReads is on
      // (disable_parallel_tool_use is set otherwise). Contract: every block
      // gets exactly one result in model order; only read-only tools execute,
      // concurrently; terminal/mutation calls in a batch are rejected
      // unexecuted with structured errors.
      if (toolUses.length > 1) {
        const plan = planToolBatch(toolUses);
        if (plan.fatalReason) {
          return await finish("failed", plan.fatalReason, lastAttempt);
        }
        counters.parallelBatches += 1;
        counters.batchedReads += plan.execute.length;
        const resultsById = new Map<string, { content: string; isError: boolean }>();

        transcript.push({
          type: "model_action_batch",
          turn: counters.turns,
          tools: toolUses.map((block) => block.name),
          rejected: plan.rejected.map((entry) => entry.block.name),
        });
        log(
          `turn ${counters.turns}: parallel batch [${toolUses.map((block) => block.name).join(", ")}]`,
        );

        await Promise.all(
          plan.execute.map(async (block) => {
            const outcome = await executeInspectionTool(block, false);
            resultsById.set(block.id, {
              content: outcome.resultText,
              isError: outcome.isError,
            });
            await recordToolCall(block.name, block.input, outcome.resultText);
            factLog.push(
              `${block.name} ${JSON.stringify(block.input).slice(0, 160)} -> ${outcome.isError ? `error: ${firstLine(outcome.resultText)}` : `ok (${outcome.resultText.length} bytes)`}`,
            );
          }),
        );

        // Apply the shared evidence cap after concurrent reads complete, in
        // model order. No sibling can race past the global byte budget.
        for (const block of plan.execute) {
          const outcome = resultsById.get(block.id);
          if (!outcome || outcome.isError) continue;
          const remaining = Math.max(0, budgets.maxEvidenceBytes - counters.evidenceBytes);
          if (remaining === 0) {
            resultsById.set(block.id, {
              content: "Evidence budget exhausted — propose a patch or call submit_blocked.",
              isError: true,
            });
            continue;
          }
          const bounded = truncateUtf8Bytes(outcome.content, remaining);
          counters.evidenceBytes += Buffer.byteLength(bounded, "utf8");
          resultsById.set(block.id, {
            content: bounded,
            isError: bounded !== outcome.content,
          });
        }

        for (const entry of plan.rejected) {
          if (!resultsById.has(entry.block.id)) {
            resultsById.set(entry.block.id, { content: entry.reason, isError: true });
          } else {
            resultsById.set(`${entry.block.id}#dup`, { content: entry.reason, isError: true });
          }
          await recordToolCall(entry.block.name, entry.block.input, entry.reason);
        }

        const batchResults = assembleBatchResults(toolUses, resultsById);

        messages.push(
          { role: "assistant", content: message.content },
          { role: "user", content: batchResults },
        );

        const batchBytes = batchResults.reduce(
          (total, block) => total + (typeof block.content === "string" ? block.content.length : 0),
          0,
        );
        compactor.record(batchBytes);

        if (compactor.maybeCompact(messages, buildStateSummary)) {
          transcript.push({ type: "compaction", turn: counters.turns, event: compactor.events });
          log(`compaction event ${compactor.events}: old history replaced with state summary.`);
        }

        continue;
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
        if (counters.successfulInspections < minimumInspections) {
          const remaining = minimumInspections - counters.successfulInspections;
          const feedback = `INSPECTION TEST MODE: propose_patch is temporarily blocked until ${remaining} more successful inspection tool call(s) complete. Use read_file/read_many/grep/get_graph_neighbors${efficiency.fixerRunCode ? "/run_code" : ""} to inspect a concrete unknown, then propose the patch.`;
          await recordToolCall("propose_patch", "(blocked by inspection test mode)", feedback);
          transcript.push({
            type: "proposal_blocked_minimum_inspections",
            turn: counters.turns,
            completed: counters.successfulInspections,
            required: minimumInspections,
          });
          messages.push(
            { role: "assistant", content: message.content },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: feedback,
                  is_error: true,
                },
              ],
            },
          );
          compactor.record(Buffer.byteLength(feedback, "utf8"));
          continue;
        }

        const proposal = {
          version: FIX_PROPOSAL_VERSION,
          ...(toolUse.input as Record<string, unknown>),
        };
        const repairedProposal = repairMalformedProposal(proposal);
        const shape = validateFixProposalShape(repairedProposal);

        if (!shape.ok) {
          counters.malformedPatchProposals += 1;
          const feedback = formatProposalShapeError(shape.errors, repairedProposal);
          await recordToolCall("propose_patch", proposal, feedback);
          transcript.push({
            type: "proposal_format_invalid",
            turn: counters.turns,
            errors: shape.errors,
          });

          if (counters.malformedPatchProposals >= 2) {
            return await finish(
              "failed",
              `The model produced invalid propose_patch input twice: ${shape.errors.join(" ")}`,
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
                  content: feedback,
                  is_error: true,
                },
              ],
            },
          );
          continue;
        }

        // Change 3: deterministic duplicate-patch guard. Identical file edits
        // (canonically hashed) never reach verification twice — no restart,
        // no replay, no consumed patch attempt. Memory-seeded hashes reject
        // known cross-run failures on their first submission.
        const proposalHash = hashFixProposalEdits(shape.proposal);
        const priorFailure = failedPatchHashes.get(proposalHash);

        if (priorFailure) {
          counters.duplicatePatchRejections += 1;

          const rejection = `REJECTED without verification: these file edits are identical to ${priorFailure}. Propose materially different edits or call submit_blocked.`;
          await recordToolCall("propose_patch", shape.proposal, rejection);
          transcript.push({
            type: "duplicate_patch_rejected",
            turn: counters.turns,
            proposalHash,
            rejections: counters.duplicatePatchRejections,
          });
          log(
            `duplicate patch rejected (${counters.duplicatePatchRejections}): hash ${proposalHash.slice(0, 12)}`,
          );

          if (counters.duplicatePatchRejections >= 3) {
            return await finish(
              "failed",
              "The model resubmitted identical file edits three times despite rejection feedback.",
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
                  content: rejection,
                  is_error: true,
                },
              ],
            },
          );
          continue;
        }

        counters.patchAttempts += 1;

        const attempt = await verify({
          investigationId: input.investigationId,
          investigationDir: input.investigationDir,
          repoPath: input.repoPath,
          sourceCommit: input.sourceCommit,
          plan: input.plan,
          originalOutcome: input.reproductionResult.outcome,
          reproductionResult: input.reproductionResult,
          proposal: shape.proposal,
          restart: input.restart,
          repositoryLabel: input.repositoryLabel,
          appNetwork: input.appNetwork ?? null,
          generateRegressionTest: input.buildRegressionTestGenerator
            ? input.buildRegressionTestGenerator(shape.proposal)
            : null,
        });

        lastAttempt = attempt;
        attempts.push({
          index: counters.patchAttempts,
          fixAttemptId: attempt.fixAttemptId,
          attemptDir: attempt.attemptDir,
          outcome: attempt.outcome,
          reason: attempt.reason,
          changedFiles: attempt.changedFiles,
          proposalSummary: shape.proposal.summary,
          proposalHash,
          failureSignature:
            attempt.outcome === "verified"
              ? null
              : (attempt.postPatchEvidence?.signature ?? null),
        });
        transcript.push({
          type: "fix_attempt",
          turn: counters.turns,
          fixAttemptId: attempt.fixAttemptId,
          outcome: attempt.outcome,
          reason: attempt.reason,
          changedFiles: attempt.changedFiles,
          proposalHash,
        });
        log(`patch attempt ${counters.patchAttempts}: ${attempt.outcome}`);

        if (attempt.outcome !== "verified") {
          failedPatchHashes.set(
            proposalHash,
            `attempt ${counters.patchAttempts}, which failed with ${truncateUtf8Bytes(attempt.reason, 500)}`,
          );
        }

        const feedback = formatAttemptFeedback(
          attempt,
          beforeEvidence,
          budgets.maxAttemptFeedbackBytes,
        );
        await recordToolCall("propose_patch", shape.proposal, feedback);

        if (attempt.outcome === "verified") {
          input.abortSignal?.throwIfAborted();
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
      const executed = await executeInspectionTool(toolUse);
      resultText = executed.resultText;
      isError = executed.isError;

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

function parseReadLineRange(
  startLine: unknown,
  endLine: unknown,
): { ok: true; range: { startLine?: number; endLine?: number } } | { ok: false; error: string } {
  if (typeof startLine === "string" && endLine === undefined) {
    const pair = startLine.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);

    if (pair) {
      return {
        ok: true,
        range: { startLine: Number(pair[1]), endLine: Number(pair[2]) },
      };
    }
  }

  const start = parseOptionalLineNumber(startLine, "startLine");
  if (!start.ok) return start;

  const end = parseOptionalLineNumber(endLine, "endLine");
  if (!end.ok) return end;

  return { ok: true, range: { startLine: start.value, endLine: end.value } };
}

function parseOptionalLineNumber(
  value: unknown,
  label: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true };
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\s*\d+\s*$/.test(value)
        ? Number(value.trim())
        : NaN;

  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      error: `read_file ${label} must be a positive integer. Use {"startLine": 88, "endLine": 116}, not ${JSON.stringify(value)}.`,
    };
  }

  return { ok: true, value: parsed };
}

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

type GrepOptions = {
  // Lines of context around each match (0-5, default 2). Overlapping or
  // adjacent context windows within one file are merged and deduplicated.
  contextLines?: number;
  // Return only matching file paths with match counts (cheap breadth scan).
  filesOnly?: boolean;
};

// Hard bail on pathological queries: matches are still COUNTED (for the
// explicit omission report) after output caps are hit, but never past this.
const MAX_GREP_COUNTED_MATCHES = 10_000;

async function execGrep(
  repoPath: string,
  query: unknown,
  glob: string | undefined,
  options: GrepOptions = {},
): Promise<ToolOutcome> {
  if (typeof query !== "string" || !query) {
    return { ok: false, text: "grep requires a non-empty string query." };
  }

  const contextLines =
    options.filesOnly === true
      ? 0
      : Math.min(5, Math.max(0, Math.floor(options.contextLines ?? 2)));

  let pattern: RegExp;

  try {
    pattern = new RegExp(query);
  } catch {
    pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }

  const globPattern = glob ? globToRegExp(glob) : null;
  const globOnBasename = glob ? !glob.includes("/") : false;
  const repoRoot = path.resolve(repoPath);

  const outputLines: string[] = [];
  let outputBytes = 0;
  let outputFull = false;
  // Totals continue past the output caps so omissions are reported, not
  // silently dropped (fable/16).
  let totalMatches = 0;
  let totalMatchedFiles = 0;
  let emittedMatches = 0;
  const emittedFiles = new Set<string>();
  let countingBailed = false;

  const pushOutput = (line: string): boolean => {
    if (outputFull) {
      return false;
    }

    if (
      outputLines.length >= FIXER_BUDGETS.maxGrepLines ||
      outputBytes + line.length > FIXER_BUDGETS.maxGrepBytes
    ) {
      outputFull = true;
      return false;
    }

    outputLines.push(line);
    outputBytes += line.length + 1;
    return true;
  };

  const walk = async (dir: string): Promise<void> => {
    if (countingBailed) {
      return;
    }

    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (countingBailed) {
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
      const matchIndexes: number[] = [];

      for (let index = 0; index < fileLines.length; index += 1) {
        if (pattern.test(fileLines[index])) {
          matchIndexes.push(index);
          totalMatches += 1;

          if (totalMatches >= MAX_GREP_COUNTED_MATCHES) {
            countingBailed = true;
            break;
          }
        }
      }

      if (matchIndexes.length === 0) {
        continue;
      }

      totalMatchedFiles += 1;

      if (options.filesOnly === true) {
        if (pushOutput(`${relative} (${matchIndexes.length} match${matchIndexes.length === 1 ? "" : "es"})`)) {
          emittedFiles.add(relative);
          emittedMatches += matchIndexes.length;
        }
        continue;
      }

      if (outputFull) {
        continue; // Keep counting totals; emit nothing further.
      }

      // Merge overlapping/adjacent context windows into ranges so shared
      // context lines are never duplicated.
      const matchSet = new Set(matchIndexes);
      const ranges: Array<{ start: number; end: number }> = [];

      for (const index of matchIndexes) {
        const start = Math.max(0, index - contextLines);
        const end = Math.min(fileLines.length - 1, index + contextLines);
        const last = ranges[ranges.length - 1];

        if (last && start <= last.end + 1) {
          last.end = Math.max(last.end, end);
        } else {
          ranges.push({ start, end });
        }
      }

      for (const range of ranges) {
        if (outputFull) {
          break;
        }

        for (let index = range.start; index <= range.end; index += 1) {
          const isMatch = matchSet.has(index);
          const line = isMatch
            ? `${relative}:${index + 1}: ${fileLines[index].slice(0, 300)}`
            : `${relative}-${index + 1}- ${fileLines[index].slice(0, 300)}`;

          if (!pushOutput(line)) {
            break;
          }

          if (isMatch) {
            emittedMatches += 1;
            emittedFiles.add(relative);
          }
        }

        if (!outputFull && ranges.length > 1 && range !== ranges[ranges.length - 1]) {
          pushOutput("--");
        }
      }
    }
  };

  await walk(repoRoot);

  if (totalMatches === 0) {
    return { ok: true, text: "(no matches)" };
  }

  const omittedMatches = Math.max(0, totalMatches - emittedMatches);
  const omittedFiles = Math.max(0, totalMatchedFiles - emittedFiles.size);
  const footer: string[] = [];

  if (omittedMatches > 0 || omittedFiles > 0 || countingBailed) {
    footer.push(
      `[OUTPUT CAPPED: showing ${options.filesOnly ? emittedFiles.size : emittedMatches}${options.filesOnly ? ` of ${totalMatchedFiles} matching files` : ` of ${totalMatches}${countingBailed ? "+" : ""} matches`}; omitted ${omittedMatches}${countingBailed ? "+" : ""} match(es) in ${omittedFiles} additional file(s). Narrow the query or glob, or use filesOnly.]`,
    );
  }

  return {
    ok: true,
    text: [outputLines.join("\n"), ...footer].filter(Boolean).join("\n"),
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

type SystemPromptContext = {
  hydratedFullFiles: string[];
  hasMemory: boolean;
  parallelReads: boolean;
  runCodeEnabled: boolean;
  minimumInspections: number;
};

const buildSystemPrompt = (
  budgets: FixerBudgets,
  context: SystemPromptContext,
) => `You are Sherlock's fixer agent. A bug has already been deterministically reproduced in an isolated workspace; your job is to find the root cause and land the smallest safe fix.

What you CAN do:
- read_file, read_many, grep, get_graph_neighbors — ONLY to obtain a specific missing fact that blocks patching. read_many returns up to 8 files in one call (each costs one read_file budget unit): use it instead of several read_file calls when you already know which files you need. Example: read_many {"files": [{"path": "src/api/tasks.js"}, {"path": "src/store.js", "startLine": 40, "endLine": 90}]} answers in one turn what two read_file turns would. grep accepts contextLines (default 2) so a single search returns enough surrounding code to act on — example: grep {"query": "writeTaskList\\\\(", "contextLines": 3} shows every call site with its context; add filesOnly: true first when you only need to locate files.
${context.runCodeEnabled ? `- run_code — ONE read-only POSIX shell script in an isolated container (repo at /app, git + ripgrep available, no network). For broad exploration on large repos, prefer one script that greps/finds/filters and prints a distilled JSON conclusion over many separate model turns — but use the ordinary tools when each next step genuinely depends on reasoning over the prior result. Print conclusions with short cited excerpts, never raw file dumps.\n` : ""}- propose_patch — as soon as you can state a plausible minimal change. This is your primary move.
- submit_blocked — when a safe fix is impossible with the available evidence and attempts.
${context.parallelReads ? `\nParallel reads: when you need several independent facts (files, searches, graph lookups) and none depends on another's result, request them ALL in one response as multiple tool calls — each still consumes its own budget, but you spend one turn instead of several. Mutation and terminal tools (propose_patch, submit_blocked${context.runCodeEnabled ? ", run_code" : ""}) must always be called alone.\n` : ""}

What you CANNOT do:
- You cannot re-read files whose FULL contents are already in the initial context. ${context.hydratedFullFiles.length > 0 ? `These files are fully provided and read_file on them is REJECTED automatically: ${context.hydratedFullFiles.join(", ")}. Their contents in the initial message are exact and stay exact (non-verified patches are rolled back) — copy oldText verbatim from there.` : "(No fully hydrated files this run.)"}
- You cannot use tools to look around, confirm generally, build confidence, or rediscover anything already present in the provided evidence, hydrated files, graph context, or past investigations.
- You cannot declare success — only the deterministic verifier can.

Rules:
${context.minimumInspections > 0 ? `- INSPECTION TEST MODE: before propose_patch is accepted, complete at least ${context.minimumInspections} successful inspection tool calls. This temporary test setting overrides the normal instruction to patch immediately; make each inspection answer a concrete question and do not waste calls.\n` : ""}- You already receive the reproduced failure, assertion result, observed evidence, Graphify-ranked context, hydrated source files, and${context.hasMemory ? "" : " (this run: none matched)"} PAST INVESTIGATIONS memory. Treat all of it as evidence, not background noise.
${context.hasMemory ? `- MEMORY FIRST: if a PAST INVESTIGATIONS entry is a verified fix for this same issue and its diff is not marked STALE, adapt that diff and call propose_patch on your FIRST turn — zero exploration calls. If it is marked STALE, verify only the changed region, then patch.\n` : ""}- Before calling any non-patch tool, decide what exact fact is missing, whether it is already present in the provided evidence, how the result will change your patch, and whether you can patch now without it. If you can patch now, patch now.
- A non-patch tool call is allowed only when it answers a concrete unknown that blocks patching.
- Your goal is not to maximize certainty. Your goal is to make the smallest defensible patch once the evidence is sufficient. Extra tool calls are harmful unless they remove a specific blocker to patching.
- If the reproduction evidence names a concrete function and the hydrated context includes that function, propose a patch within the next 1-2 turns.
- Inspect files with read_file and grep only when exact edit context or symbol location is missing AND the file is not fully hydrated. The provided graph context is a map, not the territory — when evidence is missing, read files; never guess.
- For structural questions ("who calls X", "what does this handler import"), prefer get_graph_neighbors over grep: it returns real call/import edges with confidence tags. Follow a NODE line's file:line pointer with a ranged read_file to read just that span.
- Propose the smallest patch that fixes the root cause. No refactors, no new files.
- Each oldText must appear EXACTLY ONCE in the target file, copied verbatim including whitespace.
- Change at most ${PATCH_LIMITS.maxChangedFiles} files and ${PATCH_LIMITS.maxChangedLines} lines. Never touch .env files, keys, lockfiles, GitHub workflows, or deployment configuration. Violations waste a patch attempt.
- Never modify UI text, roles, labels, placeholders, or testids referenced by the saved reproduction plan — the EXACT plan is replayed after every patch, and changing those strings breaks verification.
- relevantTests must be plain npm/npx/node commands (no shell operators); use an empty array if the repository has no runnable tests.
- propose_patch runs the full deterministic verification (safety validation, apply, restart, exact replay, tests) and returns the result. Only that verifier decides success — a failed attempt is rolled back and you receive the evidence. You have at most ${budgets.maxPatchAttempts} patch attempts; revise using the returned evidence.
- When calling propose_patch, provide normal JSON tool fields only. Do not include XML tags, pseudo-tool markup, closing tags, or <parameter ...> text inside string fields.
- propose_patch.confidence must be a top-level numeric field between 0 and 1, for example confidence: 0.85. Never write confidence inside rootCause or any other string field.
- propose_patch.rootCause must contain only the root-cause explanation. It must not contain markup such as </rootCause> or <parameter name="confidence">0.85.
- You have at most ${budgets.maxExplorationBeforeFirstPatch} non-patch tool calls before the first patch attempt. If that exploration budget is exhausted, only propose_patch or submit_blocked is allowed.
- If ${budgets.maxModelTurns - 2} model turns have passed and no patch has been proposed, only propose_patch or submit_blocked is allowed.
- If a safe fix is not possible, call submit_blocked with a clear reason.
${context.parallelReads ? "- Respond with tool calls only: one call per turn, or several READ-ONLY calls (read_file/read_many/grep/get_graph_neighbors) batched in one response when they are independent." : "- Respond with exactly one tool call per turn."}`;

type FixerCounters = {
  turns: number;
  readFile: number;
  grep: number;
  graph: number;
  runCode: number;
  patchAttempts: number;
};

const EXPLORATION_BUDGET_EXHAUSTED =
  "Exploration budget exhausted. You must now call propose_patch or submit_blocked.";

function shouldBlockInspectionTool(
  toolName: string,
  counters: FixerCounters,
  budgets: FixerBudgets,
): { blocked: true; reason: string } | { blocked: false } {
  if (
    !["read_file", "read_many", "grep", "get_graph_neighbors", "run_code"].includes(toolName)
  ) {
    return { blocked: false };
  }

  if (counters.patchAttempts > 0) {
    return { blocked: false };
  }

  const explorationCalls =
    counters.readFile + counters.grep + counters.graph + counters.runCode;
  const remainingTurns = budgets.maxModelTurns - counters.turns;

  if (
    explorationCalls >= budgets.maxExplorationBeforeFirstPatch ||
    remainingTurns <= 2
  ) {
    return { blocked: true, reason: EXPLORATION_BUDGET_EXHAUSTED };
  }

  return { blocked: false };
}

function classifyFixerFailure(
  status: FixerAgentStatus,
  patchAttempts: number,
  malformedPatchProposals: number,
  duplicatePatchRejections: number,
  fixAttempt: FixAttemptResult | null,
): FixerFailureCode | null {
  if (status === "verified" || fixAttempt?.outcome === "verified") {
    return null;
  }

  if (status === "failed" && duplicatePatchRejections >= 3) {
    return "fixer_repeated_patch";
  }

  if (malformedPatchProposals > 0 && patchAttempts === 0 && status === "failed") {
    return "proposal_format_invalid";
  }

  if (
    patchAttempts === 0 &&
    (status === "exhausted" || status === "blocked" || status === "failed")
  ) {
    return "fixer_no_patch_attempt";
  }

  if (fixAttempt?.outcome === "rejected_patch_invalid") {
    return "fixer_patch_rejected_safety";
  }

  if (fixAttempt?.outcome === "rejected_tests_failed") {
    return "fixer_patch_failed_tests";
  }

  if (patchAttempts > 0 && (status === "exhausted" || status === "failed")) {
    return "fixer_patch_failed_verification";
  }

  return null;
}

function repairMalformedProposal(proposal: Record<string, unknown>): Record<string, unknown> {
  if (typeof proposal.confidence === "number" || typeof proposal.rootCause !== "string") {
    return proposal;
  }

  const match = proposal.rootCause.match(/<parameter\s+name=["']confidence["']>\s*([01](?:\.\d+)?)/i);

  if (!match) {
    return proposal;
  }

  const confidence = Number(match[1]);

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return proposal;
  }

  return {
    ...proposal,
    confidence,
    rootCause: proposal.rootCause
      .replace(/<\/rootCause>/gi, "")
      .replace(/<parameter\s+name=["']confidence["']>\s*[01](?:\.\d+)?/gi, "")
      .replace(/<\/parameter>/gi, "")
      .trim(),
  };
}

function formatProposalShapeError(
  errors: string[],
  proposal: Record<string, unknown>,
): string {
  const rootCause = typeof proposal.rootCause === "string" ? proposal.rootCause : "";
  const placedConfidenceInRootCause =
    /<parameter\s+name=["']confidence["']>/i.test(rootCause) ||
    /<\/rootCause>/i.test(rootCause);

  return [
    placedConfidenceInRootCause
      ? "Invalid propose_patch input: confidence must be a top-level number between 0 and 1. You placed confidence or tool markup inside rootCause. Retry propose_patch with the same patch and valid fields."
      : "Invalid propose_patch input. Retry propose_patch with valid top-level fields.",
    `Validation errors: ${errors.join(" ")}`,
    "Do not call read_file, grep, or get_graph_neighbors just to fix proposal formatting.",
  ].join("\n");
}

function formatFixerMemorySection(pastInvestigations: string | undefined): string {
  if (!pastInvestigations?.trim()) {
    return "";
  }

  return `
PAST INVESTIGATIONS (this repo — READ BEFORE ANY TOOL CALL):

${pastInvestigations}

How you MUST use these:
- If a verified entry matches this issue and includes a fix diff with patched
  files marked UNCHANGED, that diff IS the fix. Adapt it into propose_patch on
  your FIRST turn. Do not re-derive the root cause with read_file, grep, or
  get_graph_neighbors first.
- If the diff is marked STALE, use it as a strong starting hypothesis: read
  only the changed region of the patched file(s), then patch.
- A verified, non-stale fix diff is strong evidence and may be reapplied.
- An ALREADY TRIED AND FAILED diff is a falsified historical approach — not
  proof that every related approach is wrong.
- A patch whose file edits exactly match a listed proposal hash will be
  REJECTED automatically without verification. Do not resubmit it.
- A materially different patch may revisit the same area only when current
  evidence explains why it differs from the recorded failure.
- Treat "blocked"/"failed" entries as approaches that already failed — do not
  repeat them unchanged.
`;
}

// Change 4: bounded live-exploration hints. Only rendered when the reproducer
// agent actually ran; never elevated above the deterministic replay.
function formatReproducerFindingsSection(
  findings: ReproducerFinding[] | undefined,
): string {
  if (!findings || findings.length === 0) {
    return "";
  }

  const header = [
    "",
    "REPRODUCER EXPLORATION HINTS",
    "These observations came from live exploration before the accepted clean replay.",
    "Use them as bounded hints. They are not proof and must not override the accepted plan or official replay result.",
    "",
  ].join("\n");
  const bodyBudget = Math.max(
    0,
    MAX_RENDERED_REPRODUCER_FINDINGS_BYTES - Buffer.byteLength(`${header}\n`, "utf8"),
  );

  let body = "";

  for (const finding of findings) {
    const line = `- [${finding.kind}/${finding.sourceTool}] ${finding.observation}\n`;

    if (
      Buffer.byteLength(body + line, "utf8") > bodyBudget
    ) {
      break;
    }

    body += line;
  }

  return body
    ? truncateUtf8Bytes(`${header}\n${body}`, MAX_RENDERED_REPRODUCER_FINDINGS_BYTES)
    : "";
}

function buildInitialMessage(input: FixerAgentInput): string {
  const result = input.reproductionResult;

  return `A bug was reproduced. Investigate and fix it.

Repository commit: ${input.sourceCommit}
${formatFixerMemorySection(input.pastInvestigations)}${formatReproducerFindingsSection(input.reproducerFindings)}

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

// Change 1b: retry feedback with an explicit PRE/POST evidence delta. Uses
// the active run's byte budget (never the global FIXER_BUDGETS alias).
// Truncation priority: outcome/reason and signature lines always survive;
// delta detail lines, then checks/files/tests, are dropped first.
function formatAttemptFeedback(
  attempt: FixAttemptResult,
  beforeEvidence: ReproductionEvidenceSummary,
  maxBytes: number,
): string {
  const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

  const head = [
    `Verification outcome: ${attempt.outcome}`,
    `Reason: ${truncateUtf8Bytes(attempt.reason, 600)}`,
  ].join("\n");

  // Delta core (signature lines) is never trimmed by the tail sections; the
  // delta formatter itself only trims its detail lines to fit its sub-budget.
  const deltaBudget = Math.min(2_048, Math.max(0, maxBytes - byteLength(head) - 2));
  const delta = attempt.postPatchEvidence
    ? formatReproductionEvidenceDelta(
        beforeEvidence,
        attempt.postPatchEvidence,
        deltaBudget,
      )
    : "EVIDENCE DELTA\nPost-patch replay not reached (the patch was rejected before replay).";

  const failedChecks = attempt.checks
    .filter((item) => item.status === "failed")
    .map((item) => `  ${item.name}: ${item.detail}`);

  const observed = attempt.postPatchEvidence?.assertion?.observed ?? "";
  const deterministicDiagnostic =
    /"items"\s*:\s*\[\s*\]/.test(observed) &&
    /"total"\s*:\s*[1-9]\d*/.test(observed)
      ? "DETERMINISTIC DIAGNOSTIC: the response reports total > 0 while items is empty. Filtering matched records, but pagination/slicing removed them; revise the patch directly around page offset/index handling. This is the root-cause discriminator—do not re-read hydrated files or perform generic searches."
      : null;

  const tail = [
    deterministicDiagnostic,
    failedChecks.length > 0 ? `Failed checks:\n${failedChecks.join("\n")}` : "Failed checks: (none)",
    `Changed files: ${attempt.changedFiles.join(", ") || "(none)"}`,
    `Post-patch replay outcome: ${attempt.postPatchOutcome ?? "(replay not reached)"}`,
    attempt.testRuns.length > 0
      ? `Tests:\n${attempt.testRuns.map((run) => `  ${run.command} -> exit ${run.exitCode}${run.timedOut ? " (timed out)" : ""}`).join("\n")}`
      : "Tests: (none run)",
  ];

  let text = `${head}\n\n${delta}`;

  for (const section of tail.filter((item): item is string => item !== null)) {
    const candidate = `${text}\n${section}`;

    if (byteLength(candidate) > maxBytes) {
      break;
    }

    text = candidate;
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
