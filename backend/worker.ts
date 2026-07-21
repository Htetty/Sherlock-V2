// BullMQ worker entry point: pulls investigation jobs from Redis and runs
// the existing pipeline. Run alongside the bot/backend:
//
//   npm run redis:up
//   npm start          # backend + bot (webhook enqueues only)
//   npm run worker     # this process
//
// Concurrency: INVESTIGATION_WORKER_CONCURRENCY (default 1) is how many jobs
// THIS process runs simultaneously. Total capacity is approximately:
//   number of worker processes x INVESTIGATION_WORKER_CONCURRENCY
// Tier-aware scheduling is intentionally not implemented yet; this is the
// global concurrency of the worker process.

import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { createProbot } from "probot";
import {
  DELIVERY_JOB_NAME,
  INVESTIGATION_QUEUE_NAME,
  createInvestigationQueue,
  createRedisConnection,
  enqueueDeliveryJob,
  type DeliveryJobPayload,
  type InvestigationJobPayload,
} from "./queue/investigation-queue.js";
import {
  processDeliveryJob,
  processInvestigationJobWithConcurrency,
  type WorkerDeps,
} from "./queue/process-investigation.js";
import { cleanupAllContainers } from "./services/container.js";
import {
  createDeliveryGitHubRestClient,
  createFileDeliveryStateStore,
  reconcileTerminalCommentPaginated,
} from "./services/delivery.js";
import { runInvestigationPipeline } from "./services/investigation.js";
import { createInvestigationStateStoreFromEnv } from "./services/investigation-state-store.js";
import {
  asScriptRunner,
  createInvestigationConcurrencyGate,
} from "./services/rate-limit.js";
import {
  asOperationalRedis,
  createWorkerHeartbeat,
  getProductionMonitoringConfig,
  getWorkerId,
} from "./services/production-monitoring.js";
import {
  describeWorkerError,
  enforceStartupChecks,
  runWorkerPreflight,
} from "./worker-preflight.js";

const concurrency = Math.max(
  1,
  Number(process.env.INVESTIGATION_WORKER_CONCURRENCY ?? 1) || 1,
);

const monitoringConfig = getProductionMonitoringConfig();
const workerId = getWorkerId();

const connection = createRedisConnection();
const operationalRedis = asOperationalRedis(connection);

// Reuses the GitHub App credentials (APP_ID / PRIVATE_KEY) already required
// by the bot to mint short-lived installation tokens; secrets never travel
// through Redis.
const probot = createProbot();

async function getInstallationOctokit(installationId: number) {
  return probot.auth(installationId);
}

// Lifecycle state store (selected by SHERLOCK_STATE_STORE; no-op default);
// shared across jobs. Never carries secrets and never fails an investigation.
const stateStore = createInvestigationStateStoreFromEnv();

// Durable delivery state under the artifacts volume, plus a queue producer
// used to enqueue delivery-only retry jobs. The producer gets its own Redis
// connection: the worker connection is reserved for blocking commands.
const deliveryStore = createFileDeliveryStateStore();
const deliveryQueueConnection = createRedisConnection();
const deliveryQueue = createInvestigationQueue(deliveryQueueConnection);
const deps: Omit<WorkerDeps, "reportStage"> = {
  stateStore,
  delivery: {
    store: deliveryStore,
    enqueue: (payload: DeliveryJobPayload) =>
      enqueueDeliveryJob(deliveryQueue, payload),
    createGitHubClient: createDeliveryGitHubRestClient,
    findTerminalComment: async ({
      installationId,
      owner,
      repo,
      issueNumber,
      marker,
      reusableMarker,
      assertOwnership,
    }) => {
      const octokit = await getInstallationOctokit(installationId);
      return reconcileTerminalCommentPaginated({
        terminalMarker: marker,
        reusableMarker,
        appId: Number(process.env.APP_ID),
        assertOwnership,
        listPage: async (page, perPage) => {
          const { data } = await octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: issueNumber,
            per_page: perPage,
            page,
          });
          return data;
        },
      });
    },
  },
  runPipeline: (payload, pipelineOptions) =>
    runInvestigationPipeline(payload, {
      ...pipelineOptions,
      stateStore,
      deliveryPayloadStore: deliveryStore,
    }),
  getInstallationToken: async (installationId) => {
    const octokit = await getInstallationOctokit(installationId);
    // Single token request: @octokit/auth-app's installation auth result
    // already includes the token response's permission metadata, which is
    // the authoritative record of the token's Contents access.
    const auth = (await octokit.auth({ type: "installation" })) as {
      token?: string;
      permissions?: Record<string, string>;
    };

    if (!auth.token) {
      return null;
    }

    return { token: auth.token, permissions: auth.permissions ?? null };
  },
  postIssueComment: async ({
    installationId,
    owner,
    repo,
    issueNumber,
    body,
    assertOwnership,
  }) => {
    const octokit = await getInstallationOctokit(installationId);
    await assertOwnership?.();
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  },
  updateIssueComment: async ({
    installationId,
    owner,
    repo,
    commentId,
    body,
    assertOwnership,
  }) => {
    const octokit = await getInstallationOctokit(installationId);
    await assertOwnership();
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
  },
  log: (message) => console.log(message),
};

// Optional startup enforcement: with SHERLOCK_RUN_STARTUP_CHECKS=true the
// preflight must pass before the BullMQ worker is created (and therefore
// before any job can be consumed). Without the flag, behavior is unchanged.
const proceed = await enforceStartupChecks(
  process.env,
  () => runWorkerPreflight(),
  () => {
    process.exitCode = 1;
  },
);

if (!proceed) {
  await connection.quit().catch(() => {});
  await deliveryQueue.close().catch(() => {});
  await deliveryQueueConnection.quit().catch(() => {});
  process.exit(1);
}

// Redis-backed tenant/repo concurrency, shared across every worker process
// on this queue. Slots carry a TTL, so a crashed worker cannot permanently
// hold one; a blocked job is intentionally delayed, never dropped.
const concurrencyGate = createInvestigationConcurrencyGate(() =>
  asScriptRunner(connection),
);

const worker = new Worker<InvestigationJobPayload | DeliveryJobPayload>(
  INVESTIGATION_QUEUE_NAME,
  async (job: Job<InvestigationJobPayload | DeliveryJobPayload>, token?: string) => {
    // Delivery-only jobs finish GitHub delivery from durable state. They are
    // cheap API work: no pipeline, and no tenant/repo concurrency slot.
    if (job.name === DELIVERY_JOB_NAME) {
      return processDeliveryJob(job as Job<DeliveryJobPayload>, deps);
    }

    const investigationJob = job as Job<InvestigationJobPayload>;

    return processInvestigationJobWithConcurrency(
      investigationJob,
      {
        ...deps,
        reportStage: async (stage) => {
          console.log(`[${investigationJob.data.investigationId}] Stage: ${stage}`);
          await investigationJob.updateProgress({ stage });
        },
      },
      {
        gate: concurrencyGate,
        delayJob: async (delayMs) => {
          await investigationJob.moveToDelayed(Date.now() + delayMs, token);
        },
      },
    );
  },
  { connection, concurrency },
);

const workerHeartbeat = createWorkerHeartbeat({
  redis: operationalRedis,
  workerId,
  intervalMs: monitoringConfig.heartbeatIntervalMs,
  ttlMs: monitoringConfig.heartbeatTtlMs,
  log: (message) => console.error(message),
});
workerHeartbeat.start();

worker.on("completed", (job) => {
  console.log(`[queue] Job ${job.id} completed.`);
});

worker.on("failed", (job, error) => {
  console.error(`[queue] Job ${job?.id} failed: ${describeWorkerError(error)}`);
});

// Redis/worker infrastructure errors surface asynchronously; log them
// safely (redacted) instead of crashing silently.
worker.on("error", (error) => {
  console.error(`[queue] Worker error: ${describeWorkerError(error)}`);
});

console.log(
  `Sherlock investigation worker started (queue "${INVESTIGATION_QUEUE_NAME}", concurrency ${concurrency}).`,
);

// Graceful shutdown: worker.close() waits for active jobs, whose pipeline
// finally-blocks stop sandbox processes/containers and clean workspaces.
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; closing worker, queue connection, and sandboxes...`);

  try {
    await worker.close();
    await workerHeartbeat.stop();
    await deliveryQueue.close();
    await connection.quit();
    await deliveryQueueConnection.quit();
  } catch (error) {
    console.error("Error during shutdown:", error);
  }

  // Force-remove any target containers still alive (pipeline finally-blocks
  // normally stop them; this sweep covers interrupted jobs).
  const cleaned = await cleanupAllContainers();

  if (cleaned.length > 0) {
    console.log(`Force-removed ${cleaned.length} leftover target container(s).`);
  }

  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
