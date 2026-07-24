import type { Job, Queue } from "bullmq";
import {
  buildDeliveryJobId,
  enqueueDeliveryJob,
  enqueueInvestigationJob,
  type DeliveryJobPayload,
} from "../queue/investigation-queue.js";
import type { ProductDataStore } from "./product-data.js";

type RecoverableJob = Pick<Job, "getState" | "retry" | "remove">;

export type DurableRecoveryQueue = Pick<Queue, "add"> & {
  getJob(jobId: string): Promise<RecoverableJob | undefined>;
};

export type DurableRecoveryResult = {
  investigationEnqueues: number;
  deliveryEnqueues: number;
  alreadyScheduled: number;
  failures: Array<{ kind: "investigation" | "delivery"; id: string; error: string }>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureDeliveryScheduled(
  queue: DurableRecoveryQueue,
  payload: DeliveryJobPayload,
): Promise<"enqueued" | "already_scheduled"> {
  const jobId = buildDeliveryJobId(payload.investigationId);
  const existing = await queue.getJob(jobId);
  if (!existing) {
    await enqueueDeliveryJob(queue, payload);
    return "enqueued";
  }

  const state = await existing.getState();
  if (state === "failed") {
    await existing.retry("failed");
    return "enqueued";
  }
  if (state === "completed") {
    // Supabase still says delivery is pending. Reconciliation is idempotent,
    // so replace the completed queue record with a fresh delivery-only job.
    await existing.remove();
    await enqueueDeliveryJob(queue, payload);
    return "enqueued";
  }

  return "already_scheduled";
}

export async function recoverDurableWork(input: {
  productData: ProductDataStore;
  queue: DurableRecoveryQueue;
  now?: Date;
  limit?: number;
}): Promise<DurableRecoveryResult> {
  const result: DurableRecoveryResult = {
    investigationEnqueues: 0,
    deliveryEnqueues: 0,
    alreadyScheduled: 0,
    failures: [],
  };
  const pendingInvestigations =
    await input.productData.listPendingInvestigationEnqueues(input.limit);

  for (const pending of pendingInvestigations) {
    try {
      const jobId = await enqueueInvestigationJob(input.queue, pending.jobPayload);
      await input.productData.markInvestigationEnqueued({
        installationId: pending.installationId,
        triggeringCommentId: pending.triggeringCommentId,
        investigationId: pending.investigationId,
        queueJobId: jobId,
      });
      result.investigationEnqueues += 1;
    } catch (error) {
      result.failures.push({
        kind: "investigation",
        id: pending.investigationId,
        error: message(error),
      });
    }
  }

  const pendingDeliveries = await input.productData.listPendingDeliveryRecoveries(
    input.now,
    input.limit,
  );
  for (const payload of pendingDeliveries) {
    try {
      const outcome = await ensureDeliveryScheduled(input.queue, payload);
      if (outcome === "enqueued") result.deliveryEnqueues += 1;
      else result.alreadyScheduled += 1;
    } catch (error) {
      result.failures.push({
        kind: "delivery",
        id: payload.investigationId,
        error: message(error),
      });
    }
  }

  return result;
}
