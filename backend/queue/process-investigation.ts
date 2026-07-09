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
import { RepositoryError } from "../services/repo-auth.js";
import { redactSecrets } from "../services/report.js";
import {
  safeRepoUrl,
  type InvestigationStateEvent,
  type InvestigationStateEventInput,
  type InvestigationStateStore,
} from "../services/investigation-state-store.js";
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
  // tokens are never stored in the queue payload. The permissions object is
  // the token response's own metadata (authoritative for Contents access) —
  // returned alongside the token so no extra token request is needed.
  getInstallationToken: (installationId: number) => Promise<{
    token: string;
    permissions: Record<string, string> | null;
  } | null>;
  postIssueComment: (input: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }) => Promise<void>;
  reportStage?: (stage: InvestigationStage) => void | Promise<void>;
  // Lifecycle state store. Worker-level writes (queued/running before the
  // pipeline runs, and a terminal failure when setup fails before the pipeline)
  // go through here so an investigation that dies during token/auth setup still
  // leaves a state record. Optional and best-effort: never fails the job.
  stateStore?: InvestigationStateStore;
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

  // Typed repository errors carry their own retry classification; this is
  // authoritative and never falls through to message matching (a logical
  // access error whose message happens to mention "rate limit" must not be
  // retried).
  if (error instanceof RepositoryError) {
    return error.retryable;
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

  // Best-effort, non-fatal worker-level state writes. A failing store must
  // never fail the job (which would trigger a spurious retry).
  const recordState = async (event: InvestigationStateEventInput) => {
    try {
      await deps.stateStore?.record({
        ...event,
        investigationId: payload.investigationId,
        at: new Date().toISOString(),
      } as InvestigationStateEvent);
    } catch (stateError) {
      log(
        `[${payload.investigationId}] Worker state write failed ("${event.type}"); continuing: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
      );
    }
  };

  const reportStage = async (stage: InvestigationStage) => {
    try {
      await deps.reportStage?.(stage);
    } catch {
      // Stage reporting is telemetry; never fail the job over it.
    }
  };

  // Set once the pipeline returns; distinguishes a pre-pipeline/worker-setup
  // failure (record a terminal worker outcome) from a post-pipeline failure
  // (the pipeline already recorded its own final outcome — do not overwrite).
  let pipelineResult: InvestigationPipelineResult | null = null;

  try {
    // Worker-level state before any setup runs, so an investigation that dies
    // during token/auth setup still leaves a created + terminal record. The
    // repo URL is derived from owner/name, never a caller-supplied URL.
    await recordState({
      type: "created",
      repoOwner: payload.repositoryOwner,
      repoName: payload.repositoryName,
      repoUrl: safeRepoUrl(payload.repositoryOwner, payload.repositoryName),
      issueNumber: payload.issueNumber,
      issueTitle: payload.issueTitle,
      issueUrl: payload.issueUrl,
      triggeredBy: payload.triggeredBy,
    });
    await recordState({ type: "stage_changed", stage: "running" });

    await reportStage("running");
    log(`[${payload.investigationId}] Job started for ${payload.repositoryOwner}/${payload.repositoryName}#${payload.issueNumber} (tenant ${payload.tenantId}).`);

    const installationAuth = await deps.getInstallationToken(payload.installationId);

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
        installationToken: installationAuth?.token ?? null,
        installationPermissions: installationAuth?.permissions ?? null,
      },
      { onStage: reportStage },
    );
    pipelineResult = result;

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
      // Record the failed attempt (best-effort) so a retryable pre-pipeline
      // failure is visible in state, without recording a terminal outcome —
      // then rethrow unchanged so BullMQ retries with backoff.
      await recordState({
        type: "error",
        stage: "worker",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
      throw error;
    }

    // Final failure: preserve the investigation id and artifacts (the
    // pipeline's own cleanup already stopped sandboxes and containers),
    // report to GitHub, and stop retrying.
    await reportStage("failed");

    // Record a terminal worker-level state. Always append the error; only own
    // the final outcome when the pipeline never produced one (a pre-pipeline
    // or worker-setup failure), so a post-pipeline failure — e.g. GitHub
    // comment posting — cannot overwrite the pipeline's real outcome.
    const failureMessage = error instanceof Error ? error.message : String(error);
    await recordState({ type: "error", stage: "worker", message: failureMessage });
    if (!pipelineResult) {
      await recordState({
        type: "final_outcome",
        outcome: "failed",
        error: failureMessage,
      });
    }

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
