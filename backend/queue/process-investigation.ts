// Worker-side job processing, separated from the BullMQ Worker wiring so it
// can be tested with injected dependencies and no Redis server.
//
// Retry policy: only transient infrastructure failures are retried (thrown
// as-is so BullMQ applies the job's bounded exponential backoff). Logical
// outcomes — not_reproduced, plan_failed, rejected patches, failed
// verification — are successful pipeline *results*, never retries. Any other
// error fails permanently via UnrecoverableError.

import { DelayedError, UnrecoverableError } from "bullmq";
import { randomUUID } from "node:crypto";
import {
  buildDeliveryState,
  deliveryCommentMarker,
  runDeliveryFromState,
  terminalCommentMarker,
  DeliveryRetryableError,
  type DeliveryExecutorDeps,
  type DeliveryGitHubClient,
  type DeliveryState,
  type DeliveryStateStore,
  type TerminalFailureCategory,
  type TerminalFailureRecord,
} from "../services/delivery.js";
import {
  buildWorkerFailureReportData,
  renderWorkerFailureIssueReport,
} from "../services/issue-report-renderer.js";
import type {
  InvestigationPipelineInput,
  InvestigationPipelineResult,
  InvestigationStage,
} from "../services/investigation.js";
import {
  buildRepoConcurrencyKey,
  type InvestigationConcurrencyGate,
} from "../services/rate-limit.js";
import { RepositoryError } from "../services/repo-auth.js";
import { redactSecrets } from "../services/report.js";
import {
  safeRepoUrl,
  type InvestigationStateEvent,
  type InvestigationStateEventInput,
  type InvestigationStateStore,
} from "../services/investigation-state-store.js";
import {
  DELIVERY_RETRY_BACKOFF_MS,
  type DeliveryJobPayload,
  type InvestigationJobPayload,
} from "./investigation-queue.js";

export type InvestigationJobLike = {
  id?: string | number;
  data: InvestigationJobPayload;
  // BullMQ: attempts already fully executed before this one.
  attemptsMade: number;
  opts?: { attempts?: number };
};

export type WorkerDeps = {
  runPipeline: (
    payload: InvestigationPipelineInput,
    options: {
      onStage?: (stage: InvestigationStage) => void | Promise<void>;
      signal?: AbortSignal;
      onTerminalResult?: (
        result: InvestigationPipelineResult,
      ) => void | Promise<void>;
    },
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
    assertOwnership?: () => Promise<void>;
  }) => Promise<void | { id: number }>;
  updateIssueComment?: DeliveryExecutorDeps["updateIssueComment"];
  reportStage?: (stage: InvestigationStage) => void | Promise<void>;
  // Lifecycle state store. Worker-level writes (queued/running before the
  // pipeline runs, and a terminal failure when setup fails before the pipeline)
  // go through here so an investigation that dies during token/auth setup still
  // leaves a state record. Optional and best-effort: never fails the job.
  stateStore?: InvestigationStateStore;
  // Required product projection in configured deployments. It runs at the
  // terminal callback while local artifacts still exist, before workspace
  // cleanup can remove the exact diff and replay evidence.
  persistResult?: (result: InvestigationPipelineResult) => Promise<void>;
  recordDeliveryAttempt?: (
    investigationId: string,
    attemptCount: number,
    nextRetryAt: string | null,
  ) => Promise<void>;
  acknowledgeInvestigationEnqueued?: (
    payload: InvestigationJobPayload,
    queueJobId: string,
  ) => Promise<void>;
  // GitHub delivery: durable state store, delivery-only retry job producer,
  // and the GitHub surfaces the idempotent delivery executor needs. See
  // services/delivery.ts for the contract.
  delivery: {
    store: DeliveryStateStore;
    enqueue: (payload: DeliveryJobPayload) => Promise<void>;
    createGitHubClient: (input: {
      token: string;
      owner: string;
      repo: string;
    }) => DeliveryGitHubClient;
    findTerminalComment: (input: {
      installationId: number;
      owner: string;
      repo: string;
      issueNumber: number;
      marker: string;
      reusableMarker: string;
      assertOwnership: () => Promise<void>;
    }) => ReturnType<DeliveryExecutorDeps["findTerminalComment"]>;
  };
  log?: (message: string) => void;
};

// Deliberately excludes runPipeline and every execution-stage adapter. A
// delivery-only processor can be constructed and tested without clone,
// Anthropic, reproduction, fixer, sandbox, or validation capabilities.
export type DeliveryWorkerDeps = Pick<
  WorkerDeps,
  | "getInstallationToken"
  | "postIssueComment"
  | "updateIssueComment"
  | "stateStore"
  | "recordDeliveryAttempt"
  | "delivery"
  | "log"
>;

function toDeliveryExecutorDeps(deps: DeliveryWorkerDeps): DeliveryExecutorDeps {
  return {
    deliveryStore: deps.delivery.store,
    stateStore: deps.stateStore,
    getInstallationToken: deps.getInstallationToken,
    createGitHubClient: deps.delivery.createGitHubClient,
    postIssueComment: deps.postIssueComment,
    updateIssueComment: deps.updateIssueComment,
    findTerminalComment: deps.delivery.findTerminalComment,
    isRetryableError: isTransientInfrastructureError,
    log: deps.log,
  };
}

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
const PRODUCT_PERSISTENCE_DEADLINE_MS = 15_000;

async function withProductPersistenceDeadline(
  operation: () => Promise<void>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Product persistence timed out.")),
          PRODUCT_PERSISTENCE_DEADLINE_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

// Single choke point for rendering a worker-path error as text. Everything a
// failure message can reach — worker logs, the BullMQ failed reason, the
// Supabase state record, the GitHub failure comment — must go through this
// (or redactSecrets directly) so a raw error that happens to embed a token,
// connection string, or env assignment never leaves the process verbatim.
export function safeErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

// Terminal report body for a pre-pipeline worker failure. The visible text
// carries no investigation id; the id lives only in the hidden markers, which
// let delivery reconciliation recognize this as the terminal report and let
// the failure path reuse the owned queued comment.
export function formatWorkerFailureComment(
  investigationId: string,
  error: unknown,
): string {
  return [
    renderWorkerFailureIssueReport({ error: safeErrorMessage(error) }),
    terminalCommentMarker(investigationId),
    deliveryCommentMarker(investigationId),
  ].join("\n\n");
}

function terminalFailureCategory(
  error: unknown,
  pipelineStarted: boolean,
): TerminalFailureCategory {
  return error instanceof RepositoryError
    ? "repository"
    : isTransientInfrastructureError(error)
      ? "infrastructure"
      : !pipelineStarted
        ? "preflight"
        : "worker";
}

function retryableWorkerFailureMessage(error: unknown): string {
  if (error instanceof DeliveryRetryableError) {
    return "Delivery reconciliation is temporarily unavailable.";
  }
  if (error instanceof RepositoryError) {
    return "A repository operation is temporarily unavailable; the job will retry.";
  }
  return "An infrastructure operation is temporarily unavailable; the job will retry.";
}

function terminalWorkerFailureMessage(category: TerminalFailureCategory): string {
  switch (category) {
    case "repository":
      return "Repository access failed after the configured attempts.";
    case "infrastructure":
      return "Infrastructure failed after the configured attempts.";
    case "preflight":
      return "Worker preflight failed permanently.";
    case "worker":
      return "The investigation worker failed permanently.";
  }
}

// Durable delivery of a pre-pipeline worker-failure report. It uses the same
// protected v2 payload, delivery lease, owned-comment reconciliation, persisted
// create intent, acknowledgement-loss handling, and delivery-only retry queue
// as every pipeline terminal report. A failed or ambiguous scan can therefore
// never become permission to create a second comment.
async function deliverWorkerFailureReport(
  deps: DeliveryWorkerDeps,
  payload: InvestigationJobPayload,
  failureMessage: string,
  failureStage: string,
): Promise<void> {
  const report = buildWorkerFailureReportData({
    error: failureMessage,
    stage: failureStage,
  });
  const state = await buildDeliveryState(
    {
      investigationId: payload.investigationId,
      tenantId: payload.tenantId,
      installationId: payload.installationId,
      repoOwner: payload.repositoryOwner,
      repoName: payload.repositoryName,
      issueNumber: payload.issueNumber,
      issueTitle: payload.issueTitle,
      outcome: "failed",
      // The v1-only summary is not rendered for this v2 payload. Keep its
      // legacy enum valid while the delivery state's execution truth is failed.
      summary: {
        investigationId: payload.investigationId,
        outcome: "execution_failed",
        stage: failureStage,
        error: failureMessage,
      },
      fixVerified: false,
      fixAttemptId: null,
      analysisComment: null,
      fixComment: null,
      report,
      pullRequest: null,
      retryPlan: null,
    },
    deps.delivery.store,
  );

  // Persist before the first GitHub read or write. A restarted investigation
  // worker will hit the delivery-state resume guard and cannot rerun execution.
  await deps.delivery.store.save(state);

  try {
    const { complete } = await runDeliveryFromState(
      state,
      toDeliveryExecutorDeps(deps),
      { isFinalAttempt: false },
    );
    if (complete) return;
    // A permanent terminal-comment failure was already recorded by delivery.
    return;
  } catch (error) {
    if (
      !(error instanceof DeliveryRetryableError) &&
      !isTransientInfrastructureError(error)
    ) {
      throw error;
    }
  }

  await deps.delivery.enqueue({
    investigationId: payload.investigationId,
    tenantId: payload.tenantId,
    installationId: payload.installationId,
    repositoryOwner: payload.repositoryOwner,
    repositoryName: payload.repositoryName,
    issueNumber: payload.issueNumber,
  });
}

// How long a concurrency-blocked job waits before the queue retries it.
// Intentional delay through the queue — never a drop and never a failure.
export const CONCURRENCY_BLOCKED_RETRY_DELAY_MS = 30_000;
export const CONCURRENCY_HEARTBEAT_INTERVAL_MS = 10 * 60_000;

export type ConcurrencyHooks = {
  gate: InvestigationConcurrencyGate;
  // Moves this job back to the delayed set (BullMQ job.moveToDelayed with
  // the worker token); processInvestigationJobWithConcurrency then throws
  // DelayedError so BullMQ treats the job as rescheduled, not failed.
  delayJob: (delayMs: number) => Promise<void>;
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
};

// Wraps job processing with the Redis-backed concurrency gate: acquire a
// tenant+repo slot before the pipeline runs, always release it afterwards
// (success, logical outcome, or throw), and delay the job when no slot is
// free. With hooks=null behavior is identical to processInvestigationJob.
export async function processInvestigationJobWithConcurrency(
  job: InvestigationJobLike,
  deps: WorkerDeps,
  hooks: ConcurrencyHooks | null,
): Promise<{ investigationId: string; outcome: string }> {
  if (!hooks) {
    return processInvestigationJob(job, deps);
  }

  const log = deps.log ?? (() => {});
  const slot = {
    tenantKey: job.data.tenantId,
    repoKey: buildRepoConcurrencyKey(
      job.data.repositoryOwner,
      job.data.repositoryName,
    ),
    investigationId: job.data.investigationId,
    leaseId: randomUUID(),
  };

  const decision = await hooks.gate.acquireInvestigationConcurrency(slot);

  if (!decision.acquired) {
    const delayMs = hooks.retryDelayMs ?? CONCURRENCY_BLOCKED_RETRY_DELAY_MS;

    log(
      `[${slot.investigationId}] Concurrency limit reached (${decision.blockedBy}: ${decision.blockedBy === "repo" ? decision.repoActive : decision.tenantActive} active, limit ${decision.limit}); delaying job by ${delayMs}ms.`,
    );
    await hooks.delayJob(delayMs);
    throw new DelayedError(
      `Investigation ${slot.investigationId} delayed: ${decision.blockedBy} concurrency limit reached.`,
    );
  }

  const heartbeatIntervalMs =
    hooks.heartbeatIntervalMs ?? CONCURRENCY_HEARTBEAT_INTERVAL_MS;
  let heartbeatStopped = false;
  const leaseAbort = new AbortController();
  let pendingRenewal = Promise.resolve();
  const heartbeat = setInterval(() => {
    pendingRenewal = pendingRenewal
      .then(async () => {
        if (heartbeatStopped) {
          return;
        }

        const renewed = await hooks.gate.renewInvestigationConcurrency(slot);

        if (!renewed) {
          const reason = new Error(
            `Concurrency lease ownership was lost for investigation ${slot.investigationId}.`,
          );
          log(`[${slot.investigationId}] ${reason.message}`);
          leaseAbort.abort(reason);
        }
      })
      .catch((error: unknown) => {
        log(
          `[${slot.investigationId}] Could not renew concurrency lease; the next heartbeat will retry: ${safeErrorMessage(error)}`,
        );
      });
  }, heartbeatIntervalMs);
  heartbeat.unref();

  try {
    return await processInvestigationJob(job, deps, leaseAbort.signal);
  } finally {
    heartbeatStopped = true;
    clearInterval(heartbeat);
    await pendingRenewal;
    // Slot release must survive every exit path; a failed release only
    // falls back to the TTL-based stale eviction, never a permanent block.
    await hooks.gate.releaseInvestigationConcurrency(slot).catch((error: unknown) => {
      log(
        `[${slot.investigationId}] Could not release concurrency slot (stale-slot TTL will reclaim it): ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

export async function processInvestigationJob(
  job: InvestigationJobLike,
  deps: WorkerDeps,
  signal?: AbortSignal,
): Promise<{ investigationId: string; outcome: string }> {
  const payload = job.data;
  const log = deps.log ?? (() => {});
  let latestStage: InvestigationStage = "queued";

  // Repair the database outbox acknowledgement if the bot enqueued the job
  // but lost its Supabase acknowledgement. This is best-effort and must never
  // make investigation execution depend on dashboard persistence.
  try {
    const acknowledge = deps.acknowledgeInvestigationEnqueued;
    if (job.id && acknowledge) {
      await withProductPersistenceDeadline(() =>
        acknowledge(payload, String(job.id)),
      );
    }
  } catch (error) {
    log(
      `[${payload.investigationId}] Durable enqueue acknowledgement failed in worker; execution will continue: ${safeErrorMessage(error)}`,
    );
  }

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
        `[${payload.investigationId}] Worker state write failed ("${event.type}"); continuing: ${safeErrorMessage(stateError)}`,
      );
    }
  };

  const reportStage = async (stage: InvestigationStage) => {
    latestStage = stage;
    if (stage !== "failed") {
      signal?.throwIfAborted();
    }
    try {
      await deps.reportStage?.(stage);
    } catch {
      // Stage reporting is telemetry; never fail the job over it.
    }
    if (stage !== "failed") {
      signal?.throwIfAborted();
    }
  };

  const attemptsAllowed = job.opts?.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= attemptsAllowed;

  // --- Delivery-only resume guard -------------------------------------------
  // A persisted delivery state means execution already reached a terminal
  // result on a previous attempt (or the worker crashed/stalled after it).
  // Never rerun the pipeline: finish GitHub delivery from the durable state.
  let existingDeliveryState: DeliveryState | null;
  let existingTerminalFailure: TerminalFailureRecord | null;
  try {
    existingDeliveryState = await deps.delivery.store.load(
      payload.investigationId,
    );
    existingTerminalFailure = await deps.delivery.store.loadTerminalFailure(
      payload.investigationId,
    );
  } catch (error) {
    const message = safeErrorMessage(error);
    // An unreadable durable state is never equivalent to "execution has not
    // happened". Retry the read, but never enter the pipeline on this attempt.
    if (!isFinalAttempt) {
      throw new Error(message);
    }
    throw new UnrecoverableError(`[${payload.investigationId}] ${message}`);
  }

  if (existingTerminalFailure) {
    if (
      existingTerminalFailure.tenantId !== payload.tenantId ||
      existingTerminalFailure.repoOwner !== payload.repositoryOwner ||
      existingTerminalFailure.repoName !== payload.repositoryName
    ) {
      throw new UnrecoverableError(
        `[${payload.investigationId}] Terminal failure state does not match the investigation job.`,
      );
    }
    log(
      `[${payload.investigationId}] Terminal infrastructure failure already exists; the investigation pipeline will not rerun.`,
    );
    throw new UnrecoverableError(
      `[${payload.investigationId}] Investigation already terminalized at ${existingTerminalFailure.stage}.`,
    );
  }

  if (existingDeliveryState) {
    if (
      existingDeliveryState.tenantId !== payload.tenantId ||
      existingDeliveryState.installationId !== payload.installationId ||
      existingDeliveryState.repoOwner !== payload.repositoryOwner ||
      existingDeliveryState.repoName !== payload.repositoryName ||
      existingDeliveryState.issueNumber !== payload.issueNumber
    ) {
      throw new UnrecoverableError(
        `[${payload.investigationId}] Delivery state does not match the investigation job; refusing to deliver.`,
      );
    }

    log(
      `[${payload.investigationId}] Terminal execution state already exists; resuming delivery only (no pipeline rerun).`,
    );

    try {
      await reportStage("delivering");
      const { state: delivered, complete } = await runDeliveryFromState(
        existingDeliveryState,
        toDeliveryExecutorDeps(deps),
        { isFinalAttempt },
      );

      if (!complete) {
        await reportStage("failed");
        throw new UnrecoverableError(
          `[${payload.investigationId}] Delivery incomplete: terminal comment ${delivered.terminalComment.status}${delivered.terminalComment.reason ? ` (${delivered.terminalComment.reason})` : ""}.`,
        );
      }

      await reportStage("completed");
      return {
        investigationId: payload.investigationId,
        outcome: delivered.executionOutcome,
      };
    } catch (error) {
      if (error instanceof UnrecoverableError) {
        throw error;
      }

      const message = safeErrorMessage(error);

      if (error instanceof DeliveryRetryableError) {
        log(
          `[${payload.investigationId}] Delivery retry failed transiently; durable delivery remains pending: ${message}`,
        );
        await recordState({
          type: "error",
          stage: "delivery",
          message,
          retryable: true,
        });
        throw new Error(message);
      }

      await recordState({ type: "error", stage: "delivery", message });
      throw new UnrecoverableError(`[${payload.investigationId}] ${message}`);
    }
  }

  // Set once the pipeline returns; distinguishes a pre-pipeline/worker-setup
  // failure (record a terminal worker outcome) from a post-pipeline failure
  // (the pipeline already recorded its own final outcome — do not overwrite).
  let pipelineResult: InvestigationPipelineResult | null = null;
  let pipelineStarted = false;
  let persistedDeliveryState: DeliveryState | null = null;
  let persistedProductResult = false;
  let deliveryPersistenceError: unknown = null;

  const deliveryStateFor = (result: InvestigationPipelineResult) =>
    buildDeliveryState({
      investigationId: payload.investigationId,
      tenantId: payload.tenantId,
      installationId: payload.installationId,
      repoOwner: payload.repositoryOwner,
      repoName: payload.repositoryName,
      issueNumber: payload.issueNumber,
      issueTitle: payload.issueTitle,
      outcome: result.outcome,
      summary: result.summary,
      fixVerified: result.fixAttempt?.outcome === "verified",
      fixAttemptId: result.fixAttempt?.fixAttemptId ?? null,
      analysisComment: result.commentSections?.analysis ?? null,
      fixComment: result.commentSections?.fix ?? null,
      report: result.report ?? null,
      pullRequest: result.pullRequest ?? null,
      retryPlan: result.pullRequestRetryPlan ?? null,
    }, deps.delivery.store);

  try {
    // Worker-level state before any setup runs, so an investigation that dies
    // during token/auth setup still leaves a created + terminal record. The
    // repo URL is derived from owner/name, never a caller-supplied URL.
    await recordState({
      type: "created",
      tenantId: payload.tenantId,
      installationId: payload.installationId,
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

    pipelineStarted = true;
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
      {
        onStage: reportStage,
        signal,
        onTerminalResult: async (terminalResult) => {
          // Mark execution terminal before doing I/O so an error during this
          // boundary can never trigger a contradictory worker-failure comment.
          pipelineResult = terminalResult;
          // The existing local delivery ledger is the reliability boundary.
          // Persist it before attempting any dashboard projection so a slow
          // or failed Supabase write cannot widen the crash window or suppress
          // PR/comment recovery.
          try {
            const state = await deliveryStateFor(terminalResult);
            await deps.delivery.store.save(state);
            persistedDeliveryState = state;
          } catch (error) {
            deliveryPersistenceError = error;
          }
          if (deps.persistResult) {
            try {
              await withProductPersistenceDeadline(() =>
                deps.persistResult!(terminalResult),
              );
              persistedProductResult = true;
            } catch (error) {
              log(
                `[${payload.investigationId}] Product result persistence deferred; GitHub delivery will continue from local durable state: ${safeErrorMessage(error)}`,
              );
            }
          }
        },
      },
    );
    pipelineResult = result;

    // --- Delivery phase ----------------------------------------------------
    // Execution is terminal. Persist the durable delivery state first, so
    // ANY later failure (comment post, worker crash, stalled-job recovery)
    // retries GitHub delivery only and never the pipeline.
    const deliveryPayload: DeliveryJobPayload = {
      investigationId: payload.investigationId,
      tenantId: payload.tenantId,
      installationId: payload.installationId,
      repositoryOwner: payload.repositoryOwner,
      repositoryName: payload.repositoryName,
      issueNumber: payload.issueNumber,
    };

    let deliveryState: DeliveryState;

    try {
      if (deliveryPersistenceError) {
        throw deliveryPersistenceError;
      }

      // Injected/legacy pipeline adapters may not call onTerminalResult yet;
      // keep the post-return save as a compatibility fallback. Production's
      // real pipeline persists through the callback before workspace cleanup.
      deliveryState =
        persistedDeliveryState ?? (await deliveryStateFor(result));
      if (!persistedDeliveryState) {
        await deps.delivery.store.save(deliveryState);
      }
    } catch (stateError) {
      const message = safeErrorMessage(stateError);
      log(
        `[${payload.investigationId}] Could not persist required delivery state; delivery is stopped without rerunning execution: ${message}`,
      );
      await recordState({
        type: "error",
        stage: "delivery",
        message: `Durable delivery state could not be persisted: ${message}`,
      });
      throw new UnrecoverableError(
        `[${payload.investigationId}] Durable delivery state could not be persisted: ${message}`,
      );
    }

    // Compatibility for injected/legacy pipeline adapters that do not invoke
    // onTerminalResult. The required local delivery ledger is already durable
    // above; this optional product projection can fail without affecting
    // GitHub delivery.
    if (!persistedProductResult && deps.persistResult) {
      try {
        await withProductPersistenceDeadline(() => deps.persistResult!(result));
        persistedProductResult = true;
      } catch (error) {
        log(
          `[${payload.investigationId}] Product result persistence remains deferred; GitHub delivery will continue: ${safeErrorMessage(error)}`,
        );
      }
    }

    await reportStage("delivering");
    let deliveryDeferred = false;

    // If a delivery-job enqueue fails, surface the original delivery error
    // (or the enqueue error) as a normal retryable failure: the job then
    // retries and the resume guard finishes delivery without the pipeline.
    const enqueueDeliveryOrRethrow = async (cause: unknown) => {
      try {
        await deps.delivery.enqueue(deliveryPayload);
        deliveryDeferred = true;
        log(
          `[${payload.investigationId}] Delivery-only retry job queued for unfinished GitHub delivery.`,
        );
      } catch (enqueueError) {
        throw cause ?? enqueueError;
      }
    };

    if (deliveryState.pullRequest.status === "pending") {
      // Verified execution is complete. Branch, PR, and terminal-comment
      // work starts only in the isolated delivery job.
      log(
        `[${payload.investigationId}] Verified execution is complete; deferring branch, pull-request, and terminal-comment delivery.`,
      );
      await enqueueDeliveryOrRethrow(null);
    } else {
      try {
        const { state: delivered, complete } = await runDeliveryFromState(
          deliveryState,
          toDeliveryExecutorDeps(deps),
          { isFinalAttempt: false },
        );

        if (!complete) {
          // Permanent comment failure, already recorded truthfully; fail
          // the job without posting any second, contradictory comment.
          throw new UnrecoverableError(
            `[${payload.investigationId}] Terminal comment delivery failed permanently: ${delivered.terminalComment.reason ?? "unknown"}.`,
          );
        }
      } catch (error) {
        if (error instanceof UnrecoverableError) {
          throw error;
        }

        log(
          `[${payload.investigationId}] Delivery failed transiently; deferring to the delivery-only retry job: ${safeErrorMessage(error)}`,
        );
        await enqueueDeliveryOrRethrow(error);
      }
    }
    if (!deliveryDeferred) {
      await reportStage("completed");
    }
    log(
      `[${payload.investigationId}] Execution completed with outcome ${result.outcome}${deliveryDeferred ? "; delivery is queued" : " and delivery completed"}.`,
    );

    return { investigationId: payload.investigationId, outcome: result.outcome };
  } catch (error) {
    if (
      (isTransientInfrastructureError(error) ||
        error instanceof DeliveryRetryableError) &&
      !isFinalAttempt
    ) {
      const transientMessage = retryableWorkerFailureMessage(error);
      log(
        `[${payload.investigationId}] Transient failure (attempt ${job.attemptsMade + 1}/${attemptsAllowed}), will retry: ${transientMessage}`,
      );
      // Record the failed attempt (best-effort) so a retryable pre-pipeline
      // failure is visible in state, without recording a terminal outcome.
      await recordState({
        type: "error",
        stage: "worker",
        message: transientMessage,
        retryable: true,
      });
      // Rethrow a sanitized copy: any non-Unrecoverable error triggers the
      // job's bounded backoff retry, but the message becomes the attempt's
      // stored BullMQ failed reason, so it must not carry the raw text.
      throw new Error(transientMessage);
    }

    // Final failure: preserve the investigation id and artifacts (the
    // pipeline's own cleanup already stopped sandboxes and containers),
    // report to GitHub, and stop retrying.
    const terminalFailureStage = latestStage;
    await reportStage("failed");

    // Record a terminal worker-level state. Always append the error; only own
    // the final outcome when the pipeline never produced one (a pre-pipeline
    // or worker-setup failure), so a post-pipeline failure — e.g. GitHub
    // comment posting — cannot overwrite the pipeline's real outcome.
    const failureCategory = terminalFailureCategory(error, pipelineStarted);
    const failureMessage = terminalWorkerFailureMessage(failureCategory);
    await recordState({ type: "error", stage: "worker", message: failureMessage });
    if (!pipelineResult) {
      await recordState({
        type: "final_outcome",
        outcome: "failed",
        error: failureMessage,
      });
    }

    // The failure comment is only for runs whose pipeline never completed.
    // Once execution is terminal, all issue messaging belongs to the delivery
    // layer — a worker failure comment here would be a second, contradictory
    // terminal message. The failure report reconciles and updates the owned
    // queued comment instead of posting a separate unmarked comment, keeping
    // the public lifecycle at one canonical comment (queued -> terminal).
    if (!pipelineResult) {
      try {
        await deliverWorkerFailureReport(
          deps,
          payload,
          failureMessage,
          terminalFailureStage,
        );
      } catch (deliveryError) {
        throw new UnrecoverableError(
          `[${payload.investigationId}] Durable worker-failure delivery could not be persisted or scheduled: ${safeErrorMessage(deliveryError)}`,
        );
      }
    }

    // The message becomes the job's stored BullMQ failed reason; redacted.
    throw new UnrecoverableError(`[${payload.investigationId}] ${failureMessage}`);
  }
}

// --- Delivery-only job processing -------------------------------------------

export type DeliveryJobLike = {
  data: DeliveryJobPayload;
  attemptsMade: number;
  opts?: { attempts?: number };
};

// Finishes GitHub delivery for an investigation whose execution already
// produced a terminal result. Loads the durable delivery state and runs the
// idempotent executor; the investigation pipeline (clone, reproduction,
// model calls, fixing, validation) is deliberately unreachable from here.
export async function processDeliveryJob(
  job: DeliveryJobLike,
  deps: DeliveryWorkerDeps,
): Promise<{ investigationId: string; outcome: string }> {
  const payload = job.data;
  const log = deps.log ?? (() => {});
  const attemptsAllowed = job.opts?.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade + 1 >= attemptsAllowed;
  const attemptCount = job.attemptsMade + 1;
  // BullMQ stops scheduling after its final configured attempt, but durable
  // recovery continues from Supabase. Keep a due time even on that last
  // attempt; a successful terminal state clears it in saveDeliveryState().
  const nextRetryAt = new Date(
    Date.now() +
      DELIVERY_RETRY_BACKOFF_MS * 2 ** Math.max(0, job.attemptsMade),
  ).toISOString();

  const recordState = async (event: InvestigationStateEventInput) => {
    try {
      await deps.stateStore?.record({
        ...event,
        investigationId: payload.investigationId,
        at: new Date().toISOString(),
      } as InvestigationStateEvent);
    } catch (stateError) {
      log(
        `[${payload.investigationId}] Delivery-job state write failed ("${event.type}"); continuing: ${safeErrorMessage(stateError)}`,
      );
    }
  };

  let state: DeliveryState | null;

  try {
    state = await deps.delivery.store.load(payload.investigationId);
  } catch (error) {
    const message = safeErrorMessage(error);

    if (!isFinalAttempt) {
      throw new Error(message);
    }

    throw new UnrecoverableError(`[${payload.investigationId}] ${message}`);
  }

  if (!state) {
    throw new UnrecoverableError(
      `[${payload.investigationId}] No delivery state was found; nothing can be delivered.`,
    );
  }

  // Defensive identity check: the job must only ever act on the repository
  // and issue the persisted state belongs to.
  if (
    state.tenantId !== payload.tenantId ||
    state.installationId !== payload.installationId ||
    state.repoOwner !== payload.repositoryOwner ||
    state.repoName !== payload.repositoryName ||
    state.issueNumber !== payload.issueNumber
  ) {
    throw new UnrecoverableError(
      `[${payload.investigationId}] Delivery state does not match the job payload; refusing to deliver.`,
    );
  }

  try {
    if (deps.recordDeliveryAttempt) {
      await withProductPersistenceDeadline(() =>
        deps.recordDeliveryAttempt!(
          payload.investigationId,
          attemptCount,
          nextRetryAt,
        ),
      );
    }
  } catch (error) {
    log(
      `[${payload.investigationId}] Product delivery-attempt persistence deferred; GitHub delivery will continue from local durable state: ${safeErrorMessage(error)}`,
    );
  }

  await recordState({ type: "stage_changed", stage: "delivering" });

  try {
    const { state: delivered, complete } = await runDeliveryFromState(
      state,
      toDeliveryExecutorDeps(deps),
      { isFinalAttempt },
    );

    if (!complete) {
      throw new UnrecoverableError(
        `[${payload.investigationId}] Delivery incomplete: terminal comment ${delivered.terminalComment.status}${delivered.terminalComment.reason ? ` (${delivered.terminalComment.reason})` : ""}.`,
      );
    }

    log(
      `[${payload.investigationId}] Delivery completed (pull request: ${delivered.pullRequest.status}, comment: ${delivered.terminalComment.status}).`,
    );
    await recordState({ type: "stage_changed", stage: "completed" });
    return {
      investigationId: payload.investigationId,
      outcome: delivered.executionOutcome,
    };
  } catch (error) {
    if (error instanceof UnrecoverableError) {
      throw error;
    }

    const message = safeErrorMessage(error);

    if (error instanceof DeliveryRetryableError) {
      log(
        `[${payload.investigationId}] Delivery attempt ${job.attemptsMade + 1}/${attemptsAllowed} failed transiently; durable delivery remains pending: ${message}`,
      );
      await recordState({
        type: "error",
        stage: "delivery",
        message,
        retryable: true,
      });
      throw new Error(message);
    }

    await recordState({ type: "error", stage: "delivery", message });
    throw new UnrecoverableError(`[${payload.investigationId}] ${message}`);
  }
}
