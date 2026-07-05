// Redis-backed investigation queue (BullMQ). The webhook enqueues here and a
// separate worker process runs the pipeline; the queue payload is the
// non-secret information the pipeline needs. Tokens, API keys, and Redis
// credentials must never be stored in a job.

import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const INVESTIGATION_QUEUE_NAME = "sherlock-investigations";
export const INVESTIGATION_JOB_NAME = "investigate";

// Transient infrastructure failures get a small bounded retry with
// exponential backoff (5s, 10s, 20s). Logical outcomes never reach retry:
// the pipeline reports them as completed results, and non-transient worker
// errors are thrown as UnrecoverableError.
export const INVESTIGATION_JOB_ATTEMPTS = 3;
export const INVESTIGATION_RETRY_BACKOFF_MS = 5_000;

// Bounded job retention. Deterministic job-id deduplication only works while
// the original job is still in Redis, so completed/failed jobs must not be
// removed immediately: webhook-redelivery idempotency holds only within this
// retention window (GitHub redeliveries are typically minutes to hours).
// Failed jobs are kept longer for debugging. Permanent idempotency will move
// to a database record when Sherlock gains one.
export const INVESTIGATION_JOB_RETENTION = {
  removeOnComplete: { age: 3 * 24 * 60 * 60, count: 1_000 }, // 3 days
  removeOnFail: { age: 14 * 24 * 60 * 60, count: 5_000 }, // 14 days
} as const;

export type InvestigationJobPayload = {
  investigationId: string;
  tenantId: string;
  installationId: number;
  repositoryOwner: string;
  repositoryName: string;
  repositoryUrl: string;
  defaultBranch: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  triggeringCommentId: number;
  triggerComment: string;
  triggeredBy: string;
  sourceRef: string | null;
  deliveryId: string | null;
};

// Deterministic, non-secret tenant identity for future B2B SaaS plans.
// Deliberately the single indirection point for tenancy: when Sherlock gains
// database-backed organizations, replace this lookup (installation ->
// organization id) without touching queue or worker code.
export function deriveTenantIdFromInstallation(installationId: number): string {
  return `tenant-gh-${installationId}`;
}

// Deterministic BullMQ job id: repeated webhook delivery of the same comment
// maps to the same id (BullMQ deduplicates), while a new /sherlock
// investigate comment has a new comment id and therefore a new job.
// BullMQ custom job ids must not contain ":".
export function buildInvestigationJobId(input: {
  tenantId: string;
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  triggeringCommentId: number;
}): string {
  return [
    INVESTIGATION_JOB_NAME,
    input.tenantId,
    input.repositoryOwner,
    input.repositoryName,
    `issue-${input.issueNumber}`,
    `comment-${input.triggeringCommentId}`,
  ].join("_");
}

// Everything the bot needs from the queue, injectable so webhook tests run
// without a Redis server.
export type InvestigationQueueAdapter = {
  add: (
    payload: InvestigationJobPayload,
  ) => Promise<{ jobId: string; deduplicated: boolean }>;
  close: () => Promise<void>;
};

export function createRedisConnection(
  url: string = process.env.REDIS_URL ?? "redis://localhost:6379",
): Redis {
  // BullMQ requires maxRetriesPerRequest: null for blocking connections.
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createInvestigationQueue(connection: Redis): Queue {
  return new Queue(INVESTIGATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: INVESTIGATION_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: INVESTIGATION_RETRY_BACKOFF_MS },
      removeOnComplete: INVESTIGATION_JOB_RETENTION.removeOnComplete,
      removeOnFail: INVESTIGATION_JOB_RETENTION.removeOnFail,
    },
  });
}

export function createInvestigationQueueAdapter(
  connection: Redis = createRedisConnection(),
): InvestigationQueueAdapter {
  const queue = createInvestigationQueue(connection);

  return {
    add: async (payload) => {
      const jobId = buildInvestigationJobId(payload);
      const existing = await queue.getJob(jobId);

      if (existing) {
        return { jobId, deduplicated: true };
      }

      await queue.add(INVESTIGATION_JOB_NAME, payload, { jobId });
      return { jobId, deduplicated: false };
    },
    close: async () => {
      await queue.close();
      await connection.quit();
    },
  };
}
