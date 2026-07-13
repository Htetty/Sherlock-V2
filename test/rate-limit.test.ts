// Redis-backed rate limiting and concurrency: window limits per tenant,
// tenant/repo concurrency slots with TTL-based stale eviction, and the
// worker wrapper that acquires/releases slots around job processing.
//
// The fake Redis emulates exactly the exported Lua scripts the service
// sends (same style as the queue-adapter tests), so no Redis server runs.

import { DelayedError, UnrecoverableError } from "bullmq";
import { describe, expect, test } from "vitest";
import {
  CONCURRENCY_ACQUIRE_SCRIPT,
  CONCURRENCY_RENEW_SCRIPT,
  CONCURRENCY_RELEASE_SCRIPT,
  INVESTIGATION_LIMITS,
  RATE_LIMIT_SCRIPT,
  buildRepoConcurrencyKey,
  createInvestigationConcurrencyGate,
  createInvestigationRateLimiter,
  getConcurrencyConfig,
  getRateLimitConfig,
  type RedisScriptRunner,
} from "../backend/services/rate-limit.js";
import {
  processInvestigationJobWithConcurrency,
  type WorkerDeps,
} from "../backend/queue/process-investigation.js";
import type { InvestigationJobPayload } from "../backend/queue/investigation-queue.js";
import { createInMemoryDeliveryStateStore } from "../backend/services/delivery.js";
import type { InvestigationPipelineResult } from "../backend/services/investigation.js";

const noLog = () => {};

// --- Fake Redis (script-level emulation) -------------------------------------

function createFakeRedis(clock: { now: number }) {
  const counters = new Map<string, { value: number; expiresAtMs: number }>();
  const zsets = new Map<string, Map<string, number>>();

  const zset = (key: string) => {
    let set = zsets.get(key);

    if (!set) {
      set = new Map();
      zsets.set(key, set);
    }

    return set;
  };

  const runner: RedisScriptRunner = {
    eval: async (script, _numKeys, ...args) => {
      if (script === RATE_LIMIT_SCRIPT) {
        const [key, windowSeconds] = args as [string, number];
        const existing = counters.get(key);

        if (!existing || existing.expiresAtMs <= clock.now) {
          counters.set(key, {
            value: 1,
            expiresAtMs: clock.now + Number(windowSeconds) * 1000,
          });
          return 1;
        }

        existing.value += 1;
        return existing.value;
      }

      if (script === CONCURRENCY_ACQUIRE_SCRIPT) {
        const [tenantKey, repoKey, tenantLimit, repoLimit, staleCutoff, now, member] =
          args as [string, string, number, number, number, number, string];
        const tenant = zset(tenantKey);
        const repo = zset(repoKey);

        // ZREMRANGEBYSCORE -inf..cutoff (inclusive).
        for (const [m, score] of [...tenant]) {
          if (score <= Number(staleCutoff)) tenant.delete(m);
        }
        for (const [m, score] of [...repo]) {
          if (score <= Number(staleCutoff)) repo.delete(m);
        }

        const heldTenant = tenant.has(member);
        const heldRepo = repo.has(member);

        if (Number(tenantLimit) > 0 && !heldTenant && tenant.size >= Number(tenantLimit)) {
          return [0, "tenant", tenant.size, repo.size];
        }

        if (Number(repoLimit) > 0 && !heldRepo && repo.size >= Number(repoLimit)) {
          return [0, "repo", tenant.size, repo.size];
        }

        tenant.set(member, Number(now));
        repo.set(member, Number(now));
        return [1, "ok", tenant.size, repo.size];
      }

      if (script === CONCURRENCY_RELEASE_SCRIPT) {
        const [tenantKey, repoKey, member] = args as [string, string, string];

        zsets.get(tenantKey)?.delete(member);
        zsets.get(repoKey)?.delete(member);
        return 1;
      }

      if (script === CONCURRENCY_RENEW_SCRIPT) {
        const [tenantKey, repoKey, now, member, _keyTtlSeconds, staleCutoff] = args as [
          string,
          string,
          number,
          string,
          number,
          number,
        ];
        const tenant = zsets.get(tenantKey);
        const repo = zsets.get(repoKey);

        const tenantScore = tenant?.get(member);
        const repoScore = repo?.get(member);

        if (
          tenantScore === undefined ||
          repoScore === undefined ||
          tenantScore <= Number(staleCutoff) ||
          repoScore <= Number(staleCutoff)
        ) {
          return 0;
        }

        tenant.set(member, Number(now));
        repo.set(member, Number(now));
        return 1;
      }

      throw new Error("Unknown script sent to fake Redis.");
    },
  };

  return { runner, counters, zsets };
}

// --- Rate limiting -------------------------------------------------------------

describe("investigation rate limiting (Redis window)", () => {
  test("a tenant exceeding the window limit is rejected with a clear decision", async () => {
    const clock = { now: 0 };
    const { runner } = createFakeRedis(clock);
    const limiter = createInvestigationRateLimiter(() => runner, {
      config: { max: 2, windowSeconds: 60 },
      log: noLog,
    });

    const first = await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-1");
    const second = await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-1");
    const third = await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-1");

    expect(first).toMatchObject({ allowed: true, count: 1, limit: 2 });
    expect(second).toMatchObject({ allowed: true, count: 2 });
    expect(third).toMatchObject({
      allowed: false,
      count: 3,
      limit: 2,
      windowSeconds: 60,
      tenantKey: "tenant-gh-1",
    });
  });

  test("different tenants never share a limit bucket", async () => {
    const clock = { now: 0 };
    const { runner } = createFakeRedis(clock);
    const limiter = createInvestigationRateLimiter(() => runner, {
      config: { max: 1, windowSeconds: 60 },
      log: noLog,
    });

    expect(
      (await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-1")).allowed,
    ).toBe(true);
    expect(
      (await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-1")).allowed,
    ).toBe(false);
    // A different tenant still has a full budget.
    expect(
      (await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-2")).allowed,
    ).toBe(true);
  });

  test("the window resets after windowSeconds", async () => {
    const clock = { now: 0 };
    const { runner } = createFakeRedis(clock);
    const limiter = createInvestigationRateLimiter(() => runner, {
      config: { max: 1, windowSeconds: 60 },
      log: noLog,
    });

    expect(
      (await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-1")).allowed,
    ).toBe(true);
    expect(
      (await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-1")).allowed,
    ).toBe(false);

    clock.now = 61_000;
    expect(
      (await limiter.checkAndConsumeInvestigationRateLimit("tenant-gh-1")).allowed,
    ).toBe(true);
  });
});

// --- Concurrency gate --------------------------------------------------------------

const gateConfig = { tenantLimit: 2, repoLimit: 1, slotTtlSeconds: 10 };

function buildGate(clock: { now: number }, config = gateConfig) {
  const { runner, zsets } = createFakeRedis(clock);
  const gate = createInvestigationConcurrencyGate(() => runner, {
    config,
    now: () => clock.now,
    log: noLog,
  });

  return { gate, zsets };
}

describe("investigation concurrency gate", () => {
  test("tenant slots are acquired, denied at the limit, and freed by release", async () => {
    const clock = { now: 1_000 };
    const { gate } = buildGate(clock);

    const slot = (id: string, repo: string) => ({
      tenantKey: "tenant-gh-1",
      repoKey: repo,
      investigationId: id,
    });

    expect(
      (await gate.acquireInvestigationConcurrency(slot("inv_A", "o/r1"))).acquired,
    ).toBe(true);
    expect(
      (await gate.acquireInvestigationConcurrency(slot("inv_B", "o/r2"))).acquired,
    ).toBe(true);

    const denied = await gate.acquireInvestigationConcurrency(slot("inv_C", "o/r3"));
    expect(denied).toMatchObject({
      acquired: false,
      blockedBy: "tenant",
      limit: 2,
      tenantActive: 2,
    });

    await gate.releaseInvestigationConcurrency(slot("inv_A", "o/r1"));
    expect(
      (await gate.acquireInvestigationConcurrency(slot("inv_C", "o/r3"))).acquired,
    ).toBe(true);
  });

  test("repo concurrency blocks a second active investigation of the same repo", async () => {
    const clock = { now: 1_000 };
    const { gate } = buildGate(clock, { ...gateConfig, tenantLimit: 10 });
    const repoKey = buildRepoConcurrencyKey("Owner", "Repo");

    expect(buildRepoConcurrencyKey("Owner", "Repo")).toBe("owner/repo");

    expect(
      (
        await gate.acquireInvestigationConcurrency({
          tenantKey: "tenant-gh-1",
          repoKey,
          investigationId: "inv_A",
        })
      ).acquired,
    ).toBe(true);

    const denied = await gate.acquireInvestigationConcurrency({
      tenantKey: "tenant-gh-1",
      repoKey,
      investigationId: "inv_B",
    });
    expect(denied).toMatchObject({ acquired: false, blockedBy: "repo", limit: 1 });

    // A different repo is unaffected.
    expect(
      (
        await gate.acquireInvestigationConcurrency({
          tenantKey: "tenant-gh-1",
          repoKey: buildRepoConcurrencyKey("Owner", "Other"),
          investigationId: "inv_C",
        })
      ).acquired,
    ).toBe(true);
  });

  test("stale slots from a crashed worker are evicted by TTL, preventing deadlock", async () => {
    const clock = { now: 0 };
    const { gate } = buildGate(clock, { tenantLimit: 1, repoLimit: 1, slotTtlSeconds: 10 });
    const slot = (id: string) => ({
      tenantKey: "tenant-gh-1",
      repoKey: "o/r",
      investigationId: id,
    });

    expect((await gate.acquireInvestigationConcurrency(slot("inv_A"))).acquired).toBe(true);
    // Crashed worker: inv_A is never released. Within the TTL it blocks...
    clock.now = 5_000;
    expect((await gate.acquireInvestigationConcurrency(slot("inv_B"))).acquired).toBe(false);
    // ...and past the TTL the stale slot is evicted inside acquire.
    clock.now = 11_000;
    expect((await gate.acquireInvestigationConcurrency(slot("inv_B"))).acquired).toBe(true);
  });

  test("the same investigation re-acquires its own slot idempotently", async () => {
    const clock = { now: 1_000 };
    const { gate } = buildGate(clock, { tenantLimit: 1, repoLimit: 1, slotTtlSeconds: 10 });
    const slot = {
      tenantKey: "tenant-gh-1",
      repoKey: "o/r",
      investigationId: "inv_A",
    };

    expect((await gate.acquireInvestigationConcurrency(slot)).acquired).toBe(true);
    // Retry of the same job (e.g. after a worker restart) must not deadlock
    // on its own held slot.
    expect((await gate.acquireInvestigationConcurrency(slot)).acquired).toBe(true);
  });

  test("renewal keeps a live investigation from being evicted as stale", async () => {
    const clock = { now: 1_000 };
    const { gate } = buildGate(clock, {
      tenantLimit: 1,
      repoLimit: 1,
      slotTtlSeconds: 10,
    });
    const slot = (id: string) => ({
      tenantKey: "tenant-gh-1",
      repoKey: "o/r",
      investigationId: id,
    });

    expect((await gate.acquireInvestigationConcurrency(slot("inv_A"))).acquired).toBe(
      true,
    );
    clock.now = 9_000;
    expect(await gate.renewInvestigationConcurrency(slot("inv_A"))).toBe(true);
    clock.now = 15_000;
    expect((await gate.acquireInvestigationConcurrency(slot("inv_B"))).acquired).toBe(
      false,
    );
  });

  test("renewal never recreates a lease after ownership is lost", async () => {
    const clock = { now: 1_000 };
    const { gate } = buildGate(clock);
    const slot = {
      tenantKey: "tenant-gh-1",
      repoKey: "o/r",
      investigationId: "inv_A",
    };

    expect(await gate.renewInvestigationConcurrency(slot)).toBe(false);
  });

  test("an expired old worker cannot renew or release a newer retry lease", async () => {
    const clock = { now: 1_000 };
    const { gate } = buildGate(clock, {
      tenantLimit: 1,
      repoLimit: 1,
      slotTtlSeconds: 10,
    });
    const oldSlot = {
      tenantKey: "tenant-gh-1",
      repoKey: "o/r",
      investigationId: "inv_A",
      leaseId: "lease-old",
    };
    const retrySlot = { ...oldSlot, leaseId: "lease-retry" };

    expect((await gate.acquireInvestigationConcurrency(oldSlot)).acquired).toBe(true);
    clock.now = 12_000;
    expect((await gate.acquireInvestigationConcurrency(retrySlot)).acquired).toBe(true);
    expect(await gate.renewInvestigationConcurrency(oldSlot)).toBe(false);
    await gate.releaseInvestigationConcurrency(oldSlot);

    expect(
      (
        await gate.acquireInvestigationConcurrency({
          ...oldSlot,
          investigationId: "inv_B",
          leaseId: "lease-other",
        })
      ).acquired,
    ).toBe(false);
  });

  test("owned lease members retain the investigation id for cleanup fencing", async () => {
    const clock = { now: 1_000 };
    const { gate, zsets } = buildGate(clock);
    const slot = {
      tenantKey: "tenant-gh-1",
      repoKey: "o/r",
      investigationId: "inv_A",
      leaseId: "lease-owner",
    };

    expect((await gate.acquireInvestigationConcurrency(slot)).acquired).toBe(true);
    const members = [...zsets.values()].flatMap((set) => [...set.keys()]);
    expect(members).toEqual(["inv_A|lease-owner", "inv_A|lease-owner"]);
  });

  test("limits of 0 disable the corresponding dimension", async () => {
    const clock = { now: 1_000 };
    const { gate } = buildGate(clock, { tenantLimit: 0, repoLimit: 0, slotTtlSeconds: 10 });

    for (let index = 0; index < 5; index += 1) {
      expect(
        (
          await gate.acquireInvestigationConcurrency({
            tenantKey: "tenant-gh-1",
            repoKey: "o/r",
            investigationId: `inv_${index}`,
          })
        ).acquired,
      ).toBe(true);
    }
  });
});

// --- Limit configuration ---------------------------------------------------------------

describe("limit configuration", () => {
  test("uses centralized hardcoded limits", () => {
    expect(getRateLimitConfig()).toEqual({
      max: INVESTIGATION_LIMITS.rateLimitMax,
      windowSeconds: INVESTIGATION_LIMITS.rateLimitWindowSeconds,
    });

    expect(getConcurrencyConfig()).toEqual({
      tenantLimit: INVESTIGATION_LIMITS.tenantConcurrencyLimit,
      repoLimit: INVESTIGATION_LIMITS.repoConcurrencyLimit,
      slotTtlSeconds: INVESTIGATION_LIMITS.concurrencySlotTtlSeconds,
    });
  });

  test("preserves production defaults and compatible environment overrides", () => {
    expect(getRateLimitConfig({})).toEqual({ max: 5, windowSeconds: 600 });
    expect(
      getRateLimitConfig({
        SHERLOCK_MAX_COMMANDS_PER_WINDOW: "12",
        SHERLOCK_COMMAND_WINDOW_MINUTES: "3",
      }),
    ).toEqual({ max: 12, windowSeconds: 180 });
    expect(
      getRateLimitConfig({
        SHERLOCK_MAX_COMMANDS_PER_WINDOW: "0",
        SHERLOCK_COMMAND_WINDOW_MINUTES: "invalid",
      }),
    ).toEqual({ max: 5, windowSeconds: 600 });
    expect(
      getRateLimitConfig({
        SHERLOCK_MAX_COMMANDS_PER_WINDOW: "2.9",
        SHERLOCK_COMMAND_WINDOW_MINUTES: "0.333",
      }),
    ).toEqual({ max: 2, windowSeconds: 20 });
  });
});

// --- Worker wrapper -------------------------------------------------------------------

const jobPayload: InvestigationJobPayload = {
  investigationId: "inv_WRAP123456",
  tenantId: "tenant-gh-2",
  installationId: 2,
  repositoryOwner: "Hiimbex",
  repositoryName: "Testing-Things",
  repositoryUrl: "https://github.com/hiimbex/testing-things",
  defaultBranch: "main",
  issueNumber: 1,
  issueTitle: "Example bug",
  issueBody: "Something broke",
  issueUrl: "https://github.com/hiimbex/testing-things/issues/1",
  triggeringCommentId: 4242,
  triggerComment: "/sherlock investigate",
  triggeredBy: "hiimbex",
  sourceRef: "main",
  deliveryId: "delivery-1",
};

function buildWorkerDeps(
  runPipeline?: WorkerDeps["runPipeline"],
): WorkerDeps {
  return {
    runPipeline:
      runPipeline ??
      (async (payload) =>
        ({
          investigationId: payload.investigationId ?? "inv_WRAP123456",
          outcome: "not_reproduced",
          summary: {
            investigationId: payload.investigationId ?? "inv_WRAP123456",
            outcome: "not_reproduced",
          },
          githubComment: "done",
        }) as InvestigationPipelineResult),
    getInstallationToken: async () => null,
    postIssueComment: async () => {},
    delivery: {
      store: createInMemoryDeliveryStateStore(),
      enqueue: async () => {},
      createGitHubClient: () => {
        throw new Error("The delivery GitHub client should not be used in this test.");
      },
      findTerminalComment: async () => false,
    },
    log: noLog,
  };
}

type GateCall = {
  action: "acquire" | "renew" | "release";
  investigationId: string;
};

function buildFakeGate(
  acquireResult: { acquired: boolean },
  renewResult = true,
) {
  const calls: GateCall[] = [];

  return {
    calls,
    gate: {
      acquireInvestigationConcurrency: async (slot: {
        tenantKey: string;
        repoKey: string;
        investigationId: string;
      }) => {
        calls.push({ action: "acquire", investigationId: slot.investigationId });

        if (acquireResult.acquired) {
          return { acquired: true as const, tenantActive: 1, repoActive: 1 };
        }

        return {
          acquired: false as const,
          blockedBy: "tenant" as const,
          limit: 2,
          tenantActive: 2,
          repoActive: 1,
        };
      },
      renewInvestigationConcurrency: async (slot: { investigationId: string }) => {
        calls.push({ action: "renew", investigationId: slot.investigationId });
        return renewResult;
      },
      releaseInvestigationConcurrency: async (slot: { investigationId: string }) => {
        calls.push({ action: "release", investigationId: slot.investigationId });
      },
    },
  };
}

describe("processInvestigationJobWithConcurrency", () => {
  const job = { data: jobPayload, attemptsMade: 0, opts: { attempts: 3 } };

  test("acquires before the pipeline and releases after success", async () => {
    const { gate, calls } = buildFakeGate({ acquired: true });

    const result = await processInvestigationJobWithConcurrency(
      job,
      buildWorkerDeps(),
      { gate, delayJob: async () => {} },
    );

    expect(result.outcome).toBe("not_reproduced");
    expect(calls).toEqual([
      { action: "acquire", investigationId: "inv_WRAP123456" },
      { action: "release", investigationId: "inv_WRAP123456" },
    ]);
  });

  test("releases the slot when the investigation throws", async () => {
    const { gate, calls } = buildFakeGate({ acquired: true });
    const deps = buildWorkerDeps(async () => {
      throw new Error("pipeline exploded");
    });

    await expect(
      processInvestigationJobWithConcurrency(job, deps, {
        gate,
        delayJob: async () => {},
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(calls.filter((call) => call.action === "release")).toHaveLength(1);
  });

  test("renews the lease while a long-running investigation is active", async () => {
    const { gate, calls } = buildFakeGate({ acquired: true });
    const deps = buildWorkerDeps(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                investigationId: "inv_WRAP123456",
                outcome: "not_reproduced",
                summary: {
                  investigationId: "inv_WRAP123456",
                  outcome: "not_reproduced",
                },
                githubComment: "done",
              } as InvestigationPipelineResult),
            25,
          );
        }),
    );

    await processInvestigationJobWithConcurrency(job, deps, {
      gate,
      delayJob: async () => {},
      heartbeatIntervalMs: 5,
    });

    expect(calls.some((call) => call.action === "renew")).toBe(true);
    expect(calls.at(-1)?.action).toBe("release");
  });

  test("lost lease ownership aborts the pipeline before it can complete", async () => {
    const { gate, calls } = buildFakeGate({ acquired: true }, false);
    let completed = false;
    const deps = buildWorkerDeps(async (_payload, options) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      options.signal?.throwIfAborted();
      completed = true;
      return {
        investigationId: "inv_WRAP123456",
        outcome: "not_reproduced",
        summary: {
          investigationId: "inv_WRAP123456",
          outcome: "not_reproduced",
        },
        githubComment: "done",
      } as InvestigationPipelineResult;
    });

    await expect(
      processInvestigationJobWithConcurrency(job, deps, {
        gate,
        delayJob: async () => {},
        heartbeatIntervalMs: 5,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(completed).toBe(false);
    expect(calls.some((call) => call.action === "renew")).toBe(true);
    expect(calls.at(-1)?.action).toBe("release");
  });

  test("a denied slot delays the job through the queue instead of dropping it", async () => {
    const { gate, calls } = buildFakeGate({ acquired: false });
    const delays: number[] = [];
    let pipelineRuns = 0;
    const deps = buildWorkerDeps(async () => {
      pipelineRuns += 1;
      throw new Error("must not run");
    });

    await expect(
      processInvestigationJobWithConcurrency(job, deps, {
        gate,
        delayJob: async (delayMs) => {
          delays.push(delayMs);
        },
        retryDelayMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(pipelineRuns).toBe(0);
    expect(delays).toEqual([5_000]);
    // Never released a slot it did not acquire.
    expect(calls.filter((call) => call.action === "release")).toHaveLength(0);
  });

  test("with hooks=null behavior is a plain passthrough", async () => {
    const result = await processInvestigationJobWithConcurrency(
      job,
      buildWorkerDeps(),
      null,
    );

    expect(result.investigationId).toBe("inv_WRAP123456");
  });
});
