// Redis-backed investigation rate limiting and concurrency control.
//
// Replaces the old process-local limiter: limits are shared across every
// backend/worker process through Redis and survive restarts. All check-and-
// consume operations run as single Lua scripts, so there are no
// read-then-write races between processes.
//
// Two independent controls:
// - Rate limit: how many investigations a tenant may START per fixed window
//   (INCR + EXPIRE). Applied at the webhook, AFTER the idempotency claim, so
//   deduplicated redeliveries never consume quota.
// - Concurrency: how many investigations a tenant / repository may have
//   ACTIVELY RUNNING (sorted set of active investigation ids, scored by
//   acquisition time). Applied in the worker around the pipeline. Slots
//   older than the TTL are evicted inside the acquire script, so a crashed
//   worker can never permanently block a tenant.
//
// Tenant identity is the queue's tenant key (derived from the GitHub
// installation id). Callers without an installation id should pass a stable
// fallback such as "repo:<owner>/<repo>" — the limiter treats keys opaquely.

import type { Redis } from "ioredis";

// Minimal structural Redis surface, so tests inject fakes (matching the
// queue-adapter test style) and production passes the existing ioredis
// connection.
export type RedisScriptRunner = {
  eval: (
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ) => Promise<unknown>;
};

export function asScriptRunner(redis: Redis): RedisScriptRunner {
  return redis as unknown as RedisScriptRunner;
}

// --- Configuration -----------------------------------------------------------

// Central hardcoded limits for now. Keep all production values here so they
// are easy to change without threading new env vars through local/dev setup.
// Later, getRateLimitConfig/getConcurrencyConfig can read env vars and fall
// back to these values.
export const INVESTIGATION_LIMITS = {
  rateLimitMax: 3, // change later
  rateLimitWindowSeconds: 5, // change later
  tenantConcurrencyLimit: 2,
  repoConcurrencyLimit: 1,
  concurrencySlotTtlSeconds: 1800,
} as const;

export type RateLimitConfig = {
  max: number;
  windowSeconds: number;
};

export type ConcurrencyConfig = {
  // <= 0 disables the corresponding limit.
  tenantLimit: number;
  repoLimit: number;
  slotTtlSeconds: number;
};

export function getRateLimitConfig(): RateLimitConfig {
  return {
    max: INVESTIGATION_LIMITS.rateLimitMax,
    windowSeconds: INVESTIGATION_LIMITS.rateLimitWindowSeconds,
  };
}

export function getConcurrencyConfig(): ConcurrencyConfig {
  return {
    tenantLimit: INVESTIGATION_LIMITS.tenantConcurrencyLimit,
    repoLimit: INVESTIGATION_LIMITS.repoConcurrencyLimit,
    slotTtlSeconds: INVESTIGATION_LIMITS.concurrencySlotTtlSeconds,
  };
}

// --- Keys ----------------------------------------------------------------------

export const RATE_LIMIT_KEY_PREFIX = "sherlock:rate-limit:tenant:";
export const TENANT_CONCURRENCY_KEY_PREFIX = "sherlock:concurrency:tenant:";
export const REPO_CONCURRENCY_KEY_PREFIX = "sherlock:concurrency:repo:";

// Stable, case-insensitive repo identity ("owner/repo").
export function buildRepoConcurrencyKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

// --- Lua scripts ------------------------------------------------------------------
// Exported so tests can emulate exactly the script the service sends.

// Fixed-window counter: first hit in a window sets the expiry. Returns the
// post-increment count.
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return count
`;

// Atomic acquire over BOTH the tenant and repo sorted sets: stale slots are
// evicted first, then both limits are checked, and only if both pass is the
// member added to both. A member that already holds a slot (worker retry of
// the same investigation) re-acquires idempotently instead of deadlocking.
// KEYS: [tenant zset, repo zset]
// ARGV: [tenantLimit, repoLimit, staleCutoffMs, nowMs, member, keyTtlSeconds]
// Returns: {allowedFlag, blockedBy("ok"|"tenant"|"repo"), tenantCount, repoCount}
export const CONCURRENCY_ACQUIRE_SCRIPT = `
local tenantLimit = tonumber(ARGV[1])
local repoLimit = tonumber(ARGV[2])
local staleCutoff = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local member = ARGV[5]
local keyTtlSeconds = tonumber(ARGV[6])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', staleCutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', staleCutoff)

local heldTenant = redis.call('ZSCORE', KEYS[1], member)
local heldRepo = redis.call('ZSCORE', KEYS[2], member)

if tenantLimit > 0 and not heldTenant and redis.call('ZCARD', KEYS[1]) >= tenantLimit then
  return {0, 'tenant', redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2])}
end

if repoLimit > 0 and not heldRepo and redis.call('ZCARD', KEYS[2]) >= repoLimit then
  return {0, 'repo', redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2])}
end

redis.call('ZADD', KEYS[1], now, member)
redis.call('ZADD', KEYS[2], now, member)
redis.call('EXPIRE', KEYS[1], keyTtlSeconds)
redis.call('EXPIRE', KEYS[2], keyTtlSeconds)
return {1, 'ok', redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2])}
`;

// Removes the member from both sets. Safe to call more than once.
// KEYS: [tenant zset, repo zset], ARGV: [member]
export const CONCURRENCY_RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

// --- Rate limiter --------------------------------------------------------------------

export type RateLimitDecision = {
  allowed: boolean;
  tenantKey: string;
  count: number;
  limit: number;
  windowSeconds: number;
};

export type InvestigationRateLimiter = {
  // Atomically counts this request against the tenant's window and returns
  // whether it fits. Call ONLY for genuinely new requests (after idempotency
  // dedup), never for redeliveries.
  checkAndConsumeInvestigationRateLimit: (
    tenantKey: string,
  ) => Promise<RateLimitDecision>;
};

export type RateLimiterOptions = {
  config?: RateLimitConfig;
  log?: (message: string) => void;
};

export function createInvestigationRateLimiter(
  getRedis: () => RedisScriptRunner,
  options: RateLimiterOptions = {},
): InvestigationRateLimiter {
  const config = options.config ?? getRateLimitConfig();
  const log = options.log ?? ((message: string) => console.log(message));

  return {
    checkAndConsumeInvestigationRateLimit: async (tenantKey) => {
      const key = `${RATE_LIMIT_KEY_PREFIX}${tenantKey}`;
      const count = Number(
        await getRedis().eval(RATE_LIMIT_SCRIPT, 1, key, config.windowSeconds),
      );
      const allowed = count <= config.max;

      log(
        `Rate limit ${allowed ? "allowed" : "rejected"} for tenant ${tenantKey}: ${count}/${config.max} in ${config.windowSeconds}s window.`,
      );

      return {
        allowed,
        tenantKey,
        count,
        limit: config.max,
        windowSeconds: config.windowSeconds,
      };
    },
  };
}

// --- Concurrency gate -------------------------------------------------------------------

export type ConcurrencySlot = {
  tenantKey: string;
  repoKey: string;
  investigationId: string;
};

export type ConcurrencyDecision =
  | { acquired: true; tenantActive: number; repoActive: number }
  | {
      acquired: false;
      blockedBy: "tenant" | "repo";
      limit: number;
      tenantActive: number;
      repoActive: number;
    };

export type InvestigationConcurrencyGate = {
  acquireInvestigationConcurrency: (
    slot: ConcurrencySlot,
  ) => Promise<ConcurrencyDecision>;
  // Must run when the investigation finishes, fails, or throws. Idempotent.
  releaseInvestigationConcurrency: (slot: ConcurrencySlot) => Promise<void>;
};

export type ConcurrencyGateOptions = {
  config?: ConcurrencyConfig;
  now?: () => number;
  log?: (message: string) => void;
};

export function createInvestigationConcurrencyGate(
  getRedis: () => RedisScriptRunner,
  options: ConcurrencyGateOptions = {},
): InvestigationConcurrencyGate {
  const config = options.config ?? getConcurrencyConfig();
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));

  const keysFor = (slot: ConcurrencySlot): [string, string] => [
    `${TENANT_CONCURRENCY_KEY_PREFIX}${slot.tenantKey}`,
    `${REPO_CONCURRENCY_KEY_PREFIX}${slot.repoKey}`,
  ];

  return {
    acquireInvestigationConcurrency: async (slot) => {
      const [tenantConcurrencyKey, repoConcurrencyKey] = keysFor(slot);
      const currentMs = now();
      // Key TTL is a garbage-collection backstop only; slot staleness is
      // enforced per member by the score cutoff inside the script.
      const keyTtlSeconds = config.slotTtlSeconds * 2;

      const raw = (await getRedis().eval(
        CONCURRENCY_ACQUIRE_SCRIPT,
        2,
        tenantConcurrencyKey,
        repoConcurrencyKey,
        config.tenantLimit,
        config.repoLimit,
        currentMs - config.slotTtlSeconds * 1000,
        currentMs,
        slot.investigationId,
        keyTtlSeconds,
      )) as [number, string, number, number];

      const [allowedFlag, blockedBy, tenantActive, repoActive] = raw;

      if (Number(allowedFlag) === 1) {
        log(
          `[${slot.investigationId}] Concurrency acquired (tenant ${slot.tenantKey}: ${tenantActive}/${describeLimit(config.tenantLimit)}, repo ${slot.repoKey}: ${repoActive}/${describeLimit(config.repoLimit)}).`,
        );

        return {
          acquired: true,
          tenantActive: Number(tenantActive),
          repoActive: Number(repoActive),
        };
      }

      const dimension = blockedBy === "repo" ? "repo" : "tenant";
      const limit = dimension === "repo" ? config.repoLimit : config.tenantLimit;

      log(
        `[${slot.investigationId}] Concurrency denied by ${dimension} limit (tenant ${slot.tenantKey}: ${tenantActive} active, repo ${slot.repoKey}: ${repoActive} active, limit ${limit}).`,
      );

      return {
        acquired: false,
        blockedBy: dimension,
        limit,
        tenantActive: Number(tenantActive),
        repoActive: Number(repoActive),
      };
    },
    releaseInvestigationConcurrency: async (slot) => {
      const [tenantConcurrencyKey, repoConcurrencyKey] = keysFor(slot);

      await getRedis().eval(
        CONCURRENCY_RELEASE_SCRIPT,
        2,
        tenantConcurrencyKey,
        repoConcurrencyKey,
        slot.investigationId,
      );

      log(
        `[${slot.investigationId}] Concurrency released (tenant ${slot.tenantKey}, repo ${slot.repoKey}).`,
      );
    },
  };
}

function describeLimit(limit: number): string {
  return limit > 0 ? String(limit) : "unlimited";
}
