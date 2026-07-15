// Turns a verified local fix into a GitHub branch, commit, push, and pull
// request. Git operations run against the investigation workspace; GitHub API
// operations go through the injected GitHubClient so tests never call GitHub.

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readJsonArtifact, type ArtifactStore } from "./artifacts.js";
import type { FixAttemptResult } from "./fix.js";
import { validateFixProposalShape } from "./fix-proposal.js";
import { parseGitStatusPorcelainZ } from "./git-status.js";
import { getPlanMode, type ReproductionPlan } from "./plan.js";
import {
  buildPullRequestDescriptionData,
  renderPullRequestDescription,
  renderPullRequestTitle,
  type PullRequestReportingProposal,
} from "./pull-request-description-renderer.js";
import { createGitAuthContext, redactGitFailure, type GitAuthContext } from "./repo-auth.js";
import { redactSecrets } from "./report.js";

const execFileAsync = promisify(execFile);

export const SHERLOCK_AUTHOR_NAME = "sherlock[bot]";
export const SHERLOCK_AUTHOR_EMAIL = "sherlock[bot]@users.noreply.github.com";
const MAX_SLUG_CHARS = 24;

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

// Shared secret-path gate: true when a changed file must never be committed,
// pushed, or persisted into a delivery retry plan.
export function isForbiddenPullRequestPath(filePath: string): boolean {
  return SECRET_FILE_PATTERN.test(path.basename(filePath));
}

// Terminal-issue-comment delivery is owned by the delivery layer
// (backend/services/delivery.ts), not the pull-request flow, so there is
// deliberately no issue-comment status in this union.
export type PullRequestStatus =
  | "created"
  | "already_exists"
  | "precondition_failed"
  | "branch_creation_failed"
  | "commit_failed"
  | "push_failed"
  | "pull_request_failed";

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
  abortSignal?: AbortSignal;
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
  input.abortSignal?.throwIfAborted();

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
  const preconditionError = await checkPullRequestPreconditions(input);

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
    input.abortSignal?.throwIfAborted();
    branch = await chooseBranchName(input);
    await runGit(input.repoPath, ["checkout", "-b", branch]);
    result.branch = branch;
  } catch (error) {
    input.abortSignal?.throwIfAborted();
    return finish("branch_creation_failed", formatError(error));
  }

  // --- Commit -----------------------------------------------------------------
  try {
    input.abortSignal?.throwIfAborted();
    await runGit(input.repoPath, ["add", "--", ...input.fixAttempt.changedFiles]);

    const staged = (await runGit(input.repoPath, ["diff", "--cached", "--name-only"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const approved = new Set(input.fixAttempt.changedFiles);
    const unexpected = staged.filter((file) => !approved.has(file));
    const secretFiles = staged.filter((file) => isForbiddenPullRequestPath(file));

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
    input.abortSignal?.throwIfAborted();
    return finish("commit_failed", formatError(error));
  }

  // --- Push (never force, never the default branch) ----------------------------
  const remote = input.pushUrl ? await createPushRemote(input.pushUrl) : null;

  try {
    input.abortSignal?.throwIfAborted();
    if (!remote) {
      return finish("push_failed", "No push remote was provided.");
    }

    await runGit(input.repoPath, [
      "push",
      remote.url,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ], remote.auth);
    input.abortSignal?.throwIfAborted();
  } catch (error) {
    input.abortSignal?.throwIfAborted();
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
    input.abortSignal?.throwIfAborted();
    const head = `${input.owner}:${result.branch}`;
    const existing = await input.github.findOpenPullRequest(head);

    if (existing) {
      result.pullRequestNumber = existing.number;
      result.pullRequestUrl = existing.url;
      return finish("already_exists", "An open pull request for this branch already exists.");
    }

    const body = await buildPullRequestBody(input, result.branch);
    input.abortSignal?.throwIfAborted();
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
    input.abortSignal?.throwIfAborted();
    return finish(
      "pull_request_failed",
      `The branch ${result.branch} was pushed, but pull request creation failed: ${formatError(error)}`,
    );
  }
}

// Shared with delivery-plan capture so moving branch/PR work out of the
// investigation pipeline does not bypass any verification, scope, workspace,
// or regression-evidence gate enforced by the original PR flow.
export async function checkPullRequestPreconditions(
  input: PullRequestInput,
): Promise<string | null> {
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

// Deterministic branch name for a fix attempt. The fix-attempt id suffix keys
// the branch to one attempt of one investigation, so a delivery retry that
// lost the recorded branch name can re-derive the same branch instead of
// creating a second one.
export function buildFixBranchName(input: {
  issueNumber: number;
  issueTitle: string;
  fixAttemptId: string;
}): string {
  const slug =
    input.issueTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_CHARS)
      .replace(/-+$/g, "") || "fix";
  const shortId = input.fixAttemptId.slice(-6).toLowerCase();

  return `sherlock/fix-${input.issueNumber}-${slug}-${shortId}`;
}

async function chooseBranchName(input: PullRequestInput) {
  let branch = buildFixBranchName({
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    fixAttemptId: input.fixAttempt.fixAttemptId,
  });

  // Never reuse an existing remote branch; add fresh entropy until unique.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await remoteBranchExists(input, branch))) {
      return branch;
    }

    branch = `${buildFixBranchName({
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      fixAttemptId: input.fixAttempt.fixAttemptId,
    })}-${randomBytes(2).toString("hex")}`;
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

export function buildPullRequestTitle(
  input: Pick<PullRequestInput, "fixAttempt">,
) {
  return renderPullRequestTitle(input.fixAttempt.summary);
}

export function buildCommitMessage(
  input: Pick<PullRequestInput, "investigationId" | "fixAttempt">,
) {
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

// Builds the public pull-request description from structured fix data only.
// `branch` is the head branch the description's native compare link points
// at; when absent (e.g. legacy callers) the deterministic derived branch name
// is used, which matches the branch a workspace-less delivery retry creates.
export async function buildPullRequestBody(
  input: PullRequestInput,
  branch?: string | null,
): Promise<string> {
  const attempt = input.fixAttempt;
  const proposal = await readReportingProposal(attempt.attemptDir);

  const data = buildPullRequestDescriptionData({
    owner: input.owner,
    repo: input.repo,
    baseBranch: input.baseBranch,
    branch:
      branch ??
      buildFixBranchName({
        issueNumber: input.issueNumber,
        issueTitle: input.issueTitle,
        fixAttemptId: attempt.fixAttemptId,
      }),
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    plan: {
      stepCount: input.plan.steps.length,
      mode: getPlanMode(input.plan),
      expectedBehavior: input.plan.expectedBehavior,
      failureCondition: input.plan.failureCondition,
    },
    fixAttempt: {
      summary: attempt.summary,
      rootCause: attempt.rootCause,
      changedFiles: attempt.changedFiles,
      postPatchOutcome: attempt.postPatchOutcome,
      checks: attempt.checks.map((check) => ({
        name: check.name,
        status: check.status,
      })),
      repositoryValidation: attempt.repositoryValidation,
      regressionTest: attempt.regressionTest,
      testRuns: attempt.testRuns.map((run) => ({
        command: run.command,
        exitCode: run.exitCode,
        targeted: run.targeted,
        durationMs: run.durationMs,
        timedOut: run.timedOut ?? false,
      })),
    },
    proposal,
  });

  return renderPullRequestDescription(data);
}

// Reads the persisted fix proposal's reporting fields (risk, assumptions,
// relevant tests). Only a proposal that passes the structural validator is
// trusted; anything else yields null and the description omits review focus
// derived from it. Never throws: reporting must not fail PR delivery.
async function readReportingProposal(
  attemptDir: string,
): Promise<PullRequestReportingProposal | null> {
  try {
    const artifact = (await readJsonArtifact(
      path.join(attemptDir, "fix-proposal.json"),
    )) as { proposal?: unknown };
    const validation = validateFixProposalShape(artifact?.proposal);
    if (!validation.ok) {
      return null;
    }
    return {
      risk: validation.proposal.risk,
      assumptions: validation.proposal.assumptions,
      relevantTests: validation.proposal.relevantTests,
    };
  } catch {
    return null;
  }
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
        // status carries through so the worker retry classifier can tell a
        // transient 5xx/429 from a permanent 4xx on delivery retries.
        throw Object.assign(
          new Error(`GitHub PR lookup failed: ${response.status} ${response.statusText}`),
          { status: response.status },
        );
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
        throw Object.assign(
          new Error(
            `GitHub PR creation failed: ${response.status} ${response.statusText} ${detail.slice(0, 300)}`,
          ),
          { status: response.status },
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
