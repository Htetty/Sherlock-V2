// Failure injection for the delivery layer: once execution reaches a
// terminal result, GitHub delivery (branch push, PR create/reuse, terminal
// issue comment) must be independently retryable, idempotent (at most one
// branch, one PR, one terminal comment), and truthful — and a delivery-only
// retry must never call the reproduction or fixer pipeline again.
import { UnrecoverableError } from "bullmq";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  runDeliveryFromState,
  terminalCommentMarker,
  DeliveryRetryableError,
  type DeliveryExecutorDeps,
  type DeliveryGitHubClient,
  type DeliveryState,
  type DeliveryStateStore,
  type PullRequestRetryPlan,
} from "../backend/services/delivery.js";
import type { FixAttemptResult } from "../backend/services/fix.js";
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
    expect(github.calls.findPullRequests).toBe(1);
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

  test("transient comment failure retries and posts exactly one comment in the end", async () => {
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
    const retry = makeExecutorDeps({ deliveryStore });
    const { state: delivered, complete } = await runDeliveryFromState(
      stored,
      retry.deps,
      { isFinalAttempt: false },
    );

    expect(complete).toBe(true);
    expect(delivered.terminalComment.status).toBe("posted");
    expect(retry.comments).toHaveLength(1);
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

  test("a transient comment failure queues a delivery-only job; the retry never reruns the pipeline", async () => {
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

    // The delivery job finishes the comment without touching the pipeline.
    const result = await processDeliveryJob(
      { data: deliveryPayload, attemptsMade: 0, opts: { attempts: 4 } },
      fixture.deps,
    );

    expect(result).toEqual({ investigationId: INV, outcome: "verified_fix" });
    expect(fixture.pipelineCalls()).toBe(1);
    expect(fixture.comments).toHaveLength(1);
    expect(fixture.comments[0]).toContain("opened a pull request");
  });

  test("unfinished PR delivery defers to the delivery job, which pushes, opens the PR, and comments once", async () => {
    const github = mockGitHub();
    const fixture = makeWorkerDeps({
      pipelineResult: verifiedPipelineResult(pullRequestResult("push_failed")),
      github: github.client,
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

    // Running the delivery job again is a no-op: no duplicates anywhere.
    await processDeliveryJob(
      { data: deliveryPayload, attemptsMade: 1, opts: { attempts: 4 } },
      fixture.deps,
    );
    expect(github.calls.createBranchWithCommit).toBe(1);
    expect(github.calls.createPullRequest).toBe(1);
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
