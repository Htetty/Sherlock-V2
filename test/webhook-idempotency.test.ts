import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { describe, expect, test } from "vitest";
import { createWebhookInvestigationId } from "../backend/services/artifacts.js";
import {
  INVESTIGATION_JOB_RETENTION,
  WEBHOOK_COMMAND_CLAIM_PREFIX,
  WEBHOOK_COMMAND_CLAIM_TTL_SECONDS,
  buildInvestigationJobId,
  createInvestigationQueueAdapter,
  enqueueInvestigationJob,
  type InvestigationJobPayload,
} from "../backend/queue/investigation-queue.js";

const payload: InvestigationJobPayload = {
  investigationId: "inv_SAFE123",
  tenantId: "tenant-gh-2",
  installationId: 2,
  repositoryOwner: "hiimbex",
  repositoryName: "testing-things",
  repositoryUrl: "https://github.com/hiimbex/testing-things",
  defaultBranch: "main",
  issueNumber: 1,
  issueTitle: "Example bug",
  issueBody: "Something broke",
  issueUrl: "https://github.com/hiimbex/testing-things/issues/1",
  triggeringCommentId: 4242,
  triggerComment: "/sherlock investigate",
  triggeredBy: "hiimbex",
  sourceRef: "main",
  deliveryId: "delivery-1",
};

function createRedisMock() {
  const values = new Map<string, string>();
  const evalCalls: unknown[][] = [];
  const redis = {
    eval: async (...args: unknown[]) => {
      evalCalls.push(args);
      const [, keyCount, ...rest] = args as [string, number, ...string[]];
      if (keyCount === 2) {
        const [key, legacyKey, value] = rest;
        if (values.has(key) || values.has(legacyKey)) return 0;
        values.set(key, value);
        return 1;
      }
      const [key, value] = rest;
      if (values.get(key) !== value) return 0;
      values.delete(key);
      return 1;
    },
    quit: async () => "OK",
  };
  return { redis: redis as unknown as Redis, values, evalCalls };
}

function createQueueMock(addImpl?: () => Promise<void>) {
  const added: Array<{ data: InvestigationJobPayload; jobId: string }> = [];
  const queue = {
    add: async (_name: string, data: InvestigationJobPayload, options: { jobId: string }) => {
      await addImpl?.();
      if (!added.some((entry) => entry.jobId === options.jobId)) {
        added.push({ data, jobId: options.jobId });
      }
    },
    close: async () => {},
  };
  return { queue: queue as unknown as Pick<Queue, "add" | "close">, added };
}

describe("webhook command Redis claim", () => {
  test("webhook investigation ids are stable, opaque, and command-scoped", () => {
    const first = createWebhookInvestigationId({
      installationId: 2,
      triggeringCommentId: 4242,
    });
    expect(
      createWebhookInvestigationId({
        installationId: "2",
        triggeringCommentId: "4242",
      }),
    ).toBe(first);
    expect(
      createWebhookInvestigationId({
        installationId: 2,
        triggeringCommentId: 4243,
      }),
    ).not.toBe(first);
    expect(first).toMatch(/^inv_[0-9A-F]{20}$/);
    expect(first).not.toContain("4242");
  });

  test("two concurrent attempts have exactly one winner", async () => {
    const { redis } = createRedisMock();
    const { queue, added } = createQueueMock(async () => Promise.resolve());
    const adapter = createInvestigationQueueAdapter(redis, queue);

    const results = await Promise.all([adapter.add(payload), adapter.add(payload)]);

    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(results.filter((result) => result.deduplicated)).toHaveLength(1);
    expect(added).toHaveLength(1);
  });

  test("claim identity, TTL, and stored data are bounded and safe", async () => {
    const { redis, evalCalls } = createRedisMock();
    const { queue, added } = createQueueMock();
    const adapter = createInvestigationQueueAdapter(redis, queue);

    await adapter.add(payload);

    const jobId = buildInvestigationJobId(payload);
    expect(evalCalls[0]).toEqual([
      expect.stringContaining("EXISTS"),
      2,
      `${WEBHOOK_COMMAND_CLAIM_PREFIX}${jobId}`,
      expect.stringContaining(`${WEBHOOK_COMMAND_CLAIM_PREFIX}investigate_`),
      expect.any(String),
      WEBHOOK_COMMAND_CLAIM_TTL_SECONDS,
    ]);
    expect(WEBHOOK_COMMAND_CLAIM_TTL_SECONDS).toBe(
      INVESTIGATION_JOB_RETENTION.removeOnComplete.age,
    );
    expect(WEBHOOK_COMMAND_CLAIM_TTL_SECONDS).toBe(3 * 24 * 60 * 60);

    const claimValue = String(evalCalls[0][4]).toLowerCase();
    const queuedPayload = JSON.stringify(added[0].data).toLowerCase();
    for (const secretName of ["token", "apikey", "private", "secret"]) {
      expect(claimValue).not.toContain(secretName);
      expect(queuedPayload).not.toContain(secretName);
    }
  });

  test("a deduplicated redelivery never invokes onClaim, so it consumes no rate-limit quota", async () => {
    const { redis } = createRedisMock();
    const { queue, added } = createQueueMock();
    const adapter = createInvestigationQueueAdapter(redis, queue);
    let onClaimCalls = 0;
    const onClaim = () => {
      onClaimCalls += 1;
      return true;
    };

    await adapter.add(payload, { onClaim });
    const redelivery = await adapter.add(payload, { onClaim });

    expect(redelivery.deduplicated).toBe(true);
    expect(onClaimCalls).toBe(1);
    expect(added).toHaveLength(1);
  });

  test("an ea99a10 legacy claim prevents a duplicate during the opaque-ID upgrade", async () => {
    const { redis, values } = createRedisMock();
    values.set(
      `${WEBHOOK_COMMAND_CLAIM_PREFIX}investigate_tenant-gh-2_hiimbex_testing-things_issue-1_comment-4242`,
      "legacy-owner",
    );
    const { queue, added } = createQueueMock();
    const adapter = createInvestigationQueueAdapter(redis, queue);

    await expect(adapter.add(payload)).resolves.toMatchObject({
      deduplicated: true,
      rateLimited: false,
    });
    expect(added).toHaveLength(0);
  });

  test("enqueue failure compare-deletes its claim and permits retry", async () => {
    const { redis, values } = createRedisMock();
    let attempts = 0;
    const { queue } = createQueueMock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("BullMQ unavailable");
    });
    const adapter = createInvestigationQueueAdapter(redis, queue);

    await expect(adapter.add(payload)).rejects.toThrow("BullMQ unavailable");
    expect(values.size).toBe(0);
    await expect(adapter.add(payload)).resolves.toMatchObject({
      deduplicated: false,
      rateLimited: false,
    });
    expect(attempts).toBe(2);
  });

  test("a pending command revives a retained failed investigation job", async () => {
    let retried = 0;
    const queue = {
      add: async () =>
        ({
          getState: async () => "failed",
          retry: async (state: string) => {
            expect(state).toBe("failed");
            retried += 1;
          },
        }) as never,
    } as unknown as Pick<Queue, "add">;

    await expect(enqueueInvestigationJob(queue, payload)).resolves.toBe(
      buildInvestigationJobId(payload),
    );
    expect(retried).toBe(1);
  });

  test("a durable pending claim resumes the original payload after acknowledgement failure", async () => {
    const { redis, values } = createRedisMock();
    const { queue, added } = createQueueMock();
    const adapter = createInvestigationQueueAdapter(redis, queue);
    const original = { ...payload, investigationId: "inv_ORIGINAL12345" };
    let acknowledged = false;
    let acknowledgementAttempts = 0;
    const options = {
      onClaim: async () =>
        acknowledged
          ? "duplicate" as const
          : { decision: "allow" as const, payload: original },
      onEnqueued: async () => {
        acknowledgementAttempts += 1;
        if (acknowledgementAttempts === 1) {
          throw new Error("Supabase acknowledgement unavailable");
        }
        acknowledged = true;
      },
    };

    await expect(adapter.add(payload, options)).rejects.toThrow(
      "Supabase acknowledgement unavailable",
    );
    expect(values.size).toBe(0);

    await expect(adapter.add(payload, options)).resolves.toMatchObject({
      deduplicated: false,
      rateLimited: false,
    });
    expect(added).toEqual([
      {
        data: original,
        jobId: buildInvestigationJobId(payload),
      },
    ]);
    expect(acknowledged).toBe(true);

    // Once acknowledged permanently, even a fresh Redis claim cannot enqueue.
    values.clear();
    await expect(adapter.add(payload, options)).resolves.toMatchObject({
      deduplicated: true,
      rateLimited: false,
    });
    expect(added).toHaveLength(1);
  });
});
