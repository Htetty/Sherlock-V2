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
  INVESTIGATION_QUEUE_NAME,
  createRedisConnection,
  type InvestigationJobPayload,
} from "./queue/investigation-queue.js";
import {
  processInvestigationJob,
  type WorkerDeps,
} from "./queue/process-investigation.js";
import { cleanupAllContainers } from "./services/container.js";
import { runInvestigationPipeline } from "./services/investigation.js";
import {
  describeWorkerError,
  enforceStartupChecks,
  runWorkerPreflight,
} from "./worker-preflight.js";

const concurrency = Math.max(
  1,
  Number(process.env.INVESTIGATION_WORKER_CONCURRENCY ?? 1) || 1,
);

const connection = createRedisConnection();

// Reuses the GitHub App credentials (APP_ID / PRIVATE_KEY) already required
// by the bot to mint short-lived installation tokens; secrets never travel
// through Redis.
const probot = createProbot();

async function getInstallationOctokit(installationId: number) {
  return probot.auth(installationId);
}

const deps: Omit<WorkerDeps, "reportStage"> = {
  runPipeline: runInvestigationPipeline,
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
  postIssueComment: async ({ installationId, owner, repo, issueNumber, body }) => {
    const octokit = await getInstallationOctokit(installationId);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
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
  process.exit(1);
}

const worker = new Worker<InvestigationJobPayload>(
  INVESTIGATION_QUEUE_NAME,
  async (job: Job<InvestigationJobPayload>) =>
    processInvestigationJob(job, {
      ...deps,
      reportStage: async (stage) => {
        console.log(`[${job.data.investigationId}] Stage: ${stage}`);
        await job.updateProgress({ stage });
      },
    }),
  { connection, concurrency },
);

worker.on("completed", (job) => {
  console.log(`[queue] Job ${job.id} completed.`);
});

worker.on("failed", (job, error) => {
  console.error(`[queue] Job ${job?.id} failed: ${error.message}`);
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
    await connection.quit();
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
