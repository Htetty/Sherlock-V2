import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

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

export type BrowserResult = {
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
    model: "claude-sonnet-4-0",
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
