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
import {
  buildDeliveryJobId,
  buildLegacyDeliveryJobId,
} from "../queue/investigation-queue.js";
import { getArtifactsRoot, isInvestigationId } from "./artifacts.js";
import {
  isDeliveryTerminal,
  isFixFullyDelivered,
  type DeliveryState,
  type DeliveryStateStore,
  type TerminalFailureRecord,
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
  isProtected(state: DeliveryState | TerminalFailureRecord): Promise<boolean>;
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

export const ACTIVE_DELIVERY_JOB_SCRIPT = `
for _, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then
    local terminal = redis.call('HMGET', key, 'finishedOn', 'failedReason')
    if not terminal[1] and not terminal[2] then return 1 end
  end
end
return 0
`;

export function createRedisArtifactCleanupProtection(input: {
  queue: Pick<Queue, "getJobCounts" | "toKey">;
  redis: RedisScriptRunner;
  now?: () => number;
}): ArtifactCleanupProtection {
  const now = input.now ?? Date.now;
  const slotTtlMs = getConcurrencyConfig().slotTtlSeconds * 1000;

  return {
    async snapshot() {
      // Counts prove Redis/BullMQ metadata is reachable. Exact protection
      // below inspects one deterministic delivery job ID, so queue volume does
      // not expand the privacy or latency bound.
      await input.queue.getJobCounts(...PROTECTED_JOB_TYPES);

      return {
        isProtected: async (state) => {
          // Terminal records cannot still have a retryable investigation job;
          // only the deterministic delivery-only job can race cleanup. Check
          // that one safe ID directly in BullMQ's metadata structures, never
          // a Job object or its data hash field.
          const deliveryJobActive = Number(
            await input.redis.eval(
              ACTIVE_DELIVERY_JOB_SCRIPT,
              2,
              input.queue.toKey(buildDeliveryJobId(state.investigationId)),
              input.queue.toKey(buildLegacyDeliveryJobId(state.investigationId)),
            ),
          );
          if (deliveryJobActive !== 0) {
            return true;
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
  // Safe aggregate used only for operational visibility. No artifact,
  // repository, issue, or delivery content leaves the cleanup service.
  retainedFailedAgeMs?: number;
};

export type ArtifactCleanupScanResult = {
  // Root entries examined is the hard bound; scanned counts only valid
  // Sherlock investigation directories.
  examined: number;
  scanned: number;
  deleted: number;
  retained: number;
  protected: number;
  errors: number;
  oldestRetainedFailedAgeMs: number | null;
  bounded: boolean;
};

export type ArtifactCleanupService = {
  cleanupInvestigation(investigationId: string): Promise<ArtifactCleanupResult>;
  scanExpired(): Promise<ArtifactCleanupScanResult>;
};

export async function evaluateTerminalJobArtifactRetention(input: {
  cleanup: ArtifactCleanupService;
  investigationId: string;
  onResult?: (result: ArtifactCleanupResult) => void | Promise<void>;
}): Promise<ArtifactCleanupResult | null> {
  try {
    const result = await input.cleanup.cleanupInvestigation(input.investigationId);
    await input.onResult?.(result);
    return result;
  } catch {
    // Retention is detached operational work. A cleanup or visibility failure
    // must never change the BullMQ job's already-decided outcome.
    return null;
  }
}

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
  "failed",
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
      // Yield before taking the delivery lease when publishing is unfinished
      // or the queue/concurrency snapshot already protects this investigation.
      // Returning early can only retain data longer; it can never delete data
      // that delivery still needs. A later cleanup pass re-evaluates it.
      const preflightState = await options.deliveryStore.load(investigationId);
      const preflightTerminalFailure = preflightState
        ? null
        : await options.deliveryStore.loadTerminalFailure(investigationId);
      const preflightRecord = preflightState ?? preflightTerminalFailure;
      if (preflightState && !isDeliveryTerminal(preflightState)) {
        return { investigationId, status: "not_terminal" };
      }
      if (preflightRecord && await snapshot.isProtected(preflightRecord)) {
        return { investigationId, status: "protected" };
      }

      return await options.deliveryStore.withLock(investigationId, async () => {
        // Revalidate after acquiring the same lock used by delivery. This
        // makes deletion and delivery-state reconciliation mutually exclusive.
        target = await resolveSafeInvestigationDirectory(rootDir, investigationId);
        if (!(await pathExists(target))) {
          return { investigationId, status: "missing" };
        }

        const state = await options.deliveryStore.load(investigationId);
        const terminalFailure = state
          ? null
          : await options.deliveryStore.loadTerminalFailure(investigationId);
        const currentTime = now();
        const expiry = state
          ? artifactExpiry(state, config)
          : terminalFailure
            ? Date.parse(terminalFailure.retentionEligibleAt)
            : null;
        const retainedFailedAgeMs = state
          ? failedArtifactAge(state, currentTime)
          : terminalFailure
            ? Math.max(0, currentTime - Date.parse(terminalFailure.terminalAt))
            : null;
        const retained = (status: ArtifactCleanupStatus) => ({
          investigationId,
          status,
          ...(retainedFailedAgeMs === null ? {} : { retainedFailedAgeMs }),
        });

        if ((!state && !terminalFailure) || expiry === null || !Number.isFinite(expiry)) {
          return retained("not_terminal");
        }
        if (currentTime < expiry) {
          return retained("not_expired");
        }
        if (await snapshot.isProtected(state ?? terminalFailure!)) {
          return retained("protected");
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
        return emptyScanResult();
      }
      scanRunning = true;

      try {
        let snapshot: ArtifactCleanupProtectionSnapshot;
        try {
          snapshot = await options.protection.snapshot();
        } catch {
          safeLog(log, null, "activity snapshot unavailable; scan skipped");
          return emptyScanResult({ errors: 1, bounded: false });
        }

        let directory;
        try {
          const rootInfo = await lstat(rootDir);
          if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
            safeLog(log, null, "artifact root is unsafe; scan skipped");
            return emptyScanResult({ errors: 1, bounded: false });
          }
          directory = await opendir(rootDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return emptyScanResult();
          }
          safeLog(log, null, "artifact root unavailable; scan skipped");
          return emptyScanResult({ errors: 1, bounded: false });
        }

        let examined = 0;
        let scanned = 0;
        let deleted = 0;
        let retained = 0;
        let protectedCount = 0;
        let errors = 0;
        let oldestRetainedFailedAgeMs: number | null = null;
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
          scanned += 1;

          const result = await cleanupInvestigationWithSnapshot(
            entry.name,
            snapshot,
          );
          if (result.status === "deleted") deleted += 1;
          if (result.status !== "deleted" && result.status !== "missing") {
            retained += 1;
          }
          if (result.status === "protected") protectedCount += 1;
          if (result.status === "error" || result.status === "unsafe") errors += 1;
          if (result.retainedFailedAgeMs !== undefined) {
            oldestRetainedFailedAgeMs = Math.max(
              oldestRetainedFailedAgeMs ?? 0,
              result.retainedFailedAgeMs,
            );
          }
        }
        return {
          examined,
          scanned,
          deleted,
          retained,
          protected: protectedCount,
          errors,
          oldestRetainedFailedAgeMs,
          bounded,
        };
      } catch {
        safeLog(log, null, "scan failed; artifacts retained");
        return emptyScanResult({ errors: 1, bounded: false });
      } finally {
        scanRunning = false;
      }
    },
  };
}

function emptyScanResult(
  overrides: Partial<ArtifactCleanupScanResult> = {},
): ArtifactCleanupScanResult {
  return {
    examined: 0,
    scanned: 0,
    deleted: 0,
    retained: 0,
    protected: 0,
    errors: 0,
    oldestRetainedFailedAgeMs: null,
    bounded: true,
    ...overrides,
  };
}

function artifactExpiry(
  state: DeliveryState,
  config: ArtifactRetentionConfig,
): number | null {
  if (state.terminalComment.status === "failed") {
    const failedAt = Date.parse(state.updatedAt);
    return Number.isFinite(failedAt)
      ? failedAt + config.failedRetentionMs
      : null;
  }
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
    if (isFixFullyDelivered(state)) {
      return deliveredAt + config.successfulRetentionMs;
    }
    // A truthful blocked/failed PR plus a posted terminal comment is a
    // terminal failed delivery, not an indefinitely active delivery.
    return state.pullRequest.status === "failed" ||
      state.pullRequest.status === "blocked"
      ? deliveredAt + config.failedRetentionMs
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

function failedArtifactAge(state: DeliveryState, nowMs: number): number | null {
  if (state.terminalComment.status === "failed") {
    const failedAt = Date.parse(state.updatedAt);
    return Number.isFinite(failedAt) ? Math.max(0, nowMs - failedAt) : null;
  }
  if (
    state.executionOutcome === "verified_fix" &&
    (state.pullRequest.status === "failed" ||
      state.pullRequest.status === "blocked") &&
    state.terminalComment.status === "posted" &&
    state.terminalComment.postedAt
  ) {
    const deliveredAt = Date.parse(state.terminalComment.postedAt);
    return Number.isFinite(deliveredAt)
      ? Math.max(0, nowMs - deliveredAt)
      : null;
  }
  if (
    !RETAINED_FAILURE_OUTCOMES.has(state.executionOutcome) ||
    state.fixVerified ||
    state.terminalComment.status !== "posted" ||
    !state.terminalComment.postedAt
  ) {
    return null;
  }

  const deliveredAt = Date.parse(state.terminalComment.postedAt);
  return Number.isFinite(deliveredAt) ? Math.max(0, nowMs - deliveredAt) : null;
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
  onScanComplete?: (
    result: ArtifactCleanupScanResult,
  ) => void | Promise<void>;
}): () => void {
  const scan = async () => {
    const result = await input.cleanup.scanExpired();
    await input.onScanComplete?.(result);
  };

  if (input.config.cleanupOnStartup) {
    // Startup must never wait for filesystem or Redis cleanup. The scan is
    // bounded, fail-closed, and deliberately detached from worker creation.
    void scan().catch(() => {});
  }

  if (input.config.cleanupIntervalMs <= 0) {
    return () => {};
  }

  const timer = setInterval(() => {
    void scan().catch(() => {});
  }, input.config.cleanupIntervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
