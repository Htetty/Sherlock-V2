import { describe, expect, it, vi } from "vitest";
import {
  buildDeliveryJobId,
  buildInvestigationJobId,
  type DeliveryJobPayload,
} from "../backend/queue/investigation-queue.js";
import { recoverDurableWork } from "../backend/services/durable-recovery.js";
import { createInMemoryProductDataStore } from "../backend/services/product-data.js";

const investigationPayload = {
  investigationId: "inv_01K123456789AB",
  tenantId: "tenant-gh-2",
  installationId: 2,
  repositoryOwner: "octo",
  repositoryName: "repo",
  repositoryUrl: "https://github.com/octo/repo",
  defaultBranch: "main",
  issueNumber: 7,
  issueTitle: "Broken dashboard",
  issueBody: "The dashboard is broken.",
  issueUrl: "https://github.com/octo/repo/issues/7",
  triggeringCommentId: 202,
  triggerComment: "/sherlock investigate",
  triggeredBy: "octocat",
  sourceRef: "main",
  deliveryId: "delivery-1",
};

function investigationInput() {
  return {
    investigationId: investigationPayload.investigationId,
    tenantId: investigationPayload.tenantId,
    installationId: "2",
    repositoryId: "99",
    repositoryOwner: "octo",
    repositoryName: "repo",
    repositoryFullName: "octo/repo",
    repositoryPrivate: true,
    githubIssueId: "101",
    issueNumber: 7,
    issueTitle: "Broken dashboard",
    issueUrl: "https://github.com/octo/repo/issues/7",
    triggeringCommentId: "202",
    triggeredBy: "octocat",
    triggeredByGithubUserId: "303",
    sourceRef: "main",
    createdAt: "2026-07-23T00:00:00.000Z",
    jobPayload: investigationPayload,
  };
}

describe("durable work recovery", () => {
  it("enqueues and acknowledges a pending investigation command exactly once", async () => {
    const productData = createInMemoryProductDataStore();
    await productData.createInvestigation(investigationInput());
    const add = vi.fn(async () => ({ id: "ignored" }));
    const queue = {
      add,
      getJob: vi.fn(async () => undefined),
    };

    await expect(recoverDurableWork({ productData, queue })).resolves.toEqual({
      investigationEnqueues: 1,
      deliveryEnqueues: 0,
      alreadyScheduled: 0,
      failures: [],
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "investigate",
      investigationPayload,
      expect.objectContaining({
        jobId: buildInvestigationJobId(investigationPayload),
      }),
    );

    await expect(recoverDurableWork({ productData, queue })).resolves.toEqual({
      investigationEnqueues: 0,
      deliveryEnqueues: 0,
      alreadyScheduled: 0,
      failures: [],
    });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "completed"] as const)(
    "recovers a due delivery whose retained BullMQ job is %s",
    async (jobState) => {
      const base = createInMemoryProductDataStore();
      const payload: DeliveryJobPayload = {
        investigationId: investigationPayload.investigationId,
        tenantId: investigationPayload.tenantId,
        installationId: investigationPayload.installationId,
        repositoryOwner: investigationPayload.repositoryOwner,
        repositoryName: investigationPayload.repositoryName,
        issueNumber: investigationPayload.issueNumber,
      };
      const retry = vi.fn(async () => {});
      const remove = vi.fn(async () => {});
      const add = vi.fn(async () => ({ id: "ignored" }));
      const queue = {
        add,
        getJob: vi.fn(async (jobId: string) => {
          expect(jobId).toBe(buildDeliveryJobId(payload.investigationId));
          return {
            getState: async () => jobState,
            retry,
            remove,
          };
        }),
      };
      const productData = {
        ...base,
        listPendingDeliveryRecoveries: async () => [payload],
      };

      const result = await recoverDurableWork({ productData, queue });

      expect(result).toMatchObject({
        investigationEnqueues: 0,
        deliveryEnqueues: 1,
        alreadyScheduled: 0,
        failures: [],
      });
      if (jobState === "failed") {
        expect(retry).toHaveBeenCalledWith("failed");
        expect(remove).not.toHaveBeenCalled();
        expect(add).not.toHaveBeenCalled();
      } else {
        expect(remove).toHaveBeenCalledOnce();
        expect(add).toHaveBeenCalledWith(
          "deliver",
          payload,
          expect.objectContaining({
            jobId: buildDeliveryJobId(payload.investigationId),
          }),
        );
      }
    },
  );

  it("leaves failed enqueues pending for the next recovery run", async () => {
    const productData = createInMemoryProductDataStore();
    await productData.createInvestigation(investigationInput());
    const queue = {
      add: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
      getJob: vi.fn(async () => undefined),
    };

    const result = await recoverDurableWork({ productData, queue });

    expect(result.failures).toEqual([
      {
        kind: "investigation",
        id: investigationPayload.investigationId,
        error: "redis unavailable",
      },
    ]);
    await expect(
      productData.listPendingInvestigationEnqueues(),
    ).resolves.toHaveLength(1);
  });
});
