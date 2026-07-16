// Bounded tool-using reproducer agent (docs/fable/11).
//
// Plan AUTHORING is agentic: the model drives a real browser/API session
// against the live sandbox and observes actual outcomes. The REPRODUCED
// VERDICT is deterministic: a submitted plan is validated by
// validateReproductionPlan() and replayed FROM SCRATCH by
// executeReproductionPlan() against a pristine workspace and restarted
// sandbox. Only that clean replay can mark the issue "reproduced" - the
// model's live observations count for nothing until the frozen plan
// reproduces on its own.
//
// Loop conventions mirror backend/agents/fixer.ts: native tool use, one tool
// call per turn, per-call message snapshots, one nudge on a non-tool
// response, injectable deps, full artifact transcript, hard budgets.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { createCompactor } from "./compaction.js";
import {
  createArtifactStore,
  rebaseExecutionArtifactPaths,
} from "../services/artifacts.js";
import {
  MODEL,
  formatGraphSection,
  formatPastSection,
} from "../services/claude.js";
import { runInference, type InferenceTelemetry } from "../services/inference.js";
import type { RestartResult } from "../services/fix.js";
import type { GraphContext } from "../services/graphContext.js";
import {
  REPRODUCTION_PLAN_VERSION,
  getPlanMode,
  hashPlanBehavior,
  validateReproductionPlan,
  validateStep,
  type PlanMode,
  type ReproductionPlan,
  type ReproductionStep,
} from "../services/plan.js";
import {
  computeReproducerDivergence,
  formatReproducerDivergence,
  hasDivergence,
  type ReproducerDivergence,
} from "../services/reproduction-divergence.js";
import {
  executeReproductionPlan,
  openLiveSession,
  type LiveSession,
  type ReproductionResult,
  type StepRecord,
} from "../services/playwright.js";
import type { SourceFile } from "../services/repo.js";
import { redactSecrets } from "../services/report.js";
import {
  summarizeReproductionEvidence,
  truncateUtf8Bytes,
  type ReproductionEvidenceSummary,
} from "../services/reproduction-evidence.js";
import type { CreateModelMessage } from "./fixer.js";

const execFileAsync = promisify(execFile);

// --- Budgets (docs/fable/11) --------------------------------------------------
//
// Two profiles: cost-conscious "standard" (default) and quality-oriented
// "deep" behind SHERLOCK_DEEP_INVESTIGATION=true. Every tool call consumes a
// model turn, so maxModelTurns must cover the plausible tool-call budget plus
// terminal turns. First-pass numbers — tune from cost-shape.json.

// Limits shared by both profiles (safety caps, not cost knobs).
const REPRODUCER_SHARED_LIMITS = {
  maxWallTimeMs: 10 * 60_000,
  maxResponseTokens: 4_000,
  // Per read_page result.
  maxDigestBytes: 16 * 1024,
  // Cumulative tool-result bytes returned to the model.
  maxEvidenceBytes: 300 * 1024,
};

export const STANDARD_REPRODUCER_BUDGETS = {
  ...REPRODUCER_SHARED_LIMITS,
  maxModelTurns: 16,
  maxBrowserActions: 8, // goto/click/fill/wait combined
  maxRequestCalls: 8,
  maxReadPageCalls: 5,
  maxPlanSubmissions: 2, // invalid submissions count
};

export const DEEP_REPRODUCER_BUDGETS = {
  ...REPRODUCER_SHARED_LIMITS,
  maxModelTurns: 40,
  maxBrowserActions: 30,
  maxRequestCalls: 15,
  maxReadPageCalls: 15,
  maxPlanSubmissions: 3,
};

export type ReproducerBudgets = typeof STANDARD_REPRODUCER_BUDGETS;

// Stable alias for existing imports; the agent runtime selects a profile via
// getReproducerBudgets() at run start instead of using this directly.
export const REPRODUCER_BUDGETS = STANDARD_REPRODUCER_BUDGETS;

export function getBudgetProfileName(): "standard" | "deep" {
  return process.env.SHERLOCK_DEEP_INVESTIGATION === "true" ? "deep" : "standard";
}

export function getReproducerBudgets(): ReproducerBudgets {
  return getBudgetProfileName() === "deep"
    ? DEEP_REPRODUCER_BUDGETS
    : STANDARD_REPRODUCER_BUDGETS;
}

// --- Public interface -----------------------------------------------------------

export type ReproducerAgentInput = {
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
  graphContext: GraphContext;
  initialSourceFiles: SourceFile[];
  pastInvestigations: string;
  abortSignal?: AbortSignal;
  // Plan-behavior hashes that failed to reproduce in PREVIOUS investigations
  // of this issue (from memory failedPlans). COMMIT-SCOPED: the guard only
  // blocks a hash whose recorded commitSha equals the current sourceCommit —
  // an old failure on a different commit informs (via rendered memory) but
  // never blocks.
  knownFailedPlans?: Array<{
    planHash: string;
    commitSha: string;
    failureReason: string;
  }>;
  // Restart the sandbox (fresh container) and return the new base URL.
  restart: () => Promise<RestartResult>;
  // Inference telemetry (FABLE_IMPLEMENTATION_PROMPT.md Phase 1.1). Optional:
  // absent means calls run untelemetered, exactly as before the gateway.
  telemetry?: InferenceTelemetry | null;
};

export type ReproducerAgentStatus =
  | "reproduced" // official clean replay matched the failure
  | "not_reproduced" // final valid plan replayed cleanly, showed expected behavior
  | "plan_failed" // no valid plan produced / agent declared not reproducible
  | "environment_failed"
  | "exhausted"
  | "failed";

// Exploration mode (docs/fable/11 observability): which kind of tools the
// agent actually used. Distinct from the submitted plan's mode - the agent
// may explore in the browser and submit an API-only plan, or vice versa.
export type ReproductionMode = "api-only" | "browser" | "mixed" | "unknown";

export type PlanSubmissionRecord = {
  index: number;
  valid: boolean;
  // Canonical behavior hash (hashPlanBehavior over the submitted steps +
  // assertion), present for every submission — invalid ones included, hashed
  // over the raw submitted values.
  planHash: string;
  validationErrors?: string[];
  // Origin-free evidence signature of this submission's replay; null when the
  // submission never reached replay (invalid).
  replaySignature?: string | null;
  // What the agent had explored with UP TO this submission. Exploration can
  // be broader than the frozen proof (e.g. mixed exploration, api-only plan).
  explorationModeAtSubmission?: ReproductionMode;
  // Mode of the SUBMITTED plan (from its steps), present for valid plans.
  planMode?: PlanMode;
  replayOutcome?: string;
  replayReason?: string;
};

export type ReproducerAgentResult = {
  plan: ReproductionPlan | null; // the frozen plan (when submitted + valid)
  result: ReproductionResult | null; // from the OFFICIAL clean replay only
  status: ReproducerAgentStatus;
  reason: string;
  // How the agent explored (may be broader than the accepted plan's mode).
  explorationMode: ReproductionMode;
  submissions: PlanSubmissionRecord[];
  // Bounded, deterministic live-exploration observations (Change 4). Hints
  // for the fixer, never proof — the official replay stays authoritative.
  findings: ReproducerFinding[];
  // Deterministic failure classification (REPRODUCER_LOOP_UPGRADE_PROMPT.md).
  // Null on "reproduced" and "not_reproduced" — the latter is a truthful
  // negative result, not a failure.
  failureCode: ReproducerFailureCode | null;
  failureEvidence: ReproducerFailureEvidence | null;
  // Cost-shape observability (artifacts/<inv_id>/cost-shape.json).
  turns: number;
  compactionEvents: number;
};

// --- Failure taxonomy (REPRODUCER_LOOP_UPGRADE_PROMPT.md, Change 1) -----------

export type ReproducerFailureCode =
  | "reproducer_no_submission"           // budgets exhausted before any submit_plan
  | "reproducer_all_submissions_invalid" // every submission failed validation
  | "reproducer_replay_diverged"         // failure observed live, but no replay reproduced it
  | "reproducer_no_failure_signal"       // failure never observed, live or replayed
  | "reproducer_repeated_plan"           // duplicate-plan cap hit (Change 3)
  | "reproducer_ambiguity_loop"          // >= 3 ambiguous-target step failures, no valid submission accepted
  | "reproducer_environment";            // environment_failed terminal state

export type ReproducerFailureEvidence = {
  code: ReproducerFailureCode;
  failureObservedLive: boolean;
  // One entry per submission, in order (bounded by maxPlanSubmissions).
  submissions: Array<{
    planHash: string;
    valid: boolean;
    invalidReasons?: string[];
    replaySignature: string | null;
    replayOutcome: string | null;
  }>;
  // Shared bounded summary of the LAST failed replay (null if none ran).
  lastReplayEvidence: ReproductionEvidenceSummary | null;
  // Structured divergence from Change 4 (null when not computable).
  divergence: ReproducerDivergence | null;
};

// True when live exploration observed the failure itself: a runtime error, or
// a response finding carrying a 4xx/5xx status. Shared by the failure
// classifier and future consumers (e.g. plan_mismatch routing).
export function failureObservedLive(findings: ReproducerFinding[]): boolean {
  return findings.some(
    (finding) =>
      finding.kind === "runtime_error" ||
      (finding.kind === "response" && /->\s*[45]\d\d\b/.test(finding.observation)),
  );
}

// --- Structured findings (AGENT_LOOP_UPGRADE_PROMPT.md, Change 4) -------------
//
// Deterministic summaries of actual tool observations, built at tool-execution
// time. Never model-generated prose, never byte-count metadata.

export type ReproducerFinding = {
  kind: "route" | "element" | "response" | "runtime_error" | "tool_failure";
  observation: string;
  sourceTool: string;
  sourceStepId: string | null;
  evidenceClass: "live_exploration";
};

export const MAX_REPRODUCER_FINDINGS = 30;
export const MAX_REPRODUCER_FINDING_BYTES = 300;
export const MAX_RENDERED_REPRODUCER_FINDINGS_BYTES = 2 * 1024;

// Final cap selection: prefer recent runtime errors and route/response
// findings, then fill with the rest (newest first). Chronological order is
// preserved in the returned array.
export function selectReproducerFindings(
  all: ReproducerFinding[],
): ReproducerFinding[] {
  if (all.length <= MAX_REPRODUCER_FINDINGS) {
    return [...all];
  }

  const priority = new Set(["runtime_error", "route", "response"]);
  const selected = new Set<ReproducerFinding>();

  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (selected.size >= MAX_REPRODUCER_FINDINGS) break;
    if (priority.has(all[index].kind)) selected.add(all[index]);
  }

  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (selected.size >= MAX_REPRODUCER_FINDINGS) break;
    selected.add(all[index]);
  }

  return all.filter((finding) => selected.has(finding));
}

export type ReproducerAgentDeps = {
  createMessage: CreateModelMessage;
  openLiveSession: typeof openLiveSession;
  executeReproductionPlan: typeof executeReproductionPlan;
};

// --- Tools -------------------------------------------------------------------------

const TARGET_SCHEMA = {
  type: "object" as const,
  description:
    'Intent target, never a CSS selector. One or more of: role, name, label, placeholder, text, testId (data-testid attribute ONLY), id (HTML id attribute). All values non-empty strings that you have seen via read_page.',
  properties: {
    role: { type: "string" },
    name: { type: "string" },
    label: { type: "string" },
    placeholder: { type: "string" },
    text: { type: "string" },
    testId: { type: "string" },
    id: { type: "string" },
  },
};

const PLAN_STEP_SCHEMA = {
  type: "object" as const,
  description:
    'One reproduction step. Shapes: {id, action:"goto", path} | {id, action:"click"|"waitForSelector", target} | {id, action:"fill", target, value} | {id, action:"wait", ms<=10000} | {id, action:"screenshot"} | {id, action:"request", method, path, body?}. Paths are relative and start with "/".',
  properties: {
    id: { type: "string" },
    action: {
      type: "string",
      enum: ["goto", "click", "fill", "waitForSelector", "screenshot", "wait", "request"],
    },
    path: { type: "string" },
    target: TARGET_SCHEMA,
    value: { type: "string" },
    ms: { type: "number" },
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    body: { type: "object" },
  },
  required: ["id", "action"],
};

const ASSERTION_SCHEMA = {
  type: "object" as const,
  description:
    'Exactly one of: {type:"response_status", pathPattern?, method?, expected, failureValue} | {type:"response_body", pathPattern?, method?, failureContains, expectedContains?} (checks the LAST matching "request" step response) | {type:"console_error", contains} | {type:"element_text", target, contains}. console_error/element_text require at least one browser step in the plan.',
  properties: {
    type: {
      type: "string",
      enum: ["response_status", "response_body", "console_error", "element_text"],
    },
    pathPattern: { type: "string" },
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    expected: { type: "number" },
    failureValue: { type: "number" },
    failureContains: { type: "string" },
    expectedContains: { type: "string" },
    contains: { type: "string" },
    target: TARGET_SCHEMA,
  },
  required: ["type"],
};

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "goto",
    description: "Navigate the live browser to a path (relative to the sandbox, starts with \"/\").",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "click",
    description:
      "Click an element in the live browser. Strict mode: an ambiguous target fails with per-key match diagnostics.",
    input_schema: {
      type: "object" as const,
      properties: { target: TARGET_SCHEMA },
      required: ["target"],
    },
  },
  {
    name: "fill",
    description: "Fill a form field in the live browser.",
    input_schema: {
      type: "object" as const,
      properties: { target: TARGET_SCHEMA, value: { type: "string" } },
      required: ["target", "value"],
    },
  },
  {
    name: "request",
    description:
      "Send an HTTP request to the sandbox app (relative path). Returns status and body.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string" },
        body: { type: "object" },
      },
      required: ["method", "path"],
    },
  },
  {
    name: "wait",
    description: "Pause the live session (max 10000 ms) to let async work settle.",
    input_schema: {
      type: "object" as const,
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "read_page",
    description:
      "Digest of the CURRENT page (URL, title, interactive elements in target vocabulary) plus console/network/API evidence recorded since your last read_page.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "submit_plan",
    description:
      "Freeze your reproduction plan. It is validated, then replayed FROM SCRATCH against a pristine workspace and freshly restarted app - your live session state does not carry over. Only that clean replay decides reproduction. You receive the replay result.",
    input_schema: {
      type: "object" as const,
      properties: {
        steps: { type: "array", items: PLAN_STEP_SCHEMA },
        expectedBehavior: { type: "string", description: "One sentence: correct behavior." },
        failureCondition: { type: "string", description: "One sentence: the reported failure." },
        assertion: ASSERTION_SCHEMA,
      },
      required: ["steps", "expectedBehavior", "failureCondition", "assertion"],
    },
  },
  {
    name: "submit_not_reproducible",
    description:
      "Declare that the reported issue cannot be reproduced in this app (e.g. the described behavior/elements do not exist). Ends the session.",
    input_schema: {
      type: "object" as const,
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

const BROWSER_ACTION_TOOLS = new Set(["goto", "click", "fill", "wait"]);

// --- UI-first policy ---------------------------------------------------------------
// The agent must look at the running app (at least one successful goto and
// one read_page) before submitting a plan or declaring the issue not
// reproducible - UNLESS the issue or past memory clearly identifies an API
// endpoint failure. Returns the matched signal (for artifacts/logs) or null.

export function detectApiIssueSignal(text: string): string | null {
  const methodPath = text.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+\/[^\s"'`)]+/);

  if (methodPath) {
    return `explicit request "${methodPath[0]}"`;
  }

  const apiPath = text.match(/(?:^|[\s"'`(])(\/api\/[^\s"'`)]+)/);

  if (apiPath) {
    return `API route "${apiPath[1]}"`;
  }

  const hasStatusCode = /\b[45]\d{2}\b/.test(text);

  if (hasStatusCode && /\b(api|endpoint|route|request|response)\b/i.test(text)) {
    return "HTTP status code mentioned together with an API/endpoint/request reference";
  }

  if (/\bendpoint\b/i.test(text)) {
    return 'the word "endpoint"';
  }

  return null;
}

// --- Agent loop -----------------------------------------------------------------------

export async function runReproducerAgent(
  input: ReproducerAgentInput,
  deps: Partial<ReproducerAgentDeps> = {},
): Promise<ReproducerAgentResult> {
  const createMessage =
    deps.createMessage ??
    ((params) =>
      runInference({ phase: "reproduce", telemetry: input.telemetry ?? null }, params));
  const openSession = deps.openLiveSession ?? openLiveSession;
  const replayPlan = deps.executeReproductionPlan ?? executeReproductionPlan;

  // Budget profile is selected once at run start and used for the whole run.
  const budgetProfile = getBudgetProfileName();
  const budgets = getReproducerBudgets();

  const log = (message: string) => {
    console.log(`[${input.investigationId}] Reproducer: ${message}`);
  };

  log(`Reproducer budget profile: ${budgetProfile}`);

  const agentDir = path.join(input.investigationDir, "repro-agent");
  const store = await createArtifactStore(input.investigationId, agentDir);
  await mkdir(path.join(agentDir, "tool-calls"), { recursive: true });
  // Exploration screenshots (after browser actions, plus failure shots) live
  // under exploration/screenshots/, separate from official replay artifacts.
  const explorationStore = await createArtifactStore(
    input.investigationId,
    path.join(agentDir, "exploration"),
  );

  const startedAt = Date.now();
  const counters = {
    turns: 0,
    browserActions: 0, // goto/click/fill/wait attempts (budget)
    requests: 0, // request attempts (budget)
    // Mode counters: only actions that passed validation and actually ran
    // against the live session. Invalid attempts never count toward mode.
    pageActionsExecuted: 0, // goto/click/fill
    requestsExecuted: 0,
    gotoPassed: 0, // successful goto steps (UI-first policy)
    readPage: 0,
    readPageOk: 0, // read_page calls that returned a digest (UI-first policy)
    submissions: 0,
    // Duplicate-plan guard (Change 3): rejections that never reached replay.
    duplicatePlanRejections: 0,
    // Failed steps whose target was ambiguous (strict-mode violations) — the
    // reproducer_ambiguity_loop classification input.
    ambiguousStepFailures: 0,
    evidenceBytes: 0,
  };

  // Duplicate-plan guard state (Change 3): behavior hash -> bounded prior
  // failure description. Seeded from memory (commit-scoped), extended with
  // this run's replayed-but-not-reproduced submissions.
  const failedPlanHashes = new Map<string, string>();

  for (const known of input.knownFailedPlans ?? []) {
    if (
      typeof known?.planHash === "string" &&
      known.planHash &&
      known.commitSha === input.sourceCommit
    ) {
      failedPlanHashes.set(
        known.planHash,
        `a plan that failed to reproduce in a previous investigation of this issue on this same commit: ${truncateUtf8Bytes(known.failureReason ?? "(no reason recorded)", 500)}`,
      );
    }
  }

  // Evidence-delta state (Change 4a) and failure-evidence state (Change 1).
  let previousFailedReplaySummary: ReproductionEvidenceSummary | null = null;
  let lastFailedReplaySummary: ReproductionEvidenceSummary | null = null;
  let lastDivergence: ReproducerDivergence | null = null;

  // UI-first policy: required unless the issue/memory clearly identifies an
  // API endpoint failure. Satisfied by >=1 successful goto and >=1 read_page.
  const apiIssueSignal = detectApiIssueSignal(
    `${input.issueTitle}\n${input.issueBody}\n${input.pastInvestigations}`,
  );
  const uiFirstRequired = apiIssueSignal === null;
  const uiFirstSatisfied = () => counters.gotoPassed >= 1 && counters.readPageOk >= 1;

  if (uiFirstRequired) {
    log("UI-first policy active: no clear API signal in the issue or memory.");
  } else {
    log(`UI-first policy waived: ${apiIssueSignal}.`);
  }

  // Exploration mode: page tools (goto/click/fill/read_page) vs request.
  // "wait" is neutral. "unknown" = no meaningful action before a terminal.
  const explorationMode = (): ReproductionMode => {
    const pageTouches = counters.pageActionsExecuted + counters.readPage;

    if (pageTouches > 0 && counters.requestsExecuted > 0) {
      return "mixed";
    }

    if (pageTouches > 0) {
      return "browser";
    }

    if (counters.requestsExecuted > 0) {
      return "api-only";
    }

    return "unknown";
  };
  const submissions: PlanSubmissionRecord[] = [];
  const transcript: unknown[] = [];
  let toolCallIndex = 0;
  let stepCounter = 0;
  let nudged = false;

  // Compaction (SHERLOCK_COMPACTION=true): locally tracked state used to
  // rebuild a compact summary when old history is spliced out.
  const compactor = createCompactor();
  const factLog: string[] = [];
  let lastReplayFeedback = "";

  const buildStateSummary = (): string => {
    const sections = [
      factLog.length > 0
        ? `Actions taken so far (live exploration):\n${factLog.slice(-40).map((line) => `- ${line}`).join("\n")}`
        : "No exploration actions yet.",
      submissions.length > 0
        ? `Plan submissions so far:\n${submissions
            .map(
              (submission) =>
                `- submission ${submission.index}: ${submission.valid ? `replay ${submission.replayOutcome ?? "?"} — ${(submission.replayReason ?? "").slice(0, 200)}` : `invalid — ${(submission.validationErrors ?? []).join(" | ").slice(0, 300)}`}`,
            )
            .join("\n")}`
        : "No plan submissions yet.",
      lastReplayFeedback ? `Latest official replay feedback:\n${lastReplayFeedback}` : "",
      `Remaining budgets: ${budgets.maxModelTurns - counters.turns} model turn(s), ${Math.max(0, budgets.maxBrowserActions - counters.browserActions)} browser action(s), ${Math.max(0, budgets.maxRequestCalls - counters.requests)} request(s), ${Math.max(0, budgets.maxReadPageCalls - counters.readPage)} read_page call(s), ${budgets.maxPlanSubmissions - counters.submissions} submission(s).`,
      uiFirstRequired && !uiFirstSatisfied()
        ? "UI-first policy is still unsatisfied: perform at least one successful goto and one read_page before submitting."
        : "",
    ];

    return sections.filter(Boolean).join("\n\n");
  };

  const pushResult = (
    assistantContent: Anthropic.Messages.ContentBlock[],
    toolUseId: string,
    content: string,
    isError: boolean,
  ) => {
    pushToolResult(messages, assistantContent, toolUseId, content, isError);
    compactor.record(content.length);

    if (compactor.maybeCompact(messages, buildStateSummary)) {
      transcript.push({ type: "compaction", turn: counters.turns, event: compactor.events });
      log(`compaction event ${compactor.events}: old history replaced with state summary.`);
    }
  };

  // Live session state. Opened lazily; closed before every official replay.
  let session: LiveSession | null = null;
  let sessionBaseUrl = input.sandboxResult.baseUrl;
  // Rolling cursors into session.evidence for read_page deltas.
  let evidenceCursor = { console: 0, page: 0, network: 0, api: 0 };
  // Last failed official replay (for the not_reproduced terminal state).
  let lastReplay: { plan: ReproductionPlan; result: ReproductionResult } | null = null;

  // Structured findings (Change 4): deterministic, deduplicated, bounded.
  const findings: ReproducerFinding[] = [];
  const findingKeys = new Set<string>();
  let findingsCursor = { console: 0, page: 0, network: 0 };

  const recordFinding = (
    kind: ReproducerFinding["kind"],
    observation: string,
    sourceTool: string,
    sourceStepId: string | null,
  ) => {
    const bounded = truncateUtf8Bytes(
      redactSecrets(observation).replace(/\s+/g, " ").trim(),
      MAX_REPRODUCER_FINDING_BYTES,
    );

    if (!bounded) {
      return;
    }

    const key = `${kind}|${bounded}`;

    if (findingKeys.has(key)) {
      return;
    }

    findingKeys.add(key);
    findings.push({
      kind,
      observation: bounded,
      sourceTool,
      sourceStepId,
      evidenceClass: "live_exploration",
    });
  };

  // New console/page errors and failed requests observed since the last
  // findings sweep. Peeks without touching the model-facing evidenceCursor.
  const recordNewEvidenceFindings = (
    live: LiveSession,
    sourceTool: string,
    sourceStepId: string | null,
  ) => {
    const { evidence } = live;

    for (const error of evidence.consoleErrors.slice(findingsCursor.console)) {
      recordFinding("runtime_error", error, sourceTool, sourceStepId);
    }

    for (const error of evidence.pageErrors.slice(findingsCursor.page)) {
      recordFinding("runtime_error", error, sourceTool, sourceStepId);
    }

    for (const failure of evidence.networkFailures.slice(findingsCursor.network)) {
      recordFinding(
        "response",
        `${failure.method} ${failure.url} -> ${failure.status ?? failure.failure}`,
        sourceTool,
        sourceStepId,
      );
    }

    findingsCursor.console = evidence.consoleErrors.length;
    findingsCursor.page = evidence.pageErrors.length;
    findingsCursor.network = evidence.networkFailures.length;
  };

  const messages: Anthropic.Messages.MessageParam[] = [];

  const finish = async (
    status: ReproducerAgentStatus,
    reason: string,
    plan: ReproductionPlan | null,
    result: ReproductionResult | null,
  ): Promise<ReproducerAgentResult> => {
    if (session) {
      await session.close().catch(() => {});
      session = null;
    }

    const mode = explorationMode();
    const acceptedPlanMode = plan ? getPlanMode(plan) : null;
    // The fixer only ever receives the official replay result of the frozen
    // plan - never the exploratory browser trace or screenshots.
    const fixerEvidenceMode = status === "reproduced" ? acceptedPlanMode : null;

    // Bounded structured findings (Change 4): typed result is the runtime
    // transport; the artifact is the audit trail.
    const selectedFindings = selectReproducerFindings(findings);

    // Failure classification (Change 1): deterministic, terminal-failure
    // statuses only. "not_reproduced" is a truthful negative, not a failure.
    const isTerminalFailure =
      status === "plan_failed" ||
      status === "exhausted" ||
      status === "environment_failed" ||
      status === "failed";
    const failureCode = isTerminalFailure
      ? classifyReproducerFailure({
          status,
          submissions,
          findings: selectedFindings,
          duplicatePlanRejections: counters.duplicatePlanRejections,
          ambiguousStepFailures: counters.ambiguousStepFailures,
        })
      : null;
    const failureEvidence: ReproducerFailureEvidence | null = failureCode
      ? {
          code: failureCode,
          failureObservedLive: failureObservedLive(selectedFindings),
          submissions: submissions.map((submission) => ({
            planHash: submission.planHash,
            valid: submission.valid,
            ...(submission.validationErrors
              ? {
                  invalidReasons: submission.validationErrors
                    .slice(0, 5)
                    .map((error) => truncateUtf8Bytes(error, 300)),
                }
              : {}),
            replaySignature: submission.replaySignature ?? null,
            replayOutcome: submission.replayOutcome ?? null,
          })),
          lastReplayEvidence: lastFailedReplaySummary,
          divergence: lastDivergence,
        }
      : null;

    const agentResult: ReproducerAgentResult = {
      plan,
      result,
      status,
      reason,
      explorationMode: mode,
      submissions,
      findings: selectedFindings,
      failureCode,
      failureEvidence,
      turns: counters.turns,
      compactionEvents: compactor.events,
    };
    transcript.push({ type: "final_result", status, reason, submissions, mode, failureCode });
    await store.writeJson("transcript.json", transcript);
    await store.writeJson("reproducer-findings.json", selectedFindings);

    if (failureEvidence) {
      await store.writeJson("failure-evidence.json", failureEvidence);
    }
    await store.writeJson("mode.json", {
      mode,
      browserActions: counters.pageActionsExecuted,
      requestActions: counters.requestsExecuted,
      readPageCalls: counters.readPage,
      submittedPlans: counters.submissions,
      submittedPlanMode: acceptedPlanMode,
      uiFirstPolicy: {
        required: uiFirstRequired,
        satisfied: uiFirstSatisfied(),
        apiIssueSignal,
      },
    });
    await store.writeJson("reproduction-evidence-summary.json", {
      explorationMode: mode,
      acceptedPlanMode,
      fixerEvidenceMode,
      explanation: buildEvidenceExplanation(mode, acceptedPlanMode, status),
    });
    await store.writeJson("summary.json", {
      status,
      reason,
      failureCode,
      mode,
      acceptedPlanMode,
      submissions,
      counters,
      compactionEvents: compactor.events,
      durationMs: Date.now() - startedAt,
      replayOutcome: result?.outcome ?? null,
    });
    log(
      `finished: ${status} (exploration: ${mode}${acceptedPlanMode ? `, accepted plan: ${acceptedPlanMode}` : ""}) — ${reason}`,
    );
    if (failureCode) {
      log(`failure code: ${failureCode}`);
    }
    return agentResult;
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

  const ensureSession = async (): Promise<LiveSession> => {
    if (!session) {
      session = await openSession(sessionBaseUrl, { store: explorationStore });
      evidenceCursor = { console: 0, page: 0, network: 0, api: 0 };
      findingsCursor = { console: 0, page: 0, network: 0 };
    }

    return session;
  };

  const closeSession = async () => {
    if (session) {
      await session.close().catch(() => {});
      session = null;
    }
  };

  try {
    // The fallback may start after a one-shot plan partially mutated the app
    // and repository. Exploration must begin from the same pristine source
    // state that official replays use, never from abandoned setup residue.
    const initialReset = await resetWorkspace(input.repoPath, input.sourceCommit);

    if (!initialReset.ok) {
      return await finish(
        "failed",
        `Workspace reset before reproducer exploration failed: ${initialReset.error}`,
        null,
        null,
      );
    }

    const initialRestart = await input.restart();

    if (!initialRestart.ok || !initialRestart.baseUrl) {
      return await finish(
        "environment_failed",
        `Sandbox restart before reproducer exploration failed: ${initialRestart.log ?? "(no log)"}`,
        null,
        null,
      );
    }

    sessionBaseUrl = initialRestart.baseUrl;
    messages.push({
      role: "user",
      content: buildInitialMessage({
        ...input,
        sandboxResult: { ...input.sandboxResult, baseUrl: sessionBaseUrl },
      }),
    });

    while (true) {
      input.abortSignal?.throwIfAborted();
      if (Date.now() - startedAt > budgets.maxWallTimeMs) {
        return await finishExhausted("Wall-time budget exhausted.");
      }

      if (counters.turns >= budgets.maxModelTurns) {
        return await finishExhausted("Model turn budget exhausted.");
      }

      counters.turns += 1;

      // Once deterministic live evidence contains the failure, exploration
      // has achieved its purpose. Force the next turn to freeze a plan so the
      // model cannot spend the remaining budget re-querying the same state.
      const forcePlanSubmission =
        counters.submissions === 0 &&
        (!uiFirstRequired || uiFirstSatisfied()) &&
        failureObservedLive(findings);

      const message = await createMessage({
        model: MODEL,
        max_tokens: budgets.maxResponseTokens,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        tool_choice: forcePlanSubmission
          ? { type: "tool", name: "submit_plan", disable_parallel_tool_use: true }
          : { type: "any", disable_parallel_tool_use: true },
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
            null,
            null,
          );
        }

        nudged = true;
        messages.push(
          { role: "assistant", content: nonEmptyContent(message.content) },
          { role: "user", content: "Respond with exactly one tool call." },
        );
        continue;
      }

      transcript.push({
        type: "model_action",
        turn: counters.turns,
        tool: toolUse.name,
        input: toolUse.name === "submit_plan" ? "(see tool-calls artifact)" : toolUse.input,
      });
      log(`turn ${counters.turns}: ${toolUse.name}`);

      // --- UI-first policy gate on terminal tools ------------------------------
      // Both terminals are blocked (WITHOUT consuming a submission) until the
      // agent has actually looked at the app, unless the issue/memory clearly
      // identified an API endpoint failure. Bounded by the turn budget.
      if (
        (toolUse.name === "submit_plan" || toolUse.name === "submit_not_reproducible") &&
        uiFirstRequired &&
        !uiFirstSatisfied()
      ) {
        const policyMessage =
          "Policy: this issue does not clearly identify an API endpoint failure, so you must inspect the running app first - perform at least one successful goto and one read_page before submitting a plan or declaring the issue not reproducible. This attempt was NOT counted against your submission budget.";

        transcript.push({
          type: "ui_first_policy_rejection",
          turn: counters.turns,
          tool: toolUse.name,
          gotoPassed: counters.gotoPassed,
          readPageOk: counters.readPageOk,
        });
        log(`UI-first policy blocked ${toolUse.name} (goto: ${counters.gotoPassed}, read_page: ${counters.readPageOk}).`);
        await recordToolCall(toolUse.name, toolUse.input, policyMessage);

        pushResult(message.content, toolUse.id, policyMessage, true);
        continue;
      }

      // --- Terminal: agent declares not reproducible -------------------------
      if (toolUse.name === "submit_not_reproducible") {
        const reason =
          typeof (toolUse.input as { reason?: unknown })?.reason === "string"
            ? (toolUse.input as { reason: string }).reason
            : "(no reason given)";
        await recordToolCall("submit_not_reproducible", toolUse.input, reason);
        return await finish("plan_failed", `Agent declared not reproducible: ${reason}`, null, null);
      }

      // --- Terminal-capable: submit_plan --------------------------------------
      if (toolUse.name === "submit_plan") {
        counters.submissions += 1;
        const explorationModeAtSubmission = explorationMode();

        const submitted = toolUse.input as Record<string, unknown>;
        const candidate = {
          version: REPRODUCTION_PLAN_VERSION,
          baseUrl: sessionBaseUrl,
          steps: submitted.steps,
          expectedBehavior: submitted.expectedBehavior,
          failureCondition: submitted.failureCondition,
          assertion: submitted.assertion,
        };

        // Canonical behavior hash (Change 1/3): computed for every submission,
        // including invalid ones (hashed over the raw submitted values).
        const planHash = hashPlanBehavior(candidate as unknown as ReproductionPlan);

        const validation = validateReproductionPlan(candidate);

        if (!validation.ok) {
          submissions.push({
            index: counters.submissions,
            valid: false,
            planHash,
            explorationModeAtSubmission,
            validationErrors: validation.errors,
          });
          transcript.push({
            type: "plan_submission",
            turn: counters.turns,
            valid: false,
            errors: validation.errors,
          });
          log(`submission ${counters.submissions}: invalid (${validation.errors.length} error(s))`);

          const feedback = `The submitted plan is invalid:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`;
          await recordToolCall("submit_plan", submitted, feedback);

          if (counters.submissions >= budgets.maxPlanSubmissions) {
            return await finishExhausted(
              `Plan submission budget exhausted (${budgets.maxPlanSubmissions} submissions, none reproduced).`,
            );
          }

          pushResult(message.content, toolUse.id, `${feedback}\n\n${remainingSubmissions()}`, true);
          continue;
        }

        // --- Duplicate-plan guard (Change 3) -----------------------------------
        // A behaviorally identical plan never reaches the expensive path
        // (workspace reset + app restart + replay) and never consumes a
        // submission. Seeded from memory (same-commit only), extended with
        // this run's replayed-but-not-reproduced submissions.
        const priorPlanFailure = failedPlanHashes.get(planHash);

        if (priorPlanFailure) {
          counters.submissions -= 1; // Duplicates never consume the budget.
          counters.duplicatePlanRejections += 1;

          const rejection = `REJECTED without replay: this plan's steps and assertion are behaviorally identical to ${priorPlanFailure}. Submit a materially different plan (different steps or assertion) or call submit_not_reproducible.`;
          await recordToolCall("submit_plan", submitted, rejection);
          transcript.push({
            type: "duplicate_plan_rejected",
            turn: counters.turns,
            planHash,
            rejections: counters.duplicatePlanRejections,
          });
          log(
            `duplicate plan rejected (${counters.duplicatePlanRejections}): hash ${planHash}`,
          );

          if (counters.duplicatePlanRejections >= 3) {
            return await finish(
              "failed",
              "The model resubmitted a behaviorally identical plan three times despite rejection feedback.",
              null,
              null,
            );
          }

          pushResult(message.content, toolUse.id, rejection, true);
          continue;
        }

        // --- Official replay: pristine workspace + fresh sandbox --------------
        await closeSession();

        const reset = await resetWorkspace(input.repoPath, input.sourceCommit);

        if (!reset.ok) {
          return await finish(
            "failed",
            `Workspace reset before the official replay failed: ${reset.error}`,
            null,
            null,
          );
        }

        const restart = await input.restart();

        if (!restart.ok || !restart.baseUrl) {
          return await finish(
            "environment_failed",
            `Sandbox restart before the official replay failed: ${restart.log ?? "(no log)"}`,
            null,
            null,
          );
        }

        sessionBaseUrl = restart.baseUrl;

        // Freeze the plan against the restarted sandbox.
        const frozen: ReproductionPlan = JSON.parse(
          JSON.stringify({ ...validation.plan, baseUrl: restart.baseUrl }),
        ) as ReproductionPlan;

        const planMode = getPlanMode(frozen);
        const replayStore = await createArtifactStore(
          input.investigationId,
          path.join(agentDir, `replay-${counters.submissions}`),
        );
        await replayStore.writeJson("replay-mode.json", { mode: planMode });

        const replayResult = await replayPlan(frozen, replayStore);

        // Per-replay artifacts: full result plus a clear request/response
        // trace (the primary evidence for api-only plans).
        await replayStore.writeJson("reproduction-result.json", {
          investigationId: input.investigationId,
          ...replayResult,
        });
        await replayStore.writeJson("api-trace.json", {
          apiResponses: replayResult.apiResponses,
          httpResponses: replayResult.httpResponses,
          networkFailures: replayResult.networkFailures,
        });
        const promotedReplayResult = rebaseExecutionArtifactPaths(
          replayResult,
          path.relative(input.investigationDir, replayStore.dir),
        );

        // Shared bounded evidence summary of this replay (Change 1/4).
        const replaySummary = summarizeReproductionEvidence(replayResult);
        const failedReplay = replayResult.outcome !== "reproduced";
        // Live-vs-replay divergence (Change 4b): only meaningful for a replay
        // that actually ran and did not reproduce.
        const divergence =
          failedReplay && replayResult.outcome !== "environment_failed"
            ? computeReproducerDivergence(findings, frozen, replayResult)
            : null;

        submissions.push({
          index: counters.submissions,
          valid: true,
          planHash,
          replaySignature: replaySummary.signature,
          explorationModeAtSubmission,
          planMode,
          replayOutcome: replayResult.outcome,
          replayReason: replayResult.outcomeReason,
        });
        transcript.push({
          type: "plan_submission",
          turn: counters.turns,
          valid: true,
          planHash,
          explorationModeAtSubmission,
          planMode,
          replayOutcome: replayResult.outcome,
          replayReason: replayResult.outcomeReason,
        });
        log(`submission ${counters.submissions}: replay ${replayResult.outcome} — ${firstLine(replayResult.outcomeReason)}`);

        const feedback = formatReplayFeedback(
          replayResult,
          failedReplay ? previousFailedReplaySummary : null,
          failedReplay ? replaySummary : null,
          divergence,
        );
        await recordToolCall("submit_plan", submitted, feedback);

        if (replayResult.outcome === "reproduced") {
          return await finish(
            "reproduced",
            replayResult.outcomeReason,
            frozen,
            promotedReplayResult,
          );
        }

        lastFailedReplaySummary = replaySummary;

        if (replayResult.outcome === "environment_failed") {
          return await finish(
            "environment_failed",
            replayResult.outcomeReason,
            frozen,
            promotedReplayResult,
          );
        }

        lastDivergence = divergence;
        previousFailedReplaySummary = replaySummary;
        // Register the failed plan so an identical resubmission is rejected
        // without another reset/restart/replay (Change 3).
        failedPlanHashes.set(
          planHash,
          `submission ${counters.submissions}, which replayed with outcome ${replayResult.outcome} (${truncateUtf8Bytes(replayResult.outcomeReason, 300)})`,
        );

        lastReplay = { plan: frozen, result: promotedReplayResult };

        if (counters.submissions >= budgets.maxPlanSubmissions) {
          return await finishExhausted(
            `Plan submission budget exhausted (${budgets.maxPlanSubmissions} submissions, none reproduced).`,
          );
        }

        lastReplayFeedback = feedback;
        pushResult(
          message.content,
          toolUse.id,
          `${feedback}\n\nThe workspace and app were reset to a pristine state. ${remainingSubmissions()} You may explore again (a fresh live session will open) and revise.`,
          true,
        );
        continue;
      }

      // --- Non-terminal tools ---------------------------------------------------
      let resultText: string;
      let isError = false;

      if (toolUse.name === "read_page") {
        counters.readPage += 1;
        if (counters.readPage > budgets.maxReadPageCalls) {
          resultText = "read_page budget exhausted — submit a plan or call submit_not_reproducible.";
          isError = true;
        } else if (counters.evidenceBytes >= budgets.maxEvidenceBytes) {
          resultText = "Evidence budget exhausted — submit a plan or call submit_not_reproducible.";
          isError = true;
        } else {
          try {
            const live = await ensureSession();
            const digest = await live.readPageDigest();
            const delta = drainEvidenceDelta(live, evidenceCursor);
            resultText = truncateText(`${digest}\n\n${delta}`, budgets.maxDigestBytes);
            counters.evidenceBytes += resultText.length;
            counters.readPageOk += 1;
            recordFinding(
              "route",
              `page observed: ${digest.split("\n").slice(0, 2).join(" | ")}`,
              "read_page",
              null,
            );
            recordNewEvidenceFindings(live, "read_page", null);
            await live
              .captureScreenshot(`${String(toolCallIndex + 1).padStart(3, "0")}-after-read_page`)
              .catch(() => null);
          } catch (error) {
            resultText = `Live session unavailable: ${formatError(error)}`;
            isError = true;
          }
        }
      } else if (BROWSER_ACTION_TOOLS.has(toolUse.name) || toolUse.name === "request") {
        const isRequest = toolUse.name === "request";

        if (isRequest) {
          counters.requests += 1;
        } else {
          counters.browserActions += 1;
        }

        if (!isRequest && counters.browserActions > budgets.maxBrowserActions) {
          resultText = "Browser action budget exhausted — submit a plan or call submit_not_reproducible.";
          isError = true;
        } else if (isRequest && counters.requests > budgets.maxRequestCalls) {
          resultText = "Request budget exhausted — submit a plan or call submit_not_reproducible.";
          isError = true;
        } else {
          stepCounter += 1;
          const step = {
            id: `live-${stepCounter}`,
            action: toolUse.name,
            ...(toolUse.input as Record<string, unknown>),
          };

          // Same validation rules as frozen plan steps.
          const stepErrors = validateStep(step, stepCounter - 1);

          if (stepErrors.length > 0) {
            resultText = `Invalid action: ${stepErrors.join(" | ")}`;
            isError = true;
            recordFinding(
              "tool_failure",
              `${toolUse.name} rejected as invalid: ${stepErrors.join(" | ")}`,
              toolUse.name,
              null,
            );
          } else {
            try {
              const live = await ensureSession();
              const record = await live.executeStep(step as unknown as ReproductionStep);
              resultText = formatStepResult(record, live, evidenceCursor, isRequest);
              isError = record.outcome === "failed";
              counters.evidenceBytes += resultText.length;

              // Structured finding from the ACTUAL observation (Change 4).
              const stepInput = toolUse.input as Record<string, unknown>;
              const targetLabel =
                typeof stepInput.path === "string"
                  ? stepInput.path
                  : stepInput.target
                    ? JSON.stringify(stepInput.target)
                    : typeof stepInput.selector === "string"
                      ? stepInput.selector
                      : "";

              if (record.outcome === "failed") {
                if (record.ambiguous) {
                  counters.ambiguousStepFailures += 1;
                }

                recordFinding(
                  "tool_failure",
                  `${toolUse.name} ${targetLabel} failed${record.ambiguous ? " (ambiguous target)" : ""}: ${record.error ?? "unknown error"}`,
                  toolUse.name,
                  record.id,
                );
              } else if (isRequest) {
                const lastResponse =
                  live.evidence.apiResponses[live.evidence.apiResponses.length - 1];
                recordFinding(
                  "response",
                  lastResponse
                    ? `${lastResponse.method} ${lastResponse.url} -> ${lastResponse.status}`
                    : `request ${targetLabel} executed`,
                  "request",
                  record.id,
                );
              } else if (toolUse.name === "goto") {
                recordFinding(
                  "route",
                  `goto ${targetLabel} -> page loaded`,
                  "goto",
                  record.id,
                );
              } else if (toolUse.name === "click" || toolUse.name === "fill") {
                recordFinding(
                  "element",
                  `${toolUse.name} ${targetLabel} existed and the action succeeded`,
                  toolUse.name,
                  record.id,
                );
              }

              recordNewEvidenceFindings(live, toolUse.name, record.id);

              if (isRequest) {
                counters.requestsExecuted += 1;
              } else if (toolUse.name !== "wait") {
                counters.pageActionsExecuted += 1;

                if (toolUse.name === "goto" && record.outcome === "passed") {
                  counters.gotoPassed += 1;
                }
              }

              // Exploration trace: screenshot after successful browser
              // actions only - never for API requests or waits.
              if (
                record.outcome === "passed" &&
                (toolUse.name === "goto" || toolUse.name === "click" || toolUse.name === "fill")
              ) {
                await live
                  .captureScreenshot(
                    `${String(toolCallIndex + 1).padStart(3, "0")}-after-${toolUse.name}`,
                  )
                  .catch(() => null);
              }
            } catch (error) {
              resultText = `Live session unavailable: ${formatError(error)}`;
              isError = true;
            }
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

      pushResult(message.content, toolUse.id, resultText, isError);
    }
  } catch (error) {
    return await finish(
      "failed",
      `Reproducer agent failed unexpectedly: ${formatError(error)}`,
      null,
      null,
    );
  }

  // Exhaustion terminal: if the last valid submission replayed cleanly and
  // showed expected behavior, that IS a deterministic verdict - surface it as
  // not_reproduced (with plan + result) instead of a bare "exhausted".
  async function finishExhausted(reason: string): Promise<ReproducerAgentResult> {
    if (lastReplay && lastReplay.result.outcome === "not_reproduced") {
      return finish(
        "not_reproduced",
        `${lastReplay.result.outcomeReason} (${reason})`,
        lastReplay.plan,
        lastReplay.result,
      );
    }

    return finish("exhausted", reason, null, null);
  }

  function remainingSubmissions(): string {
    return `${budgets.maxPlanSubmissions - counters.submissions} submission(s) remaining.`;
  }
}

// Deterministic failure classification (Change 1). Precedence: first match
// wins. Derived only from counters, submissions, findings, and replays —
// never from model output.
function classifyReproducerFailure(args: {
  status: ReproducerAgentStatus;
  submissions: PlanSubmissionRecord[];
  findings: ReproducerFinding[];
  duplicatePlanRejections: number;
  ambiguousStepFailures: number;
}): ReproducerFailureCode {
  if (args.status === "environment_failed") {
    return "reproducer_environment";
  }

  if (args.duplicatePlanRejections >= 3) {
    return "reproducer_repeated_plan";
  }

  if (args.submissions.length === 0) {
    return "reproducer_no_submission";
  }

  if (args.submissions.every((submission) => !submission.valid)) {
    return "reproducer_all_submissions_invalid";
  }

  if (args.ambiguousStepFailures >= 3) {
    return "reproducer_ambiguity_loop";
  }

  if (failureObservedLive(args.findings)) {
    return "reproducer_replay_diverged";
  }

  return "reproducer_no_failure_signal";
}

// Factual metadata only: explains the exploration-vs-proof split so a human
// reading artifacts can immediately tell what evidence drove the fixer.
function buildEvidenceExplanation(
  explorationMode: ReproductionMode,
  acceptedPlanMode: PlanMode | null,
  status: ReproducerAgentStatus,
): string {
  if (!acceptedPlanMode) {
    return `No plan was accepted (status: ${status}). Exploration mode was ${explorationMode}.`;
  }

  const proofSentence =
    status === "reproduced"
      ? "The fixer receives the official replay result, not the exploratory browser trace."
      : "No fixer evidence was produced (the official replay did not reproduce the failure).";

  if (explorationMode === "mixed" && acceptedPlanMode === "api-only") {
    return `The agent used UI and API tools to understand the app, then submitted an API-only deterministic plan. ${proofSentence}`;
  }

  if (explorationMode === acceptedPlanMode) {
    return `Exploration and the accepted plan are both ${acceptedPlanMode}. ${proofSentence}`;
  }

  return `The agent explored in ${explorationMode} mode and submitted a ${acceptedPlanMode} deterministic plan. ${proofSentence}`;
}

// --- Workspace reset ------------------------------------------------------------------

async function resetWorkspace(
  repoPath: string,
  sourceCommit: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFileAsync("git", ["checkout", "--", "."], { cwd: repoPath });
    // Remove app-written data files from exploration; keep the extracted graph.
    await execFileAsync("git", ["clean", "-fd", "-e", "graphify-out"], { cwd: repoPath });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    const head = stdout.trim();

    if (head !== sourceCommit) {
      return { ok: false, error: `HEAD is ${head} after reset, expected ${sourceCommit}.` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

// --- Tool result formatting -------------------------------------------------------------

type EvidenceCursor = { console: number; page: number; network: number; api: number };

function drainEvidenceDelta(session: LiveSession, cursor: EvidenceCursor): string {
  const { evidence } = session;
  const consoleErrors = evidence.consoleErrors.slice(cursor.console);
  const pageErrors = evidence.pageErrors.slice(cursor.page);
  const networkFailures = evidence.networkFailures.slice(cursor.network);
  const apiResponses = evidence.apiResponses.slice(cursor.api);

  cursor.console = evidence.consoleErrors.length;
  cursor.page = evidence.pageErrors.length;
  cursor.network = evidence.networkFailures.length;
  cursor.api = evidence.apiResponses.length;

  return [
    "Evidence since last read:",
    `Console errors: ${consoleErrors.join(" | ") || "(none)"}`,
    `Page errors: ${pageErrors.join(" | ") || "(none)"}`,
    `Network failures: ${networkFailures.map((failure) => `${failure.method} ${failure.url} -> ${failure.status ?? failure.failure}`).join(" | ") || "(none)"}`,
    `API responses: ${apiResponses.map((response) => `${response.method} ${response.url} -> ${response.status} ${response.body.slice(0, 300)}`).join(" | ") || "(none)"}`,
  ].join("\n");
}

function formatStepResult(
  record: StepRecord,
  session: LiveSession,
  cursor: EvidenceCursor,
  includeApiBody: boolean,
): string {
  const lines = [`${record.action} ${record.outcome}${record.error ? `: ${record.error}` : ""}`];

  if (record.ambiguous) {
    lines.push(
      "This target was AMBIGUOUS (matched multiple elements). Use the diagnostics above to pick a unique key before retrying.",
    );
  }

  if (includeApiBody) {
    const last = session.evidence.apiResponses[session.evidence.apiResponses.length - 1];

    if (last) {
      lines.push(`Response: ${last.status} ${last.statusText}`, truncateText(last.body, 4_000));
      cursor.api = session.evidence.apiResponses.length;
    }
  }

  return lines.join("\n");
}

// Replay feedback (Change 4): outcome + reason first, then the
// submission-vs-previous-submission signature delta and the live-vs-replay
// divergence (both BEFORE the per-step listing so they survive the overall
// truncation), then the detailed listing.
function formatReplayFeedback(
  result: ReproductionResult,
  previousSummary: ReproductionEvidenceSummary | null,
  currentSummary: ReproductionEvidenceSummary | null,
  divergence: ReproducerDivergence | null,
): string {
  const stepLines = result.steps.map(
    (step) =>
      `  ${step.id} [${step.outcome}]${step.error ? ` ${firstLine(step.error)}` : ""}`,
  );

  const sections = [
    `OFFICIAL REPLAY (pristine workspace, fresh app): ${result.outcome}`,
    `Reason: ${result.outcomeReason}`,
  ];

  if (previousSummary && currentSummary) {
    const changed = previousSummary.signature !== currentSummary.signature;
    sections.push(
      [
        "DELTA vs your previous submission:",
        `Before signature: ${previousSummary.signature}`,
        `After signature:  ${currentSummary.signature}`,
        `Signature changed: ${changed ? "yes" : "no"}`,
        "- Identical signature: your plan changes did not alter what the replay observed. Do not iterate on the same approach.",
        "- Changed signature: the plan change altered observable behavior; use the new evidence.",
      ].join("\n"),
    );
  }

  if (divergence && hasDivergence(divergence)) {
    sections.push(formatReproducerDivergence(divergence));
  }

  sections.push(
    `Steps:\n${stepLines.join("\n")}`,
    `Assertion: ${result.assertion ? `matchedFailure=${result.assertion.matchedFailure} matchedExpected=${result.assertion.matchedExpected} — ${result.assertion.detail}` : "(not evaluated)"}`,
    `Console errors: ${result.consoleErrors.join(" | ") || "(none)"}`,
    `Page errors: ${result.pageErrors.join(" | ") || "(none)"}`,
    `API responses: ${result.apiResponses.map((response) => `${response.method} ${response.url} -> ${response.status} ${response.body.slice(0, 200)}`).join(" | ") || "(none)"}`,
  );

  return truncateText(sections.join("\n"), 8_000);
}

// --- Prompt --------------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Sherlock's reproducer agent. A GitHub issue reports a bug; a LIVE instance of the app is running in a sandbox. Interact with it, observe real outcomes, and only then freeze a deterministic reproduction plan.

Rules:
- Ground every target in read_page output — target only elements you have seen, using the most specific unique key (testId > role+name > label/placeholder > id > unique text). Never use CSS selectors. Ambiguous targets fail; use the returned diagnostics to pick a unique key.
- The frozen plan replays against a FRESH app instance: it must not depend on state your exploration created. Include every setup step the plan needs (create the data it asserts about).
- After async work (202 responses, queued jobs, background saves), insert an explicit "wait" step long enough for the work to finish — your interactive timing will not carry over to the replay.
- The assertion must detect the reported failure using evidence you actually observed: copy exact strings from responses and errors you saw. Never invent error text.
- A "console_error" or "element_text" assertion requires at least one browser step; an API-only plan must assert "response_status" or "response_body" (checked against the LAST matching "request" step).
- Use browser actions (goto/click/fill) for UI/user-facing bugs. Use request actions for API/backend bugs. If your reproduction is API-only, make that intentional and assert against response_status or response_body. Do not open a blank page just to create a screenshot - screenshots are only meaningful when the bug is visible on a page.
- Unless the issue or past investigations clearly identify an API endpoint failure (an explicit method and path, an /api/... route, or an endpoint with a status code), you MUST look at the running app first: at least one successful goto and one read_page before submitting a plan or declaring the issue not reproducible. Submissions that skip this are rejected.
- Aim for the shortest plan that deterministically shows the failure.
- Submissions are limited; explore until you have SEEN the failure before submitting.
- Once you have seen the reported failure in live evidence, stop exploring and submit the shortest self-contained plan on your next turn.
- PAST INVESTIGATIONS may list REPRODUCTION PLANS ALREADY TRIED. A plan whose steps and assertion behaviorally match a listed plan hash will be REJECTED automatically without replay — submit a materially different plan (different steps or assertion), and treat the recorded replay signature as evidence of what that plan actually did.
- Respond with exactly one tool call per turn.`;

// Deliberately lean initial context (cost): the reproducer explores the LIVE
// app, so it does not need hydrated source file bodies — it gets graph
// node/edge names as route/API/UI hints, a package/scripts summary, past
// memory, and a bounded tail of the sandbox logs. It has no read_file/grep
// tools, so source inspection is not assumed. The fixer still receives the
// full refined, hydrated context after reproduction is proven.
const SANDBOX_LOG_TAIL_LINES = 40;

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");

  if (lines.length <= maxLines) {
    return text;
  }

  return `[...${lines.length - maxLines} earlier line(s) omitted]\n${lines.slice(-maxLines).join("\n")}`;
}

export function summarizePackageJson(packageJson: string | null): string {
  if (!packageJson) {
    return "(not found)";
  }

  try {
    const parsed = JSON.parse(packageJson) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };

    const scripts = Object.entries(parsed.scripts ?? {})
      .map(([key, value]) => `  ${key}: ${String(value)}`)
      .join("\n");

    return [
      `name: ${typeof parsed.name === "string" ? parsed.name : "(unknown)"}`,
      `scripts:\n${scripts || "  (none)"}`,
      `dependencies: ${Object.keys(parsed.dependencies ?? {}).join(", ") || "(none)"}`,
      `devDependencies: ${Object.keys(parsed.devDependencies ?? {}).join(", ") || "(none)"}`,
    ].join("\n");
  } catch {
    // Unparseable package.json: fall back to a bounded slice.
    return packageJson.slice(0, 2_000);
  }
}

function buildInitialMessage(input: ReproducerAgentInput): string {
  return `Reproduce this issue in the live app, then submit a deterministic plan.

The app is running now; use goto/read_page/click/fill/request/wait to explore it.
${formatGraphSection(input.graphContext)}${formatPastSection(input.pastInvestigations)}
Grounding rules:
- Only reference routes, components, and UI strings that appear in the
  evidence below or that you observe live. If you have not seen it, it does
  not exist.
- You cannot read source files. Ground your plan in what you observe through
  read_page, request responses, and the graph hints above.

Issue title:
${input.issueTitle}

Issue body:
${input.issueBody || "(empty)"}

package.json summary:
${summarizePackageJson(input.packageJson)}

Sandbox runtime logs (bounded tail):

Base URL:
${input.sandboxResult.baseUrl || "(unknown)"}

STDOUT (last ${SANDBOX_LOG_TAIL_LINES} lines):
${tailLines(input.sandboxResult.stdout, SANDBOX_LOG_TAIL_LINES) || "(empty)"}

STDERR (last ${SANDBOX_LOG_TAIL_LINES} lines):
${tailLines(input.sandboxResult.stderr, SANDBOX_LOG_TAIL_LINES) || "(empty)"}`;
}

// --- Small helpers ---------------------------------------------------------------------------

function pushToolResult(
  messages: Anthropic.Messages.MessageParam[],
  assistantContent: Anthropic.Messages.ContentBlock[],
  toolUseId: string,
  content: string,
  isError: boolean,
) {
  messages.push(
    { role: "assistant", content: assistantContent },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  );
}

function nonEmptyContent(
  content: Anthropic.Messages.ContentBlock[],
): Anthropic.Messages.MessageParam["content"] {
  if (content.length > 0) {
    return content;
  }

  return [{ type: "text", text: "(no content)" }];
}

function truncateText(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) {
    return text;
  }

  return `${text.slice(0, maxBytes)}\n[TRUNCATED]`;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
