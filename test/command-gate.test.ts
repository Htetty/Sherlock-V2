// Authorized-command gate: exact-command parsing, bot filtering, repository
// permission checks, and rate-limit rejection behavior. GitHub permission
// lookups, the queue, and the rate limiter are injected; nock covers the
// comment-posting API. Limiter internals are tested in rate-limit.test.ts.
import nock from "nock";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Probot, ProbotOctokit } from "probot";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSherlockApp, type GetRepositoryRole } from "../src/index.js";
import {
  isAuthorizedRole,
  isBotUser,
  parseSherlockCommand,
} from "../src/command-gate.js";
import type { InvestigationRateLimiter } from "../backend/services/rate-limit.js";
import {
  buildInvestigationJobId,
  type InvestigationJobPayload,
  type InvestigationQueueAdapter,
} from "../backend/queue/investigation-queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(
  path.join(__dirname, "fixtures/mock-cert.pem"),
  "utf-8",
);

function buildWebhookPayload(
  overrides: { body?: string; user?: { login?: string; type?: string } } = {},
) {
  return {
    action: "created",
    issue: {
      number: 1,
      title: "Example bug",
      body: "Something broke",
      html_url: "https://github.com/hiimbex/testing-things/issues/1",
    },
    comment: {
      id: 4242,
      body: overrides.body ?? "/sherlock investigate",
      user: overrides.user ?? { login: "hiimbex", type: "User" },
    },
    repository: {
      name: "testing-things",
      html_url: "https://github.com/hiimbex/testing-things",
      default_branch: "main",
      owner: { login: "hiimbex" },
    },
    installation: { id: 2 },
  };
}

function createFakeQueue() {
  const jobs = new Map<string, InvestigationJobPayload>();
  const claims = new Set<string>();

  const adapter: InvestigationQueueAdapter = {
    add: async (payload, options) => {
      const jobId = buildInvestigationJobId(payload);

      if (claims.has(jobId)) {
        return { jobId, deduplicated: true, rateLimited: false };
      }

      claims.add(jobId);

      if (options?.onClaim) {
        const decision = await options.onClaim();
        if (decision === "duplicate") {
          claims.delete(jobId);
          return { jobId, deduplicated: true, rateLimited: false };
        }
        if (decision === false || decision === "rate_limited") {
          claims.delete(jobId);
          return { jobId, deduplicated: false, rateLimited: true };
        }
      }

      jobs.set(jobId, payload);
      return { jobId, deduplicated: false, rateLimited: false };
    },
    close: async () => {},
  };

  return { adapter, jobs };
}

// One nock interceptor per expected comment; asserts the body contains the
// given text. Token endpoint is mocked once per test that posts comments.
function mockCommentPost(expectedText: string) {
  return nock("https://api.github.com")
    .post("/app/installations/2/access_tokens")
    .reply(200, { token: "test", permissions: { issues: "write" } })
    .post("/repos/hiimbex/testing-things/issues/1/comments", (body: any) => {
      expect(body.body).toContain(expectedText);
      return true;
    })
    .reply(200);
}

function buildProbot(deps: {
  queue: InvestigationQueueAdapter;
  getRepositoryRole?: GetRepositoryRole;
  rateLimiter?: InvestigationRateLimiter;
}) {
  const probot = new Probot({
    appId: 123,
    privateKey,
    Octokit: ProbotOctokit.defaults((instanceOptions: object) => ({
      ...instanceOptions,
      retry: { enabled: false },
      throttle: { enabled: false },
    })),
  });

  probot.load(
    createSherlockApp({
      // Default to a permissive limiter: the production default would open a
      // real Redis connection. Limiter behavior itself is rate-limit.test.ts.
      rateLimiter: {
        checkAndConsumeInvestigationRateLimit: async (tenantKey) => ({
          allowed: true,
          tenantKey,
          count: 1,
          limit: 10,
          windowSeconds: 3600,
        }),
      },
      ...deps,
    }),
  );
  return probot;
}

async function receiveComment(
  probot: Probot,
  overrides: Parameters<typeof buildWebhookPayload>[0] = {},
) {
  await probot.receive({
    id: `delivery-${Math.random().toString(36).slice(2)}`,
    name: "issue_comment",
    payload: buildWebhookPayload(overrides) as any,
  });
}

describe("authorized command gate", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test("the exact /sherlock investigate command is accepted and enqueued", async () => {
    // Parsing: exact command with whitespace and case tolerance.
    expect(parseSherlockCommand("/sherlock investigate")).toBe("investigate");
    expect(parseSherlockCommand("  /sherlock investigate  ")).toBe("investigate");
    expect(parseSherlockCommand("/SHERLOCK  Investigate")).toBe("investigate");
    expect(parseSherlockCommand("/sherlock\tinvestigate")).toBe("investigate");

    // Newlines between the words are not the command: only spaces/tabs
    // may separate "/sherlock" from "investigate".
    expect(parseSherlockCommand("/sherlock\ninvestigate")).toBeNull();
    expect(parseSherlockCommand("/sherlock\r\ninvestigate")).toBeNull();

    const fake = createFakeQueue();
    const probot = buildProbot({
      queue: fake.adapter,
      getRepositoryRole: async () => ({ roleName: "write" }),
    });
    const mock = mockCommentPost("**Investigation queued**");

    await receiveComment(probot);

    expect(fake.jobs.size).toBe(1);
    expect(mock.pendingMocks()).toStrictEqual([]);
  });

  test("comments merely containing 'investigate' are ignored silently", async () => {
    for (const prose of [
      "please investigate this",
      "can Sherlock investigate?",
      "/sherlock investigate later",
      "I ran /sherlock investigate yesterday",
      "/sherlock",
      "sherlock investigate",
    ]) {
      expect(parseSherlockCommand(prose)).toBeNull();
    }

    const fake = createFakeQueue();
    const permissionChecks: string[] = [];
    const probot = buildProbot({
      queue: fake.adapter,
      getRepositoryRole: async (_octokit, params) => {
        permissionChecks.push(params.username);
        return { roleName: "write" };
      },
    });

    // No nock comment mocks: any posted comment or permission API call
    // would fail loudly under disableNetConnect.
    await receiveComment(probot, { body: "please investigate this" });
    await receiveComment(probot, { body: "can Sherlock investigate?" });
    await receiveComment(probot, { body: "/sherlock investigate later" });

    expect(fake.jobs.size).toBe(0);
    expect(permissionChecks).toHaveLength(0);
  });

  test("bot comments, including Sherlock's own, are ignored", async () => {
    expect(isBotUser({ type: "Bot", login: "sherlock-github-bot[bot]" })).toBe(true);
    expect(isBotUser({ login: "some-app[bot]" })).toBe(true);
    expect(isBotUser(undefined)).toBe(true);
    expect(isBotUser({ type: "User", login: "hiimbex" })).toBe(false);

    const fake = createFakeQueue();
    const probot = buildProbot({
      queue: fake.adapter,
      getRepositoryRole: async () => ({ roleName: "write" }),
    });

    await receiveComment(probot, {
      user: { login: "sherlock-github-bot[bot]", type: "Bot" },
    });

    expect(fake.jobs.size).toBe(0);
  });

  test("write, maintain, and admin permissions are authorized", async () => {
    expect(isAuthorizedRole({ roleName: "write" })).toBe(true);
    expect(isAuthorizedRole({ roleName: "maintain" })).toBe(true);
    expect(isAuthorizedRole({ roleName: "admin" })).toBe(true);
    // Fallback to the coarse permission when role_name is missing.
    expect(isAuthorizedRole({ permission: "write" })).toBe(true);
    expect(isAuthorizedRole({ permission: "admin" })).toBe(true);

    const fake = createFakeQueue();
    const probot = buildProbot({
      queue: fake.adapter,
      getRepositoryRole: async () => ({ roleName: "maintain" }),
    });
    const mock = mockCommentPost("**Investigation queued**");

    await receiveComment(probot);

    expect(fake.jobs.size).toBe(1);
    expect(mock.pendingMocks()).toStrictEqual([]);
  });

  test("read, triage, none, and unknown permissions are rejected without enqueueing", async () => {
    expect(isAuthorizedRole({ roleName: "read" })).toBe(false);
    expect(isAuthorizedRole({ roleName: "triage" })).toBe(false);
    expect(isAuthorizedRole({ permission: "none" })).toBe(false);
    expect(isAuthorizedRole({ roleName: "custom-deploy-role" })).toBe(false);
    expect(isAuthorizedRole({})).toBe(false);

    const fake = createFakeQueue();
    const probot = buildProbot({
      queue: fake.adapter,
      getRepositoryRole: async () => ({ roleName: "read", permission: "read" }),
    });
    const mock = mockCommentPost("write access or higher");

    await receiveComment(probot);

    expect(fake.jobs.size).toBe(0);
    expect(mock.pendingMocks()).toStrictEqual([]);
  });

  test("permission API failures and rate-limit rejections do not enqueue", async () => {
    // Permission API failure: safe comment, nothing queued, no internals
    // leaked into the comment body.
    const fake = createFakeQueue();
    const failingProbot = buildProbot({
      queue: fake.adapter,
      getRepositoryRole: async () => {
        throw new Error("secret-internal-detail: 502 from GitHub");
      },
    });
    const failureMock = nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test", permissions: { issues: "write" } })
      .post("/repos/hiimbex/testing-things/issues/1/comments", (body: any) => {
        expect(body.body).toContain("could not verify repository permissions");
        expect(body.body).not.toContain("secret-internal-detail");
        return true;
      })
      .reply(200);

    await receiveComment(failingProbot);
    expect(fake.jobs.size).toBe(0);
    expect(failureMock.pendingMocks()).toStrictEqual([]);

    // Exhausted limiter at the webhook level: comment posted, no job. The
    // limiter is keyed by the tenant derived from the installation id.
    const limitedTenants: string[] = [];
    const limited = createFakeQueue();
    const limitedProbot = buildProbot({
      queue: limited.adapter,
      getRepositoryRole: async () => ({ roleName: "admin" }),
      rateLimiter: {
        checkAndConsumeInvestigationRateLimit: async (tenantKey) => {
          limitedTenants.push(tenantKey);
          return {
            allowed: false,
            tenantKey,
            count: 11,
            limit: 10,
            windowSeconds: 3600,
          };
        },
      },
    });
    const limitMock = mockCommentPost("too many investigation requests");

    await receiveComment(limitedProbot);
    expect(limited.jobs.size).toBe(0);
    expect(limitedTenants).toEqual(["tenant-gh-2"]);
    expect(limitMock.pendingMocks()).toStrictEqual([]);
  });
});
