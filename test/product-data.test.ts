import { describe, expect, it, vi } from "vitest";
import {
  buildDeliveryState,
  createInMemoryDeliveryStateStore,
} from "../backend/services/delivery.js";
import {
  createInMemoryProductDataStore,
  createProductBackedDeliveryStateStore,
} from "../backend/services/product-data.js";

const investigationId = "inv_01K123456789AB";

function deliveryInput() {
  return {
    investigationId,
    tenantId: "tenant-gh-2",
    installationId: 2,
    repoOwner: "octo",
    repoName: "repo",
    issueNumber: 7,
    issueTitle: "Broken dashboard",
    outcome: "not_reproduced" as const,
    summary: {
      investigationId,
      outcome: "not_reproduced" as const,
    },
    fixVerified: false,
    fixAttemptId: null,
    analysisComment: null,
    fixComment: null,
    report: {
      outcome: "not_reproduced" as const,
      originalOutcome: null,
      rootCause: null,
      fixSummary: null,
      fixOutcome: null,
      fixReason: null,
      changedFiles: [],
      verification: {
        exactReplay: null,
        repository: null,
        regression: null,
      },
      limitations: [],
      technicalEvidence: {
        expected: null,
        observed: null,
        reproductionMode: null,
        evidence: null,
        failedChecks: [],
        stage: null,
        error: null,
        planErrors: [],
        analysis: null,
      },
    },
    pullRequest: null,
    retryPlan: null,
  };
}

function createInput() {
  const jobPayload = {
    investigationId,
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
  return {
    investigationId,
    tenantId: "tenant-gh-2",
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
    jobPayload,
  };
}

describe("product data persistence", () => {
  it("claims a triggering comment once and retains the original public id", async () => {
    const store = createInMemoryProductDataStore();

    await expect(store.createInvestigation(createInput())).resolves.toEqual({
      created: true,
      investigationId,
      shouldEnqueue: true,
      jobPayload: createInput().jobPayload,
    });
    await expect(
      store.createInvestigation({
        ...createInput(),
        investigationId: "inv_01K123456789AC",
      }),
    ).resolves.toEqual({
      created: false,
      investigationId,
      shouldEnqueue: true,
      jobPayload: createInput().jobPayload,
    });

    expect(store.snapshot().investigations).toHaveLength(1);

    await store.markInvestigationEnqueued({
      installationId: "2",
      triggeringCommentId: "202",
      investigationId,
      queueJobId: "investigate-job",
    });
    await expect(
      store.createInvestigation({
        ...createInput(),
        investigationId: "inv_01K123456789AD",
      }),
    ).resolves.toEqual({
      created: false,
      investigationId,
      shouldEnqueue: false,
      jobPayload: null,
    });
  });

  it("persists individual lifecycle events instead of only current status", async () => {
    const store = createInMemoryProductDataStore();
    await store.createInvestigation(createInput());

    await store.record({
      type: "stage_changed",
      investigationId,
      at: "2026-07-23T00:00:01.000Z",
      stage: "reproducing",
    });
    await store.record({
      type: "reproduction",
      investigationId,
      at: "2026-07-23T00:00:02.000Z",
      path: "one_shot",
      mode: "browser",
      outcome: "reproduced",
      commit: "a".repeat(40),
    });

    const snapshot = store.snapshot();
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "created",
      "stage_changed",
      "reproduction",
    ]);
    expect(snapshot.investigations[0].stage).toBe("reproducing");
    expect(snapshot.investigations[0].reproduction?.outcome).toBe("reproduced");
  });

  it("recovers delivery state and protected payload after local store loss", async () => {
    const product = createInMemoryProductDataStore();
    await product.createInvestigation(createInput());

    const firstLocal = createInMemoryDeliveryStateStore();
    const first = createProductBackedDeliveryStateStore(firstLocal, product);
    const state = await buildDeliveryState(deliveryInput(), first);
    await first.save(state);
    await vi.waitFor(() => {
      expect(product.snapshot().deliveries).toHaveLength(1);
    });

    const afterLocalLoss = createProductBackedDeliveryStateStore(
      createInMemoryDeliveryStateStore(),
      product,
    );
    const recovered = await afterLocalLoss.load(investigationId);
    expect(recovered).toEqual(state);
    await expect(
      afterLocalLoss.loadPayload(investigationId, state.terminalPayload),
    ).resolves.toMatchObject({
      version: 2,
      investigationId,
    });
  });

  it("never waits for product replication before preserving local delivery", async () => {
    const base = createInMemoryProductDataStore();
    const never = new Promise<void>(() => {});
    const product = {
      ...base,
      persistDeliveryPayload: async () => never,
      saveDeliveryState: async () => never,
      saveTerminalFailure: async () => never,
      loadDeliveryState: async () => {
        throw new Error("Supabase unavailable");
      },
      loadTerminalFailure: async () => {
        throw new Error("Supabase unavailable");
      },
    };
    const local = createInMemoryDeliveryStateStore();
    const store = createProductBackedDeliveryStateStore(local, product);

    const outcome = await Promise.race([
      (async () => {
        const state = await buildDeliveryState(deliveryInput(), store);
        await store.save(state);
        return state;
      })(),
      new Promise<"timed_out">((resolve) =>
        setTimeout(() => resolve("timed_out"), 100),
      ),
    ]);

    expect(outcome).not.toBe("timed_out");
    if (outcome === "timed_out") return;
    await expect(local.load(investigationId)).resolves.toEqual(outcome);

    const emptyLocalStore = createProductBackedDeliveryStateStore(
      createInMemoryDeliveryStateStore(),
      product,
    );
    await expect(emptyLocalStore.load("inv_EMPTY123456")).resolves.toBeNull();
    await expect(
      emptyLocalStore.loadTerminalFailure("inv_EMPTY123456"),
    ).resolves.toBeNull();
  });
});
