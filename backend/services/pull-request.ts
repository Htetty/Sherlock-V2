// Turns a verified local fix into a GitHub branch, commit, push, and pull
// request. Git operations run against the investigation workspace; GitHub API
// operations go through the injected GitHubClient so tests never call GitHub.

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readJsonArtifact, type ArtifactStore } from "./artifacts.js";
import type { FixAttemptResult } from "./fix.js";
import { parseGitStatusPorcelainZ } from "./git-status.js";
import type { ReproductionPlan } from "./plan.js";
import { createGitAuthContext, redactGitFailure, type GitAuthContext } from "./repo-auth.js";
import { redactSecrets } from "./report.js";

const execFileAsync = promisify(execFile);

const SHERLOCK_AUTHOR_NAME = "sherlock[bot]";
const SHERLOCK_AUTHOR_EMAIL = "sherlock[bot]@users.noreply.github.com";
const MAX_SLUG_CHARS = 24;
const MAX_BODY_CHARS = 20_000;

// Blocking verification checks that must all have passed before a PR may be
// opened. Generated regression evidence is evaluated separately because it is
// advisory when the authoritative exact replay passes but generation is
// unavailable or the generated test remains blocked.
const REQUIRED_CHECKS = [
  "original_reproduced",
  "patch_valid",
  "changes_within_scope",
  "application_restarted",
  "exact_plan_replayed",
  "failure_no_longer_observed",
  "repository_validation",
];

const SECRET_FILE_PATTERN = /(^\.env|\.pem$|\.key$)/i;

export type PullRequestStatus =
  | "created"
  | "already_exists"
  | "precondition_failed"
  | "branch_creation_failed"
  | "commit_failed"
  | "push_failed"
  | "pull_request_failed"
  | "issue_comment_failed";

export type PullRequestResult = {
  status: PullRequestStatus;
  key: string;
  owner: string;
  repo: string;
  remote: string;
  branch: string | null;
  baseBranch: string;
  commitSha: string | null;
  sourceCommit: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  reason: string | null;
  startedAt: string;
  createdAt: string;
};

export type GitHubClient = {
  // head is "owner:branch"; returns the open PR if one exists.
  findOpenPullRequest: (
    head: string,
  ) => Promise<{ number: number; url: string } | null>;
  createPullRequest: (params: {
    title: string;
    head: string;
    base: string;
    body: string;
  }) => Promise<{ number: number; url: string }>;
};

export type PullRequestInput = {
  investigationId: string;
  fixAttempt: FixAttemptResult;
  store: ArtifactStore; // fix attempt store (attemptDir)
  repoPath: string;
  owner: string;
  repo: string;
  baseBranch: string;
  issueNumber: number;
  issueTitle: string;
  plan: ReproductionPlan;
  github: GitHubClient | null;
  // Remote used for collision checks and push. Production may pass an
  // x-access-token URL; it is normalized before any git argv is built.
  pushUrl: string | null;
};

const PR_RESULT_FILE = "pull-request-result.json";

export async function createFixPullRequest(
  input: PullRequestInput,
): Promise<PullRequestResult> {
  const startedAt = new Date().toISOString();
  const key = `${input.owner}/${input.repo}#${input.issueNumber}:${input.investigationId}:${input.fixAttempt.fixAttemptId}`;

  const result: PullRequestResult = {
    status: "precondition_failed",
    key,
    owner: input.owner,
    repo: input.repo,
    remote: "origin",
    branch: null,
    baseBranch: input.baseBranch,
    commitSha: null,
    sourceCommit: input.fixAttempt.sourceCommit,
    pullRequestNumber: null,
    pullRequestUrl: null,
    reason: null,
    startedAt,
    createdAt: startedAt,
  };

  if (input.pushUrl) {
    // Never persist credentials embedded in the push URL.
    result.remote = redactSecrets(input.pushUrl);
  }

  const finish = async (
    status: PullRequestStatus,
    reason: string | null = null,
  ) => {
    result.status = status;
    // Git errors can echo the tokenized push URL; scrub before persisting.
    result.reason = reason === null ? null : redactSecrets(reason);
    result.createdAt = new Date().toISOString();
    await input.store.writeJson(PR_RESULT_FILE, result);
    return result;
  };

  // --- Idempotency: reuse persisted state -----------------------------------
  const previous = await readPreviousResult(input.store);

  if (previous && previous.key === key) {
    if (previous.status === "created" || previous.status === "already_exists") {
      return {
        ...previous,
        status: "already_exists",
        reason: "A pull request for this fix attempt already exists.",
      };
    }

    // Resume after a partial failure: branch pushed but PR creation failed.
    if (
      previous.status === "pull_request_failed" &&
      previous.branch &&
      previous.commitSha
    ) {
      result.branch = previous.branch;
      result.commitSha = previous.commitSha;
      return openPullRequest(input, result, finish);
    }
  }

  // --- Preconditions ----------------------------------------------------------
  const preconditionError = await checkPreconditions(input);

  if (preconditionError) {
    return finish("precondition_failed", preconditionError);
  }

  if (!input.github || !input.pushUrl) {
    return finish(
      "precondition_failed",
      "GitHub installation credentials are not available.",
    );
  }

  // --- Duplicate check against GitHub (branch names are unique per attempt,
  // so a lost result file is recovered by the persisted-state check above and
  // this head lookup after branch selection below).

  // --- Branch -----------------------------------------------------------------
  let branch: string;

  try {
    branch = await chooseBranchName(input);
    await runGit(input.repoPath, ["checkout", "-b", branch]);
    result.branch = branch;
  } catch (error) {
    return finish("branch_creation_failed", formatError(error));
  }

  // --- Commit -----------------------------------------------------------------
  try {
    await runGit(input.repoPath, ["add", "--", ...input.fixAttempt.changedFiles]);

    const staged = (await runGit(input.repoPath, ["diff", "--cached", "--name-only"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const approved = new Set(input.fixAttempt.changedFiles);
    const unexpected = staged.filter((file) => !approved.has(file));
    const secretFiles = staged.filter((file) =>
      SECRET_FILE_PATTERN.test(path.basename(file)),
    );

    if (staged.length === 0) {
      throw new Error("Nothing was staged for the fix commit.");
    }

    if (unexpected.length > 0) {
      throw new Error(`Unexpected files staged: ${unexpected.join(", ")}`);
    }

    if (secretFiles.length > 0) {
      throw new Error(`Secret files must never be committed: ${secretFiles.join(", ")}`);
    }

    const message = buildCommitMessage(input);

    await runGit(input.repoPath, [
      "-c",
      `user.name=${SHERLOCK_AUTHOR_NAME}`,
      "-c",
      `user.email=${SHERLOCK_AUTHOR_EMAIL}`,
      "commit",
      "--no-verify",
      "-m",
      message,
    ]);

    result.commitSha = (await runGit(input.repoPath, ["rev-parse", "HEAD"])).trim();

    await input.store.writeJson("commit-result.json", {
      branch,
      commitSha: result.commitSha,
      stagedFiles: staged,
      message,
      status: (await runGit(input.repoPath, ["status", "--short"])).trim(),
    });
  } catch (error) {
    return finish("commit_failed", formatError(error));
  }

  // --- Push (never force, never the default branch) ----------------------------
  const remote = input.pushUrl ? await createPushRemote(input.pushUrl) : null;

  try {
    if (!remote) {
      return finish("push_failed", "No push remote was provided.");
    }

    await runGit(input.repoPath, [
      "push",
      remote.url,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ], remote.auth);
  } catch (error) {
    return finish("push_failed", formatError(error));
  } finally {
    await remote?.auth?.cleanup().catch(() => {});
  }

  return openPullRequest(input, result, finish);
}

async function openPullRequest(
  input: PullRequestInput,
  result: PullRequestResult,
  finish: (status: PullRequestStatus, reason?: string | null) => Promise<PullRequestResult>,
) {
  if (!input.github) {
    return finish(
      "pull_request_failed",
      "GitHub client is unavailable; the branch was pushed but no pull request was created.",
    );
  }

  try {
    const head = `${input.owner}:${result.branch}`;
    const existing = await input.github.findOpenPullRequest(head);

    if (existing) {
      result.pullRequestNumber = existing.number;
      result.pullRequestUrl = existing.url;
      return finish("already_exists", "An open pull request for this branch already exists.");
    }

    const body = await buildPullRequestBody(input);
    const created = await input.github.createPullRequest({
      title: buildPullRequestTitle(input),
      head: result.branch!,
      base: input.baseBranch,
      body,
    });

    result.pullRequestNumber = created.number;
    result.pullRequestUrl = created.url;
    return finish("created");
  } catch (error) {
    return finish(
      "pull_request_failed",
      `The branch ${result.branch} was pushed, but pull request creation failed: ${formatError(error)}`,
    );
  }
}

async function checkPreconditions(input: PullRequestInput): Promise<string | null> {
  if (input.fixAttempt.outcome !== "verified") {
    return `Fix outcome is "${input.fixAttempt.outcome}"; only verified fixes may open a pull request.`;
  }

  const passed = new Set(
    input.fixAttempt.checks
      .filter((check) => check.status === "passed")
      .map((check) => check.name),
  );
  const missing = REQUIRED_CHECKS.filter((name) => !passed.has(name));

  if (missing.length > 0) {
    return `Verification checks missing or failed: ${missing.join(", ")}.`;
  }

  const regression = input.fixAttempt.regressionTest;
  const regressionCheck = input.fixAttempt.checks.find(
    (check) => check.name === "regression_test",
  );

  if (!regression || !regressionCheck) {
    return "Regression verification metadata is missing.";
  }

  if (regression.prePatch === "unexpectedly_passed") {
    return "The generated regression test unexpectedly passed before the patch and cannot support a verified fix.";
  }

  if (regression.status === "proven") {
    if (regressionCheck.status !== "passed") {
      return "Proven regression evidence is not recorded as a passed verification check.";
    }
  } else {
    if (regressionCheck.status !== "advisory") {
      return `${regression.status} regression evidence is not recorded as advisory.`;
    }

    if (
      regression.status === "blocked" &&
      input.fixAttempt.postPatchOutcome !== "not_reproduced"
    ) {
      return "Blocked regression evidence may only be advisory after a healthy exact post-patch replay.";
    }
  }

  if (input.fixAttempt.changedFiles.length === 0) {
    return "The verified fix has no changed files.";
  }

  let head: string;
  let status: string;

  try {
    head = (await runGit(input.repoPath, ["rev-parse", "HEAD"])).trim();
      status = await runGit(input.repoPath, ["status", "--porcelain=v1", "-z"]);
  } catch (error) {
    return `The repository workspace is unavailable: ${formatError(error)}`;
  }

  if (head !== input.fixAttempt.sourceCommit) {
    return `Workspace HEAD ${head} does not match the investigation commit ${input.fixAttempt.sourceCommit}.`;
  }

  const approved = new Set(input.fixAttempt.changedFiles);
  const dirty = parseGitStatusPorcelainZ(status);
  const unrelated = dirty.filter((file) => !approved.has(file));

  if (unrelated.length > 0) {
    return `The workspace contains unrelated changes: ${unrelated.join(", ")}.`;
  }

  if (dirty.length === 0) {
    return "The workspace has no pending changes to commit.";
  }

  return null;
}

async function chooseBranchName(input: PullRequestInput) {
  const slug =
    input.issueTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_CHARS)
      .replace(/-+$/g, "") || "fix";
  const shortId = input.fixAttempt.fixAttemptId.slice(-6).toLowerCase();

  let branch = `sherlock/fix-${input.issueNumber}-${slug}-${shortId}`;

  // Never reuse an existing remote branch; add fresh entropy until unique.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await remoteBranchExists(input, branch))) {
      return branch;
    }

    branch = `sherlock/fix-${input.issueNumber}-${slug}-${shortId}-${randomBytes(2).toString("hex")}`;
  }

  throw new Error("Could not find a unique Sherlock branch name.");
}

async function remoteBranchExists(input: PullRequestInput, branch: string) {
  if (!input.pushUrl) {
    return false;
  }

  const remote = await createPushRemote(input.pushUrl);

  try {
    const output = await runGit(input.repoPath, [
      "ls-remote",
      "--heads",
      remote.url,
      `refs/heads/${branch}`,
    ], remote.auth);

    return output.trim() !== "";
  } catch {
    // If the remote cannot be queried, proceed; the push itself will surface
    // the real error and be classified as push_failed.
    return false;
  } finally {
    await remote.auth?.cleanup().catch(() => {});
  }
}

function buildPullRequestTitle(input: PullRequestInput) {
  const summary = input.fixAttempt.summary ?? "Fix verified by reproduction replay";

  return redactSecrets(`Sherlock: ${summary}`).slice(0, 120);
}

function buildCommitMessage(input: PullRequestInput) {
  const summary = (input.fixAttempt.summary ?? "verified fix").replace(/\s+/g, " ").trim();

  return redactSecrets(
    [
      `fix: ${summary.slice(0, 72)}`,
      "",
      `Sherlock-Investigation: ${input.investigationId}`,
      `Sherlock-Fix-Attempt: ${input.fixAttempt.fixAttemptId}`,
    ].join("\n"),
  );
}

export async function buildPullRequestBody(input: PullRequestInput): Promise<string> {
  const attempt = input.fixAttempt;
  const postPatch = await readPostPatchResult(attempt.attemptDir);

  const reproductionSteps = input.plan.steps
    .map((step) => `${step.id}: ${describeStep(step)}`)
    .join("\n");

  const verificationChecks = attempt.checks
    .map(
      (check) =>
        `- ${check.status === "passed" ? "PASS" : check.status === "failed" ? "FAIL" : "ADVISORY"} ${check.name}: ${check.detail}`,
    )
    .join("\n");

  const testLines =
    attempt.testRuns.length > 0
      ? attempt.testRuns
          .map(
            (run) =>
              `- \`${run.command}\` -> exit ${run.exitCode} (${run.targeted ? "targeted" : "full suite"}, ${run.durationMs}ms)`,
          )
          .join("\n")
      : "- No project test command was available.";

  const screenshots =
    postPatch?.screenshots && postPatch.screenshots.length > 0
      ? postPatch.screenshots.map((name) => `- ${name}`).join("\n")
      : "- (none)";

  const assumptions = "(recorded in fix-proposal.json)";

  const body = `## Summary

${attempt.summary ?? "Sherlock verified a minimal fix by replaying the saved reproduction."}

## Original Failure

- Reported issue: #${input.issueNumber} — ${input.issueTitle}
- Expected: ${input.plan.expectedBehavior}
- Observed before the patch: ${input.plan.failureCondition}
- The failure was deterministically reproduced before any patch was applied.

## Reproduction

Deterministic Playwright plan (base URL elided, replayed byte-identically after the patch):

\`\`\`text
${reproductionSteps}
assertion: ${JSON.stringify(input.plan.assertion)}
\`\`\`

Original outcome: **reproduced**

## Root Cause

${attempt.rootCause ?? "(see fix-proposal.json)"}

## Changes

Changed files:
${attempt.changedFiles.map((file) => `- \`${file}\``).join("\n")}

The full diff is in this pull request; the pre-commit diff is stored as the \`git-diff.patch\` artifact.

## Verification

The exact saved reproduction plan was replayed after applying the patch and restarting the application.

- Post-patch reproduction outcome: **${attempt.postPatchOutcome ?? "unknown"}**
${verificationChecks}

## Tests

${testLines}

## Evidence

- Investigation: \`${input.investigationId}\`
- Fix attempt: \`${attempt.fixAttemptId}\`
- Stored artifacts (Sherlock server, under the investigation's fix attempt): \`fix-proposal.json\`, \`proposed.patch\`, \`patch-validation.json\`, \`git-diff.patch\`, \`build-result.json\`, \`post-patch-reproduction-result.json\`, \`test-results.json\`, \`verification-result.json\`
- Post-patch screenshots:
${screenshots}

## Risk and Limitations

- Risk and assumptions: ${assumptions}
- Only the reproduction scenario above and the listed tests were exercised; adjacent behavior was not separately verified.
- The patch was verified in an isolated Sherlock workspace, not in a production environment.

## Sherlock Metadata

\`\`\`text
Investigation: ${input.investigationId}
Fix attempt: ${attempt.fixAttemptId}
Source commit: ${attempt.sourceCommit}
Verification outcome: ${attempt.outcome}
\`\`\`
`;

  return redactSecrets(body).slice(0, MAX_BODY_CHARS);
}

function describeStep(step: ReproductionPlan["steps"][number]) {
  switch (step.action) {
    case "goto":
      return `goto ${step.path}`;
    case "click":
      return `click ${describeStepTarget(step)}`;
    case "fill":
      return `fill ${describeStepTarget(step)}`;
    case "waitForSelector":
      return `wait for ${describeStepTarget(step)}`;
    case "screenshot":
      return "screenshot";
    case "wait":
      return `wait ${step.ms}ms`;
    case "request":
      return `${step.method} ${step.path}`;
  }
}

// Steps identify their element by a raw selector or an intent target object.
function describeStepTarget(
  step: { selector: string } | { target: Record<string, string | undefined> },
) {
  if ("selector" in step) {
    return step.selector;
  }

  return Object.entries(step.target)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

async function readPreviousResult(
  store: ArtifactStore,
): Promise<PullRequestResult | null> {
  try {
    return (await readJsonArtifact(
      path.join(store.dir, PR_RESULT_FILE),
    )) as PullRequestResult;
  } catch {
    return null;
  }
}

async function readPostPatchResult(attemptDir: string) {
  try {
    return (await readJsonArtifact(
      path.join(attemptDir, "post-patch-reproduction-result.json"),
    )) as { screenshots?: string[] };
  } catch {
    return null;
  }
}

// Production GitHub REST client. Tests inject a mock GitHubClient instead.
export function createGitHubRestClient(options: {
  token: string;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
}): GitHubClient {
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${options.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const pullsUrl = `${apiBaseUrl}/repos/${options.owner}/${options.repo}/pulls`;

  return {
    findOpenPullRequest: async (head) => {
      const response = await fetch(
        `${pullsUrl}?state=open&head=${encodeURIComponent(head)}`,
        { headers },
      );

      if (!response.ok) {
        throw new Error(`GitHub PR lookup failed: ${response.status} ${response.statusText}`);
      }

      const pulls = (await response.json()) as { number: number; html_url: string }[];

      if (pulls.length === 0) {
        return null;
      }

      return { number: pulls[0].number, url: pulls[0].html_url };
    },
    createPullRequest: async (params) => {
      const response = await fetch(pullsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: params.title,
          head: params.head,
          base: params.base,
          body: params.body,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `GitHub PR creation failed: ${response.status} ${response.statusText} ${detail.slice(0, 300)}`,
        );
      }

      const created = (await response.json()) as { number: number; html_url: string };

      return { number: created.number, url: created.html_url };
    },
  };
}

async function runGit(repoPath: string, args: string[], auth?: GitAuthContext | null) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: auth ? { ...process.env, ...auth.env } : process.env,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    return stdout;
  } catch (error) {
    if (error instanceof Error) {
      const token = auth?.env.SHERLOCK_GIT_TOKEN ?? null;
      error.message = redactGitFailure(error.message, token);
    }

    throw error;
  }
}

async function createPushRemote(pushUrl: string): Promise<{
  url: string;
  auth: GitAuthContext | null;
}> {
  const parsed = parseTokenRemote(pushUrl);

  if (!parsed) {
    return { url: pushUrl, auth: null };
  }

  return {
    url: parsed.url,
    auth: await createGitAuthContext(parsed.token),
  };
}

function parseTokenRemote(pushUrl: string): { url: string; token: string } | null {
  let url: URL;

  try {
    url = new URL(pushUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.username !== "x-access-token" || !url.password) {
    return null;
  }

  const token = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";

  return { url: url.toString(), token };
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
