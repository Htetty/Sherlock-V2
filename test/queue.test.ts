// Worker-side processing: the processor must call the existing pipeline
// with the queued payload, report stages, post the result comment, and
// classify transient vs permanent failures for retry purposes. Dependencies
// are injected, so no Redis or GitHub access is required.
import { UnrecoverableError } from "bullmq";
import { describe, expect, test } from "vitest";
import {
  INVESTIGATION_JOB_RETENTION,
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
import type { InvestigationStage } from "../backend/services/investigation.js";

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
      runPipeline: async (payload, options) => {
        pipelineCalls.push(payload);
        await options.onStage?.("reproducing");
        return {
          investigationId: payload.investigationId!,
          outcome: "verified_fix",
          summary: { investigationId: payload.investigationId!, outcome: "verified_fix" },
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
    expect(comments).toEqual([{ issueNumber: 1, body: "RESULT COMMENT" }]);
    expect(stages).toEqual(["running", "reproducing", "completed"]);
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

    // Transient failure on a non-final attempt: rethrown as-is (BullMQ
    // retries with backoff), no failure comment posted.
    const comments: string[] = [];
    const stages: InvestigationStage[] = [];
    const transientError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    const failingDeps = (error: unknown): WorkerDeps => ({
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

    await expect(
      processInvestigationJob(
        { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } },
        failingDeps(transientError),
      ),
    ).rejects.toBe(transientError);
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
    // with the investigation id and secrets redacted.
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
    expect(failureComment).toContain("Investigation: inv_0TEST123ABC");
    expect(failureComment).toContain("Outcome: failed");
    expect(failureComment).not.toContain("hunter2");
    expect(failureComment).toContain("[REDACTED]");
    expect(stages.filter((stage) => stage === "failed")).toHaveLength(2);

    // The standalone formatter also redacts.
    expect(formatWorkerFailureComment("inv_X", new Error("api_key: sekret"))).not.toContain(
      "sekret",
    );
  });
});

describe("production safety", () => {
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
