// Worker-side processing: the processor must call the existing pipeline
// with the queued payload, report stages, post the result comment, and
// classify transient vs permanent failures for retry purposes. Dependencies
// are injected, so no Redis or GitHub access is required.
import { UnrecoverableError } from "bullmq";
import { describe, expect, test } from "vitest";
import {
  DELIVERY_JOB_ATTEMPTS,
  DELIVERY_JOB_NAME,
  DELIVERY_RETRY_BACKOFF_MS,
  INVESTIGATION_JOB_RETENTION,
  enqueueDeliveryJob,
  type InvestigationJobPayload,
} from "../backend/queue/investigation-queue.js";
import {
  createApp,
  isSyncInvestigationEndpointEnabled,
} from "../backend/server.js";
import {
  formatWorkerFailureComment,
  isTransientInfrastructureError,
  processInvestigationJob,
  type WorkerDeps,
} from "../backend/queue/process-investigation.js";
import {
  createInMemoryDeliveryStateStore,
  terminalCommentMarker,
  type DeliveryGitHubClient,
} from "../backend/services/delivery.js";
import type { InvestigationStage } from "../backend/services/investigation.js";
import { createInMemoryInvestigationStateStore } from "../backend/services/investigation-state-store.js";

// Minimal delivery wiring for worker tests that exercise the investigation
// path: durable in-memory state, no queued retry job, and a GitHub client
// that must never be needed (these tests never leave a pending PR).
function testDelivery(): WorkerDeps["delivery"] {
  return {
    store: createInMemoryDeliveryStateStore(),
    enqueue: async () => {},
    createGitHubClient: (): DeliveryGitHubClient => {
      throw new Error("The delivery GitHub client should not be used in this test.");
    },
    findTerminalComment: async () => false,
  };
}

const jobPayload: InvestigationJobPayload = {
  investigationId: "inv_0TEST123ABC",
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

describe("investigation worker processing", () => {
  test("invokes the existing pipeline with the queued payload, reports stages, and posts the result", async () => {
    const stages: InvestigationStage[] = [];
    const pipelineCalls: unknown[] = [];
    const comments: { issueNumber: number; body: string }[] = [];

    const deps: WorkerDeps = {
      delivery: testDelivery(),
      runPipeline: async (payload, options) => {
        pipelineCalls.push(payload);
        await options.onStage?.("reproducing");
        return {
          investigationId: payload.investigationId!,
          outcome: "verified_fix",
          summary: { investigationId: payload.investigationId!, outcome: "verified_fix" },
          fixAttempt: {
            outcome: "verified",
            fixAttemptId: "fix_0TEST123ABC",
          },
          githubComment: "RESULT COMMENT",
        };
      },
      getInstallationToken: async (installationId) => {
        expect(installationId).toBe(2);
        return {
          token: "short-lived-token",
          permissions: { contents: "write", issues: "write" },
        };
      },
      postIssueComment: async ({ issueNumber, body }) => {
        comments.push({ issueNumber, body });
      },
      reportStage: (stage) => {
        stages.push(stage);
      },
    };

    const outcome = await processInvestigationJob(
      { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } },
      deps,
    );

    expect(outcome).toEqual({ investigationId: "inv_0TEST123ABC", outcome: "verified_fix" });
    expect(pipelineCalls).toHaveLength(1);
    expect(pipelineCalls[0]).toMatchObject({
      investigationId: "inv_0TEST123ABC",
      repoOwner: "hiimbex",
      repoName: "testing-things",
      repoUrl: "https://github.com/hiimbex/testing-things",
      defaultBranch: "main",
      issueNumber: 1,
      issueTitle: "Example bug",
      installationToken: "short-lived-token",
      installationPermissions: { contents: "write", issues: "write" },
    });
    // Exactly one terminal comment, rebuilt from the durable delivery state
    // and stamped with the idempotency marker.
    expect(comments).toHaveLength(1);
    expect(comments[0].issueNumber).toBe(1);
    expect(comments[0].body).toContain("Outcome: verified_fix");
    expect(comments[0].body).toContain(terminalCommentMarker("inv_0TEST123ABC"));
    expect(stages).toEqual(["running", "reproducing", "delivering", "completed"]);
  });

  test("classifies retryable vs non-retryable failures and reports final failures", async () => {
    // Classifier: transient infrastructure signals.
    for (const transient of [
      { status: 502, message: "Bad gateway" },
      { status: 429, message: "too many requests" },
      Object.assign(new Error("connect failed"), { code: "ECONNRESET" }),
      new Error("git clone failed: early EOF"),
      new Error("You have exceeded a secondary rate limit"),
    ]) {
      expect(isTransientInfrastructureError(transient)).toBe(true);
    }

    // Classifier: logical/permanent failures are never retried.
    for (const permanent of [
      new Error("Fix proposal must be a JSON object."),
      { status: 404, message: "Not Found" },
      new Error("plan_failed"),
      null,
    ]) {
      expect(isTransientInfrastructureError(permanent)).toBe(false);
    }

    // Transient failure on a non-final attempt: rethrown as a sanitized,
    // non-Unrecoverable error (BullMQ retries with backoff), no failure
    // comment posted.
    const comments: string[] = [];
    const stages: InvestigationStage[] = [];
    const transientError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    const failingDeps = (error: unknown): WorkerDeps => ({
      delivery: testDelivery(),
      runPipeline: async () => {
        throw error;
      },
      getInstallationToken: async () => ({
        token: "token",
        permissions: { contents: "write" },
      }),
      postIssueComment: async ({ body }) => {
        comments.push(body);
      },
      reportStage: (stage) => {
        stages.push(stage);
      },
    });

    const transientRejection = await processInvestigationJob(
      { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } },
      failingDeps(transientError),
    ).then(
      () => {
        throw new Error("expected the job to reject");
      },
      (rejection: unknown) => rejection as Error,
    );
    expect(transientRejection).not.toBeInstanceOf(UnrecoverableError);
    expect(transientRejection.message).toBe(
      "An infrastructure operation is temporarily unavailable; the job will retry.",
    );
    expect(comments).toHaveLength(0);

    // Same transient failure on the final attempt: reported and permanent.
    await expect(
      processInvestigationJob(
        { data: jobPayload, attemptsMade: 2, opts: { attempts: 3 } },
        failingDeps(transientError),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(comments).toHaveLength(1);

    // Non-transient failure: immediately permanent, failure comment posted
    // with the investigation id in the hidden markers only, secrets redacted.
    const permanentError = new Error(
      "startup failed while DATABASE_URL=postgres://admin:hunter2@db/app was set",
    );

    await expect(
      processInvestigationJob(
        { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } },
        failingDeps(permanentError),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(comments).toHaveLength(2);
    const failureComment = comments[1];
    expect(failureComment).toContain("could not complete this investigation");
    expect(failureComment).toContain(
      "<!-- sherlock-terminal-comment:inv_0TEST123ABC -->",
    );
    expect(failureComment).toContain(
      "<!-- sherlock-delivery-comment:inv_0TEST123ABC -->",
    );
    // No visible investigation id outside the hidden markers.
    expect(failureComment).not.toMatch(/Investigation: inv_/);
    expect(failureComment).not.toContain("hunter2");
    expect(failureComment).toContain("**Investigation failed**");
    expect(failureComment).not.toContain("worker failed permanently");
    expect(stages.filter((stage) => stage === "failed")).toHaveLength(2);

    // The standalone formatter also redacts.
    expect(formatWorkerFailureComment("inv_X", new Error("api_key: sekret"))).not.toContain(
      "sekret",
    );
  });
});

describe("worker-level state store writes", () => {
  test("records created + terminal failed when installation-token setup fails before the pipeline", async () => {
    const stateStore = createInMemoryInvestigationStateStore();
    let pipelineRan = false;

    const deps: WorkerDeps = {
      stateStore,
      delivery: testDelivery(),
      runPipeline: async (payload) => {
        pipelineRan = true;
        return {
          investigationId: payload.investigationId!,
          outcome: "verified_fix",
          summary: { investigationId: payload.investigationId!, outcome: "verified_fix" },
          githubComment: "unused",
        };
      },
      // Auth/setup failure before the pipeline; non-transient => permanent.
      getInstallationToken: async () => {
        throw new Error("installation token minting failed: bad credentials");
      },
      postIssueComment: async () => {},
      reportStage: () => {},
    };

    await expect(
      processInvestigationJob(
        { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } },
        deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(pipelineRan).toBe(false);

    const record = await stateStore.get?.(jobPayload.investigationId);
    expect(record).toBeTruthy();
    // Worker-level created state exists with a derived (safe) repo URL.
    expect(record?.repoOwner).toBe("hiimbex");
    expect(record?.repoUrl).toBe("https://github.com/hiimbex/testing-things");
    // Terminal worker outcome recorded even though the pipeline never ran.
    expect(record?.status).toBe("finished");
    expect(record?.outcome).toBe("failed");
    expect(record?.errors.length).toBeGreaterThan(0);
    expect(record?.errors.some((entry) => entry.stage === "worker")).toBe(true);
  });

  test("records a retryable attempt error (but no final outcome) when transient token setup fails on a non-final attempt", async () => {
    const stateStore = createInMemoryInvestigationStateStore();
    let pipelineRan = false;

    // Transient/retryable infrastructure signal (ECONNRESET) raised during
    // pre-pipeline token/auth setup.
    const transientError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    const deps: WorkerDeps = {
      stateStore,
      delivery: testDelivery(),
      runPipeline: async (payload) => {
        pipelineRan = true;
        return {
          investigationId: payload.investigationId!,
          outcome: "verified_fix",
          summary: { investigationId: payload.investigationId!, outcome: "verified_fix" },
          githubComment: "unused",
        };
      },
      getInstallationToken: async () => {
        throw transientError;
      },
      postIssueComment: async () => {},
      reportStage: () => {},
    };

    // Non-final attempt: rethrown as a sanitized, non-Unrecoverable error so
    // BullMQ retries with backoff.
    await expect(
      processInvestigationJob(
        { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } },
        deps,
      ),
    ).rejects.toThrowError("temporarily unavailable");

    expect(pipelineRan).toBe(false);

    const record = await stateStore.get?.(jobPayload.investigationId);
    expect(record).toBeTruthy();
    // The failed attempt is visible: a worker-stage error flagged retryable.
    const retryableError = record?.errors.find(
      (entry) => entry.stage === "worker" && entry.retryable === true,
    );
    expect(retryableError).toBeTruthy();
    // No terminal outcome yet — the job will retry.
    expect(record?.status).toBe("running");
    expect(record?.outcome).toBeNull();
    expect(record?.finishedAt).toBeNull();
  });

  test("failure paths redact secret-bearing errors from logs, state records, and thrown reasons", async () => {
    const stateStore = createInMemoryInvestigationStateStore();
    const logs: string[] = [];
    const comments: string[] = [];
    // Placeholder-only "secret" values; the assertion is that neither survives.
    const secretBearingMessage =
      "clone failed: Authorization: Bearer example-secret while DATABASE_URL=postgres://admin:redact-me@db/app";

    const makeDeps = (error: unknown): WorkerDeps => ({
      stateStore,
      delivery: testDelivery(),
      runPipeline: async () => {
        throw error;
      },
      getInstallationToken: async () => ({ token: "t", permissions: null }),
      postIssueComment: async ({ body }) => {
        comments.push(body);
      },
      reportStage: () => {},
      log: (message) => {
        logs.push(message);
      },
    });

    // Transient path (non-final attempt): log, state record, and the rethrown
    // retry error are all redacted.
    const transient = Object.assign(new Error(secretBearingMessage), {
      code: "ECONNRESET",
    });
    const retryRejection = await processInvestigationJob(
      { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } },
      makeDeps(transient),
    ).then(
      () => {
        throw new Error("expected the job to reject");
      },
      (rejection: unknown) => rejection as Error,
    );
    expect(retryRejection.message).toContain("temporarily unavailable");
    expect(retryRejection.message).not.toContain("example-secret");
    expect(retryRejection.message).not.toContain("redact-me");

    // Permanent path (final attempt): the UnrecoverableError message becomes
    // the BullMQ failed reason and must be redacted too.
    const finalRejection = await processInvestigationJob(
      { data: jobPayload, attemptsMade: 2, opts: { attempts: 3 } },
      makeDeps(new Error(secretBearingMessage)),
    ).then(
      () => {
        throw new Error("expected the job to reject");
      },
      (rejection: unknown) => rejection as Error,
    );
    expect(finalRejection).toBeInstanceOf(UnrecoverableError);
    expect(finalRejection.message).toContain("inv_0TEST123ABC");
    expect(finalRejection.message).toContain("failed permanently");
    expect(finalRejection.message).not.toContain("example-secret");
    expect(finalRejection.message).not.toContain("redact-me");

    // Nothing that left the worker carries either raw value: worker logs,
    // GitHub comments, and every stored state-record error message are clean.
    const record = await stateStore.get?.(jobPayload.investigationId);
    const escaped = [
      ...logs,
      ...comments,
      ...(record?.errors ?? []).map((entry) => entry.message),
    ].join("\n");
    expect(escaped).not.toContain("example-secret");
    expect(escaped).not.toContain("redact-me");
    expect(escaped).toContain("temporarily unavailable");
  });

  test("a post-pipeline comment failure keeps the pipeline outcome and records the failed delivery", async () => {
    // The pipeline (stub) returns a result; the terminal comment then fails
    // permanently. The recorded outcome must stay the pipeline's own outcome,
    // with the comment failure captured as delivery state — and no second
    // "worker failure" comment may be posted over it.
    const stateStore = createInMemoryInvestigationStateStore();
    const comments: string[] = [];

    const deps: WorkerDeps = {
      stateStore,
      delivery: testDelivery(),
      runPipeline: async (payload) => ({
        investigationId: payload.investigationId!,
        outcome: "verified_fix",
        summary: { investigationId: payload.investigationId!, outcome: "verified_fix" },
        fixAttempt: {
          outcome: "verified",
          fixAttemptId: "fix_0TEST123ABC",
        },
        githubComment: "RESULT",
      }),
      getInstallationToken: async () => ({ token: "t", permissions: null }),
      // Non-transient failure AFTER the pipeline produced a result.
      postIssueComment: async ({ body }) => {
        comments.push(body);
        throw new Error("GitHub comment API rejected the request");
      },
      reportStage: () => {},
    };

    await expect(
      processInvestigationJob(
        { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } },
        deps,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const record = await stateStore.get?.(jobPayload.investigationId);
    // The delivery layer recorded the pipeline's true outcome and the failed
    // terminal-comment delivery — the worker did not stamp "failed" over it.
    expect(record?.status).toBe("finished");
    expect(record?.outcome).toBe("verified_fix");
    expect(record?.terminalComment?.status).toBe("failed");
    // Only the (failed) terminal comment attempt; no extra failure comment.
    expect(comments).toHaveLength(1);
  });
});

describe("production safety", () => {
  test("delivery jobs contain only non-secret identity and use their own bounded retry policy", async () => {
    const calls: unknown[][] = [];
    const queue = {
      add: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    };

    await enqueueDeliveryJob(queue as never, {
      investigationId: jobPayload.investigationId,
      tenantId: jobPayload.tenantId,
      installationId: jobPayload.installationId,
      repositoryOwner: jobPayload.repositoryOwner,
      repositoryName: jobPayload.repositoryName,
      issueNumber: jobPayload.issueNumber,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(DELIVERY_JOB_NAME);
    expect(calls[0][1]).toEqual({
      investigationId: jobPayload.investigationId,
      tenantId: jobPayload.tenantId,
      installationId: jobPayload.installationId,
      repositoryOwner: jobPayload.repositoryOwner,
      repositoryName: jobPayload.repositoryName,
      issueNumber: jobPayload.issueNumber,
    });
    expect(calls[0][2]).toMatchObject({
      attempts: DELIVERY_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: DELIVERY_RETRY_BACKOFF_MS },
    });
    const serialized = JSON.stringify(calls[0][1]);
    expect(serialized).not.toContain("short-lived-token");
    expect(serialized).not.toContain("ANTHROPIC");
    expect(serialized).not.toContain("WEBHOOK_SECRET");
  });

  test("the synchronous HTTP endpoint is disabled in production but health stays available", async () => {
    // Gate logic across environments.
    expect(isSyncInvestigationEndpointEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isSyncInvestigationEndpointEnabled({})).toBe(true);
    expect(isSyncInvestigationEndpointEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      isSyncInvestigationEndpointEnabled({
        NODE_ENV: "production",
        ALLOW_SYNC_INVESTIGATIONS: "true",
      }),
    ).toBe(true);

    // Real HTTP behavior of a production-configured app.
    const app = createApp({ NODE_ENV: "production" });
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const investigation = await fetch(`${baseUrl}/investigations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoUrl: "https://github.com/x/y" }),
      });
      expect(investigation.status).toBe(403);
      const body = (await investigation.json()) as { error: string };
      expect(body.error).toContain("Redis queue");
    } finally {
      server.close();
    }
  });

  test("job retention keeps completed and failed jobs long enough for redelivery deduplication", () => {
    const DAY_SECONDS = 24 * 60 * 60;

    // Completed jobs must outlive the webhook-redelivery window (idempotency
    // depends on the job still existing in Redis) but stay bounded.
    expect(INVESTIGATION_JOB_RETENTION.removeOnComplete.age).toBeGreaterThanOrEqual(DAY_SECONDS);
    expect(INVESTIGATION_JOB_RETENTION.removeOnComplete.count).toBeGreaterThan(0);

    // Failed jobs are retained longer for debugging.
    expect(INVESTIGATION_JOB_RETENTION.removeOnFail.age).toBeGreaterThan(
      INVESTIGATION_JOB_RETENTION.removeOnComplete.age,
    );
    expect(INVESTIGATION_JOB_RETENTION.removeOnFail.count).toBeGreaterThan(0);
  });
});
