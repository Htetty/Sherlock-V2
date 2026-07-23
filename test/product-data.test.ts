import { describe, expect, it } from "vitest";
import {
  buildDeliveryState,
  createInMemoryDeliveryStateStore,
} from "../backend/services/delivery.js";
import {
  createInMemoryProductDataStore,
  createProductBackedDeliveryStateStore,
} from "../backend/services/product-data.js";

const investigationId = "inv_01K123456789AB";

function createInput() {
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
  };
}

describe("product data persistence", () => {
  it("claims a triggering comment once and retains the original public id", async () => {
    const store = createInMemoryProductDataStore();

    await expect(store.createInvestigation(createInput())).resolves.toEqual({
      created: true,
      investigationId,
    });
    await expect(
      store.createInvestigation({
        ...createInput(),
        investigationId: "inv_01K123456789AC",
      }),
    ).resolves.toEqual({
      created: false,
      investigationId,
    });

    expect(store.snapshot().investigations).toHaveLength(1);
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
    const state = await buildDeliveryState(
      {
        investigationId,
        tenantId: "tenant-gh-2",
        installationId: 2,
        repoOwner: "octo",
        repoName: "repo",
        issueNumber: 7,
        issueTitle: "Broken dashboard",
        outcome: "not_reproduced",
        summary: {
          investigationId,
          outcome: "not_reproduced",
        },
        fixVerified: false,
        fixAttemptId: null,
        analysisComment: null,
        fixComment: null,
        report: {
          outcome: "not_reproduced",
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
      },
      first,
    );
    await first.save(state);

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
});
