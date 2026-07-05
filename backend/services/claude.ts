import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { REPRODUCTION_PLAN_VERSION, type ReproductionPlan } from "./plan.js";
import { FIX_PROPOSAL_VERSION, PATCH_LIMITS } from "./fix-proposal.js";
import type { ReproductionResult } from "./playwright.js";

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
  browserResult: ReproductionResult;
};

export type RepoEvidenceInput = Omit<AnalyzeIssueInput, "browserResult">;

export type GeneratedPlan = {
  rawText: string;
  parsed: unknown | null;
  parseError: string | null;
};

export async function generateReproductionPlan(
  input: RepoEvidenceInput,
): Promise<GeneratedPlan> {
  const prompt = `
You are creating a deterministic browser reproduction plan for a GitHub issue.

Return ONLY valid JSON. Do not include markdown, explanations, comments, or code fences.

The JSON must match this exact shape:
{
  "version": ${REPRODUCTION_PLAN_VERSION},
  "baseUrl": "${input.sandboxResult.baseUrl}",
  "steps": [
    { "id": "step-1", "action": "goto", "path": "/" },
    { "id": "step-2", "action": "fill", "selector": "...", "value": "..." },
    { "id": "step-3", "action": "click", "selector": "..." },
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
Use stable CSS selectors visible in the provided source code when possible.
Use "request" for API endpoints or server routes that are not reachable through visible page controls.
Use { "id": "...", "action": "wait", "ms": 2000 } (max 10000) after triggering asynchronous work.
IMPORTANT: if an endpoint runs work asynchronously (returns 202, "queued", a job id, or schedules a background job), insert a "wait" step long enough for the job to finish BEFORE the step that checks the resulting state; otherwise the check races the job and the bug cannot be observed.
Use this exact baseUrl: ${input.sandboxResult.baseUrl}

The "assertion" describes how to detect the reported failure. It must be exactly one of:
{ "type": "response_status", "pathPattern": "/api/path", "method": "POST", "expected": 401, "failureValue": 500 }
  (pathPattern and method are optional filters; expected is the correct status; failureValue is the buggy status)
{ "type": "response_body", "pathPattern": "/api/path", "method": "GET", "failureContains": "text present only when the bug occurs", "expectedContains": "text present only when behavior is correct" }
  (checks the body of the LAST matching "request" step response; pathPattern, method, and expectedContains are optional)
{ "type": "console_error", "contains": "substring of the expected error message" }
{ "type": "element_text", "selector": "css selector", "contains": "text shown when the bug occurs" }

Assertion rules:
- "console_error" and "element_text" observe the browser page, so they are only valid when the plan contains at least one browser step (goto, click, fill, waitForSelector). A plan made only of "request" steps MUST use "response_status" or "response_body".
- Server-side errors (background jobs, API handlers) never appear in the browser console; detect them through the API state they corrupt, using "response_body" on a final "request" step that reads the state back.
- The failure text must be something the buggy code actually produces (copy it from the provided source), never an invented message.

${formatRepoEvidence(input)}
`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1_000,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const rawText = getTextContent(message.content);

  try {
    return { rawText, parsed: JSON.parse(rawText) as unknown, parseError: null };
  } catch (error) {
    return {
      rawText,
      parsed: null,
      parseError: `Claude did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type FixProposalInput = RepoEvidenceInput & {
  commit: string;
  plan: ReproductionPlan;
  reproductionResult: ReproductionResult;
};

export async function generateFixProposal(
  input: FixProposalInput,
): Promise<GeneratedPlan> {
  const prompt = `
You are proposing a minimal code fix for a bug that Sherlock has deterministically reproduced.

Return ONLY valid JSON. Do not include markdown, explanations, comments, or code fences.

The JSON must match this exact shape:
{
  "version": ${FIX_PROPOSAL_VERSION},
  "summary": "one sentence describing the fix",
  "rootCause": "one sentence describing the exact root cause",
  "confidence": 0.0,
  "files": [
    {
      "path": "relative/path/from/repo/root.ts",
      "edits": [
        { "oldText": "exact text currently in the file", "newText": "replacement text" }
      ]
    }
  ],
  "relevantTests": ["npm test"],
  "risk": "low",
  "assumptions": []
}

Rules:
- Each oldText must appear EXACTLY ONCE in the target file, copied verbatim including whitespace.
- Make the smallest change that fixes the root cause. Do not refactor.
- Change at most ${PATCH_LIMITS.maxChangedFiles} files and ${PATCH_LIMITS.maxChangedLines} lines.
- Never touch .env files, keys, lockfiles, GitHub workflows, or deployment configuration.
- relevantTests must be plain npm/npx/node commands (no shell operators). Use the smallest relevant project test command; use an empty array if the repository has no runnable tests.
- Do not create new files.

Repository commit: ${input.commit}

Saved reproduction plan (already verified to reproduce the bug):
${JSON.stringify(input.plan, null, 2)}

Reproduction outcome: ${input.reproductionResult.outcome} — ${input.reproductionResult.outcomeReason}
Failed assertion: ${JSON.stringify(input.reproductionResult.assertion)}
Console errors:
${input.reproductionResult.consoleErrors.join("\n") || "(none)"}
Page errors:
${input.reproductionResult.pageErrors.join("\n") || "(none)"}
Failed network requests:
${input.reproductionResult.networkFailures.map((failure) => `${failure.method} ${failure.url} -> ${failure.status ?? failure.failure}`).join("\n") || "(none)"}
API responses:
${input.reproductionResult.apiResponses.map((response) => `${response.method} ${response.url} -> ${response.status}\n${response.body}`).join("\n\n") || "(none)"}

${formatRepoEvidence(input)}
`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2_000,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const rawText = getTextContent(message.content);

  try {
    return { rawText, parsed: JSON.parse(rawText) as unknown, parseError: null };
  } catch (error) {
    return {
      rawText,
      parsed: null,
      parseError: `Claude did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function analyzeIssue(input: AnalyzeIssueInput) {
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
${input.browserResult.html || "(empty)"}

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
