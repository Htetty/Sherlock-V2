import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { isTransientInfrastructureError } from "../backend/queue/process-investigation.js";
import {
  buildDeliveryState,
  createDeliveryGitHubRestClient,
  createInMemoryDeliveryStateStore,
  deliveryCommentMarker,
  findTerminalCommentPaginated,
  reconcileTerminalCommentPaginated,
  runDeliveryFromState,
  terminalCommentMarker,
  type DeliveryExecutorDeps,
  type DeliveryStateStore,
} from "../backend/services/delivery.js";

const INV = "inv_0GITHUBREC01";
const FIX = "fix_0GITHUBFIX01";
const BRANCH = "sherlock/fix-42-github";
const SOURCE = "c0ffee123";
const TREE = "deadbeef1";
const BRANCH_COMMIT = "baddad123";

afterEach(() => {
  vi.unstubAllGlobals();
});

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function pendingState(store: DeliveryStateStore) {
  const contents = "export const fixed = true;\n";
  const retryPayload = await store.persistPayload(INV, "retry", {
    version: 1,
    investigationId: INV,
    title: "Sherlock verified fix",
    body: "Verified fix body",
    commitMessage: `fix: github reconciliation\n\nSherlock-Investigation: ${INV}\nSherlock-Fix-Attempt: ${FIX}`,
    files: [{ path: "src/fix.ts", contents, mode: "100644" }],
  });
  return buildDeliveryState(
    {
      investigationId: INV,
      tenantId: "tenant-gh-2",
      installationId: 2,
      repoOwner: "acme",
      repoName: "app",
      issueNumber: 42,
      issueTitle: "GitHub reconciliation",
      outcome: "verified_fix",
      summary: {
        investigationId: INV,
        outcome: "verified_fix",
        originalOutcome: "reproduced",
      },
      fixVerified: true,
      fixAttemptId: FIX,
      analysisComment: null,
      fixComment: "Verified locally.",
      pullRequest: {
        status: "pull_request_failed",
        key: "safe-key",
        owner: "acme",
        repo: "app",
        remote: "origin",
        branch: BRANCH,
        baseBranch: "main",
        commitSha: "branch-commit",
        sourceCommit: SOURCE,
        pullRequestNumber: null,
        pullRequestUrl: null,
        reason: "acknowledgement unavailable",
        startedAt: new Date(0).toISOString(),
        createdAt: new Date(0).toISOString(),
      },
      retryPlan: {
        branch: BRANCH,
        sourceCommit: SOURCE,
        baseBranch: "main",
        expectedTreeSha: TREE,
        files: [
          {
            path: "src/fix.ts",
            mode: "100644",
            contentSha256: hash(contents),
          },
        ],
        payload: retryPayload,
      },
    },
    store,
  );
}

function branchResponses(treeSha = TREE) {
  return (url: string) => {
    if (url.includes("/git/ref/heads/")) {
      return Response.json({ object: { sha: BRANCH_COMMIT } });
    }
    if (url.endsWith(`/git/commits/${BRANCH_COMMIT}`)) {
      return Response.json({
        tree: { sha: treeSha },
        parents: [{ sha: SOURCE }],
      });
    }
    return null;
  };
}

function pull(number: number, input: {
  base?: string;
  state?: "open" | "closed";
  merged?: boolean;
} = {}) {
  return {
    number,
    html_url: `https://github.com/acme/app/pull/${number}`,
    state: input.state ?? "open",
    merged_at: input.merged ? "2026-01-01T00:00:00Z" : null,
    head: { ref: BRANCH, repo: { full_name: "acme/app" } },
    base: { ref: input.base ?? "main", repo: { full_name: "acme/app" } },
  };
}

function executor(
  store: DeliveryStateStore,
  client: ReturnType<typeof createDeliveryGitHubRestClient>,
  comments: string[],
): DeliveryExecutorDeps {
  return {
    deliveryStore: store,
    getInstallationToken: async () => ({ token: "fresh-installation-token" }),
    createGitHubClient: () => client,
    findTerminalComment: async () => false,
    postIssueComment: async ({ body, assertOwnership }) => {
      await assertOwnership();
      comments.push(body);
    },
    isRetryableError: isTransientInfrastructureError,
  };
}

describe("production GitHub delivery adapter", () => {
  test("branch lookup returns the exact commit tree and parent identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const response = branchResponses()(String(input));
      if (response) return response;
      throw new Error(`unexpected request ${String(input)}`);
    }));
    const client = createDeliveryGitHubRestClient({
      token: "fresh",
      owner: "acme",
      repo: "app",
    });
    await expect(client.getBranch(BRANCH)).resolves.toEqual({
      sha: BRANCH_COMMIT,
      treeSha: TREE,
      parentShas: [SOURCE],
    });
  });

  test("acknowledgement loss after deterministic ref creation reconciles the branch", async () => {
    let branchCreated = false;
    let refCreates = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/")) {
        return branchCreated
          ? Response.json({ object: { sha: BRANCH_COMMIT } })
          : new Response(null, { status: 404 });
      }
      if (url.endsWith(`/git/commits/${SOURCE}`) && init?.method === "GET") {
        return Response.json({ tree: { sha: "ba5eba11" } });
      }
      if (url.endsWith(`/git/commits/${BRANCH_COMMIT}`) && init?.method === "GET") {
        return Response.json({
          tree: { sha: TREE },
          parents: [{ sha: SOURCE }],
        });
      }
      if (url.endsWith("/git/trees") && init?.method === "POST") {
        return Response.json({ sha: TREE });
      }
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        return Response.json({ sha: BRANCH_COMMIT });
      }
      if (url.endsWith("/git/refs") && init?.method === "POST") {
        branchCreated = true;
        refCreates += 1;
        return new Response(null, { status: 502, statusText: "Bad Gateway" });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    }));
    const client = createDeliveryGitHubRestClient({
      token: "fresh",
      owner: "acme",
      repo: "app",
    });

    await expect(
      client.createBranchWithCommit({
        branch: BRANCH,
        baseCommitSha: SOURCE,
        message: "fix: deterministic branch",
        authorDate: new Date(0).toISOString(),
        files: [{ path: "obsolete.ts", contents: null, mode: "100644" }],
        expectedTreeSha: TREE,
        assertOwnership: async () => {},
      }),
    ).resolves.toEqual({ commitSha: BRANCH_COMMIT, treeSha: TREE });
    expect(refCreates).toBe(1);
  });

  test("a branch-name collision with the wrong tree fails without PR side effects", async () => {
    const store = createInMemoryDeliveryStateStore();
    const state = await pendingState(store);
    let pullCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const response = branchResponses("badcafe99")(url);
      if (response) return response;
      if (url.includes("/pulls")) pullCalls += 1;
      throw new Error(`unexpected request ${url}`);
    }));
    const client = createDeliveryGitHubRestClient({ token: "fresh", owner: "acme", repo: "app" });
    const result = await runDeliveryFromState(
      state,
      executor(store, client, []),
      { isFinalAttempt: true },
    );
    expect(result.state.pullRequest.status).toBe("failed");
    expect(result.state.pullRequest.branchPushed).toBe(false);
    expect(pullCalls).toBe(0);
  });

  test("PR lookup verifies exact repository, head, and base across all states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json([
        pull(1, { base: "release" }),
        pull(2, { state: "closed" }),
        pull(3, { state: "closed", merged: true }),
        pull(4),
      ]),
    ));
    const client = createDeliveryGitHubRestClient({ token: "fresh", owner: "acme", repo: "app" });
    const result = await client.findPullRequests({
      head: `acme:${BRANCH}`,
      base: "main",
      assertOwnership: async () => {},
    });
    expect(result.conflictingBase).toBe(true);
    expect(result.matches).toEqual([
      {
        number: 2,
        url: "https://github.com/acme/app/pull/2",
        state: "closed",
        merged: false,
      },
      {
        number: 3,
        url: "https://github.com/acme/app/pull/3",
        state: "closed",
        merged: true,
      },
      {
        number: 4,
        url: "https://github.com/acme/app/pull/4",
        state: "open",
        merged: false,
      },
    ]);
  });

  test.each([
    ["open", pull(7), "reused"],
    ["closed", pull(8, { state: "closed" }), "blocked"],
    ["merged", pull(9, { state: "closed", merged: true }), "merged"],
  ] as const)("a %s matching PR is recorded truthfully", async (_label, existing, status) => {
    const store = createInMemoryDeliveryStateStore();
    const state = await pendingState(store);
    let createCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const branch = branchResponses()(url);
      if (branch) return branch;
      if (url.includes("/pulls") && init?.method !== "POST") {
        return Response.json([existing]);
      }
      if (init?.method === "POST") createCalls += 1;
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    }));
    const client = createDeliveryGitHubRestClient({ token: "fresh", owner: "acme", repo: "app" });
    const comments: string[] = [];
    const result = await runDeliveryFromState(
      state,
      executor(store, client, comments),
      { isFinalAttempt: true },
    );
    expect(result.state.pullRequest.status).toBe(status);
    expect(result.state.pullRequest.number).toBe(existing.number);
    expect(createCalls).toBe(0);
    expect(comments).toHaveLength(1);
  });

  test("a wrong-base PR is never reused and never causes a replacement PR", async () => {
    const store = createInMemoryDeliveryStateStore();
    const state = await pendingState(store);
    let createCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const branch = branchResponses()(url);
      if (branch) return branch;
      if (url.includes("/pulls") && init?.method !== "POST") {
        return Response.json([pull(11, { base: "release" })]);
      }
      if (init?.method === "POST") createCalls += 1;
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    }));
    const client = createDeliveryGitHubRestClient({ token: "fresh", owner: "acme", repo: "app" });
    const result = await runDeliveryFromState(
      state,
      executor(store, client, []),
      { isFinalAttempt: true },
    );
    expect(result.state.pullRequest.status).toBe("failed");
    expect(result.state.pullRequest.number).toBeNull();
    expect(createCalls).toBe(0);
  });

  test("acknowledgement loss after PR creation reuses the created PR", async () => {
    const store = createInMemoryDeliveryStateStore();
    const state = await pendingState(store);
    await store.save(state);
    let created = false;
    let createCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const branch = branchResponses()(url);
      if (branch) return branch;
      if (url.includes("/pulls") && init?.method !== "POST") {
        return Response.json(created ? [pull(7)] : []);
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        created = true;
        createCalls += 1;
        return new Response(null, { status: 502, statusText: "Bad Gateway" });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    }));
    const client = createDeliveryGitHubRestClient({ token: "fresh", owner: "acme", repo: "app" });
    const comments: string[] = [];
    const deps = executor(store, client, comments);

    const recovered = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });
    expect(recovered.state.pullRequest).toMatchObject({
      status: "reused",
      number: 7,
    });
    expect(createCalls).toBe(1);
    expect(comments).toHaveLength(1);
  });

  test("concurrent reconciliation through the production adapter creates one PR and one comment", async () => {
    const store = createInMemoryDeliveryStateStore();
    const state = await pendingState(store);
    await store.save(state);
    let created = false;
    let createCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const branch = branchResponses()(url);
      if (branch) return branch;
      if (url.includes("/pulls") && init?.method !== "POST") {
        return Response.json(created ? [pull(12)] : []);
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        created = true;
        createCalls += 1;
        return Response.json(pull(12));
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    }));
    const client = createDeliveryGitHubRestClient({
      token: "fresh",
      owner: "acme",
      repo: "app",
    });
    const comments: string[] = [];
    const deps = executor(store, client, comments);

    const [first, second] = await Promise.all([
      runDeliveryFromState(state, deps, { isFinalAttempt: false }),
      runDeliveryFromState(state, deps, { isFinalAttempt: false }),
    ]);

    expect(first.complete).toBe(true);
    expect(second.complete).toBe(true);
    expect(createCalls).toBe(1);
    expect(comments).toHaveLength(1);
  });
});

describe("production terminal-comment pagination", () => {
  test("owned progress comments are reusable and copied markers are ignored", async () => {
    const result = await reconcileTerminalCommentPaginated({
      terminalMarker: terminalCommentMarker(INV),
      reusableMarker: deliveryCommentMarker(INV),
      appId: 123,
      assertOwnership: async () => {},
      listPage: async () => [
        {
          id: 1,
          body: terminalCommentMarker(INV),
          performed_via_github_app: { id: 999 },
        },
        {
          id: 2,
          body: deliveryCommentMarker(INV),
          performed_via_github_app: { id: 123 },
        },
      ],
    });
    expect(result).toEqual({ terminalCommentId: null, reusableCommentId: 2 });
  });

  test("owned comment reconciliation fails closed when its bounded scan is incomplete", async () => {
    await expect(
      reconcileTerminalCommentPaginated({
        terminalMarker: terminalCommentMarker(INV),
        reusableMarker: deliveryCommentMarker(INV),
        appId: 123,
        maxPages: 1,
        assertOwnership: async () => {},
        listPage: async () =>
          Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            body: "older comment",
            performed_via_github_app: null,
          })),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  test("an acknowledgement-lost comment create is reconciled in the same attempt", async () => {
    const store = createInMemoryDeliveryStateStore();
    const state = await pendingState(store);
    state.pullRequest.status = "created";
    state.pullRequest.branchPushed = true;
    state.pullRequest.number = 7;
    state.pullRequest.url = "https://github.com/acme/app/pull/7";
    await store.save(state);
    let remoteComment = false;
    let creates = 0;
    const deps = executor(
      store,
      createDeliveryGitHubRestClient({ token: "unused", owner: "acme", repo: "app" }),
      [],
    );
    deps.findTerminalComment = async () => ({
      terminalCommentId: remoteComment ? 91 : null,
      reusableCommentId: null,
    });
    deps.postIssueComment = async () => {
      creates += 1;
      remoteComment = true;
      throw Object.assign(new Error("lost acknowledgement"), { status: 502 });
    };

    const result = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });
    expect(result.complete).toBe(true);
    expect(creates).toBe(1);
  });

  test("terminal delivery updates one owned progress comment instead of creating another", async () => {
    const store = createInMemoryDeliveryStateStore();
    const state = await pendingState(store);
    state.pullRequest.status = "created";
    state.pullRequest.branchPushed = true;
    state.pullRequest.number = 7;
    state.pullRequest.url = "https://github.com/acme/app/pull/7";
    await store.save(state);
    let updates = 0;
    let creates = 0;
    const deps = executor(
      store,
      createDeliveryGitHubRestClient({ token: "unused", owner: "acme", repo: "app" }),
      [],
    );
    deps.findTerminalComment = async () => ({
      terminalCommentId: null,
      reusableCommentId: 44,
    });
    deps.updateIssueComment = async ({ commentId, body }) => {
      expect(commentId).toBe(44);
      expect(body).toContain(terminalCommentMarker(INV));
      updates += 1;
    };
    deps.postIssueComment = async () => {
      creates += 1;
    };

    const result = await runDeliveryFromState(state, deps, {
      isFinalAttempt: false,
    });
    expect(result.complete).toBe(true);
    expect(updates).toBe(1);
    expect(creates).toBe(0);
  });

  test("a marker beyond 300 comments is found without timestamp filtering", async () => {
    const marker = terminalCommentMarker(INV);
    const pages: number[] = [];
    await expect(
      findTerminalCommentPaginated({
        marker,
        assertOwnership: async () => {},
        listPage: async (page) => {
          pages.push(page);
          if (page <= 3) return Array.from({ length: 100 }, () => ({ body: "older" }));
          return [{ body: `clock-skewed old comment ${marker}` }];
        },
      }),
    ).resolves.toBe(true);
    expect(pages).toEqual([1, 2, 3, 4]);
  });

  test("an unproven bounded history fails closed and remains retryable", async () => {
    await expect(
      findTerminalCommentPaginated({
        marker: terminalCommentMarker(INV),
        maxPages: 2,
        assertOwnership: async () => {},
        listPage: async () =>
          Array.from({ length: 100 }, () => ({ body: "no marker" })),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  test("acknowledgement loss after comment creation reconciles without a duplicate", async () => {
    const marker = terminalCommentMarker(INV);
    let postedBody: string | null = null;
    let postCalls = 0;
    const find = () =>
      findTerminalCommentPaginated({
        marker,
        assertOwnership: async () => {},
        listPage: async () => (postedBody ? [{ body: postedBody }] : []),
      });

    expect(await find()).toBe(false);
    postCalls += 1;
    postedBody = `terminal result ${marker}`;
    // Simulated 502/connection loss occurs after GitHub accepted the body.
    expect(await find()).toBe(true);
    if (!(await find())) postCalls += 1;
    expect(postCalls).toBe(1);
  });
});
