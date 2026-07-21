// Lightweight, payload-free operational signals for the hosted worker.
// Redis records contain only worker identity and timestamps. Queue inspection
// reads counts and job timestamps only; job data is never returned or formatted.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { StatsFs } from "node:fs";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const WORKER_HEARTBEAT_KEY_PREFIX =
  "sherlock:ops:worker-heartbeat:";

const SAFE_WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_OPERATIONAL_RECORD_BYTES = 4_096;
const MAX_OPERATIONAL_RECORDS = 100;
const MAX_SCAN_ITERATIONS = 20;
const HEARTBEAT_DELETE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export type OperationalRedis = {
  ping(): Promise<string>;
  set(
    key: string,
    value: string,
    expiryMode: "PX",
    ttlMs: number,
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  scan(
    cursor: string,
    match: "MATCH",
    pattern: string,
    count: "COUNT",
    countValue: number,
  ): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  zrange(
    key: string,
    start: number,
    stop: number,
    withScores: "WITHSCORES",
  ): Promise<string[]>;
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>;
};

export function asOperationalRedis(redis: Redis): OperationalRedis {
  return redis as unknown as OperationalRedis;
}

export type ProductionMonitoringConfig = {
  heartbeatIntervalMs: number;
  heartbeatTtlMs: number;
  heartbeatMaxAgeMs: number;
  queueMaxWaitingAgeMs: number;
  diskWarningPercent: number;
  diskCriticalPercent: number;
  requestTimeoutMs: number;
};

export const PRODUCTION_MONITORING_DEFAULTS = {
  heartbeatIntervalMs: 15_000,
  heartbeatTtlMs: 60_000,
  heartbeatMaxAgeMs: 45_000,
  queueMaxWaitingAgeMs: 10 * 60_000,
  diskWarningPercent: 80,
  diskCriticalPercent: 90,
  requestTimeoutMs: 5_000,
} as const;

export function getProductionMonitoringConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProductionMonitoringConfig {
  const heartbeatIntervalMs = seconds(
    env,
    "SHERLOCK_WORKER_HEARTBEAT_INTERVAL_SECONDS",
    PRODUCTION_MONITORING_DEFAULTS.heartbeatIntervalMs,
  );
  const heartbeatTtlMs = seconds(
    env,
    "SHERLOCK_WORKER_HEARTBEAT_TTL_SECONDS",
    PRODUCTION_MONITORING_DEFAULTS.heartbeatTtlMs,
  );
  const heartbeatMaxAgeMs = seconds(
    env,
    "SHERLOCK_WORKER_HEARTBEAT_MAX_AGE_SECONDS",
    PRODUCTION_MONITORING_DEFAULTS.heartbeatMaxAgeMs,
  );
  const diskWarningPercent = percentage(
    env,
    "SHERLOCK_DISK_WARNING_PERCENT",
    PRODUCTION_MONITORING_DEFAULTS.diskWarningPercent,
  );
  const diskCriticalPercent = percentage(
    env,
    "SHERLOCK_DISK_CRITICAL_PERCENT",
    PRODUCTION_MONITORING_DEFAULTS.diskCriticalPercent,
  );

  if (heartbeatIntervalMs >= heartbeatMaxAgeMs) {
    throw new Error(
      "SHERLOCK_WORKER_HEARTBEAT_INTERVAL_SECONDS must be lower than SHERLOCK_WORKER_HEARTBEAT_MAX_AGE_SECONDS.",
    );
  }
  if (heartbeatMaxAgeMs >= heartbeatTtlMs) {
    throw new Error(
      "SHERLOCK_WORKER_HEARTBEAT_MAX_AGE_SECONDS must be lower than SHERLOCK_WORKER_HEARTBEAT_TTL_SECONDS.",
    );
  }
  if (diskWarningPercent >= diskCriticalPercent) {
    throw new Error(
      "SHERLOCK_DISK_WARNING_PERCENT must be lower than SHERLOCK_DISK_CRITICAL_PERCENT.",
    );
  }

  return {
    heartbeatIntervalMs,
    heartbeatTtlMs,
    heartbeatMaxAgeMs,
    queueMaxWaitingAgeMs: seconds(
      env,
      "SHERLOCK_QUEUE_MAX_WAIT_AGE_SECONDS",
      PRODUCTION_MONITORING_DEFAULTS.queueMaxWaitingAgeMs,
    ),
    diskWarningPercent,
    diskCriticalPercent,
    requestTimeoutMs: seconds(
      env,
      "SHERLOCK_OPS_REQUEST_TIMEOUT_SECONDS",
      PRODUCTION_MONITORING_DEFAULTS.requestTimeoutMs,
    ),
  };
}

function seconds(
  env: NodeJS.ProcessEnv,
  key: string,
  fallbackMs: number,
): number {
  return positiveNumber(env[key], key, fallbackMs / 1_000) * 1_000;
}

function percentage(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const value = positiveNumber(env[key], key, fallback);
  if (value > 100) {
    throw new Error(`${key} must be at most 100.`);
  }
  return value;
}

function positiveNumber(
  value: string | undefined,
  key: string,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number.`);
  }
  return parsed;
}

export function getWorkerId(
  env: NodeJS.ProcessEnv = process.env,
  host: () => string = hostname,
): string {
  const workerId = env.SHERLOCK_WORKER_ID?.trim() || host();
  if (!SAFE_WORKER_ID.test(workerId)) {
    throw new Error(
      "SHERLOCK_WORKER_ID must contain only letters, numbers, dot, underscore, or hyphen (maximum 100 characters).",
    );
  }
  return workerId;
}

export type WorkerHeartbeatRecord = {
  version: 1;
  workerId: string;
  ownerId: string;
  startedAt: string;
  updatedAt: string;
};

export type WorkerHeartbeatController = {
  start(): void;
  beat(): Promise<boolean>;
  stop(): Promise<void>;
};

export function createWorkerHeartbeat(input: {
  redis: OperationalRedis;
  workerId: string;
  intervalMs: number;
  ttlMs: number;
  now?: () => number;
  log?: (message: string) => void;
}): WorkerHeartbeatController {
  if (!SAFE_WORKER_ID.test(input.workerId)) {
    throw new Error("Unsafe worker identifier.");
  }
  if (input.intervalMs <= 0 || input.ttlMs <= input.intervalMs) {
    throw new Error("Worker heartbeat TTL must exceed its interval.");
  }

  const now = input.now ?? Date.now;
  const log = input.log ?? (() => {});
  const key = `${WORKER_HEARTBEAT_KEY_PREFIX}${input.workerId}`;
  const ownerId = randomUUID();
  const startedAt = new Date(now()).toISOString();
  let lastValue: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let pending: Promise<boolean> | null = null;

  const write = async () => {
    if (stopped) return false;
    const record: WorkerHeartbeatRecord = {
      version: 1,
      workerId: input.workerId,
      ownerId,
      startedAt,
      updatedAt: new Date(now()).toISOString(),
    };
    const value = JSON.stringify(record);
    try {
      await input.redis.set(key, value, "PX", input.ttlMs);
      lastValue = value;
      return true;
    } catch {
      log(`[worker-heartbeat:${input.workerId}] Redis update failed.`);
      return false;
    }
  };

  const beat = () => {
    // Coalesce timer ticks while Redis is unavailable. A reconnect must not
    // release an unbounded chain of stale heartbeat writes.
    if (pending) return pending;
    pending = write().finally(() => {
      pending = null;
    });
    return pending;
  };

  return {
    start() {
      if (timer || stopped) return;
      void beat();
      timer = setInterval(() => void beat(), input.intervalMs);
      timer.unref();
    },
    beat,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await pending?.catch(() => false);
      if (lastValue) {
        await input.redis
          .eval(HEARTBEAT_DELETE_SCRIPT, 1, key, lastValue)
          .catch(() => {});
      }
    },
  };
}

function parseHeartbeat(value: string | null): WorkerHeartbeatRecord | null {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_OPERATIONAL_RECORD_BYTES) {
    return null;
  }
  try {
    const record = JSON.parse(value) as Partial<WorkerHeartbeatRecord>;
    if (
      record.version !== 1 ||
      typeof record.workerId !== "string" ||
      !SAFE_WORKER_ID.test(record.workerId) ||
      typeof record.ownerId !== "string" ||
      record.ownerId.length > 100 ||
      typeof record.startedAt !== "string" ||
      !Number.isFinite(Date.parse(record.startedAt)) ||
      typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.updatedAt))
    ) {
      return null;
    }
    return record as WorkerHeartbeatRecord;
  } catch {
    return null;
  }
}

export type WorkerHeartbeatSummary = {
  total: number;
  fresh: number;
  stale: number;
  oldestAgeMs: number | null;
  truncated: boolean;
};

export async function readWorkerHeartbeatSummary(
  redis: OperationalRedis,
  options: { now?: () => number; maxAgeMs: number },
): Promise<WorkerHeartbeatSummary> {
  const now = options.now ?? Date.now;
  const { values, truncated } = await scanOperationalValues(
    redis,
    WORKER_HEARTBEAT_KEY_PREFIX,
  );
  let fresh = 0;
  let stale = 0;
  let oldestAgeMs: number | null = null;

  for (const value of values) {
    const record = parseHeartbeat(value);
    const updatedAt = record ? Date.parse(record.updatedAt) : Number.NaN;
    const age = Number.isFinite(updatedAt) ? now() - updatedAt : Number.NaN;
    if (record && age >= 0 && age <= options.maxAgeMs) {
      fresh += 1;
      oldestAgeMs = Math.max(oldestAgeMs ?? 0, age);
    } else {
      stale += 1;
    }
  }

  return {
    total: values.length,
    fresh,
    stale,
    oldestAgeMs,
    truncated,
  };
}

export async function readWorkerHeartbeat(
  redis: OperationalRedis,
  workerId: string,
  options: { now?: () => number; maxAgeMs: number },
): Promise<{ healthy: boolean; ageMs: number | null }> {
  if (!SAFE_WORKER_ID.test(workerId)) {
    return { healthy: false, ageMs: null };
  }
  const value = await redis.get(`${WORKER_HEARTBEAT_KEY_PREFIX}${workerId}`);
  const record = parseHeartbeat(value);
  if (!record || record.workerId !== workerId) {
    return { healthy: false, ageMs: null };
  }
  const ageMs = (options.now ?? Date.now)() - Date.parse(record.updatedAt);
  return {
    healthy: ageMs >= 0 && ageMs <= options.maxAgeMs,
    ageMs: ageMs >= 0 ? ageMs : null,
  };
}

export type QueueOperationalSummary = {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  oldestWaitingAgeMs: number | null;
  oldestDelayedCreationAgeMs: number | null;
  oldestDelayedOverdueAgeMs: number | null;
  waitingAgeComplete: boolean;
  delayedCreationAgeComplete: boolean;
  delayedDueAgeComplete: boolean;
};

const MAX_QUEUE_AGE_IDS = 100;
const OPAQUE_QUEUE_JOB_ID = /^(?:investigate|deliver)_[0-9a-f]{64}$/;

export async function readQueueOperationalSummary(
  queue: Pick<Queue, "getJobCounts" | "toKey">,
  redis: Pick<OperationalRedis, "lrange" | "zrange" | "hmget">,
  now: () => number = Date.now,
): Promise<QueueOperationalSummary> {
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "completed",
    "failed",
  );
  const count = (name: "waiting" | "active" | "delayed" | "completed" | "failed") => {
    if (counts[name] === undefined || counts[name] === null) {
      throw new Error("Queue counts are unavailable.");
    }
    const value = Number(counts[name]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Queue counts are unavailable.");
    }
    return value;
  };
  const waiting = count("waiting");
  const delayed = count("delayed");
  const waitingIds =
    waiting > 0 && waiting <= MAX_QUEUE_AGE_IDS
      ? await redis.lrange(queue.toKey("wait"), 0, waiting - 1)
      : [];
  const delayedEntries =
    delayed > 0
      ? await redis.zrange(
          queue.toKey("delayed"),
          0,
          Math.min(delayed, MAX_QUEUE_AGE_IDS) - 1,
          "WITHSCORES",
        )
      : [];
  const delayedIds = delayedEntries.filter((_, index) => index % 2 === 0);
  const delayedScores = delayedEntries
    .filter((_, index) => index % 2 === 1)
    .map(Number);
  const waitingTimestamps = await safeJobTimestamps(queue, redis, waitingIds);
  const delayedTimestamps = await safeJobTimestamps(queue, redis, delayedIds);
  const waitingAgeComplete =
    waiting === 0 ||
    (waiting <= MAX_QUEUE_AGE_IDS &&
      waitingIds.length === waiting &&
      new Set(waitingIds).size === waitingIds.length &&
      waitingTimestamps.length === waiting &&
      waitingTimestamps.every(Number.isFinite));
  const delayedCreationAgeComplete =
    delayed === 0 ||
    (delayed <= MAX_QUEUE_AGE_IDS &&
      delayedIds.length === delayed &&
      new Set(delayedIds).size === delayedIds.length &&
      delayedTimestamps.length === delayed &&
      delayedTimestamps.every(Number.isFinite));
  const delayedDueAgeComplete =
    delayed === 0 ||
    (delayedScores.length > 0 &&
      Number.isFinite(delayedScores[0]) &&
      delayedEntries.length % 2 === 0);
  const nowMs = now();
  const oldestDueAt = delayedDueAgeComplete && delayed > 0
    ? Math.floor(delayedScores[0] / 0x1000)
    : null;

  return {
    waiting,
    active: count("active"),
    delayed,
    completed: count("completed"),
    failed: count("failed"),
    oldestWaitingAgeMs: waitingAgeComplete
      ? oldestAge(waitingTimestamps, nowMs)
      : null,
    oldestDelayedCreationAgeMs: delayedCreationAgeComplete
      ? oldestAge(delayedTimestamps, nowMs)
      : null,
    oldestDelayedOverdueAgeMs:
      oldestDueAt !== null && oldestDueAt <= nowMs
        ? Math.max(0, nowMs - oldestDueAt)
        : null,
    waitingAgeComplete,
    delayedCreationAgeComplete,
    delayedDueAgeComplete,
  };
}

async function safeJobTimestamps(
  queue: Pick<Queue, "toKey">,
  redis: Pick<OperationalRedis, "hmget">,
  ids: string[],
): Promise<number[]> {
  const values = await Promise.all(
    ids.map(async (id) => {
      if (!OPAQUE_QUEUE_JOB_ID.test(id)) return Number.NaN;
      const [timestamp] = await redis.hmget(queue.toKey(id), "timestamp");
      return timestamp !== null && timestamp.trim() !== ""
        ? Number(timestamp)
        : Number.NaN;
    }),
  );
  return values.map((value) => (Number.isFinite(value) && value >= 0 ? value : Number.NaN));
}

function oldestAge(timestamps: number[], nowMs: number): number | null {
  return timestamps.length > 0
    ? Math.max(...timestamps.map((timestamp) => Math.max(0, nowMs - timestamp)))
    : null;
}

export type FilesystemTarget = {
  name: string;
  path: string | null;
  optional: boolean;
};

export type FilesystemUsage = {
  name: string;
  optional: boolean;
  available: boolean;
  usedPercent: number | null;
};

export type FilesystemUsageAdapter = {
  statfs(path: string): Promise<Pick<StatsFs, "blocks" | "bavail" | "bsize">>;
};

export async function readFilesystemUsage(
  targets: FilesystemTarget[],
  adapter: FilesystemUsageAdapter,
): Promise<FilesystemUsage[]> {
  return Promise.all(
    targets.map(async (target) => {
      if (!target.path) {
        return {
          name: target.name,
          optional: target.optional,
          available: false,
          usedPercent: null,
        };
      }
      try {
        const stats = await adapter.statfs(target.path);
        const blocks = Number(stats.blocks);
        const available = Number(stats.bavail);
        if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(available)) {
          throw new Error("Invalid filesystem statistics.");
        }
        const usedPercent = Math.max(
          0,
          Math.min(100, ((blocks - available) / blocks) * 100),
        );
        return {
          name: target.name,
          optional: target.optional,
          available: true,
          usedPercent,
        };
      } catch {
        return {
          name: target.name,
          optional: target.optional,
          available: false,
          usedPercent: null,
        };
      }
    }),
  );
}

async function scanOperationalValues(
  redis: OperationalRedis,
  prefix: string,
): Promise<{ values: Array<string | null>; truncated: boolean }> {
  let cursor = "0";
  let iterations = 0;
  let truncated = false;
  const keys = new Set<string>();

  do {
    const [nextCursor, page] = await redis.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      Math.min(100, MAX_OPERATIONAL_RECORDS + 1),
    );
    cursor = nextCursor;
    iterations += 1;
    for (const key of page) {
      if (!key.startsWith(prefix)) continue;
      keys.add(key);
      if (keys.size > MAX_OPERATIONAL_RECORDS) {
        truncated = true;
        break;
      }
    }
    if (truncated || iterations >= MAX_SCAN_ITERATIONS) break;
  } while (cursor !== "0");

  if (cursor !== "0") truncated = true;
  const boundedKeys = [...keys].slice(0, MAX_OPERATIONAL_RECORDS);
  return {
    values: boundedKeys.length > 0 ? await redis.mget(...boundedKeys) : [],
    truncated,
  };
}
