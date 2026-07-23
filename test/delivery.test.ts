// Failure injection for the delivery layer: once execution reaches a
// terminal result, GitHub delivery (branch push, PR create/reuse, terminal
// issue comment) must be independently retryable, idempotent (at most one
// branch, one PR, one terminal comment), and truthful — and a delivery-only
// retry must never call the reproduction or fixer pipeline again.
import { UnrecoverableError } from "bullmq";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  isTransientInfrastructureError,
  processDeliveryJob,
  processInvestigationJob,
  type DeliveryWorkerDeps,
  type WorkerDeps,
} from "../backend/queue/process-investigation.js";
import type {
  DeliveryJobPayload,
  InvestigationJobPayload,
} from "../backend/queue/investigation-queue.js";
import {
  buildDeliveryState,
  buildTerminalComment,
  createDeliveryGitHubRestClient,
  createFileDeliveryStateStore,
  createInMemoryDeliveryStateStore,
  isDeliveryComplete,
  isFixFullyDelivered,
  reconcileTerminalCommentPaginated,
  runDeliveryFromState,
  terminalCommentMarker,
  validateDeliveryConsistency,
  DeliveryLockBusyError,
  DeliveryRetryableError,
  type DeliveryExecutorDeps,
  type DeliveryGitHubClient,
  type DeliveryState,
  type DeliveryStateInput,
  type DeliveryStateStore,
  type PullRequestRetryPlan,
} from "../backend/services/delivery.js";
import type { FixAttemptResult } from "../backend/services/fix.js";
import {
  buildInvestigationReportData,
  buildWorkerFailureReportData,
  type InvestigationReportData,
} from "../backend/services/issue-report-renderer.js";
import {
  createInMemoryInvestigationStateStore,
  createSupabaseInvestigationStateStore,
  type InvestigationStateRow,
  type InvestigationStateStore,
  type SupabaseStateStoreClient,
} from "../backend/services/investigation-state-store.js";
import type { PullRequestResult } from "../backend/services/pull-request.js";
import type { InvestigationSummary } from "../backend/services/report.js";

const INV = "inv_0TESTDELIV1";
const FIX = "fix_0TESTFIX001";
const SOURCE_COMMIT = "c0ffee123";
const EXPECTED_TREE = "baddad123";

// --- Fixtures ---------------------------------------------------------------

function verifiedSummary(): InvestigationSummary {
  return {
    investigationId: INV,
    outcome: "verified_fix",
    originalOutcome: "reproduced",
    verification: "verified",
    pullRequestStatus: "push_failed",
  };
}

const RETRY_PAYLOAD = {
  version: 1 as const,
  investigationId: INV,
  title: "Sherlock: Return 401 for unknown users",
  body: "## Summary\n\nVerified fix.",
  commitMessage: `fix: return 401\n\nSherlock-Investigation: ${INV}\nSherlock-Fix-Attempt: ${FIX}`,
  files: [{ path: "server.mjs", contents: "fixed\n", mode: "100644" as const }],
};
const fixturePayloadStore = createInMemoryDeliveryStateStore();
const RETRY_PAYLOAD_REFERENCE = await fixturePayloadStore.persistPayload(
  INV,
  "retry",
  RETRY_PAYLOAD,
);

function retryPlan(overrides: Partial<PullRequestRetryPlan> = {}): PullRequestRetryPlan {
  return {
    branch: "sherlock/fix-42-login-fix001",
    sourceCommit: SOURCE_COMMIT,
    baseBranch: "main",
    expectedTreeSha: EXPECTED_TREE,
    files: [
      {
        path: "server.mjs",
        mode: "100644",
        contentSha256:
          "0c3071418e6356e614898c84ed064ca95e88551bc0811b534bdf1952ecdae534",
      },
    ],
    payload: RETRY_PAYLOAD_REFERENCE,
    ...overrides,
  };
}

function pullRequestResult(
  status: PullRequestResult["status"],
  overrides: Partial<PullRequestResult> = {},
): PullRequestResult {
  const at = new Date().toISOString();

  return {
    status,
    key: `acme/app#42:${INV}:${FIX}`,
    owner: "acme",
    repo: "app",
    remote: "origin",
    branch: "sherlock/fix-42-login-fix001",
    baseBranch: "main",
    commitSha: null,
    sourceCommit: "c0ffee123",
    pullRequestNumber: null,
    pullRequestUrl: null,
    reason: "push failed: could not connect",
    startedAt: at,
    createdAt: at,
    ...overrides,
  };
}

async function verifiedDeliveryState(input: {
  pullRequest: PullRequestResult | null;
  retryPlan?: PullRequestRetryPlan | null;
}, store: DeliveryStateStore = createInMemoryDeliveryStateStore()): Promise<DeliveryState> {
  return buildDeliveryState({
    investigationId: INV,
    tenantId: "tenant-gh-2",
    installationId: 2,
    repoOwner: "acme",
    repoName: "app",
    issueNumber: 42,
    issueTitle: "Login returns 500",
    outcome: "verified_fix",
    summary: verifiedSummary(),
    fixVerified: true,
    fixAttemptId: FIX,
    analysisComment: null,
    fixComment: "Sherlock verified a local fix.",
    pullRequest: input.pullRequest,
    retryPlan: input.retryPlan === undefined ? retryPlan() : input.retryPlan,
  }, store);
}

function transientError(message = "GitHub is unavailable") {
  return Object.assign(new Error(message), { status: 502 });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function mockGitHub(options: {
  branchExists?: boolean;
  branchCommit?: { treeSha: string; parentShas: string[] };
  openPullRequest?: { number: number; url: string } | null;
  createPullRequestError?: unknown;
  createBranchError?: unknown;
} = {}) {
  const calls = {
    getBranch: 0,
    createBranchWithCommit: 0,
    findPullRequests: 0,
    createPullRequest: 0,
  };
  const client: DeliveryGitHubClient = {
    getBranch: async () => {
      calls.getBranch += 1;
      return options.branchExists
        ? {
            sha: "deadbeef",
            treeSha: options.branchCommit?.treeSha ?? EXPECTED_TREE,
            parentShas: options.branchCommit?.parentShas ?? [retryPlan().sourceCommit],
          }
        : null;
    },
    createBranchWithCommit: async () => {
      calls.createBranchWithCommit += 1;
      if (options.createBranchError) throw options.createBranchError;
      return { commitSha: "fee1dead", treeSha: EXPECTED_TREE };
    },
    findPullRequests: async () => {
      calls.findPullRequests += 1;
      return {
        matches: options.openPullRequest
          ? [{ ...options.openPullRequest, state: "open" as const, merged: false }]
          : [],
        conflictingBase: false,
      };
    },
    createPullRequest: async () => {
      calls.createPullRequest += 1;
      if (options.createPullRequestError) throw options.createPullRequestError;
      return { number: 7, url: "https://github.com/acme/app/pull/7" };
    },
  };

  return { client, calls };
}

function makeExecutorDeps(options: {
  github?: DeliveryGitHubClient;
  deliveryStore?: DeliveryStateStore;
  stateStore?: InvestigationStateStore;
  markerFound?: boolean;
  postCommentErrors?: unknown[];
} = {}) {
  const deliveryStore = options.deliveryStore ?? createInMemoryDeliveryStateStore();
  const stateStore = options.stateStore ?? createInMemoryInvestigationStateStore();
  const comments: string[] = [];
  const postErrors = [...(options.postCommentErrors ?? [])];

  const deps: DeliveryExecutorDeps = {
    deliveryStore,
    stateStore,
    getInstallationToken: async () => ({ token: "short-lived" }),
    createGitHubClient: () => {
      if (!options.github) {
        throw new Error("No GitHub client was expected in this test.");
      }
      return options.github;
    },
    postIssueComment: async ({ body }) => {
      const error = postErrors.shift();
      if (error) throw error;
      comments.push(body);
    },
    findTerminalComment: async () => options.markerFound ?? false,
    isRetryableError: isTransientInfrastructureError,
  };

  return { deps, deliveryStore, stateStore, comments };
}

// --- Delivery executor: per-stage failure injection --------------------------

describe("delivery executor", () => {
  test("brief lock contention is absorbed inside one delivery attempt", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
    });
    const baseStore = createInMemoryDeliveryStateStore();
    await baseStore.save(state);
    let claims = 0;
    const store: DeliveryStateStore = {
      ...baseStore,
      async withLock<T>(investigationId: string, operation: Parameters<DeliveryStateStore["withLock"]>[1]) {
        claims += 1;
        if (claims <= 2) {
          throw new DeliveryLockBusyError("cleanup briefly owns the lease");
        }
        return baseStore.withLock(investigationId, operation) as Promise<T>;
      },
    };
    const waits: number[] = [];
    const github = mockGitHub();
    const { deps } = makeExecutorDeps({ github: github.client, deliveryStore: store });
    deps.waitForDeliveryLock = async (delayMs) => {
      waits.push(delayMs);
    };

    const result = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });

    expect(result.complete).toBe(true);
    expect(claims).toBe(3);
    expect(waits).toEqual([250, 500]);
  });

  test("branch push failure: retry recreates the branch through the API, then one PR and one comment", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
    });
    expect(state.pullRequest.status).toBe("pending");
    expect(state.pullRequest.branchPushed).toBe(false);

    const github = mockGitHub();
    const { deps, comments } = makeExecutorDeps({ github: github.client });

    const { state: delivered, complete } = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });

    expect(complete).toBe(true);
    expect(isFixFullyDelivered(delivered)).toBe(true);
    expect(delivered.pullRequest).toMatchObject({
      status: "created",
      branchPushed: true,
      number: 7,
    });
    // Inspected GitHub before creating anything, and created each exactly once.
    expect(github.calls.getBranch).toBe(1);
    expect(github.calls.createBranchWithCommit).toBe(1);
    expect(github.calls.findPullRequests).toBe(2);
    expect(github.calls.createPullRequest).toBe(1);
    // Exactly one terminal comment, truthful about the delivered PR.
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("opened a pull request");
    expect(comments[0]).toContain("https://github.com/acme/app/pull/7");
    expect(comments[0]).toContain(terminalCommentMarker(INV));
  });

  test("existing branch and open PR are reused; nothing is created twice", async () => {
    // Simulates a crash after push+PR creation but before any state persisted.
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
    });
    const github = mockGitHub({
      branchExists: true,
      openPullRequest: { number: 12, url: "https://github.com/acme/app/pull/12" },
    });
    const { deps, comments } = makeExecutorDeps({ github: github.client });

    const { state: delivered, complete } = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });

    expect(complete).toBe(true);
    expect(delivered.pullRequest).toMatchObject({ status: "reused", number: 12 });
    expect(github.calls.createBranchWithCommit).toBe(0);
    expect(github.calls.createPullRequest).toBe(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("https://github.com/acme/app/pull/12");
  });

  test("an existing branch is reused only when its commit matches this investigation and source", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
    });
    const github = mockGitHub({
      branchExists: true,
      branchCommit: {
        treeSha: "badcafe99",
        parentShas: [retryPlan().sourceCommit],
      },
    });
    const { deps, comments } = makeExecutorDeps({ github: github.client });

    const { state: delivered } = await runDeliveryFromState(state, deps, {
      isFinalAttempt: true,
    });

    expect(delivered.pullRequest.status).toBe("failed");
    expect(delivered.pullRequest.branchPushed).toBe(false);
    expect(github.calls.createBranchWithCommit).toBe(0);
    expect(github.calls.createPullRequest).toBe(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("did not open a pull request");
  });

  test("two concurrent delivery attempts serialize the full reconcile and create one of each GitHub resource", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
    });
    const deliveryStore = createInMemoryDeliveryStateStore();
    await deliveryStore.save(state);
    const github = mockGitHub();
    const fixture = makeExecutorDeps({
      github: github.client,
      deliveryStore,
    });

    const [first, second] = await Promise.all([
      runDeliveryFromState(state, fixture.deps, { isFinalAttempt: false }),
      runDeliveryFromState(state, fixture.deps, { isFinalAttempt: false }),
    ]);

    expect(first.complete).toBe(true);
    expect(second.complete).toBe(true);
    expect(github.calls.createBranchWithCommit).toBe(1);
    expect(github.calls.createPullRequest).toBe(1);
    expect(fixture.comments).toHaveLength(1);
  });

  test("credential-shaped source is never placed in persisted delivery state", async () => {
    const credential = "github_pat_EXAMPLECREDENTIAL123456";
    const store = createInMemoryDeliveryStateStore();
    const payload = await store.persistPayload(INV, "retry", {
      ...RETRY_PAYLOAD,
      files: [
        {
          path: "server.mjs",
          contents: `const token = \"${credential}\";\n`,
          mode: "100644",
        },
      ],
    });
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
      retryPlan: retryPlan({
        files: [
          {
            path: "server.mjs",
            mode: "100644",
            contentSha256: "b".repeat(64),
          },
        ],
        payload,
      }),
    });

    expect(state.retryPlan).not.toBeNull();
    expect(state.pullRequest.status).toBe("pending");
    expect(JSON.stringify(state)).not.toContain(credential);
    expect(JSON.stringify(state)).not.toContain("contents");
  });

  test("pull-request API failure: branch stays pushed, PR is created exactly once on retry", async () => {
    // In-pipeline result: push succeeded, PR creation failed.
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("pull_request_failed", {
        reason: "GitHub PR creation failed: 502",
      }),
    });
    expect(state.pullRequest.branchPushed).toBe(true);

    const github = mockGitHub({ branchExists: true });
    const { deps, comments } = makeExecutorDeps({ github: github.client });

    const { state: delivered } = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });

    // The already-pushed branch is verified, then never re-pushed or recreated.
    expect(github.calls.getBranch).toBe(1);
    expect(github.calls.createBranchWithCommit).toBe(0);
    expect(github.calls.createPullRequest).toBe(1);
    expect(delivered.pullRequest.status).toBe("created");
    expect(comments).toHaveLength(1);
  });

  test("transient PR failure keeps state pending (with partial progress) and the comment is never posted early", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
    });
    const failing = mockGitHub({ createPullRequestError: transientError() });
    const { deps, deliveryStore, comments } = makeExecutorDeps({
      github: failing.client,
    });

    await expect(
      runDeliveryFromState(state, deps, { isFinalAttempt: false }),
    ).rejects.toBeInstanceOf(DeliveryRetryableError);

    // No comment before the PR state is final: the terminal comment must
    // describe the true delivery result.
    expect(comments).toHaveLength(0);

    // Partial progress persisted: the branch now exists, PR still pending.
    const stored = await deliveryStore.load(INV);
    expect(stored?.pullRequest.status).toBe("pending");
    expect(stored?.pullRequest.branchPushed).toBe(true);

    // Retry from the stored state: branch is NOT recreated, one PR, one comment.
    const healthy = mockGitHub({ branchExists: true });
    const retry = makeExecutorDeps({
      github: healthy.client,
      deliveryStore,
    });

    const { state: delivered, complete } = await runDeliveryFromState(
      stored!,
      retry.deps,
      { isFinalAttempt: false },
    );

    expect(complete).toBe(true);
    expect(delivered.pullRequest.status).toBe("created");
    expect(healthy.calls.createBranchWithCommit).toBe(0);
    expect(healthy.calls.createPullRequest).toBe(1);
    expect(retry.comments).toHaveLength(1);
  });

  test("a non-retryable PR failure is recorded permanently and the comment truthfully reports it", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("pull_request_failed"),
    });
    const github = mockGitHub({
      createPullRequestError: Object.assign(new Error("validation failed"), {
        status: 422,
      }),
    });
    const { deps, comments, stateStore } = makeExecutorDeps({ github: github.client });

    const { state: delivered, complete } = await runDeliveryFromState(state, deps, {
      isFinalAttempt: true,
    });

    // Delivery is complete (the comment was posted) but the fix is NOT fully
    // delivered — and the comment says so.
    expect(complete).toBe(true);
    expect(delivered.pullRequest.status).toBe("failed");
    expect(isFixFullyDelivered(delivered)).toBe(false);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("pull request creation failed");
    expect(comments[0]).not.toContain("opened a pull request");

    const record = await stateStore.get?.(INV);
    expect(record?.pullRequest?.status).toBe("failed");
    expect(record?.terminalComment?.status).toBe("posted");
    expect(record?.pullRequestStatus).toBe("delivery_failed");
  });

  test("a transient PR ambiguity remains pending even on the final configured attempt", async () => {
    const deliveryStore = createInMemoryDeliveryStateStore();
    const state = await verifiedDeliveryState(
      { pullRequest: pullRequestResult("pull_request_failed") },
      deliveryStore,
    );
    const github = mockGitHub({ createPullRequestError: transientError() });
    const { deps, comments } = makeExecutorDeps({
      github: github.client,
      deliveryStore,
    });

    await expect(
      runDeliveryFromState(state, deps, { isFinalAttempt: true }),
    ).rejects.toBeInstanceOf(DeliveryRetryableError);
    expect((await deliveryStore.load(INV))?.pullRequest.status).toBe("pending");
    expect(comments).toHaveLength(0);
  });

  test("an ambiguous comment create is attempted once and later retries fail closed", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("created", {
        pullRequestNumber: 9,
        pullRequestUrl: "https://github.com/acme/app/pull/9",
        reason: null,
      }),
    });
    const { deps, deliveryStore, comments } = makeExecutorDeps({
      postCommentErrors: [transientError("comment post failed")],
    });

    await expect(
      runDeliveryFromState(state, deps, { isFinalAttempt: false }),
    ).rejects.toBeInstanceOf(DeliveryRetryableError);
    expect(comments).toHaveLength(0);

    const stored = (await deliveryStore.load(INV)) ?? state;
    expect(stored.terminalComment.createAttemptedAt).toEqual(expect.any(String));
    const retry = makeExecutorDeps({ deliveryStore });
    await expect(
      runDeliveryFromState(stored, retry.deps, { isFinalAttempt: false }),
    ).rejects.toBeInstanceOf(DeliveryRetryableError);
    expect(retry.comments).toHaveLength(0);
  });

  test("an already-posted terminal comment (found by marker) is never duplicated", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("created", {
        pullRequestNumber: 9,
        pullRequestUrl: "https://github.com/acme/app/pull/9",
        reason: null,
      }),
    });
    const { deps, comments } = makeExecutorDeps({ markerFound: true });

    const { state: delivered, complete } = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });

    expect(complete).toBe(true);
    expect(delivered.terminalComment.status).toBe("posted");
    expect(comments).toHaveLength(0);
  });

  test("a terminal delivery state makes further runs no-ops", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("created", {
        pullRequestNumber: 9,
        pullRequestUrl: "https://github.com/acme/app/pull/9",
        reason: null,
      }),
    });
    const first = makeExecutorDeps({});
    const { state: delivered } = await runDeliveryFromState(state, first.deps, {
      isFinalAttempt: false,
    });
    expect(first.comments).toHaveLength(1);

    // Second run over the delivered state: no GitHub calls, no comment.
    const second = makeExecutorDeps({});
    const { complete } = await runDeliveryFromState(delivered, second.deps, {
      isFinalAttempt: false,
    });

    expect(complete).toBe(true);
    expect(second.comments).toHaveLength(0);
  });

  test("state-store write failures never break delivery; a healthy retry heals the record", async () => {
    // Execution-time Supabase outage: nothing was ever recorded. Delivery
    // still completes with a broken store...
    const throwingStore: InvestigationStateStore = {
      async record() {
        throw new Error("Supabase state-store write failed: db unreachable");
      },
    };
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
    });
    const github = mockGitHub();
    const broken = makeExecutorDeps({
      github: github.client,
      stateStore: throwingStore,
    });

    const { state: delivered, complete } = await runDeliveryFromState(state, broken.deps, {
      isFinalAttempt: false,
    });
    expect(complete).toBe(true);
    expect(broken.comments).toHaveLength(1);

    // ...and a delivery run against a healthy Supabase-shaped store heals the
    // full record: identity, outcome, PR status, and comment status.
    const rows = new Map<string, InvestigationStateRow>();
    const supabaseClient: SupabaseStateStoreClient = {
      async fetchByInvestigationId(id) {
        return rows.get(id)?.record ?? null;
      },
      async upsert(row) {
        rows.set(row.investigation_id, row);
      },
      async listByUpdatedAtDesc() {
        return [...rows.values()].map((row) => row.record);
      },
    };
    const supabaseStore = createSupabaseInvestigationStateStore(supabaseClient);
    const healthy = makeExecutorDeps({ stateStore: supabaseStore });

    await runDeliveryFromState(
      delivered,
      healthy.deps,
      { isFinalAttempt: false },
    );

    const row = rows.get(INV)!;
    expect(row.tenant_id).toBe("tenant-gh-2");
    expect(row.installation_id).toBe(2);
    expect(row.outcome).toBe("verified_fix");
    expect(row.record.originalOutcome).toBe("reproduced");
    expect(row.record.pullRequestStatus).toBe("created");
    expect(row.record.pullRequest).toMatchObject({ status: "created", number: 7 });
    expect(row.record.terminalComment?.status).toBe("posted");
    // No credentials anywhere in the persisted row.
    expect(JSON.stringify(row)).not.toContain("short-lived");
  });
});

describe("workspace-less branch reconstruction", () => {
  test("a verified file deletion becomes a null-sha Git tree entry and never creates a blob", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });

      if (url.endsWith("/git/commits/c0ffee123") && init?.method === "GET") {
        return Response.json({ tree: { sha: "ba5e7ee" } });
      }
      if (url.endsWith("/git/trees")) {
        return Response.json({ sha: "deadcafe1" });
      }
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        return Response.json({ sha: "c011117" });
      }
      if (url.includes("/git/ref/heads/") && init?.method === undefined) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/git/refs")) {
        return Response.json({ ref: "refs/heads/sherlock/fix-42-delete" });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = createDeliveryGitHubRestClient({
        token: "short-lived",
        owner: "acme",
        repo: "app",
      });
      await client.createBranchWithCommit({
        branch: "sherlock/fix-42-delete",
        baseCommitSha: "c0ffee123",
        message: RETRY_PAYLOAD.commitMessage,
        authorDate: new Date(0).toISOString(),
        files: [{ path: "obsolete.mjs", contents: null, mode: "100644" }],
        expectedTreeSha: "deadcafe1",
        assertOwnership: async () => {},
      });

      expect(requests.some(({ url }) => url.endsWith("/git/blobs"))).toBe(false);
      const treeRequest = requests.find(({ url }) => url.endsWith("/git/trees"));
      expect(JSON.parse(String(treeRequest?.init?.body))).toMatchObject({
        tree: [{ path: "obsolete.mjs", mode: "100644", type: "blob", sha: null }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// --- Worker integration: delivery is decoupled from the pipeline -------------

const investigationPayload: InvestigationJobPayload = {
  investigationId: INV,
  tenantId: "tenant-gh-2",
  installationId: 2,
  repositoryOwner: "acme",
  repositoryName: "app",
  repositoryUrl: "https://github.com/acme/app",
  defaultBranch: "main",
  issueNumber: 42,
  issueTitle: "Login returns 500",
  issueBody: "Something broke",
  issueUrl: "https://github.com/acme/app/issues/42",
  triggeringCommentId: 4242,
  triggerComment: "/sherlock investigate",
  triggeredBy: "octocat",
  sourceRef: "main",
  deliveryId: "delivery-1",
};

const deliveryPayload: DeliveryJobPayload = {
  investigationId: INV,
  tenantId: "tenant-gh-2",
  installationId: 2,
  repositoryOwner: "acme",
  repositoryName: "app",
  issueNumber: 42,
};

function verifiedPipelineResult(pullRequest: PullRequestResult | null) {
  return {
    investigationId: INV,
    outcome: "verified_fix",
    summary: verifiedSummary(),
    githubComment: "PIPELINE COMMENT",
    fixAttempt: { outcome: "verified", fixAttemptId: FIX } as FixAttemptResult,
    pullRequest,
    commentSections: { analysis: null, fix: "Sherlock verified a local fix." },
    pullRequestRetryPlan: retryPlan(),
  };
}

function makeWorkerDeps(options: {
  pipelineResult?: ReturnType<typeof verifiedPipelineResult>;
  github?: DeliveryGitHubClient;
  postCommentErrors?: unknown[];
  stateStore?: InvestigationStateStore;
  deliveryStore?: DeliveryStateStore;
}) {
  const deliveryStore =
    options.deliveryStore ?? createInMemoryDeliveryStateStore();
  const enqueued: DeliveryJobPayload[] = [];
  const comments: string[] = [];
  const postErrors = [...(options.postCommentErrors ?? [])];
  let pipelineCalls = 0;

  const deps: WorkerDeps = {
    stateStore: options.stateStore ?? createInMemoryInvestigationStateStore(),
    delivery: {
      store: deliveryStore,
      enqueue: async (payload) => {
        enqueued.push(payload);
      },
      createGitHubClient: () => {
        if (!options.github) {
          throw new Error("No GitHub client was expected in this test.");
        }
        return options.github;
      },
      findTerminalComment: async () => false,
    },
    runPipeline: async () => {
      pipelineCalls += 1;
      if (!options.pipelineResult) {
        throw new Error("The pipeline must not run in this test.");
      }
      return options.pipelineResult;
    },
    getInstallationToken: async () => ({ token: "short-lived", permissions: null }),
    postIssueComment: async ({ body }) => {
      const error = postErrors.shift();
      if (error) throw error;
      comments.push(body);
    },
  };

  return {
    deps,
    deliveryStore,
    enqueued,
    comments,
    pipelineCalls: () => pipelineCalls,
  };
}

describe("worker delivery decoupling", () => {
  test("a rejected fix attempt delivers the reproduced result without a fix identity", async () => {
    const summary: InvestigationSummary = {
      investigationId: INV,
      outcome: "reproduced",
    };
    const fixture = makeWorkerDeps({
      pipelineResult: {
        ...verifiedPipelineResult(null),
        outcome: "reproduced",
        summary,
        githubComment: "Sherlock reproduced the reported failure.",
        fixAttempt: {
          outcome: "rejected_regression_test_failed",
          fixAttemptId: FIX,
        } as FixAttemptResult,
        pullRequest: null,
        commentSections: {
          analysis: "The bug was reproduced, but no fix passed verification.",
          fix: null,
        },
        pullRequestRetryPlan: null,
      },
    });

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).resolves.toEqual({ investigationId: INV, outcome: "reproduced" });

    await expect(fixture.deliveryStore.load(INV)).resolves.toMatchObject({
      executionOutcome: "reproduced",
      fixVerified: false,
      fixAttemptId: null,
      pullRequest: { status: "not_applicable" },
      terminalComment: { status: "posted" },
    });
    expect(fixture.comments).toHaveLength(1);
    expect(fixture.comments[0]).toContain("reproduced the reported failure");
  });

  test("a fully successful run delivers inline: no retry job, one marked comment", async () => {
    const fixture = makeWorkerDeps({
      pipelineResult: verifiedPipelineResult(
        pullRequestResult("created", {
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          reason: null,
        }),
      ),
    });

    const outcome = await processInvestigationJob(
      { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
      fixture.deps,
    );

    expect(outcome).toEqual({ investigationId: INV, outcome: "verified_fix" });
    expect(fixture.enqueued).toHaveLength(0);
    expect(fixture.comments).toHaveLength(1);
    expect(fixture.comments[0]).toContain("opened a pull request");
    expect(fixture.comments[0]).toContain(terminalCommentMarker(INV));

    const stored = await fixture.deliveryStore.load(INV);
    expect(stored && isDeliveryComplete(stored)).toBe(true);
    expect(stored && isFixFullyDelivered(stored)).toBe(true);
  });

  test("an ambiguous comment create queues delivery-only reconciliation without rerunning the pipeline", async () => {
    const fixture = makeWorkerDeps({
      pipelineResult: verifiedPipelineResult(
        pullRequestResult("created", {
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          reason: null,
        }),
      ),
      postCommentErrors: [transientError("comment post failed")],
    });

    // The investigate job COMPLETES (no pipeline-rerunning retry) and hands
    // the unfinished comment to the delivery-only job.
    const outcome = await processInvestigationJob(
      { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
      fixture.deps,
    );
    expect(outcome.outcome).toBe("verified_fix");
    expect(fixture.pipelineCalls()).toBe(1);
    expect(fixture.comments).toHaveLength(0);
    expect(fixture.enqueued).toEqual([deliveryPayload]);

    // The delivery retry reconciles but does not blindly create again.
    await expect(
      processDeliveryJob(
        { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 4 } },
        fixture.deps,
      ),
    ).rejects.toThrow(/acknowledgement remains ambiguous/i);
    expect(fixture.pipelineCalls()).toBe(1);
    expect(fixture.comments).toHaveLength(0);
  });

  test("unfinished PR delivery defers to the delivery job, which pushes, opens the PR, and comments once", async () => {
    const github = mockGitHub();
    const stateStore = createInMemoryInvestigationStateStore();
    const fixture = makeWorkerDeps({
      pipelineResult: verifiedPipelineResult(pullRequestResult("push_failed")),
      github: github.client,
      stateStore,
    });

    const outcome = await processInvestigationJob(
      { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
      fixture.deps,
    );

    // Execution completed; no comment yet (the PR state is not final).
    expect(outcome.outcome).toBe("verified_fix");
    expect(fixture.comments).toHaveLength(0);
    expect(fixture.enqueued).toEqual([deliveryPayload]);

    const result = await processDeliveryJob(
      { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 4 } },
      fixture.deps,
    );

    expect(result.outcome).toBe("verified_fix");
    expect(fixture.pipelineCalls()).toBe(1);
    expect(github.calls.createBranchWithCommit).toBe(1);
    expect(github.calls.createPullRequest).toBe(1);
    expect(fixture.comments).toHaveLength(1);
    expect(fixture.comments[0]).toContain("opened a pull request");
    expect(stateStore.snapshot().find((record) => record.investigationId === INV)?.stage)
      .toBe("completed");

    // Running the delivery job again is a no-op: no duplicates anywhere.
    await processDeliveryJob(
      { data: deliveryPayload, attemptsMade: 1, opts: { attempts: 4 } },
      fixture.deps,
    );
    expect(github.calls.createBranchWithCommit).toBe(1);
    expect(github.calls.createPullRequest).toBe(1);
    expect(fixture.comments).toHaveLength(1);
  });

  test("the production deferred verified-fix shape persists before return and delivers on the retry-plan branch", async () => {
    const github = mockGitHub();
    const createBranch = vi.spyOn(github.client, "createBranchWithCommit");
    const result = {
      ...verifiedPipelineResult(null),
      report: verifiedReportData(),
    };
    const fixture = makeWorkerDeps({ pipelineResult: result, github: github.client });
    let executionCalls = 0;
    let stateBeforePipelineReturn: DeliveryState | null = null;
    fixture.deps.runPipeline = async (_payload, options) => {
      executionCalls += 1;
      await options.onTerminalResult?.(result);
      // Production cleanup runs only after this terminal callback and return
      // boundary. The pending delivery state and protected payload must already
      // be durable before that cleanup can begin.
      stateBeforePipelineReturn = await fixture.deliveryStore.load(INV);
      return result;
    };

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).resolves.toMatchObject({ outcome: "verified_fix" });

    expect(executionCalls).toBe(1);
    expect(stateBeforePipelineReturn).toMatchObject({
      executionOutcome: "verified_fix",
      fixVerified: true,
      pullRequest: {
        status: "pending",
        branch: retryPlan().branch,
        number: null,
        url: null,
      },
      retryPlan: { branch: retryPlan().branch },
      terminalComment: { status: "pending" },
    });
    const pending = await fixture.deliveryStore.load(INV);
    expect(pending).not.toBeNull();
    await expect(
      fixture.deliveryStore.loadPayload(INV, pending!.terminalPayload),
    ).resolves.toMatchObject({ version: 2, investigationId: INV });
    expect(fixture.enqueued).toEqual([deliveryPayload]);
    expect(fixture.comments).toHaveLength(0);

    await expect(
      processDeliveryJob(
        { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 4 } },
        fixture.deps,
      ),
    ).resolves.toMatchObject({ outcome: "verified_fix" });

    expect(executionCalls).toBe(1);
    expect(createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branch: retryPlan().branch }),
    );
    expect(fixture.comments).toHaveLength(1);
  });

  test("an investigate-job retry after terminal execution resumes delivery only (pipeline is not called)", async () => {
    // Simulates a stalled/crashed worker: delivery state persisted, job retried.
    const fixture = makeWorkerDeps({});
    await fixture.deliveryStore.save(
      await verifiedDeliveryState({
        pullRequest: pullRequestResult("created", {
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          reason: null,
        }),
      }),
    );

    const outcome = await processInvestigationJob(
      { data: investigationPayload, attemptsMade: 1, opts: { attempts: 3 } },
      fixture.deps,
    );

    expect(outcome).toEqual({ investigationId: INV, outcome: "verified_fix" });
    expect(fixture.pipelineCalls()).toBe(0);
    expect(fixture.comments).toHaveLength(1);
  });

  test("terminal delivery state is persisted before the pipeline returns, so a post-terminal crash resumes delivery only", async () => {
    const result = verifiedPipelineResult(
      pullRequestResult("created", {
        pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/acme/app/pull/7",
        reason: null,
      }),
    );
    const fixture = makeWorkerDeps({ pipelineResult: result });
    let executionCalls = 0;
    fixture.deps.runPipeline = async (_payload, options) => {
      executionCalls += 1;
      await options.onTerminalResult?.(result);
      throw transientError("worker connection dropped after terminal execution");
    };

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);

    expect(await fixture.deliveryStore.load(INV)).not.toBeNull();
    expect(fixture.comments).toHaveLength(0);

    const resumed = await processInvestigationJob(
      { data: investigationPayload, attemptsMade: 1, opts: { attempts: 3 } },
      fixture.deps,
    );

    expect(resumed.outcome).toBe("verified_fix");
    expect(executionCalls).toBe(1);
    expect(fixture.comments).toHaveLength(1);
  });

  test("delivery-state read failures never fall through to execution adapters", async () => {
    const unreadableStore: DeliveryStateStore = {
      async load() {
        throw new Error("delivery volume temporarily unavailable");
      },
      async save() {},
      async withLock(_investigationId, operation) {
        return operation();
      },
    };
    const fixture = makeWorkerDeps({
      pipelineResult: verifiedPipelineResult(null),
      deliveryStore: unreadableStore,
    });

    const rejection = await processInvestigationJob(
      { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
      fixture.deps,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(UnrecoverableError);
    expect(fixture.pipelineCalls()).toBe(0);
    expect(fixture.comments).toHaveLength(0);
  });

  test("a required delivery-state write failure stops permanently and never falls back to a pipeline-rerunning delivery path", async () => {
    const unwritableStore: DeliveryStateStore = {
      async load() {
        return null;
      },
      async save() {
        throw new Error("delivery volume is read-only");
      },
      async loadTerminalFailure() {
        return null;
      },
      async saveTerminalFailure() {
        throw new Error("delivery volume is read-only");
      },
      async persistPayload() {
        throw new Error("delivery volume is read-only");
      },
      async loadPayload() {
        throw new Error("delivery volume is read-only");
      },
      async withLock(_investigationId, operation) {
        return operation({
          token: "test",
          renew: async () => {},
          assertOwned: async () => {},
        });
      },
    };
    const fixture = makeWorkerDeps({
      pipelineResult: verifiedPipelineResult(null),
      deliveryStore: unwritableStore,
    });

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fixture.pipelineCalls()).toBe(1);
    expect(fixture.enqueued).toHaveLength(0);
    expect(fixture.comments).toHaveLength(0);
  });

  test("the delivery processor runs with no pipeline, Anthropic, reproduction, fixer, sandbox, or validation adapter", async () => {
    const store = createInMemoryDeliveryStateStore();
    await store.save(
      await verifiedDeliveryState({
        pullRequest: pullRequestResult("created", {
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          reason: null,
        }),
      }),
    );
    const comments: string[] = [];

    // DeliveryWorkerDeps intentionally has no execution-stage surface. If the
    // delivery processor reached any such adapter, this object could not run.
    const deliveryOnlyDeps: DeliveryWorkerDeps = {
      delivery: {
        store,
        enqueue: async () => {},
        createGitHubClient: () => {
          throw new Error("No branch or PR work is pending.");
        },
        findTerminalComment: async () => false,
      },
      getInstallationToken: async () => ({
        token: "short-lived",
        permissions: null,
      }),
      postIssueComment: async ({ body }) => {
        comments.push(body);
      },
    };

    await processDeliveryJob(
      { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 4 } },
      deliveryOnlyDeps,
    );

    expect(comments).toHaveLength(1);
  });

  test("a new worker instance resumes from the atomic on-disk delivery record without persisted credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sherlock-delivery-"));
    try {
      const firstWorkerStore = createFileDeliveryStateStore(root);
      await firstWorkerStore.save(
        await verifiedDeliveryState({
          pullRequest: pullRequestResult("created", {
            pullRequestNumber: 7,
            pullRequestUrl: "https://github.com/acme/app/pull/7",
            reason: null,
          }),
        }, firstWorkerStore),
      );

      const persisted = await readFile(
        path.join(root, INV, "delivery-state.json"),
        "utf8",
      );
      expect(persisted).not.toContain("short-lived");
      expect(persisted).not.toContain("ANTHROPIC_API_KEY");
      expect(persisted).not.toContain("WEBHOOK_SECRET");

      const restartedWorkerStore = createFileDeliveryStateStore(root);
      const comments: string[] = [];
      const restartedDeps: DeliveryWorkerDeps = {
        delivery: {
          store: restartedWorkerStore,
          enqueue: async () => {},
          createGitHubClient: () => {
            throw new Error("No branch or PR work is pending.");
          },
          findTerminalComment: async () => false,
        },
        getInstallationToken: async () => ({
          token: "fresh-short-lived",
          permissions: null,
        }),
        postIssueComment: async ({ body }) => {
          comments.push(body);
        },
      };

      await processDeliveryJob(
        { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 4 } },
        restartedDeps,
      );
      expect(comments).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a delivery job without persisted state fails permanently instead of guessing", async () => {
    const fixture = makeWorkerDeps({});

    await expect(
      processDeliveryJob(
        { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 4 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fixture.comments).toHaveLength(0);
  });

  test("an integrity-valid but malformed terminal payload blocks every GitHub side effect", async () => {
    const store = createInMemoryDeliveryStateStore();
    const state = await verifiedDeliveryStateV2(
      { pullRequest: pullRequestResult("push_failed") },
      store,
    );
    const malformedReport = structuredClone(verifiedReportData()) as
      InvestigationReportData & Record<string, unknown>;
    delete malformedReport.fixReason;
    state.terminalPayload = await store.persistPayload(INV, "terminal", {
      version: 2,
      investigationId: INV,
      report: malformedReport,
    });
    await store.save(state);

    const github = mockGitHub();
    const fixture = makeWorkerDeps({ deliveryStore: store, github: github.client });
    const scan = vi.fn(async () => false);
    const update = vi.fn();
    fixture.deps.delivery.findTerminalComment = scan;
    fixture.deps.updateIssueComment = update;

    await expect(
      processDeliveryJob(
        { data: deliveryPayload, attemptsMade: 3, opts: { attempts: 4 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fixture.pipelineCalls()).toBe(0);
    expect(github.calls).toEqual({
      getBranch: 0,
      createBranchWithCommit: 0,
      findPullRequests: 0,
      createPullRequest: 0,
    });
    expect(scan).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(fixture.comments).toHaveLength(0);
    await expect(store.load(INV)).resolves.toMatchObject({
      pullRequest: { status: "pending", branchPushed: false },
      terminalComment: { status: "pending" },
    });
  });
});

// --- Structured v2 terminal payloads ------------------------------------------

function verifiedReportData(): InvestigationReportData {
  return buildInvestigationReportData({
    summary: verifiedSummary(),
    fixAttempt: {
      outcome: "verified",
      reason: "All verification checks passed.",
      rootCause: "The login handler always responds with HTTP 500.",
      summary: "Return 401 for unknown users.",
      changedFiles: ["server.mjs"],
      checks: [],
      postPatchOutcome: "not_reproduced",
      repositoryValidation: {
        aggregate: "passed",
        categories: [{ category: "test", status: "passed" }],
      },
      regressionTest: null,
    },
  });
}

function verifiedDeliveryInput(
  overrides: Partial<DeliveryStateInput> = {},
): DeliveryStateInput {
  return {
    investigationId: INV,
    tenantId: "tenant-gh-2",
    installationId: 2,
    repoOwner: "acme",
    repoName: "app",
    issueNumber: 42,
    issueTitle: "Login returns 500",
    outcome: "verified_fix",
    summary: verifiedSummary(),
    fixVerified: true,
    fixAttemptId: FIX,
    analysisComment: null,
    fixComment: null,
    report: verifiedReportData(),
    pullRequest: null,
    retryPlan: retryPlan(),
    ...overrides,
  };
}

async function verifiedDeliveryStateV2(input: {
  pullRequest: PullRequestResult | null;
  retryPlan?: PullRequestRetryPlan | null;
}, store: DeliveryStateStore = createInMemoryDeliveryStateStore()): Promise<DeliveryState> {
  return buildDeliveryState({
    investigationId: INV,
    tenantId: "tenant-gh-2",
    installationId: 2,
    repoOwner: "acme",
    repoName: "app",
    issueNumber: 42,
    issueTitle: "Login returns 500",
    outcome: "verified_fix",
    summary: verifiedSummary(),
    fixVerified: true,
    fixAttemptId: FIX,
    analysisComment: null,
    fixComment: null,
    report: verifiedReportData(),
    pullRequest: input.pullRequest,
    retryPlan: input.retryPlan === undefined ? retryPlan() : input.retryPlan,
  }, store);
}

describe("authoritative delivery consistency validation", () => {
  test("invalid construction performs no protected-payload write and leaves no artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sherlock-prevalidate-"));
    try {
      const store = createFileDeliveryStateStore(root);
      const persist = vi.spyOn(store, "persistPayloadTracked");
      await expect(
        buildDeliveryState(
          verifiedDeliveryInput({ fixVerified: false, fixAttemptId: null }),
          store,
        ),
      ).rejects.toThrow(/execution and verification outcomes disagree/i);
      expect(persist).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("valid deferred construction persists one terminal payload with the final reference", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sherlock-valid-payload-"));
    try {
      const store = createFileDeliveryStateStore(root);
      const persist = vi.spyOn(store, "persistPayloadTracked");
      const state = await buildDeliveryState(verifiedDeliveryInput(), store);

      expect(persist).toHaveBeenCalledTimes(1);
      expect(state.pullRequest).toMatchObject({
        status: "pending",
        branch: retryPlan().branch,
        number: null,
        url: null,
      });
      expect(state.retryPlan?.branch).toBe(retryPlan().branch);
      const payloadFiles = await readdir(
        path.join(root, INV, "protected-delivery"),
      );
      expect(payloadFiles).toEqual([state.terminalPayload.sha256]);
      await expect(
        store.loadPayload(INV, state.terminalPayload),
      ).resolves.toMatchObject({ version: 2, investigationId: INV });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a concurrent valid file-store publication keeps content created by a failing construction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sherlock-retained-payload-race-"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const base = createFileDeliveryStateStore(root);
      const createdByA = deferred<Awaited<
        ReturnType<DeliveryStateStore["persistPayloadTracked"]>
      >>();
      const resumeA = deferred();
      const failingStore: DeliveryStateStore = {
        ...base,
        async persistPayloadTracked(investigationId, kind, payload) {
          const persisted = await base.persistPayloadTracked(
            investigationId,
            kind,
            payload,
          );
          createdByA.resolve(persisted);
          await resumeA.promise;
          // Force the unexpected post-write reference-verification failure only
          // after construction B has reused and durably referenced the real
          // content-addressed file.
          return {
            created: persisted.created,
            reference: {
              ...persisted.reference,
              sizeBytes: persisted.reference.sizeBytes + 1,
            },
          };
        },
      };
      const input = verifiedDeliveryInput({
        pullRequest: pullRequestResult("created", {
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          reason: null,
        }),
      });

      const constructionA = buildDeliveryState(input, failingStore);
      const payloadA = await createdByA.promise;
      expect(payloadA.created).toBe(true);

      let constructionBCreated: boolean | null = null;
      const publishingStore: DeliveryStateStore = {
        ...base,
        async persistPayloadTracked(investigationId, kind, payload) {
          const persisted = await base.persistPayloadTracked(
            investigationId,
            kind,
            payload,
          );
          constructionBCreated = persisted.created;
          return persisted;
        },
      };
      const stateB = await buildDeliveryState(input, publishingStore);
      expect(constructionBCreated).toBe(false);
      expect(stateB.terminalPayload).toEqual(payloadA.reference);
      await base.save(stateB);

      resumeA.resolve();
      await expect(constructionA).rejects.toThrow(
        /does not match its validated content identity/i,
      );
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("content was retained"),
      );

      const durable = await base.load(INV);
      expect(durable?.terminalPayload).toEqual(payloadA.reference);
      await expect(
        base.loadPayload(INV, durable!.terminalPayload),
      ).resolves.toMatchObject({ version: 2, investigationId: INV });

      const resumed = makeExecutorDeps({ deliveryStore: base });
      await expect(
        runDeliveryFromState(durable!, resumed.deps, { isFinalAttempt: false }),
      ).resolves.toMatchObject({ complete: true });
      expect(resumed.comments).toHaveLength(1);
    } finally {
      warning.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("post-write validation failure retains a pre-existing content-addressed payload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sherlock-existing-payload-"));
    try {
      const base = createFileDeliveryStateStore(root);
      const existing = await base.persistPayloadTracked(INV, "terminal", {
        unique: "pre-existing-construction-payload",
      });
      expect(existing.created).toBe(true);
      const store: DeliveryStateStore = {
        ...base,
        async persistPayloadTracked() {
          return { reference: existing.reference, created: false };
        },
      };

      await expect(
        buildDeliveryState(verifiedDeliveryInput(), store),
      ).rejects.toThrow(/does not match its validated content identity/i);
      await expect(base.loadPayload(INV, existing.reference)).resolves.toEqual({
        unique: "pre-existing-construction-payload",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts representative pending, delivered, and worker-failure states", async () => {
    const pending = await verifiedDeliveryStateV2({
      pullRequest: pullRequestResult("push_failed"),
    });
    const verifiedPayload = {
      version: 2 as const,
      investigationId: INV,
      report: verifiedReportData(),
    };
    expect(() => validateDeliveryConsistency(pending, verifiedPayload)).not.toThrow();

    const delivered = await verifiedDeliveryStateV2({
      pullRequest: pullRequestResult("created", {
        pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/acme/app/pull/7",
        reason: null,
      }),
    });
    expect(() => validateDeliveryConsistency(delivered, verifiedPayload)).not.toThrow();

    const workerReport = buildWorkerFailureReportData({
      error: "The investigation worker failed permanently.",
      stage: "failed",
    });
    const worker = await buildDeliveryState(
      {
        investigationId: INV,
        tenantId: "tenant-gh-2",
        installationId: 2,
        repoOwner: "acme",
        repoName: "app",
        issueNumber: 42,
        issueTitle: "Login returns 500",
        outcome: "failed",
        summary: {
          investigationId: INV,
          outcome: "execution_failed",
          stage: "failed",
          error: "The investigation worker failed permanently.",
        },
        fixVerified: false,
        fixAttemptId: null,
        analysisComment: null,
        fixComment: null,
        report: workerReport,
        pullRequest: null,
        retryPlan: null,
      },
      createInMemoryDeliveryStateStore(),
    );
    expect(() =>
      validateDeliveryConsistency(worker, {
        version: 2,
        investigationId: INV,
        report: workerReport,
      }),
    ).not.toThrow();
  });

  test.each([
    ["execution/fix outcome", (state: DeliveryState) => { state.executionOutcome = "reproduced"; }],
    ["verified fix identity", (state: DeliveryState) => { state.fixAttemptId = null; }],
    ["no-fix identity", (state: DeliveryState) => {
      state.executionOutcome = "reproduced";
      state.fixVerified = false;
    }],
    ["pending retry plan", (state: DeliveryState) => { state.retryPlan = null; }],
    ["pull-request number/url", (state: DeliveryState) => {
      state.pullRequest.number = 7;
      state.pullRequest.url = null;
    }],
    ["pull-request status", (state: DeliveryState) => {
      state.pullRequest.status = "created";
      state.retryPlan = null;
    }],
    ["comment status/timestamp", (state: DeliveryState) => {
      state.terminalComment.status = "posted";
      state.terminalComment.postedAt = null;
    }],
    ["comment/PR ordering", (state: DeliveryState) => {
      state.terminalComment.status = "posted";
      state.terminalComment.postedAt = state.createdAt;
    }],
    ["state timestamp ordering", (state: DeliveryState) => {
      state.updatedAt = new Date(Date.parse(state.createdAt) - 1).toISOString();
    }],
    ["comment timestamp ordering", (state: DeliveryState) => {
      state.terminalComment.createAttemptedAt = new Date(
        Date.parse(state.updatedAt) + 1,
      ).toISOString();
    }],
    ["unknown pull-request status", (state: DeliveryState) => {
      state.pullRequest.status = "unknown" as DeliveryState["pullRequest"]["status"];
    }],
    ["unknown comment status", (state: DeliveryState) => {
      state.terminalComment.status = "unknown" as DeliveryState["terminalComment"]["status"];
    }],
  ])("rejects inconsistent %s", async (_label, mutate) => {
    const state = structuredClone(
      await verifiedDeliveryStateV2({
        pullRequest: pullRequestResult("push_failed"),
      }),
    );
    mutate(state);
    expect(() => validateDeliveryConsistency(state)).toThrow(
      /internally inconsistent/i,
    );
  });

  test("rejects payload identity and report-outcome disagreements", async () => {
    const state = await verifiedDeliveryStateV2({
      pullRequest: pullRequestResult("push_failed"),
    });
    expect(() =>
      validateDeliveryConsistency(state, {
        version: 2,
        investigationId: "inv_0OTHERDELIV",
        report: verifiedReportData(),
      }),
    ).toThrow(/different investigation/i);
    expect(() =>
      validateDeliveryConsistency(state, {
        version: 2,
        investigationId: INV,
        report: buildWorkerFailureReportData({ error: "failed" }),
      }),
    ).toThrow(/report and execution outcomes disagree/i);
  });

  test("the durable store applies the same semantic validator", async () => {
    const store = createInMemoryDeliveryStateStore();
    const state = await verifiedDeliveryStateV2(
      { pullRequest: pullRequestResult("push_failed") },
      store,
    );
    state.retryPlan = null;
    await expect(store.save(state)).rejects.toThrow(/internally inconsistent/i);
  });
});

describe("structured v2 terminal payloads", () => {
  test("delivery renders the structured report against the final PR state, with no visible ids", async () => {
    const state = await verifiedDeliveryStateV2({
      pullRequest: pullRequestResult("push_failed"),
    });
    const github = mockGitHub();
    const { deps, comments } = makeExecutorDeps({ github: github.client });

    const { complete } = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });

    expect(complete).toBe(true);
    expect(comments).toHaveLength(1);
    const comment = comments[0];
    expect(comment).toContain("**Fix verified**");
    expect(comment).not.toContain("### Root cause");
    expect(comment).not.toContain("### Validation");
    expect(comment).toContain("opened the verified fix");
    expect(comment).toContain("https://github.com/acme/app/pull/7");
    expect(comment).toContain(terminalCommentMarker(INV));
    expect(
      comment.endsWith(
        `${terminalCommentMarker(INV)}\n\n<!-- sherlock-delivery-comment:${INV} -->`,
      ),
    ).toBe(true);
    expect(comment.match(/<!-- sherlock-terminal-comment:/g)).toHaveLength(1);
    expect(comment.match(/<!-- sherlock-delivery-comment:/g)).toHaveLength(1);
    // The investigation id appears only inside the two hidden markers.
    expect(comment.split(INV)).toHaveLength(3);
    expect(comment).not.toMatch(/Investigation: inv_/);
    expect(comment).not.toContain(FIX);
  });

  test("a v2 report tells the truth when PR delivery failed permanently", async () => {
    const state = await verifiedDeliveryStateV2({
      pullRequest: pullRequestResult("push_failed"),
      retryPlan: null,
    });
    expect(state.pullRequest.status).toBe("failed");

    const comment = buildTerminalComment(state, {
      version: 2,
      investigationId: INV,
      report: verifiedReportData(),
    });
    expect(comment).toContain(
      "did not open a pull request because GitHub delivery failed",
    );
    expect(comment).not.toContain("opened a pull request with the verified fix:");
  });

  test.each([
    ["merged", "already merged"],
    ["blocked", "closed without being merged"],
    ["reused", "contains this fix"],
  ] as const)("a v2 report renders the %s PR state truthfully", async (status, phrase) => {
    const state = await verifiedDeliveryStateV2({
      pullRequest: pullRequestResult("push_failed"),
    });
    state.pullRequest.status = status;
    state.pullRequest.branchPushed = true;
    state.pullRequest.number = 12;
    state.pullRequest.url = "https://github.com/acme/app/pull/12";

    const comment = buildTerminalComment(state, {
      version: 2,
      investigationId: INV,
      report: verifiedReportData(),
    });
    expect(comment).toContain(phrase);
  });

  test("v1 pending payloads and v2 payloads both load and render (v1 keeps its legacy shape)", async () => {
    const storeV1 = createInMemoryDeliveryStateStore();
    const stateV1 = await verifiedDeliveryState(
      {
        pullRequest: pullRequestResult("created", {
          pullRequestNumber: 9,
          pullRequestUrl: "https://github.com/acme/app/pull/9",
          reason: null,
        }),
      },
      storeV1,
    );
    const v1 = makeExecutorDeps({ deliveryStore: storeV1 });
    const v1Run = await runDeliveryFromState(stateV1, v1.deps, {
      isFinalAttempt: false,
    });
    expect(v1Run.complete).toBe(true);
    expect(v1.comments).toHaveLength(1);
    // Legacy presentation is preserved for old payloads.
    expect(v1.comments[0]).toContain("Outcome: verified_fix");
    expect(v1.comments[0]).toContain("Sherlock verified a local fix.");

    const storeV2 = createInMemoryDeliveryStateStore();
    const stateV2 = await verifiedDeliveryStateV2(
      {
        pullRequest: pullRequestResult("created", {
          pullRequestNumber: 9,
          pullRequestUrl: "https://github.com/acme/app/pull/9",
          reason: null,
        }),
      },
      storeV2,
    );
    const v2 = makeExecutorDeps({ deliveryStore: storeV2 });
    const v2Run = await runDeliveryFromState(stateV2, v2.deps, {
      isFinalAttempt: false,
    });
    expect(v2Run.complete).toBe(true);
    expect(v2.comments).toHaveLength(1);
    expect(v2.comments[0]).toContain("**Fix verified**");
    expect(v2.comments[0]).not.toContain("### Validation");
    expect(v2.comments[0]).not.toContain("Outcome: verified_fix");
  });
});

// --- Pre-pipeline worker failures reconcile the queued comment ----------------

describe("worker failure comment reconciliation", () => {
  test("a pre-pipeline failure updates the owned queued comment instead of posting a second comment", async () => {
    const fixture = makeWorkerDeps({});
    const updates: { commentId: number; body: string }[] = [];
    fixture.deps.delivery.findTerminalComment = async () => ({
      terminalCommentId: null,
      reusableCommentId: 55,
    });
    fixture.deps.updateIssueComment = async ({ commentId, body }) => {
      updates.push({ commentId, body });
    };

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 2, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    // The queued comment was updated in place; nothing was created.
    expect(fixture.comments).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].commentId).toBe(55);
    expect(updates[0].body).toContain("internal failure");
    expect(updates[0].body).toContain(terminalCommentMarker(INV));
    expect(updates[0].body).not.toMatch(/Investigation: inv_/);
  });

  test("an existing terminal comment suppresses any further failure comment", async () => {
    const fixture = makeWorkerDeps({});
    fixture.deps.delivery.findTerminalComment = async () => ({
      terminalCommentId: 90,
      reusableCommentId: null,
    });
    fixture.deps.updateIssueComment = async () => {
      throw new Error("must not update");
    };

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 2, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fixture.comments).toHaveLength(0);
  });

  test.each([
    ["transient 503", Object.assign(new Error("scan unavailable"), { status: 503 })],
    ["timeout", Object.assign(new Error("scan timed out"), { code: "ETIMEDOUT" })],
    ["ambiguous response", Object.assign(new Error("ambiguous response"), { status: 502 })],
    ["authentication 401", Object.assign(new Error("authentication failed"), { status: 401 })],
    ["authorization 403", Object.assign(new Error("authorization failed"), { status: 403 })],
    ["missing-resource 404", Object.assign(new Error("resource missing"), { status: 404 })],
    ["untyped error", new Error("comment scan failed")],
  ])("a %s scan failure creates nothing and queues delivery-only retry", async (_name, scanError) => {
    const fixture = makeWorkerDeps({});
    const updates = vi.fn();
    fixture.deps.updateIssueComment = updates;
    fixture.deps.delivery.findTerminalComment = async () => {
      throw scanError;
    };

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 2, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fixture.comments).toHaveLength(0);
    expect(updates).not.toHaveBeenCalled();
    expect(fixture.enqueued).toEqual([deliveryPayload]);
    expect(fixture.pipelineCalls()).toBe(1);
    await expect(fixture.deliveryStore.load(INV)).resolves.toMatchObject({
      executionOutcome: "failed",
      terminalComment: { status: "pending", createAttemptedAt: null },
    });

    await expect(
      processDeliveryJob(
        { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 6 } },
        fixture.deps,
      ),
    ).rejects.toThrow(/reconciliation is incomplete/i);
    expect(fixture.pipelineCalls()).toBe(1);
    expect(fixture.comments).toHaveLength(0);
    expect(updates).not.toHaveBeenCalled();
  });

  test("an invalid comment-list response creates nothing and queues delivery-only retry", async () => {
    const fixture = makeWorkerDeps({});
    const updates = vi.fn();
    fixture.deps.updateIssueComment = updates;
    fixture.deps.delivery.findTerminalComment = async (input) =>
      reconcileTerminalCommentPaginated({
        terminalMarker: input.marker,
        reusableMarker: input.reusableMarker,
        appId: 123,
        assertOwnership: input.assertOwnership,
        listPage: async () => [
          {
            id: 77,
            body: 42 as unknown as string,
            performed_via_github_app: { id: 123 },
          },
        ],
      });

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 2, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fixture.comments).toHaveLength(0);
    expect(updates).not.toHaveBeenCalled();
    expect(fixture.enqueued).toEqual([deliveryPayload]);
    expect(fixture.pipelineCalls()).toBe(1);
    await expect(fixture.deliveryStore.load(INV)).resolves.toMatchObject({
      executionOutcome: "failed",
      terminalComment: { status: "pending", createAttemptedAt: null },
    });

    await expect(
      processDeliveryJob(
        { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 6 } },
        fixture.deps,
      ),
    ).rejects.toThrow(/reconciliation is incomplete/i);
    expect(fixture.pipelineCalls()).toBe(1);
    expect(fixture.comments).toHaveLength(0);
    expect(updates).not.toHaveBeenCalled();
  });

  test("a complete scan with no owned report creates exactly one marked comment", async () => {
    const fixture = makeWorkerDeps({});
    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 2, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(fixture.comments).toHaveLength(1);
    expect(fixture.comments[0]).toContain(terminalCommentMarker(INV));
    expect(fixture.enqueued).toHaveLength(0);
  });

  test("a queued-comment update failure never falls back to create", async () => {
    const fixture = makeWorkerDeps({});
    fixture.deps.delivery.findTerminalComment = async () => ({
      terminalCommentId: null,
      reusableCommentId: 55,
    });
    fixture.deps.updateIssueComment = async () => {
      throw Object.assign(new Error("update timed out"), { code: "ETIMEDOUT" });
    };

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 2, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fixture.comments).toHaveLength(0);
    expect(fixture.enqueued).toEqual([deliveryPayload]);
    await expect(fixture.deliveryStore.load(INV)).resolves.toMatchObject({
      terminalComment: { status: "pending", createAttemptedAt: null },
    });
  });

  test("lost create acknowledgement preserves intent and reconciles without a second create", async () => {
    const fixture = makeWorkerDeps({});
    let scan = 0;
    let creates = 0;
    fixture.deps.delivery.findTerminalComment = async () => {
      scan += 1;
      if (scan <= 2) return false;
      if (scan === 3) throw Object.assign(new Error("scan unavailable"), { status: 503 });
      return true;
    };
    fixture.deps.postIssueComment = async () => {
      creates += 1;
      throw Object.assign(new Error("acknowledgement lost"), { status: 503 });
    };

    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 2, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(fixture.deliveryStore.load(INV)).resolves.toMatchObject({
      terminalComment: { status: "pending", createAttemptedAt: expect.any(String) },
    });

    await expect(
      processDeliveryJob(
        { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 6 } },
        fixture.deps,
      ),
    ).resolves.toMatchObject({ outcome: "failed" });
    expect(creates).toBe(1);
    await expect(fixture.deliveryStore.load(INV)).resolves.toMatchObject({
      terminalComment: { status: "posted" },
    });
  });

  test("an investigation-worker restart resumes ambiguous failure delivery without rerunning execution", async () => {
    const fixture = makeWorkerDeps({});
    fixture.deps.delivery.findTerminalComment = async () => {
      throw Object.assign(new Error("scan unavailable"), { status: 503 });
    };
    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 2, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fixture.pipelineCalls()).toBe(1);

    fixture.deps.delivery.findTerminalComment = async () => false;
    await expect(
      processInvestigationJob(
        { data: investigationPayload, attemptsMade: 0, opts: { attempts: 3 } },
        fixture.deps,
      ),
    ).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.pipelineCalls()).toBe(1);
    expect(fixture.comments).toHaveLength(1);
  });
});

// --- Terminal comment truthfulness -------------------------------------------

describe("terminal comment truthfulness", () => {
  test("fully delivered verified fix names the pull request", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("created", {
        pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/acme/app/pull/7",
        reason: null,
      }),
    });

    const comment = buildTerminalComment(state, {
      version: 1,
      investigationId: INV,
      summary: verifiedSummary(),
      analysisComment: null,
      fixComment: "Sherlock verified a local fix.",
    });
    expect(comment).toContain("verified a fix");
    expect(comment).toContain("Pull request: created");
    expect(comment).toContain("https://github.com/acme/app/pull/7");
    expect(comment).toContain(terminalCommentMarker(INV));
  });

  test("fix verified but PR delivery failed says so and never claims a PR", async () => {
    const state = await verifiedDeliveryState({
      pullRequest: pullRequestResult("push_failed"),
      retryPlan: null,
    });
    expect(state.pullRequest.status).toBe("failed");

    const comment = buildTerminalComment(state, {
      version: 1,
      investigationId: INV,
      summary: verifiedSummary(),
      analysisComment: null,
      fixComment: "Sherlock verified a local fix.",
    });
    expect(comment).toContain("Pull request: delivery_failed");
    expect(comment).toContain("did not open a pull request");
    expect(comment).not.toContain("opened a pull request");
  });

  test("reproduced without a verified fix has no pull-request section", async () => {
    const summary = { investigationId: INV, outcome: "reproduced" as const };
    const state = await buildDeliveryState({
      investigationId: INV,
      tenantId: "tenant-gh-2",
      installationId: 2,
      repoOwner: "acme",
      repoName: "app",
      issueNumber: 42,
      issueTitle: "Login returns 500",
      outcome: "reproduced",
      summary,
      fixVerified: false,
      fixAttemptId: null,
      analysisComment: "Analysis:\nThe handler always returns 500.",
      fixComment: null,
      pullRequest: null,
      retryPlan: null,
    }, createInMemoryDeliveryStateStore());

    const comment = buildTerminalComment(state, {
      version: 1,
      investigationId: INV,
      summary,
      analysisComment: "Analysis:\nThe handler always returns 500.",
      fixComment: null,
    });
    expect(comment).toContain("Sherlock reproduced the reported failure.");
    expect(comment).toContain("Analysis:");
    expect(comment).not.toContain("Pull request:");
  });

  test("a failed investigation reports the failure outcome", async () => {
    const summary = {
      investigationId: INV,
      outcome: "execution_failed" as const,
      error: "the reproduction runner crashed",
    };
    const state = await buildDeliveryState({
      investigationId: INV,
      tenantId: "tenant-gh-2",
      installationId: 2,
      repoOwner: "acme",
      repoName: "app",
      issueNumber: 42,
      issueTitle: "Login returns 500",
      outcome: "execution_failed",
      summary,
      fixVerified: false,
      fixAttemptId: null,
      analysisComment: null,
      fixComment: null,
      pullRequest: null,
      retryPlan: null,
    }, createInMemoryDeliveryStateStore());

    const comment = buildTerminalComment(state, {
      version: 1,
      investigationId: INV,
      summary,
      analysisComment: null,
      fixComment: null,
    });
    expect(comment).toContain("execution problem");
    expect(comment).toContain("Outcome: execution_failed");
    expect(comment).not.toContain("Pull request:");
  });
});
