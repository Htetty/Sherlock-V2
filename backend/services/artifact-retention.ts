// Privacy-safe retention for raw investigation artifacts.
//
// Artifact cleanup is deliberately narrower than general data retention:
// it only removes artifacts/<investigationId>/ after the local delivery
// record proves that GitHub delivery is complete and Redis proves that no
// investigation/delivery job or concurrency lease is still active. Repository
// memory, graph caches, Supabase rows, and Redis data are never deletion
// targets of this service.

import { lstat, opendir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { JobType, Queue } from "bullmq";
import { buildDeliveryJobId } from "../queue/investigation-queue.js";
import { getArtifactsRoot, isInvestigationId } from "./artifacts.js";
import {
  isFixFullyDelivered,
  type DeliveryState,
  type DeliveryStateStore,
} from "./delivery.js";
import {
  buildConcurrencyLeaseMemberPrefix,
  buildRepoConcurrencyKey,
  getConcurrencyConfig,
  REPO_CONCURRENCY_KEY_PREFIX,
  TENANT_CONCURRENCY_KEY_PREFIX,
  type RedisScriptRunner,
} from "./rate-limit.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const ARTIFACT_RETENTION_DEFAULTS = {
  successfulRetentionMs: 0,
  failedRetentionMs: 7 * DAY_MS,
  cleanupIntervalMs: HOUR_MS,
  cleanupOnStartup: true,
  maxDirectoriesPerScan: 250,
} as const;

export type ArtifactRetentionConfig = {
  successfulRetentionMs: number;
  failedRetentionMs: number;
  cleanupIntervalMs: number;
  cleanupOnStartup: boolean;
  maxDirectoriesPerScan: number;
};

export function getArtifactRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ArtifactRetentionConfig {
  const successfulHours = nonNegativeNumber(
    env.SHERLOCK_SUCCESSFUL_ARTIFACT_RETENTION_HOURS,
  );
  const failedHours = nonNegativeNumber(
    env.SHERLOCK_FAILED_ARTIFACT_RETENTION_HOURS,
  );
  const intervalMinutes = nonNegativeNumber(
    env.SHERLOCK_ARTIFACT_CLEANUP_INTERVAL_MINUTES,
  );

  return {
    successfulRetentionMs:
      successfulHours === null
        ? ARTIFACT_RETENTION_DEFAULTS.successfulRetentionMs
        : successfulHours * HOUR_MS,
    failedRetentionMs:
      failedHours === null
        ? ARTIFACT_RETENTION_DEFAULTS.failedRetentionMs
        : failedHours * HOUR_MS,
    cleanupIntervalMs:
      intervalMinutes === null
        ? ARTIFACT_RETENTION_DEFAULTS.cleanupIntervalMs
        : intervalMinutes * 60_000,
    cleanupOnStartup: booleanValue(
      env.SHERLOCK_ARTIFACT_CLEANUP_ON_STARTUP,
      ARTIFACT_RETENTION_DEFAULTS.cleanupOnStartup,
    ),
    maxDirectoriesPerScan:
      positiveInteger(env.SHERLOCK_ARTIFACT_CLEANUP_MAX_DIRECTORIES) ??
      ARTIFACT_RETENTION_DEFAULTS.maxDirectoriesPerScan,
  };
}

function nonNegativeNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = nonNegativeNumber(value);
  return parsed !== null && parsed >= 1 ? Math.floor(parsed) : null;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export type ArtifactCleanupProtectionSnapshot = {
  isProtected(state: DeliveryState): Promise<boolean>;
};

export type ArtifactCleanupProtection = {
  snapshot(): Promise<ArtifactCleanupProtectionSnapshot>;
};

export function createNoopArtifactCleanupProtection(): ArtifactCleanupProtection {
  return {
    async snapshot() {
      return { async isProtected() { return false; } };
    },
  };
}

const PROTECTED_JOB_TYPES: JobType[] = [
  "active",
  "delayed",
  "waiting",
  "waiting-children",
  "prioritized",
  "paused",
];

// Checks both lease sets. A partial lease is treated as active because it is
// safer to retain artifacts until its TTL expires than to infer ownership was
// cleanly released.
export const ACTIVE_ARTIFACT_LEASE_SCRIPT = `
local staleCutoff = tonumber(ARGV[1])
local exactMember = ARGV[2]
local memberPrefix = ARGV[3]
local maxMembers = tonumber(ARGV[4])

for _, key in ipairs(KEYS) do
  if redis.call('ZSCORE', key, exactMember) then
    local score = tonumber(redis.call('ZSCORE', key, exactMember))
    if score and score > staleCutoff then return 1 end
  end

  local count = redis.call('ZCOUNT', key, '(' .. staleCutoff, '+inf')
  if count > maxMembers then return 1 end
  local members = redis.call('ZRANGEBYSCORE', key, '(' .. staleCutoff, '+inf', 'LIMIT', 0, maxMembers)
  for _, member in ipairs(members) do
    if string.sub(member, 1, string.len(memberPrefix)) == memberPrefix then
      return 1
    end
  end
end

return 0
`;

export function createRedisArtifactCleanupProtection(input: {
  queue: Pick<Queue, "getJobCounts" | "getJobs" | "getJob">;
  redis: RedisScriptRunner;
  maxQueueJobs: number;
  now?: () => number;
}): ArtifactCleanupProtection {
  const now = input.now ?? Date.now;
  const slotTtlMs = getConcurrencyConfig().slotTtlSeconds * 1000;

  return {
    async snapshot() {
      const counts = await input.queue.getJobCounts(...PROTECTED_JOB_TYPES);
      const pendingCount = PROTECTED_JOB_TYPES.reduce(
        (total, type) => total + Number(counts[type] ?? 0),
        0,
      );

      if (pendingCount > input.maxQueueJobs) {
        throw new Error("Pending queue state exceeds the bounded cleanup scan.");
      }

      const jobs =
        pendingCount === 0
          ? []
          : await input.queue.getJobs(
              PROTECTED_JOB_TYPES,
              0,
              input.maxQueueJobs - 1,
              true,
            );
      const protectedInvestigationIds = new Set<string>();

      for (const job of jobs) {
        const investigationId = (job.data as { investigationId?: unknown })
          ?.investigationId;
        if (!isInvestigationId(investigationId)) {
          throw new Error("A pending queue job has no valid investigation id.");
        }
        protectedInvestigationIds.add(investigationId);
      }

      return {
        isProtected: async (state) => {
          if (protectedInvestigationIds.has(state.investigationId)) {
            return true;
          }

          // Close the narrow race where a delivery job is created after the
          // bounded snapshot. Its deterministic id permits an exact lookup.
          const deliveryJob = await input.queue.getJob(
            buildDeliveryJobId(state.investigationId),
          );
          if (deliveryJob) {
            const deliveryJobState = await deliveryJob.getState();
            if (
              deliveryJobState === "active" ||
              deliveryJobState === "delayed" ||
              deliveryJobState === "waiting" ||
              deliveryJobState === "waiting-children" ||
              deliveryJobState === "prioritized"
            ) {
              return true;
            }
          }

          const tenantKey = `${TENANT_CONCURRENCY_KEY_PREFIX}${state.tenantId}`;
          const repoKey = `${REPO_CONCURRENCY_KEY_PREFIX}${buildRepoConcurrencyKey(
            state.repoOwner,
            state.repoName,
          )}`;
          const leaseActive = Number(
            await input.redis.eval(
              ACTIVE_ARTIFACT_LEASE_SCRIPT,
              2,
              tenantKey,
              repoKey,
              now() - slotTtlMs,
              state.investigationId,
              buildConcurrencyLeaseMemberPrefix(state.investigationId),
              100,
            ),
          );

          // Any unexpected result is uncertainty, which means retain.
          return leaseActive !== 0;
        },
      };
    },
  };
}

export type ArtifactCleanupStatus =
  | "deleted"
  | "missing"
  | "not_expired"
  | "not_terminal"
  | "protected"
  | "unsafe"
  | "error";

export type ArtifactCleanupResult = {
  investigationId: string;
  status: ArtifactCleanupStatus;
};

export type ArtifactCleanupScanResult = {
  examined: number;
  deleted: number;
  errors: number;
  bounded: boolean;
};

export type ArtifactCleanupService = {
  cleanupInvestigation(investigationId: string): Promise<ArtifactCleanupResult>;
  scanExpired(): Promise<ArtifactCleanupScanResult>;
};

export type ArtifactCleanupServiceOptions = {
  rootDir?: string;
  deliveryStore: DeliveryStateStore;
  protection: ArtifactCleanupProtection;
  config?: ArtifactRetentionConfig;
  now?: () => number;
  removeDirectory?: (target: string) => Promise<void>;
  log?: (message: string) => void;
};

const RETAINED_FAILURE_OUTCOMES = new Set([
  "reproduced",
  "not_reproduced",
  "plan_failed",
  "environment_failed",
  "execution_failed",
]);

export function createArtifactCleanupService(
  options: ArtifactCleanupServiceOptions,
): ArtifactCleanupService {
  const rootDir = path.resolve(options.rootDir ?? getArtifactsRoot());
  const config = options.config ?? getArtifactRetentionConfig();
  const now = options.now ?? Date.now;
  const removeDirectory =
    options.removeDirectory ??
    ((target: string) => rm(target, { recursive: true, force: true }));
  const log = options.log ?? ((message: string) => console.log(message));
  let scanRunning = false;

  const cleanupInvestigationWithSnapshot = async (
    investigationId: string,
    snapshot: ArtifactCleanupProtectionSnapshot,
  ): Promise<ArtifactCleanupResult> => {
    if (!isInvestigationId(investigationId)) {
      return { investigationId, status: "unsafe" };
    }

    let target: string;
    try {
      target = await resolveSafeInvestigationDirectory(rootDir, investigationId);
    } catch {
      safeLog(log, investigationId, "cleanup target could not be verified");
      return { investigationId, status: "unsafe" };
    }

    if (!(await pathExists(target))) {
      return { investigationId, status: "missing" };
    }

    try {
      return await options.deliveryStore.withLock(investigationId, async () => {
        // Revalidate after acquiring the same lock used by delivery. This
        // makes deletion and delivery-state reconciliation mutually exclusive.
        target = await resolveSafeInvestigationDirectory(rootDir, investigationId);
        if (!(await pathExists(target))) {
          return { investigationId, status: "missing" };
        }

        const state = await options.deliveryStore.load(investigationId);
        const expiry = state ? artifactExpiry(state, config) : null;

        if (!state || expiry === null) {
          return { investigationId, status: "not_terminal" };
        }
        if (now() < expiry) {
          return { investigationId, status: "not_expired" };
        }
        if (await snapshot.isProtected(state)) {
          return { investigationId, status: "protected" };
        }

        await removeDirectory(target);
        safeLog(log, investigationId, "artifacts deleted");
        return { investigationId, status: "deleted" };
      });
    } catch {
      // Raw filesystem/JSON/Redis error text can contain paths or secrets.
      // Cleanup is best-effort, so a generic message is both safer and enough
      // for the operator to identify the affected investigation.
      safeLog(log, investigationId, "cleanup failed; artifacts retained");
      return { investigationId, status: "error" };
    }
  };

  return {
    async cleanupInvestigation(investigationId) {
      try {
        const snapshot = await options.protection.snapshot();
        return await cleanupInvestigationWithSnapshot(investigationId, snapshot);
      } catch {
        safeLog(log, investigationId, "activity state unavailable; artifacts retained");
        return { investigationId, status: "error" };
      }
    },

    async scanExpired() {
      if (scanRunning) {
        return { examined: 0, deleted: 0, errors: 0, bounded: true };
      }
      scanRunning = true;

      try {
        let snapshot: ArtifactCleanupProtectionSnapshot;
        try {
          snapshot = await options.protection.snapshot();
        } catch {
          safeLog(log, null, "activity snapshot unavailable; scan skipped");
          return { examined: 0, deleted: 0, errors: 1, bounded: false };
        }

        let directory;
        try {
          const rootInfo = await lstat(rootDir);
          if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
            safeLog(log, null, "artifact root is unsafe; scan skipped");
            return { examined: 0, deleted: 0, errors: 1, bounded: false };
          }
          directory = await opendir(rootDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { examined: 0, deleted: 0, errors: 0, bounded: true };
          }
          safeLog(log, null, "artifact root unavailable; scan skipped");
          return { examined: 0, deleted: 0, errors: 1, bounded: false };
        }

        let examined = 0;
        let deleted = 0;
        let errors = 0;
        let bounded = true;

        for await (const entry of directory) {
          if (examined >= config.maxDirectoriesPerScan) {
            bounded = false;
            break;
          }
          examined += 1;

          if (!isInvestigationId(entry.name) || !entry.isDirectory()) {
            continue;
          }

          const result = await cleanupInvestigationWithSnapshot(
            entry.name,
            snapshot,
          );
          if (result.status === "deleted") deleted += 1;
          if (result.status === "error" || result.status === "unsafe") errors += 1;
        }
        return { examined, deleted, errors, bounded };
      } catch {
        safeLog(log, null, "scan failed; artifacts retained");
        return { examined: 0, deleted: 0, errors: 1, bounded: false };
      } finally {
        scanRunning = false;
      }
    },
  };
}

function artifactExpiry(
  state: DeliveryState,
  config: ArtifactRetentionConfig,
): number | null {
  const deliveredAt = state.terminalComment.postedAt
    ? Date.parse(state.terminalComment.postedAt)
    : Number.NaN;
  if (
    state.terminalComment.status !== "posted" ||
    !Number.isFinite(deliveredAt)
  ) {
    return null;
  }

  if (state.executionOutcome === "verified_fix") {
    return isFixFullyDelivered(state)
      ? deliveredAt + config.successfulRetentionMs
      : null;
  }

  // A non-fix terminal result has no branch/PR to deliver. Any branch or PR
  // status other than not_applicable is an inconsistent/partial delivery and
  // therefore retained rather than aged from execution completion.
  if (
    RETAINED_FAILURE_OUTCOMES.has(state.executionOutcome) &&
    !state.fixVerified &&
    state.pullRequest.status === "not_applicable" &&
    !state.pullRequest.branchPushed
  ) {
    return deliveredAt + config.failedRetentionMs;
  }

  return null;
}

async function resolveSafeInvestigationDirectory(
  rootDir: string,
  investigationId: string,
): Promise<string> {
  if (!isInvestigationId(investigationId)) {
    throw new Error("Unsafe investigation id.");
  }

  const target = path.resolve(rootDir, investigationId);
  if (!target.startsWith(rootDir + path.sep)) {
    throw new Error("Artifact path escaped its root.");
  }

  let rootInfo;
  try {
    rootInfo = await lstat(rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Artifact root is not a real directory.");
  }

  let targetInfo;
  try {
    targetInfo = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw error;
  }
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw new Error("Investigation artifact target is not a real directory.");
  }

  const [realRoot, realTarget] = await Promise.all([
    realpath(rootDir),
    realpath(target),
  ]);
  if (!realTarget.startsWith(realRoot + path.sep)) {
    throw new Error("Investigation artifact target escaped its real root.");
  }

  return target;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeLog(
  log: (message: string) => void,
  investigationId: string | null,
  message: string,
) {
  log(
    investigationId
      ? `[artifact-cleanup:${investigationId}] ${message}.`
      : `[artifact-cleanup] ${message}.`,
  );
}

export function startArtifactCleanupScheduler(input: {
  cleanup: ArtifactCleanupService;
  config: ArtifactRetentionConfig;
}): () => void {
  if (input.config.cleanupOnStartup) {
    // Startup must never wait for filesystem or Redis cleanup. The scan is
    // bounded, fail-closed, and deliberately detached from worker creation.
    void input.cleanup.scanExpired().catch(() => {});
  }

  if (input.config.cleanupIntervalMs <= 0) {
    return () => {};
  }

  const timer = setInterval(() => {
    void input.cleanup.scanExpired().catch(() => {});
  }, input.config.cleanupIntervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
