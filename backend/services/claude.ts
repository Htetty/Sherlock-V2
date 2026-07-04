import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { GraphContext } from "./graphContext.js";

const client = new Anthropic();

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
  browserResult: BrowserResult;
};

export type ReproductionPlan = {
  baseUrl: string;
  steps: ReproductionStep[];
  expectedFailure: string;
};

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ReproductionStep =
  | {
      action: "goto";
      path: string;
    }
  | {
      action: "click";
      selector: string;
    }
  | {
      action: "fill";
      selector: string;
      value: string;
    }
  | {
      action: "waitForSelector";
      selector: string;
    }
  | {
      action: "screenshot";
    }
  | {
      action: "request";
      method: HttpMethod;
      path: string;
      body?: Record<string, unknown>;
    };

// Per-step execution record. "ambiguous" marks Playwright strict-mode
// violations (target matched multiple elements) - a plan defect, not
// evidence that the bug reproduced.
export type StepResult = {
  index: number;
  action: string;
  status: "passed" | "failed" | "skipped";
  ambiguous?: boolean;
  error?: string;
};

export type BrowserResult = {
  stepResults?: StepResult[];
  consoleLogs: string[];
  failedNetworkResponses: {
    url: string;
    status: number;
    statusText: string;
  }[];
  apiResponses: {
    method: string;
    url: string;
    status: number;
    statusText: string;
    body: string;
  }[];
  html: string;
  screenshots: string[];
  errors: string[];
};

export type RepoEvidenceInput = Omit<AnalyzeIssueInput, "browserResult">;

// --- Intent-level reproduction plan (Part 1: Graphify-grounded investigator) ---
// Model output describes user intent, never CSS selectors.
// Prompt contract: docs/fable/07-graphify-context-prompt.md

export type DomTargetIntent = {
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  testId?: string;
};

export type IntentStep =
  | { action: "goto"; path: string }
  | { action: "click"; target: DomTargetIntent }
  | { action: "fill"; target: DomTargetIntent; value: string }
  | {
      action: "assert";
      target: DomTargetIntent;
      condition: "visible" | "hidden" | "text_equals";
      value?: string;
    };

export type ReproductionIntentPlan = {
  baseUrl: string;
  steps: IntentStep[];
  expectedFailure: string;
  unknowns: string[];
};

export type IntentPlanInput = {
  issueTitle: string;
  issueBody: string;
  graphContext: GraphContext;
  fallbackSourceFiles: AnalyzeIssueInput["sourceFiles"];
  sandboxResult: AnalyzeIssueInput["sandboxResult"];
  // Rendered PAST lines from memory.json; empty string = section omitted.
  pastInvestigations?: string;
};

export async function generateIntentPlan(
  input: IntentPlanInput,
): Promise<ReproductionIntentPlan> {
  const prompt = buildInvestigatorPrompt(input);

  return parseIntentPlan(await requestJson(prompt, 1_500));
}

// Deterministic JSON generation: temperature 0 for stable output, and
// extractJsonObject to tolerate markdown fences or stray prose around the
// object. (claude-sonnet-4-6 does not support assistant prefill, so fences
// are handled by extraction rather than prevented.)
async function requestJson(prompt: string, maxTokens: number): Promise<string> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return extractJsonObject(getTextContent(message.content));
}

function extractJsonObject(text: string): string {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end <= start) {
    throw new Error("Model response contained no JSON object.");
  }

  return cleaned.slice(start, end + 1);
}

function buildInvestigatorPrompt(input: IntentPlanInput): string {
  const relevantFiles = input.graphContext.available
    ? input.graphContext.relevantFiles
    : input.fallbackSourceFiles;

  const graphSection = input.graphContext.available
    ? `## GRAPH CONTEXT

A knowledge graph built by static AST analysis of this repository. NODE lines
are real code entities with real file paths and line numbers. EDGE relations:
imports_from, contains, method, calls, uses, inherits. Confidence tags:
EXTRACTED = stated in source, treat as ground truth. INFERRED = deduced,
trust cautiously. AMBIGUOUS = never rely on alone.

NODES:
${input.graphContext.graphNodes || "(none)"}

EDGES:
${input.graphContext.graphEdges || "(none)"}`
    : `## GRAPH CONTEXT

(unavailable: ${input.graphContext.notes})
Rely on the file contents below.`;

  const pastSection = input.pastInvestigations
    ? `

## PAST INVESTIGATIONS (this repo)

Previous issues Sherlock investigated here, with outcomes:

${input.pastInvestigations}

How to use these:
- Treat "verified" entries as strong hints about where similar bugs live and
  what reproduction steps work in this app.
- Treat "blocked"/"failed" entries as warnings: the listed approach did not
  work - do not repeat it unchanged.
- An entry marked STALE means the code changed since that fix. Use it as a
  starting point only; re-verify against the GRAPH CONTEXT and file contents.
- Past investigations are hints, not evidence. The grounding rules still
  apply: never reference code that is not in the current evidence.`
    : "";

  return `You are the Investigator for an autonomous QA system. A GitHub issue was filed
against the repository below. Produce a reproduction plan describing USER
INTENT - what a human tester would do in the browser - not CSS selectors.

Return ONLY valid JSON matching the schema at the end. No markdown, no fences.

## Issue

Title: ${input.issueTitle}
Body:
${input.issueBody || "(empty)"}

${graphSection}${pastSection}

## Relevant file contents

${formatSourceFiles(relevantFiles)}

## Sandbox

Base URL: ${input.sandboxResult.baseUrl}
Startup logs (truncated):
${truncate(input.sandboxResult.stdout, 2_000) || "(empty)"}
${truncate(input.sandboxResult.stderr, 2_000) || ""}

## Rules

1. Only reference files, routes, components, and UI strings that appear in
   the evidence above. If it is not in the evidence, it does not exist.
2. If the evidence does not prove a route, selector, or user flow exists, do
   not invent it. Return the closest grounded plan and name what is missing
   in "unknowns".
3. Targets are intent objects (role/name/label/placeholder/text/testId),
   never CSS selectors.
4. Every target - especially assert targets - must resolve to exactly ONE
   element; execution runs in strict mode and multiple matches fail the step.
   Never assert on generic words that appear in buttons, filters, or headings
   (e.g. "Completed", "Active", "All"). Assert on the specific content in
   question, such as the exact task title text, or use a testId.

## Output schema

{
  "baseUrl": "${input.sandboxResult.baseUrl}",
  "steps": [
    { "action": "goto", "path": "/" },
    { "action": "fill", "target": { "label": "Email" }, "value": "test@example.com" },
    { "action": "click", "target": { "role": "button", "name": "Sign in" } },
    { "action": "assert", "target": { "text": "Welcome" }, "condition": "visible" }
  ],
  "expectedFailure": "one sentence: what currently goes wrong",
  "unknowns": ["things the evidence did not prove"]
}`;
}

// --- Fixer (Graphify Part 2) ---
// Runs only after reproduction. Prompt contract:
// docs/fable/09-graphify-fixer-prompt.md

export type FixPatchEdit = {
  path: string;
  find: string;
  replace: string;
};

export type FixResult = {
  status: "patch" | "blocked";
  rootCause: {
    file: string;
    location: string;
    explanation: string;
    evidence: string[];
  };
  patch: FixPatchEdit[];
  blockedReason: string;
};

export type FixInput = {
  issueTitle: string;
  issueBody: string;
  graphContext: GraphContext;
  intentPlanJson: string;
  expectedFailure: string;
  browserErrors: string[];
  consoleLogs: string[];
  failedResponses: string[];
  relevantFiles: AnalyzeIssueInput["sourceFiles"];
};

export async function generateFix(input: FixInput): Promise<FixResult> {
  const prompt = `You are the Fixer for an autonomous QA system. The bug below has been
REPRODUCED in a real browser: the steps ran and the expected failure was
observed. Produce the smallest patch that makes the same user intent pass.

Return ONLY valid JSON matching the schema at the end. No markdown, no fences.

## Issue

Title: ${input.issueTitle}
Body:
${input.issueBody || "(empty)"}

## GRAPH CONTEXT (refined by reproduction evidence)

Selected using the browser evidence below - it traces from the elements the
test actually touched to the handlers and routes connected to them. NODE
lines are real code entities; EDGE relations: imports_from, contains, method,
calls, uses, inherits. EXTRACTED = ground truth, INFERRED = trust cautiously,
AMBIGUOUS = never rely on alone.

NODES:
${input.graphContext.graphNodes || "(none)"}

EDGES:
${input.graphContext.graphEdges || "(none)"}

## Reproduction evidence

Intent plan that ran:
${input.intentPlanJson}

Expected failure (observed):
${input.expectedFailure}

Step errors / failing assertion:
${input.browserErrors.join("\n") || "(none)"}

Console logs:
${input.consoleLogs.join("\n") || "(none)"}

Failed network responses:
${input.failedResponses.join("\n") || "(none)"}

## Relevant file contents

${formatSourceFiles(input.relevantFiles)}

## Rules

1. Fix the root cause, not the symptom. Walk the graph from the touched
   element to its handler to its route; the bug is on that path.
2. Smallest possible change. No refactors, renames, reformatting, or fixes
   for unrelated issues.
3. Do not change UI text, roles, labels, or testids that the intent plan
   targets - verification reruns the same intent after the patch, and
   changing those strings breaks it.
4. "find" must be copied EXACTLY from the provided file contents (byte for
   byte, including whitespace) and must appear exactly once in that file.
5. Only patch files whose contents are shown above. If the root cause is in
   a file you cannot see, return "blocked" and name the file.
6. If the evidence does not prove the root cause, return "blocked" with the
   missing evidence named. Never guess.

## Output schema

{
  "status": "patch",
  "rootCause": {
    "file": "path",
    "location": "line or function",
    "explanation": "why this exact logic causes the observed failure",
    "evidence": ["one citation per claim, from graph/trace/files above"]
  },
  "patch": [
    {
      "path": "path/to/file",
      "find": "exact existing code",
      "replace": "replacement code"
    }
  ],
  "blockedReason": ""
}

When blocked: status="blocked", patch=[], blockedReason names what is missing.`;

  return parseFixResult(await requestJson(prompt, 2_000));
}

function parseFixResult(text: string): FixResult {
  const parsed = JSON.parse(text) as unknown;

  if (!isFixResult(parsed)) {
    throw new Error("Claude returned an invalid fix result.");
  }

  return parsed;
}

function isFixResult(value: unknown): value is FixResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as FixResult;
  const rootCauseValid =
    !!result.rootCause &&
    typeof result.rootCause === "object" &&
    typeof result.rootCause.file === "string" &&
    typeof result.rootCause.location === "string" &&
    typeof result.rootCause.explanation === "string" &&
    Array.isArray(result.rootCause.evidence) &&
    result.rootCause.evidence.every((item) => typeof item === "string");

  const patchValid =
    Array.isArray(result.patch) &&
    result.patch.every(
      (edit) =>
        edit &&
        typeof edit === "object" &&
        typeof edit.path === "string" &&
        typeof edit.find === "string" &&
        edit.find.length > 0 &&
        typeof edit.replace === "string" &&
        edit.find !== edit.replace,
    );

  if (!rootCauseValid || !patchValid || typeof result.blockedReason !== "string") {
    return false;
  }

  if (result.status === "patch") {
    return result.patch.length > 0;
  }

  if (result.status === "blocked") {
    return result.blockedReason.length > 0;
  }

  return false;
}

// --- Memory reflection (Part 2) ---
// Distills an investigation into actionable lessons for future runs.
// Prompt contract: docs/fable/08-memory-prompt.md

export type MemoryReflection = {
  issueTerms: string[];
  rootCause: string;
  whatWorked: string;
  whatFailed: string;
};

export async function generateMemoryReflection(input: {
  issueTitle: string;
  issueBody: string;
  outcome: string;
  intentPlanJson: string;
  browserErrors: string[];
  analysisText: string;
  patchedFiles: string[];
}): Promise<MemoryReflection> {
  const prompt = `You are recording the outcome of an automated bug investigation so future
investigations of this repository start smarter.

Return ONLY valid JSON matching the schema at the end.

## What happened

Issue title: ${input.issueTitle}
Issue body: ${input.issueBody || "(empty)"}
Outcome: ${input.outcome}
Intent plan executed: ${input.intentPlanJson}
Browser errors/evidence:
${input.browserErrors.join("\n") || "(none)"}
Root cause analysis:
${input.analysisText || "(none)"}
Patched files (if any): ${input.patchedFiles.join(", ") || "(none)"}

## Rules

1. "whatWorked" and "whatFailed" must be lessons a future investigator can
   act on (reproduction ordering, which functions mattered, misleading
   evidence) - not a summary of the bug.
2. Keep every field under 40 words. issueTerms: 3-8 lowercase keywords a
   future similar issue would likely contain.
3. If outcome was blocked/failed, "whatFailed" is required and must name the
   step that failed and why.
4. Record only what the evidence shows. No speculation.

## Output schema

{
  "issueTerms": ["..."],
  "rootCause": "one sentence, cite file and function",
  "whatWorked": "actionable lesson, or empty string",
  "whatFailed": "actionable lesson, or empty string"
}`;

  return parseMemoryReflection(await requestJson(prompt, 400));
}

function parseMemoryReflection(text: string): MemoryReflection {
  const parsed = JSON.parse(text) as unknown;

  if (!isMemoryReflection(parsed)) {
    throw new Error("Claude returned an invalid memory reflection.");
  }

  return parsed;
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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...(truncated)`;
}

function parseIntentPlan(text: string): ReproductionIntentPlan {
  const parsed = JSON.parse(text) as unknown;

  if (!isIntentPlan(parsed)) {
    throw new Error("Claude returned an invalid intent plan.");
  }

  return parsed;
}

function isIntentPlan(value: unknown): value is ReproductionIntentPlan {
  if (!value || typeof value !== "object") {
    return false;
  }

  const plan = value as ReproductionIntentPlan;

  return (
    typeof plan.baseUrl === "string" &&
    Array.isArray(plan.steps) &&
    plan.steps.length > 0 &&
    plan.steps.every(isIntentStep) &&
    typeof plan.expectedFailure === "string" &&
    Array.isArray(plan.unknowns) &&
    plan.unknowns.every((item) => typeof item === "string")
  );
}

function isIntentStep(value: unknown): value is IntentStep {
  if (!value || typeof value !== "object") {
    return false;
  }

  const step = value as Record<string, unknown>;

  switch (step.action) {
    case "goto":
      return typeof step.path === "string";
    case "click":
      return isDomTargetIntent(step.target);
    case "fill":
      return isDomTargetIntent(step.target) && typeof step.value === "string";
    case "assert":
      return (
        isDomTargetIntent(step.target) &&
        (step.condition === "visible" ||
          step.condition === "hidden" ||
          step.condition === "text_equals") &&
        (step.value === undefined || typeof step.value === "string")
      );
    default:
      return false;
  }
}

const TARGET_KEYS = [
  "role",
  "name",
  "label",
  "placeholder",
  "text",
  "testId",
] as const;

function isDomTargetIntent(value: unknown): value is DomTargetIntent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const target = value as Record<string, unknown>;
  const keys = Object.keys(target);

  return (
    keys.length > 0 &&
    keys.every((key) => (TARGET_KEYS as readonly string[]).includes(key)) &&
    keys.every((key) => typeof target[key] === "string")
  );
}

export async function generateReproductionPlan(input: RepoEvidenceInput) {
  const prompt = `
You are creating a browser reproduction plan for a GitHub issue.

Return ONLY valid JSON. Do not include markdown, explanations, comments, or code fences.

The JSON must match this exact shape:
{
  "baseUrl": "${input.sandboxResult.baseUrl}",
  "steps": [
    { "action": "goto", "path": "/" },
    { "action": "fill", "selector": "...", "value": "..." },
    { "action": "click", "selector": "..." },
    { "action": "request", "method": "POST", "path": "/api/path", "body": { "key": "value" } }
  ],
  "expectedFailure": "..."
}

Infer the steps from the issue, README, package.json, source files, and sandbox logs.
Do not hardcode login unless the evidence shows the bug is about login.
Use stable CSS selectors visible in the provided source code when possible.
Use "request" for API endpoints or server routes that are not reachable through visible page controls.
Do not put method or body on "goto"; "goto" only supports action and path.
Use this exact baseUrl: ${input.sandboxResult.baseUrl}

${formatRepoEvidence(input)}
`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return parseReproductionPlan(getTextContent(message.content));
}

export async function analyzeIssue(input: AnalyzeIssueInput) {
  const prompt = `
You are analyzing a GitHub issue against the actual repository context.

Do not give generic possible causes. Use the provided source code and runtime logs to identify the exact root cause. Mention the specific file and logic causing the bug.
If the provided evidence is not enough to identify an exact root cause, say what evidence is missing instead of guessing.

${formatRepoEvidence(input)}

Browser evidence from Playwright:

Console logs:
${input.browserResult.consoleLogs.join("\n") || "(empty)"}

Failed network responses:
${formatFailedNetworkResponses(input.browserResult.failedNetworkResponses)}

API responses:
${formatApiResponses(input.browserResult.apiResponses)}

Page HTML:
${input.browserResult.html || "(empty)"}

Screenshots:
${input.browserResult.screenshots.join("\n") || "(none)"}

Browser execution errors:
${input.browserResult.errors.join("\n") || "(none)"}

Provide:
- Summary
- Likely project type/framework
- How to run locally
- Reproduction plan
- Exact root cause, citing the specific file and logic
- Evidence from source code and sandbox logs that supports the root cause
`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return message.content[0];
}

function formatRepoEvidence(input: RepoEvidenceInput) {
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
${input.sandboxResult.stdout || "(empty)"}

STDERR:
${input.sandboxResult.stderr || "(empty)"}
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

function formatFailedNetworkResponses(
  responses: BrowserResult["failedNetworkResponses"],
) {
  if (responses.length === 0) {
    return "(none)";
  }

  return responses
    .map((response) => {
      return `${response.status} ${response.statusText} ${response.url}`;
    })
    .join("\n");
}

function formatApiResponses(responses: BrowserResult["apiResponses"]) {
  if (responses.length === 0) {
    return "(none)";
  }

  return responses
    .map((response) => {
      return `${response.method} ${response.url} -> ${response.status} ${response.statusText}\n${response.body}`;
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

function parseReproductionPlan(text: string): ReproductionPlan {
  const parsed = JSON.parse(text) as unknown;

  if (!isReproductionPlan(parsed)) {
    throw new Error("Claude returned an invalid reproduction plan.");
  }

  return parsed;
}

function isReproductionPlan(value: unknown): value is ReproductionPlan {
  if (!value || typeof value !== "object") {
    return false;
  }

  const plan = value as ReproductionPlan;

  return (
    typeof plan.baseUrl === "string" &&
    Array.isArray(plan.steps) &&
    plan.steps.every(isReproductionStep) &&
    typeof plan.expectedFailure === "string"
  );
}

function isReproductionStep(value: unknown): value is ReproductionStep {
  if (!value || typeof value !== "object") {
    return false;
  }

  const step = value as Record<string, unknown>;

  switch (step.action) {
    case "goto":
      return (
        hasOnlyKeys(step, ["action", "path"]) && typeof step.path === "string"
      );
    case "click":
    case "waitForSelector":
      return (
        hasOnlyKeys(step, ["action", "selector"]) &&
        typeof step.selector === "string"
      );
    case "fill":
      return (
        hasOnlyKeys(step, ["action", "selector", "value"]) &&
        typeof step.selector === "string" &&
        typeof step.value === "string"
      );
    case "screenshot":
      return hasOnlyKeys(step, ["action"]);
    case "request":
      return (
        hasOnlyKeys(step, ["action", "method", "path", "body"]) &&
        isHttpMethod(step.method) &&
        typeof step.path === "string" &&
        (step.body === undefined ||
          (typeof step.body === "object" && step.body !== null))
      );
    default:
      return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]) {
  return Object.keys(value).every((key) => {
    return allowedKeys.includes(key);
  });
}

function isHttpMethod(value: unknown): value is HttpMethod {
  return (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE"
  );
}
