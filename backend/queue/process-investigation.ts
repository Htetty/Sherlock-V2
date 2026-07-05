// Worker-side job processing, separated from the BullMQ Worker wiring so it
// can be tested with injected dependencies and no Redis server.
//
// Retry policy: only transient infrastructure failures are retried (thrown
// as-is so BullMQ applies the job's bounded exponential backoff). Logical
// outcomes — not_reproduced, plan_failed, rejected patches, failed
// verification — are successful pipeline *results*, never retries. Any other
// error fails permanently via UnrecoverableError.

import { UnrecoverableError } from "bullmq";
import type {
  InvestigationPipelineInput,
  InvestigationPipelineResult,
  InvestigationStage,
} from "../services/investigation.js";
import { redactSecrets } from "../services/report.js";
import type { InvestigationJobPayload } from "./investigation-queue.js";

export type InvestigationJobLike = {
  data: InvestigationJobPayload;
  // BullMQ: attempts already fully executed before this one.
  attemptsMade: number;
  opts?: { attempts?: number };
};

export type WorkerDeps = {
  runPipeline: (
    payload: InvestigationPipelineInput,
    options: { onStage?: (stage: InvestigationStage) => void | Promise<void> },
  ) => Promise<InvestigationPipelineResult>;
  // Mints a short-lived installation token from the GitHub App credentials;
  // tokens are never stored in the queue payload.
  getInstallationToken: (installationId: number) => Promise<string | null>;
  postIssueComment: (input: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }) => Promise<void>;
  reportStage?: (stage: InvestigationStage) => void | Promise<void>;
  log?: (message: string) => void;
};

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /rate limit/i,
  /secondary rate/i,
  /timed? ?out/i,
  /socket hang up/i,
  /could not resolve host/i,
  /early eof/i,
  /rpc failed/i,
  /temporarily unavailable/i,
  /service unavailable/i,
];

// Transient infrastructure failures: temporary GitHub 5xx or rate limiting,
// network/clone blips, temporary external-service failures.
export function isTransientInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    status?: number;
    code?: string | number;
    message?: string;
  };

  if (typeof candidate.status === "number" && (candidate.status >= 500 || candidate.status === 429)) {
    return true;
  }

  if (typeof candidate.code === "string" && TRANSIENT_ERROR_CODES.has(candidate.code)) {
    return true;
  }

  const message = typeof candidate.message === "string" ? candidate.message : "";

  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function formatWorkerFailureComment(
  investigationId: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);

  return redactSecrets(
    [
      "Sherlock could not complete this investigation because of an internal failure.",
      "",
      `Investigation: ${investigationId}`,
      "Outcome: failed",
      `Error: ${message.slice(0, 600)}`,
      "",
      "Any artifacts collected before the failure were preserved on the Sherlock server.",
    ].join("\n"),
  );
}

export async function processInvestigationJob(
  job: InvestigationJobLike,
  deps: WorkerDeps,
): Promise<{ investigationId: string; outcome: string }> {
  const payload = job.data;
  const log = deps.log ?? (() => {});

  const reportStage = async (stage: InvestigationStage) => {
    try {
      await deps.reportStage?.(stage);
    } catch {
      // Stage reporting is telemetry; never fail the job over it.
    }
  };

  try {
    await reportStage("running");
    log(`[${payload.investigationId}] Job started for ${payload.repositoryOwner}/${payload.repositoryName}#${payload.issueNumber} (tenant ${payload.tenantId}).`);

    const installationToken = await deps.getInstallationToken(payload.installationId);

    const result = await deps.runPipeline(
      {
        investigationId: payload.investigationId,
        repoOwner: payload.repositoryOwner,
        repoName: payload.repositoryName,
        repoUrl: payload.repositoryUrl,
        defaultBranch: payload.defaultBranch,
        issueNumber: payload.issueNumber,
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody,
        issueUrl: payload.issueUrl,
        triggerComment: payload.triggerComment,
        triggeredBy: payload.triggeredBy,
        installationToken,
      },
      { onStage: reportStage },
    );

    await deps.postIssueComment({
      installationId: payload.installationId,
      owner: payload.repositoryOwner,
      repo: payload.repositoryName,
      issueNumber: payload.issueNumber,
      body: result.githubComment,
    });

    await reportStage("completed");
    log(`[${payload.investigationId}] Job completed with outcome ${result.outcome}.`);

    return { investigationId: payload.investigationId, outcome: result.outcome };
  } catch (error) {
    const attemptsAllowed = job.opts?.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attemptsAllowed;

    if (isTransientInfrastructureError(error) && !isFinalAttempt) {
      log(
        `[${payload.investigationId}] Transient failure (attempt ${job.attemptsMade + 1}/${attemptsAllowed}), will retry: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    // Final failure: preserve the investigation id and artifacts (the
    // pipeline's own cleanup already stopped sandboxes and containers),
    // report to GitHub, and stop retrying.
    await reportStage("failed");
    await deps
      .postIssueComment({
        installationId: payload.installationId,
        owner: payload.repositoryOwner,
        repo: payload.repositoryName,
        issueNumber: payload.issueNumber,
        body: formatWorkerFailureComment(payload.investigationId, error),
      })
      .catch((commentError: unknown) => {
        log(
          `[${payload.investigationId}] Could not post failure comment: ${commentError instanceof Error ? commentError.message : String(commentError)}`,
        );
      });

    throw new UnrecoverableError(
      `[${payload.investigationId}] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
