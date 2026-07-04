import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { REPRODUCTION_PLAN_VERSION } from "./plan.js";
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

Supported step actions: goto, click, fill, waitForSelector, screenshot, request.
Every step must have a unique string "id".
"goto" and "request" paths must be relative and start with "/".
Do not put method or body on "goto".
Use stable CSS selectors visible in the provided source code when possible.
Use "request" for API endpoints or server routes that are not reachable through visible page controls.
Use this exact baseUrl: ${input.sandboxResult.baseUrl}

The "assertion" describes how to detect the reported failure. It must be exactly one of:
{ "type": "response_status", "pathPattern": "/api/path", "method": "POST", "expected": 401, "failureValue": 500 }
  (pathPattern and method are optional filters; expected is the correct status; failureValue is the buggy status)
{ "type": "console_error", "contains": "substring of the expected error message" }
{ "type": "element_text", "selector": "css selector", "contains": "text shown when the bug occurs" }

${formatRepoEvidence(input)}
`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-0",
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
    model: "claude-sonnet-4-0",
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
