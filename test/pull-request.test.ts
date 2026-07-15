// Verified-fix-to-pull-request flow. Git branch/commit/push run for real
// against a local bare repository acting as "origin"; only the GitHub PR API
// is mocked. No network and no Claude.
delete process.env.ANTHROPIC_API_KEY;

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createArtifactStore, createFixAttemptId, createInvestigationId } from "../backend/services/artifacts.js";
import type { FixAttemptResult } from "../backend/services/fix.js";
import type { ReproductionPlan } from "../backend/services/plan.js";
import {
  buildPullRequestBody,
  createFixPullRequest,
  type GitHubClient,
  type PullRequestInput,
} from "../backend/services/pull-request.js";
import { formatPullRequestComment } from "../backend/services/report.js";

const execFileAsync = promisify(execFile);

const BUGGY_LINE = 'res.end("Internal Server Error"); // BUG';
const FIXED_LINE = 'res.end("Invalid credentials");';

async function git(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout;
}

async function createWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "sherlock-pr-"));
  const repoPath = path.join(root, "repo");
  const originPath = path.join(root, "origin.git");

  await execFileAsync("git", ["init", "--quiet", repoPath]);
  await execFileAsync("git", ["init", "--quiet", "--bare", originPath]);

  await writeFile(path.join(repoPath, "server.mjs"), `${BUGGY_LINE}\n`, "utf8");
  await writeFile(path.join(repoPath, ".env"), "SECRET_TOKEN=super-secret\n", "utf8");
  await git(repoPath, ["config", "user.email", "fixture@example.com"]);
  await git(repoPath, ["config", "user.name", "Fixture"]);
  await git(repoPath, ["add", "-A", "-f"]);
  await git(repoPath, ["commit", "--quiet", "-m", "fixture"]);

  const commit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  // Simulate the verified fix: the approved patch is applied but uncommitted.
  await writeFile(path.join(repoPath, "server.mjs"), `${FIXED_LINE}\n`, "utf8");

  return { root, repoPath, originPath, commit };
}

async function createVerifiedAttempt(root: string, commit: string, overrides: Partial<FixAttemptResult> = {}) {
  const investigationId = createInvestigationId();
  const fixAttemptId = createFixAttemptId();
  const attemptDir = path.join(root, "artifacts", investigationId, "fix-attempts", fixAttemptId);
  const store = await createArtifactStore(investigationId, attemptDir);

  await store.writeJson("post-patch-reproduction-result.json", {
    outcome: "not_reproduced",
    screenshots: ["screenshots/final.png"],
  });

  const passedChecks = [
    "original_reproduced",
    "patch_valid",
    "changes_within_scope",
    "application_restarted",
    "exact_plan_replayed",
    "failure_no_longer_observed",
    "repository_validation",
    "regression_test",
  ].map((name) => ({ name, status: "passed" as const, detail: `${name} ok` }));

  const fixAttempt: FixAttemptResult = {
    investigationId,
    fixAttemptId,
    attemptDir,
    outcome: "verified",
    reason: "All verification checks passed.",
    checks: passedChecks,
    sourceCommit: commit,
    changedFiles: ["server.mjs"],
    summary: "Return 401 for unknown users instead of a server error.",
    rootCause: "The login handler always responds with HTTP 500.",
    postPatchOutcome: "not_reproduced",
    postPatchEvidence: null,
    testRuns: [
      {
        command: "node check-login.mjs",
        exitCode: 0,
        durationMs: 1200,
        targeted: true,
        stdoutFile: "test-1-stdout.log",
        stderrFile: "test-1-stderr.log",
      },
    ],
    repositoryValidation: {
      aggregate: "passed",
      categories: [{ category: "test", status: "passed" }],
    },
    regressionTest: {
      status: "proven",
      testName: "login-does-not-return-500",
      relativePath: "sherlock-regression.test.mjs",
      runner: "node",
      sha256: "a".repeat(64),
      prePatch: "failed_as_expected",
      postPatch: "passed",
      hashMatched: true,
      generationAttempts: 1,
      reason: null,
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };

  return { investigationId, fixAttemptId, store, fixAttempt };
}

const plan: ReproductionPlan = {
  version: 1,
  baseUrl: "http://localhost:3000",
  steps: [
    { id: "step-1", action: "goto", path: "/" },
    { id: "step-2", action: "fill", selector: "[name='email']", value: "unknown@example.com" },
    { id: "step-3", action: "click", selector: "button[type='submit']" },
  ],
  expectedBehavior: "Login with unknown credentials returns HTTP 401.",
  failureCondition: "Login request returns HTTP 500.",
  assertion: {
    type: "response_status",
    pathPattern: "/api/login",
    method: "POST",
    expected: 401,
    failureValue: 500,
  },
};

function mockGitHub() {
  const calls = { find: [] as string[], create: [] as Record<string, string>[] };
  const client: GitHubClient = {
    findOpenPullRequest: async (head) => {
      calls.find.push(head);
      return null;
    },
    createPullRequest: async (params) => {
      calls.create.push(params);
      return { number: 87, url: "https://github.com/acme/app/pull/87" };
    },
  };

  return { client, calls };
}

async function buildInput(overrides: Partial<PullRequestInput> = {}) {
  const workspace = await createWorkspace();
  const attempt = await createVerifiedAttempt(workspace.root, workspace.commit);
  const github = mockGitHub();

  const input: PullRequestInput = {
    investigationId: attempt.investigationId,
    fixAttempt: attempt.fixAttempt,
    store: attempt.store,
    repoPath: workspace.repoPath,
    owner: "acme",
    repo: "app",
    baseBranch: "main",
    issueNumber: 42,
    issueTitle: "Login returns 500 for unknown users!",
    plan,
    github: github.client,
    pushUrl: workspace.originPath,
    ...overrides,
  };

  return { workspace, attempt, github, input };
}

describe("verified fix -> pull request", () => {
  test("creates a unique branch, commit, push, and pull request", async () => {
    const { workspace, attempt, github, input } = await buildInput();

    const result = await createFixPullRequest(input);

    expect(result.status).toBe("created");
    expect(result.branch).toMatch(/^sherlock\/fix-42-login-returns-500-for-un-[a-z0-9]{6}$/);
    expect(result.pullRequestNumber).toBe(87);
    expect(result.pullRequestUrl).toBe("https://github.com/acme/app/pull/87");
    expect(result.baseBranch).toBe("main");

    // The branch really exists on the remote at the recorded commit.
    const remoteRef = await git(workspace.repoPath, [
      "ls-remote",
      workspace.originPath,
      `refs/heads/${result.branch}`,
    ]);
    expect(remoteRef).toContain(result.commitSha);

    // The commit contains only the approved file and Sherlock trailers.
    const show = await git(workspace.repoPath, ["show", "--stat", "--format=%an%n%B", "HEAD"]);
    expect(show).toContain("sherlock[bot]");
    expect(show).toContain(`Sherlock-Investigation: ${attempt.investigationId}`);
    expect(show).toContain(`Sherlock-Fix-Attempt: ${attempt.fixAttemptId}`);
    expect(show).toContain("server.mjs");
    expect(show).not.toContain(".env");

    // PR opened against the original default branch with the right head.
    expect(github.calls.create).toHaveLength(1);
    expect(github.calls.create[0].base).toBe("main");
    expect(github.calls.create[0].head).toBe(result.branch);

    // Result persisted for idempotency.
    const persisted = JSON.parse(
      await readFile(path.join(attempt.store.dir, "pull-request-result.json"), "utf8"),
    );
    expect(persisted.status).toBe("created");
    expect(persisted.pullRequestNumber).toBe(87);
    expect(persisted.sourceCommit).toBe(workspace.commit);
  });

  test("an unverified fix pushes and creates nothing", async () => {
    const { workspace, github, input } = await buildInput();
    input.fixAttempt = { ...input.fixAttempt, outcome: "rejected_tests_failed" };

    const result = await createFixPullRequest(input);

    expect(result.status).toBe("precondition_failed");
    expect(result.reason).toContain("only verified fixes");
    expect(result.branch).toBeNull();
    expect(result.pullRequestNumber).toBeNull();
    expect(github.calls.create).toHaveLength(0);

    // Nothing was committed or pushed anywhere.
    expect((await git(workspace.repoPath, ["rev-parse", "HEAD"])).trim()).toBe(workspace.commit);
    expect(await git(workspace.repoPath, ["ls-remote", "--heads", workspace.originPath])).toBe("");
  });

  test("a blocked generated regression remains advisory after a healthy replay and permits the PR", async () => {
    const { github, input } = await buildInput();
    input.fixAttempt = {
      ...input.fixAttempt,
      reason:
        "The exact saved reproduction passed after the patch. The generated regression test remained blocked and was retained as advisory evidence.",
      checks: input.fixAttempt.checks.map((check) =>
        check.name === "regression_test"
          ? {
              ...check,
              status: "advisory" as const,
              detail:
                "Generated regression test was blocked after the exact replay passed.",
            }
          : check,
      ),
      regressionTest: {
        ...input.fixAttempt.regressionTest!,
        status: "blocked",
        postPatch: "failed",
        reason: "The regression test did not pass on the patched source (failed).",
      },
    };

    const body = await buildPullRequestBody(input);
    expect(body).toContain("| Generated regression test | Inconclusive");
    expect(body).not.toMatch(/\b(?:PASS|FAIL|ADVISORY)\b/);

    const result = await createFixPullRequest(input);
    expect(result.status).toBe("created");
    expect(github.calls.create).toHaveLength(1);
  });

  test("unavailable generated regression evidence remains advisory and permits a replay-verified PR", async () => {
    const { github, input } = await buildInput();
    input.fixAttempt = {
      ...input.fixAttempt,
      checks: input.fixAttempt.checks.map((check) =>
        check.name === "regression_test"
          ? {
              ...check,
              status: "advisory" as const,
              detail: "No usable generated regression test was available.",
            }
          : check,
      ),
      regressionTest: {
        status: "unavailable",
        testName: null,
        relativePath: null,
        runner: null,
        sha256: null,
        prePatch: null,
        postPatch: null,
        hashMatched: null,
        generationAttempts: 0,
        reason: "No regression-test generator was available.",
      },
    };

    const result = await createFixPullRequest(input);
    expect(result.status).toBe("created");
    expect(github.calls.create).toHaveLength(1);
  });

  test("missing regression metadata prevents PR creation", async () => {
    const { workspace, github, input } = await buildInput();
    input.fixAttempt = { ...input.fixAttempt, regressionTest: null };

    const result = await createFixPullRequest(input);

    expect(result.status).toBe("precondition_failed");
    expect(result.reason).toContain("Regression verification metadata is missing");
    expect(github.calls.create).toHaveLength(0);
    expect((await git(workspace.repoPath, ["rev-parse", "HEAD"])).trim()).toBe(
      workspace.commit,
    );
  });

  test("a failed blocking check prevents PR creation regardless of regression proof", async () => {
    const { github, input } = await buildInput();
    input.fixAttempt = {
      ...input.fixAttempt,
      checks: input.fixAttempt.checks.map((check) =>
        check.name === "repository_validation"
          ? { ...check, status: "failed" as const, detail: "Tests failed." }
          : check,
      ),
    };

    const result = await createFixPullRequest(input);

    expect(result.status).toBe("precondition_failed");
    expect(result.reason).toContain("repository_validation");
    expect(github.calls.create).toHaveLength(0);
  });

  test("duplicate execution reuses the existing pull request", async () => {
    const { github, input } = await buildInput();

    const first = await createFixPullRequest(input);
    expect(first.status).toBe("created");

    const second = await createFixPullRequest(input);

    expect(second.status).toBe("already_exists");
    expect(second.pullRequestNumber).toBe(87);
    expect(second.branch).toBe(first.branch);
    expect(github.calls.create).toHaveLength(1);
  });

  test("a push failure is persisted and no pull request is reported", async () => {
    const { attempt, github, input } = await buildInput({
      pushUrl: path.join(tmpdir(), "sherlock-pr-missing", "does-not-exist.git"),
    });

    const result = await createFixPullRequest(input);

    expect(result.status).toBe("push_failed");
    expect(result.pullRequestNumber).toBeNull();
    expect(result.pullRequestUrl).toBeNull();
    expect(github.calls.create).toHaveLength(0);

    const persisted = JSON.parse(
      await readFile(path.join(attempt.store.dir, "pull-request-result.json"), "utf8"),
    );
    expect(persisted.status).toBe("push_failed");
    expect(persisted.branch).not.toBeNull();
  });

  test("the PR body presents structured evidence without internal ids, paths, or plan dumps", async () => {
    const { workspace, attempt, input } = await buildInput();

    const body = await buildPullRequestBody(input, "sherlock/fix-42-login-abc123");

    for (const section of [
      "## Summary",
      "## Root cause",
      "## Changes",
      "## Validation",
      "## Limitations",
    ]) {
      expect(body).toContain(section);
    }

    // Structured validation truth, without raw check details.
    expect(body).toContain("| Exact reproduction replay | Passed — failure no longer observed |");
    expect(body).toContain("| Repository tests | Passed |");
    expect(body).toContain("`login-does-not-return-500`");
    expect(body).toContain("| Targeted check: `node check-login.mjs` | Passed |");

    // Native diff link instead of any diff or artifact dump.
    expect(body).toContain(
      "https://github.com/acme/app/compare/main...sherlock%2Ffix-42-login-abc123",
    );

    // No internal identifiers, artifact names, screenshot paths, repro plan
    // dumps, or local filesystem paths in the public description.
    expect(body).not.toContain(attempt.investigationId);
    expect(body).not.toContain(attempt.fixAttemptId);
    expect(body).not.toContain(workspace.commit);
    expect(body).not.toContain("git-diff.patch");
    expect(body).not.toContain("fix-proposal.json");
    expect(body).not.toContain("screenshots/final.png");
    expect(body).not.toContain("step-1: goto");
    expect(body).not.toContain(workspace.repoPath);
    expect(body).not.toContain(attempt.fixAttempt.attemptDir);
    expect(body).not.toContain("localhost");
  });

  test("secrets are redacted from the PR body and issue comment", async () => {
    const { workspace, input } = await buildInput();
    input.fixAttempt = {
      ...input.fixAttempt,
      rootCause:
        "Login crashed when DATABASE_URL=postgres://admin:hunter2@db:5432/app was unreachable.",
    };

    const body = await buildPullRequestBody(input);
    expect(body).not.toContain("hunter2");
    expect(body).toContain("REDACTED");

    const comment = formatPullRequestComment({
      investigationId: input.investigationId,
      fixAttemptId: input.fixAttempt.fixAttemptId,
      status: "pull_request_failed",
      branch: "sherlock/fix-42-login-abc123",
      reason: `push to https://x-access-token:ghs_secrettoken123@github.com/acme/app.git failed`,
    });

    expect(comment).not.toContain("ghs_secrettoken123");
    expect(comment).toContain("Branch: sherlock/fix-42-login-abc123");
    expect(comment).toContain(`Investigation: ${input.investigationId}`);
  });
});
