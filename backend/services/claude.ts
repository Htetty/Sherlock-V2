import "dotenv/config";
import { runInference, type InferenceTelemetry } from "./inference.js";
import { REPRODUCTION_PLAN_VERSION } from "./plan.js";
import {
  extractFixProposalJson,
  requestValidProposal,
} from "./fix-proposal.js";
import { truncateWithMarker } from "./bounded-text.js";
import type { GraphContext } from "./graphContext.js";
import type { ReproductionResult } from "./playwright.js";
import {
  buildRegressionTestPrompt,
  type RegressionGenerationInput,
} from "./regression-test.js";

// Centralized Anthropic model selection. Every model call in the codebase
// resolves through this — do not hardcode model IDs elsewhere. Override with
// the ANTHROPIC_MODEL environment variable; otherwise fall back to the
// confirmed default below.
export const DEFAULT_MODEL = "claude-sonnet-5";

export function resolveModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

export const MODEL = resolveModel();
const MAX_PROMPT_LOG_CHARS = 8_000;
const MAX_PROMPT_HTML_CHARS = 8_000;
const MAX_PROMPT_API_BODY_CHARS = 4_000;

// All model calls now flow through the inference gateway
// (backend/services/inference.ts), which preserves the previous defaults —
// thinking disabled unless a caller opts in (Sonnet 5 turns on adaptive
// thinking when `thinking` is omitted; these prompts expect direct,
// deterministic output) — and adds per-call telemetry. The old low-level
// createModelMessage() wrapper was removed; agents bind runInference() with
// their phase directly.

export type AnalyzeIssueInput = {
  issueTitle: string;
  issueBody: string;
  repoUrl: string;
  defaultBranch: string;
  fileTree: string[];
  packageJson: string | null;
  readme: string | null;
  sourceFiles: {
    path: string;
    contents: string;
    truncated: boolean;
  }[];
  sandboxResult: {
    baseUrl: string;
    stdout: string;
    stderr: string;
  };
  browserResult: ReproductionResult;
};

export type RepoEvidenceInput = Omit<AnalyzeIssueInput, "browserResult">;

export type GeneratedPlan = {
  rawText: string;
  parsed: unknown | null;
  parseError: string | null;
  // Present for fix proposals: every model response, including rejected
  // format attempts, for artifact debugging.
  attempts?: { rawText: string; error: string | null }[];
};

// Graph/memory context threading (docs/fable/07 + 08). Both optional so the
// pipeline degrades gracefully when graphify is unavailable or memory is
// empty. When graphContext is available the caller passes graph-hydrated
// files as `sourceFiles`, so formatRepoEvidence needs no changes.
export type PlanGenerationInput = RepoEvidenceInput & {
  graphContext?: GraphContext | null;
  pastInvestigations?: string;
};

export function buildReproductionPlanPrompt(
  input: PlanGenerationInput,
): string {
  return `
You are creating a deterministic browser reproduction plan for a GitHub issue.

Return ONLY valid JSON. Do not include markdown, explanations, comments, or code fences.

The JSON must match this exact shape:
{
  "version": ${REPRODUCTION_PLAN_VERSION},
  "baseUrl": "${input.sandboxResult.baseUrl}",
  "steps": [
    { "id": "step-1", "action": "goto", "path": "/" },
    { "id": "step-2", "action": "fill", "target": { "label": "Email" }, "value": "test@example.com" },
    { "id": "step-3", "action": "click", "target": { "role": "button", "name": "Sign in" } },
    { "id": "step-4", "action": "request", "method": "POST", "path": "/api/path", "body": { "key": "value" } }
  ],
  "expectedBehavior": "one sentence describing correct behavior",
  "failureCondition": "one sentence describing the reported failure",
  "assertion": { ... }
}

Supported step actions: goto, click, fill, waitForSelector, screenshot, wait, request.
Every step must have a unique string "id".
"goto" and "request" paths must be relative and start with "/".
Do not put method or body on "goto".

Targets describe USER INTENT, never CSS selectors. A target is an object with
one or more of: role, name, label, placeholder, text, testId, id. Values must
be strings that appear in the provided source code or page evidence.
For repeated controls, a target may include a one-level "within" object using
the same keys to identify a unique ancestor/container. Example:
{ "role": "button", "name": "✕", "within": { "role": "listitem", "text": "Set up CI pipeline" } }
Every target must resolve to exactly ONE element; execution runs in strict
mode and multiple matches fail the step. Never target generic words that
appear in buttons, filters, or headings (e.g. "Completed", "Active", "All").
Target key rules:
- "testId" is ONLY for data-testid attribute values. An HTML id attribute is
  NOT a testId - use "id" for id="..." attributes.
- For form fields, prefer "label" (the visible label text) or "placeholder";
  these match how a user identifies the field.
- Preference order: testId (when data-testid exists), then role+name, then
  label/placeholder, then id, then unique text.

Use "request" for API endpoints or server routes that are not reachable through visible page controls.
Use { "id": "...", "action": "wait", "ms": 2000 } (max 10000) after triggering asynchronous work.
IMPORTANT: if an endpoint runs work asynchronously (returns 202, "queued", a job id, or schedules a background job), insert a "wait" step long enough for the job to finish BEFORE the step that checks the resulting state; otherwise the check races the job and the bug cannot be observed.
Use this exact baseUrl: ${input.sandboxResult.baseUrl}

Browser-first reproduction policy:
- When the issue gives user-facing steps such as opening a page, filling an input, clicking a control, refreshing, or observing rendered UI, and those controls are grounded in the supplied evidence, you MUST reproduce through those browser controls first.
- Preserve the interaction surface reported by the user. Do not replace an explicit browser flow with a direct API request merely because the API produces an easier assertion.
- A response_status assertion may observe a request triggered by a browser click; response_body can likewise inspect browser-triggered traffic. Browser steps and network assertions can be combined without adding a direct "request" step.
- Direct API requests are a fallback only when the issue is explicitly API-only, the behavior is not reachable through visible page controls, or the supplied evidence cannot ground the reported browser flow.

The "assertion" describes how to detect the reported failure. It must be exactly one of:
{ "type": "response_status", "pathPattern": "/api/path", "method": "POST", "expected": 401, "failureValue": 500 }
  (pathPattern and method are optional filters; expected is the correct status; failureValue is the buggy status)
{ "type": "response_body", "pathPattern": "/api/path", "method": "GET", "failureContains": "text present only when the bug occurs", "expectedContains": "text present only when behavior is correct" }
  (checks the body of the LAST matching "request" step response; pathPattern, method, and expectedContains are optional)
{ "type": "console_error", "contains": "substring of the expected error message" }
{ "type": "page_text", "contains": "exact visible text", "failureWhen": "present" }
  (failureWhen is "present" when seeing the text proves the bug, or "absent" when missing text proves the bug)
{ "type": "input_value", "target": { "label": "Notes for Fix login redirect" }, "value": "Remember to update auth section", "failureWhen": "equals" }
  (failureWhen is "equals" when that exact form value proves the bug, or "not_equals" when any other value proves the bug)

Assertion rules:
- "console_error", "page_text", and "input_value" observe the browser page, so they are only valid when the plan contains at least one browser step (goto, click, fill, waitForSelector). A plan made only of "request" steps MUST use "response_status" or "response_body".
- page_text checks body.innerText and NEVER includes the current value of an input, textarea, or select. Use input_value for form-control state.
- Use page_text with failureWhen "absent" when the reported bug is that expected content never appears. The contains text must be the exact visible content whose presence or absence distinguishes correct and buggy behavior.
- Server-side errors (background jobs, API handlers) never appear in the browser console; detect them through the API state they corrupt, using "response_body" on a final "request" step that reads the state back.
- The failure text must be something the buggy code actually produces (copy it from the provided source), never an invented message.
${formatGraphSection(input.graphContext)}${formatPastSection(input.pastInvestigations)}
Grounding rules:
- Only reference files, routes, components, and UI strings that appear in the
  evidence below. If it is not in the evidence, it does not exist.
- If the evidence does not prove a route, element, or user flow exists, use
  the closest grounded plan instead of inventing one.

${formatRepoEvidence(input)}
`;
}

export async function generateReproductionPlan(
  input: PlanGenerationInput,
  telemetry: InferenceTelemetry | null = null,
): Promise<GeneratedPlan> {
  const prompt = buildReproductionPlanPrompt(input);

  // Same retry-once contract as fix proposals: a malformed response is fed
  // back with the extraction error so the model can correct its format.
  const result = await requestValidProposal(async (retryError) => {
    const finalPrompt =
      retryError === null
        ? prompt
        : `${prompt}

Your previous response was rejected because it was not a valid reproduction plan: ${retryError}

Respond again with ONLY the JSON object matching the exact shape shown above. Do not include markdown, code fences, reasoning, or any text before or after the JSON object.`;

    const message = await runInference(
      { phase: "plan", telemetry },
      {
        model: MODEL,
        max_tokens: 2_500,
        messages: [
          {
            role: "user",
            content: finalPrompt,
          },
        ],
      },
    );

    return getTextContent(message.content);
  });

  const lastAttempt = result.attempts[result.attempts.length - 1];

  return {
    rawText: lastAttempt?.rawText ?? "",
    parsed: result.proposal,
    parseError: result.parseError,
    attempts: result.attempts,
  };
}

// The one-shot generateFixProposal() flow was replaced by the bounded fixer
// agent in backend/agents/fixer.ts (docs/fable/10). Fix proposals are now
// authored through native tool use; only runFixAttempt() verifies them.

export type RegressionTestInput = RegressionGenerationInput;

// Single-shot structured regression-test proposal. Retry orchestration (at
// most one refinement) lives in the fix loop, which calls this again with
// feedback describing why the previous proposal was rejected. The prompt
// itself lives in regression-test.ts so its rules are unit-testable.
export async function generateRegressionTestProposal(
  input: RegressionTestInput,
  feedback: string | null,
  telemetry: InferenceTelemetry | null = null,
): Promise<unknown> {
  const message = await runInference(
    { phase: "regression_test", telemetry },
    {
      model: MODEL,
      max_tokens: 3_000,
      messages: [{ role: "user", content: buildRegressionTestPrompt(input, feedback) }],
    },
  );

  const extracted = extractFixProposalJson(getTextContent(message.content));

  return extracted.ok ? extracted.value : null;
}

export async function analyzeIssue(
  input: AnalyzeIssueInput,
  telemetry: InferenceTelemetry | null = null,
) {
  const prompt = `
You are analyzing a GitHub issue against the actual repository context.

Do not give generic possible causes. Use the provided source code and runtime logs to identify the exact root cause. Mention the specific file and logic causing the bug.
If the provided evidence is not enough to identify an exact root cause, say what evidence is missing instead of guessing.

${formatRepoEvidence(input)}

Browser evidence from Playwright:

Reproduction outcome:
${input.browserResult.outcome} — ${input.browserResult.outcomeReason}

Console errors:
${input.browserResult.consoleErrors.join("\n") || "(none)"}

Page errors:
${input.browserResult.pageErrors.join("\n") || "(none)"}

Failed network requests:
${formatNetworkFailures(input.browserResult.networkFailures)}

API responses:
${formatApiResponses(input.browserResult.apiResponses)}

Page HTML:
${truncateWithMarker(input.browserResult.html || "(empty)", MAX_PROMPT_HTML_CHARS, "HTML PROMPT TRUNCATED")}

Provide:
- Summary
- Likely project type/framework
- How to run locally
- Reproduction plan
- Exact root cause, citing the specific file and logic
- Evidence from source code and sandbox logs that supports the root cause
`;

  const message = await runInference(
    { phase: "analysis", telemetry },
    {
      model: MODEL,
      max_tokens: 900,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    },
  );

  return message.content[0];
}

// --- Memory reflection (docs/fable/08) ---
// Distills an investigation into actionable lessons for future runs.

export type MemoryReflection = {
  issueTerms: string[];
  rootCause: string;
  whatWorked: string;
  whatFailed: string;
};

// Deliberately compact input (cost): a plan SUMMARY instead of the full plan
// JSON, bounded error evidence instead of full logs/arrays, and short
// structured fields. The reflection prompt stays small and bounded.
export type MemoryReflectionInput = {
  issueTitle: string;
  outcome: string;
  // Compact official-plan summary: step count, assertion type, one-line intent.
  planSummary: string;
  // Assertion detail from the accepted reproduction result, if any.
  assertionDetail: string;
  // Bounded error evidence (first lines of outcomeReason / failed checks).
  browserErrors: string[];
  // Fix detail when available (derived from the fix attempt).
  fixRootCause: string;
  fixSummary: string;
  changedFiles: string[];
  // Failed verification checks when no fix was verified.
  failedChecks: string[];
};

const REFLECTION_MAX_EVIDENCE_LINES = 8;
const REFLECTION_MAX_LINE_CHARS = 300;

function boundLines(lines: string[], maxLines = REFLECTION_MAX_EVIDENCE_LINES): string {
  return lines
    .filter(Boolean)
    .slice(0, maxLines)
    .map((line) => {
      const first = line.split("\n")[0] ?? "";
      return first.length > REFLECTION_MAX_LINE_CHARS
        ? `${first.slice(0, REFLECTION_MAX_LINE_CHARS)}...`
        : first;
    })
    .join("\n");
}

export async function generateMemoryReflection(
  input: MemoryReflectionInput,
  telemetry: InferenceTelemetry | null = null,
): Promise<MemoryReflection> {
  const prompt = `You are recording the outcome of an automated bug investigation so future
investigations of this repository start smarter.

Return ONLY valid JSON matching the schema at the end.

## What happened

Issue title: ${input.issueTitle}
Outcome: ${input.outcome}
Official reproduction plan: ${input.planSummary || "(none)"}
Assertion detail: ${input.assertionDetail || "(none)"}
Error evidence (bounded):
${boundLines(input.browserErrors) || "(none)"}
Fix root cause: ${input.fixRootCause || "(none)"}
Fix summary: ${input.fixSummary || "(none)"}
Failed verification checks (if no verified fix):
${boundLines(input.failedChecks) || "(none)"}
Patched files (if any): ${input.changedFiles.join(", ") || "(none)"}

## Rules

1. "whatWorked" and "whatFailed" must be lessons a future investigator can
   act on (reproduction ordering, which functions mattered, misleading
   evidence) - not a summary of the bug.
2. Keep every field under 40 words. issueTerms: 3-8 lowercase keywords a
   future similar issue would likely contain.
3. If the outcome was not verified, "whatFailed" is required and must name
   the step that failed and why.
4. Record only what the evidence shows. No speculation.

## Output schema

{
  "issueTerms": ["..."],
  "rootCause": "one sentence, cite file and function",
  "whatWorked": "actionable lesson, or empty string",
  "whatFailed": "actionable lesson, or empty string"
}`;

  const message = await runInference(
    { phase: "memory_reflection", telemetry },
    {
      model: MODEL,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    },
  );

  const extracted = extractFixProposalJson(getTextContent(message.content));

  if (!extracted.ok) {
    throw new Error(`Claude returned an invalid memory reflection: ${extracted.error}`);
  }

  if (!isMemoryReflection(extracted.value)) {
    throw new Error("Claude returned a memory reflection with an invalid shape.");
  }

  return extracted.value;
}

function isMemoryReflection(value: unknown): value is MemoryReflection {
  if (!value || typeof value !== "object") {
    return false;
  }

  const reflection = value as MemoryReflection;

  return (
    Array.isArray(reflection.issueTerms) &&
    reflection.issueTerms.every((term) => typeof term === "string") &&
    typeof reflection.rootCause === "string" &&
    typeof reflection.whatWorked === "string" &&
    typeof reflection.whatFailed === "string"
  );
}

// --- Prompt sections -------------------------------------------------------

export function formatGraphSection(
  graphContext: GraphContext | null | undefined,
  label = "",
): string {
  if (!graphContext?.available) {
    return "";
  }

  const heading = label ? `GRAPH CONTEXT (${label})` : "GRAPH CONTEXT";

  return `
${heading}:

A knowledge graph built by static AST analysis of this repository. NODE lines
are real code entities with real file paths and line numbers. EDGE relations:
imports_from, contains, method, calls, uses, inherits. Confidence tags:
EXTRACTED = stated in source, treat as ground truth. INFERRED = deduced,
trust cautiously. AMBIGUOUS = never rely on alone.

NODES:
${graphContext.graphNodes || "(none)"}

EDGES:
${graphContext.graphEdges || "(none)"}
`;
}

export function formatPastSection(pastInvestigations: string | undefined): string {
  if (!pastInvestigations) {
    return "";
  }

  return `
PAST INVESTIGATIONS (this repo):

Previous issues Sherlock investigated here, with outcomes:

${pastInvestigations}

How to use these:
- Treat "verified" entries as strong hints about where similar bugs live and
  what reproduction steps work in this app.
- Treat "blocked"/"failed" entries as warnings: the listed approach did not
  work - do not repeat it unchanged.
- An entry marked STALE means the code changed since that fix. Use it as a
  starting point only; re-verify against the current evidence.
- Past investigations are hints, not evidence. The grounding rules still
  apply: never reference code that is not in the current evidence.
`;
}

export function formatRepoEvidence(input: RepoEvidenceInput) {
  return `
Repository URL:
${input.repoUrl}

Default branch:
${input.defaultBranch}

Issue title:
${input.issueTitle}

Issue body:
${input.issueBody || "(empty)"}

File tree:
${input.fileTree.join("\n")}

package.json:
${input.packageJson || "(not found)"}

README:
${input.readme || "(not found)"}

Selected source/config files with contents:
${formatSourceFiles(input.sourceFiles)}

Sandbox runtime logs:

Base URL:
${input.sandboxResult.baseUrl || "(unknown)"}

STDOUT:
${truncateWithMarker(input.sandboxResult.stdout || "(empty)", MAX_PROMPT_LOG_CHARS, "STDOUT PROMPT TRUNCATED")}

STDERR:
${truncateWithMarker(input.sandboxResult.stderr || "(empty)", MAX_PROMPT_LOG_CHARS, "STDERR PROMPT TRUNCATED")}
`;
}

function formatSourceFiles(sourceFiles: AnalyzeIssueInput["sourceFiles"]) {
  if (sourceFiles.length === 0) {
    return "(no selected source files found)";
  }

  return sourceFiles
    .map((file) => {
      const truncatedLabel = file.truncated ? " (truncated)" : "";

      return `--- ${file.path}${truncatedLabel} ---\n${file.contents}`;
    })
    .join("\n\n");
}

function formatNetworkFailures(failures: ReproductionResult["networkFailures"]) {
  if (failures.length === 0) {
    return "(none)";
  }

  return failures
    .map((failure) => {
      return `${failure.method} ${failure.url} -> ${failure.status ?? failure.failure} ${failure.statusText}`;
    })
    .join("\n");
}

function formatApiResponses(responses: ReproductionResult["apiResponses"]) {
  if (responses.length === 0) {
    return "(none)";
  }

  return responses
    .map((response) => {
      return `${response.method} ${response.url} -> ${response.status} ${response.statusText}${response.bodyTruncated ? ` (body truncated from ${response.originalBodyLength ?? "unknown"} chars)` : ""}\n${truncateWithMarker(response.body, MAX_PROMPT_API_BODY_CHARS, "API BODY PROMPT TRUNCATED")}`;
    })
    .join("\n\n");
}

function getTextContent(content: unknown[]) {
  return content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }

      return "";
    })
    .join("")
    .trim();
}
