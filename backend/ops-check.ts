// Production operations command. Run inside the worker container so named
// volumes and the internal API/Redis service names are visible:
//   npm run ops:check:prod
// Tests and safe validation use `--test`, which creates no connections and
// touches no production paths.

import "dotenv/config";
import { statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { createInvestigationQueue } from "./queue/investigation-queue.js";
import {
  asOperationalRedis,
  getProductionMonitoringConfig,
  readArtifactCleanupStatus,
  readFilesystemUsage,
  readQueueOperationalSummary,
  readWorkerHeartbeatSummary,
  type ArtifactCleanupOperationalRecord,
  type FilesystemTarget,
  type ProductionMonitoringConfig,
} from "./services/production-monitoring.js";
import {
  formatProductionOpsReport,
  runProductionOpsCheck,
  type ProductionOpsAdapters,
} from "./services/production-ops.js";

export function productionFilesystemTargets(
  env: NodeJS.ProcessEnv = process.env,
): FilesystemTarget[] {
  const containerized =
    env.SHERLOCK_WORKER_CONTAINERIZED === "true" ||
    env.SHERLOCK_WORKER_CONTAINERIZED === "1";
  return [
    {
      name: "artifacts",
      path: env.ARTIFACTS_DIR ?? path.resolve("artifacts"),
      optional: false,
    },
    {
      name: "sherlock-data",
      path: env.SHERLOCK_DATA_DIR ?? path.join(homedir(), ".sherlock"),
      optional: false,
    },
    {
      name: "temporary-workspaces",
      path: env.TMPDIR ?? tmpdir(),
      optional: false,
    },
    { name: "root", path: "/", optional: false },
    {
      name: "docker-storage",
      // The host Docker root is not mounted into the stock worker container,
      // so statfs(/var/lib/docker) there would describe the wrong filesystem.
      // An operator may explicitly mount/configure a trustworthy path.
      path:
        env.SHERLOCK_DOCKER_STORAGE_PATH ??
        (containerized ? null : "/var/lib/docker"),
      optional: true,
    },
  ];
}

function validateApiHealthUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.SHERLOCK_API_HEALTH_URL ?? "http://api:4000/healthz";
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      "SHERLOCK_API_HEALTH_URL must be an HTTP(S) URL without credentials.",
    );
  }
  return url.toString();
}

function createRedisClient(
  env: NodeJS.ProcessEnv,
  config: ProductionMonitoringConfig,
): Redis {
  return new Redis(env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    connectTimeout: config.requestTimeoutMs,
    commandTimeout: config.requestTimeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

export function createProductionOpsAdapters(input: {
  env?: NodeJS.ProcessEnv;
  config: ProductionMonitoringConfig;
  now?: () => number;
}): { adapters: ProductionOpsAdapters; close: () => Promise<void> } {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now;
  const redis = createRedisClient(env, input.config);
  const operationalRedis = asOperationalRedis(redis);
  const queue = createInvestigationQueue(redis);
  const apiHealthUrl = validateApiHealthUrl(env);

  const ensureRedis = async () => {
    // Queue construction owns initialization of this shared lazy client.
    // Waiting on BullMQ's promise avoids racing it with a second connect().
    await queue.waitUntilReady();
  };

  return {
    adapters: {
      apiHealth: async () => {
        const response = await fetch(apiHealthUrl, {
          signal: AbortSignal.timeout(input.config.requestTimeoutMs),
        });
        // Never read or format the response body.
        return response.ok;
      },
      redisPing: async () => {
        await ensureRedis();
        return (await operationalRedis.ping()) === "PONG";
      },
      workerHeartbeats: async () => {
        await ensureRedis();
        return readWorkerHeartbeatSummary(operationalRedis, {
          now,
          maxAgeMs: input.config.heartbeatMaxAgeMs,
        });
      },
      queueSummary: async () => {
        await ensureRedis();
        return readQueueOperationalSummary(queue, operationalRedis, now);
      },
      filesystemUsage: () =>
        readFilesystemUsage(productionFilesystemTargets(env), { statfs }),
      cleanupStatus: async () => {
        await ensureRedis();
        return readArtifactCleanupStatus(operationalRedis, now);
      },
    },
    close: async () => {
      await queue.close().catch(() => {});
      redis.disconnect();
    },
  };
}

export function createTestOpsAdapters(
  nowMs = Date.parse("2026-01-01T00:00:00.000Z"),
): ProductionOpsAdapters {
  const cleanup: ArtifactCleanupOperationalRecord = {
    version: 1,
    workerId: "test-worker",
    ranAt: new Date(nowMs - 60_000).toISOString(),
    kind: "scan",
    scanned: 4,
    deleted: 2,
    retained: 2,
    protected: 1,
    failures: 0,
    bounded: true,
    oldestRetainedFailedAgeMs: 60 * 60_000,
  };
  return {
    apiHealth: async () => true,
    redisPing: async () => true,
    workerHeartbeats: async () => ({
      total: 1,
      fresh: 1,
      stale: 0,
      oldestAgeMs: 1_000,
      truncated: false,
    }),
    queueSummary: async () => ({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 3,
      failed: 0,
      oldestWaitingAgeMs: null,
      oldestDelayedCreationAgeMs: null,
      oldestDelayedOverdueAgeMs: null,
      waitingAgeComplete: true,
      delayedCreationAgeComplete: true,
      delayedDueAgeComplete: true,
    }),
    filesystemUsage: async () =>
      ["artifacts", "sherlock-data", "temporary-workspaces", "root", "docker-storage"].map(
        (name) => ({
          name,
          optional: name === "docker-storage",
          available: true,
          usedPercent: 40,
        }),
      ),
    cleanupStatus: async () => ({
      records: 1,
      latest: cleanup,
      latestAgeMs: 60_000,
      workersWithFailures: 0,
      truncated: false,
    }),
  };
}

export async function runOpsCheckCli(options: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  write?: (message: string) => void;
} = {}): Promise<number> {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const write = options.write ?? ((message: string) => console.log(message));
  let config: ProductionMonitoringConfig;
  try {
    config = getProductionMonitoringConfig(env);
  } catch {
    write(
      [
        "Sherlock production operations check",
        "FAIL  configuration: monitoring thresholds are invalid",
        "OVERALL FAIL",
      ].join("\n"),
    );
    return 2;
  }

  if (args.includes("--test")) {
    const report = await runProductionOpsCheck(config, createTestOpsAdapters());
    write(formatProductionOpsReport(report));
    return report.exitCode;
  }

  let production;
  try {
    production = createProductionOpsAdapters({ env, config });
  } catch {
    write(
      [
        "Sherlock production operations check",
        "FAIL  configuration: production adapter configuration is invalid",
        "OVERALL FAIL",
      ].join("\n"),
    );
    return 2;
  }

  try {
    const report = await runProductionOpsCheck(config, production.adapters);
    write(formatProductionOpsReport(report));
    return report.exitCode;
  } finally {
    await production.close();
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const exitCode = await runOpsCheckCli();
  process.exit(exitCode);
}
