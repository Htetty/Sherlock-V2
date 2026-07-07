// Webhook behavior with the Redis-backed queue: "/sherlock investigate" must
// enqueue a job and post a "queued" comment — never run the investigation
// pipeline inline. The queue adapter is injected, so no Redis is needed.
import nock from "nock";
import { createSherlockApp } from "../src/index.js";
import { Probot, ProbotOctokit } from "probot";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, beforeEach, afterEach, test, expect } from "vitest";
import {
  buildInvestigationJobId,
  deriveTenantIdFromInstallation,
  type InvestigationJobPayload,
  type InvestigationQueueAdapter,
} from "../backend/queue/investigation-queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const privateKey = fs.readFileSync(
  path.join(__dirname, "fixtures/mock-cert.pem"),
  "utf-8",
);

function buildWebhookPayload(commentId: number) {
  return {
    action: "created",
    issue: {
      number: 1,
      title: "Example bug",
      body: "Something broke",
      html_url: "https://github.com/hiimbex/testing-things/issues/1",
    },
    comment: {
      id: commentId,
      body: "/sherlock investigate",
      user: { login: "hiimbex" },
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

// In-memory queue with the same deterministic-id dedupe semantics as the
// real BullMQ adapter.
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

      if (options?.onClaim && !(await options.onClaim())) {
        claims.delete(jobId);
        return { jobId, deduplicated: false, rateLimited: true };
      }

      jobs.set(jobId, payload);
      return { jobId, deduplicated: false, rateLimited: false };
    },
    close: async () => {},
  };

  return { adapter, jobs };
}

function mockGithub(expectedComments: number) {
  return nock("https://api.github.com")
    .post("/app/installations/2/access_tokens")
    .reply(200, { token: "test", permissions: { issues: "write" } })
    .post("/repos/hiimbex/testing-things/issues/1/comments", (body: any) => {
      expect(body.body).toContain("Investigation queued.");
      expect(body.body).toMatch(/Investigation: inv_[0-9A-Z]{10,}/);
      return true;
    })
    .times(expectedComments)
    .reply(200);
}

describe("Sherlock webhook (queued investigations)", () => {
  let probot: Probot;
  let fake: ReturnType<typeof createFakeQueue>;

  beforeEach(() => {
    nock.disableNetConnect();
    fake = createFakeQueue();
    probot = new Probot({
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
        queue: fake.adapter,
        // Authorization is covered in command-gate.test.ts; these tests
        // focus on queueing behavior.
        getRepositoryRole: async () => ({ roleName: "write" }),
      }),
    );
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test("enqueues a job and posts a queued comment instead of running the pipeline inline", async () => {
    const mock = mockGithub(1);

    // disableNetConnect guarantees this fails loudly if the webhook tries to
    // call the investigation backend (the old inline behavior).
    await probot.receive({
      id: "delivery-1",
      name: "issue_comment",
      payload: buildWebhookPayload(4242) as any,
    });

    expect(mock.pendingMocks()).toStrictEqual([]);
    expect(fake.jobs.size).toBe(1);

    const job = [...fake.jobs.values()][0];
    expect(job.investigationId).toMatch(/^inv_[0-9A-Z]{10,}$/);
    expect(job.tenantId).toBe("tenant-gh-2");
    expect(job.installationId).toBe(2);
    expect(job.repositoryOwner).toBe("hiimbex");
    expect(job.repositoryName).toBe("testing-things");
    expect(job.issueNumber).toBe(1);
    expect(job.triggeringCommentId).toBe(4242);
    expect(job.deliveryId).toBe("delivery-1");

    // No secrets in the queue payload.
    const serialized = JSON.stringify(job).toLowerCase();
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("apikey");
    expect(serialized).not.toContain("private");
  });

  test("duplicate delivery of the same comment creates only one job and one comment", async () => {
    const mock = mockGithub(1);

    await probot.receive({
      id: "delivery-1",
      name: "issue_comment",
      payload: buildWebhookPayload(4242) as any,
    });
    // Same comment redelivered (e.g. webhook retry): if this tried to post
    // another comment, the single nock mock above would reject it.
    await probot.receive({
      id: "delivery-2",
      name: "issue_comment",
      payload: buildWebhookPayload(4242) as any,
    });

    expect(fake.jobs.size).toBe(1);
    expect(mock.pendingMocks()).toStrictEqual([]);
  });

  test("concurrent duplicate deliveries queue once and consume one rate-limit slot", async () => {
    const mock = mockGithub(1);
    let rateLimitSlots = 0;
    const concurrentProbot = new Probot({
      appId: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults((instanceOptions: object) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });
    concurrentProbot.load(
      createSherlockApp({
        queue: fake.adapter,
        getRepositoryRole: async () => ({ roleName: "write" }),
        rateLimiter: {
          tryAcquire: () => {
            rateLimitSlots += 1;
            return true;
          },
        },
      }),
    );

    await Promise.all([
      concurrentProbot.receive({
        id: "delivery-concurrent-1",
        name: "issue_comment",
        payload: buildWebhookPayload(4242) as any,
      }),
      concurrentProbot.receive({
        id: "delivery-concurrent-2",
        name: "issue_comment",
        payload: buildWebhookPayload(4242) as any,
      }),
    ]);

    expect(fake.jobs.size).toBe(1);
    expect(rateLimitSlots).toBe(1);
    expect(mock.pendingMocks()).toStrictEqual([]);
  });

  test("the same delivery id does not collapse different comment commands", async () => {
    const mock = mockGithub(2);

    await probot.receive({
      id: "delivery-shared",
      name: "issue_comment",
      payload: buildWebhookPayload(4242) as any,
    });
    await probot.receive({
      id: "delivery-shared",
      name: "issue_comment",
      payload: buildWebhookPayload(4343) as any,
    });

    expect(fake.jobs.size).toBe(2);
    expect(mock.pendingMocks()).toStrictEqual([]);
  });

  test("a distinct later comment on the same issue creates a new job", async () => {
    const mock = mockGithub(2);

    await probot.receive({
      id: "delivery-1",
      name: "issue_comment",
      payload: buildWebhookPayload(4242) as any,
    });
    await probot.receive({
      id: "delivery-3",
      name: "issue_comment",
      payload: buildWebhookPayload(4343) as any,
    });

    expect(fake.jobs.size).toBe(2);
    expect(mock.pendingMocks()).toStrictEqual([]);

    const jobIds = [...fake.jobs.keys()];
    expect(jobIds[0]).not.toBe(jobIds[1]);
  });

  test("tenant id derives from the installation and shapes the deterministic job id", () => {
    expect(deriveTenantIdFromInstallation(2)).toBe("tenant-gh-2");
    expect(deriveTenantIdFromInstallation(2)).toBe(deriveTenantIdFromInstallation(2));

    const jobId = buildInvestigationJobId({
      tenantId: "tenant-gh-2",
      repositoryOwner: "hiimbex",
      repositoryName: "testing-things",
      issueNumber: 1,
      triggeringCommentId: 4242,
    });

    expect(jobId).toBe(
      "investigate_tenant-gh-2_hiimbex_testing-things_issue-1_comment-4242",
    );
    expect(jobId).not.toContain(":");
  });
});
