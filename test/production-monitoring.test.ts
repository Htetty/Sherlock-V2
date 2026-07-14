import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runOpsCheckCli } from "../backend/ops-check.js";
import {
  ARTIFACT_CLEANUP_STATUS_KEY_PREFIX,
  WORKER_HEARTBEAT_KEY_PREFIX,
  cleanupScanOperationalRecord,
  createWorkerHeartbeat,
  getProductionMonitoringConfig,
  readArtifactCleanupStatus,
  readFilesystemUsage,
  readQueueOperationalSummary,
  readWorkerHeartbeat,
  readWorkerHeartbeatSummary,
  writeArtifactCleanupStatus,
  type OperationalRedis,
} from "../backend/services/production-monitoring.js";
import {
  formatProductionOpsReport,
  runProductionOpsCheck,
  type ProductionOpsAdapters,
} from "../backend/services/production-ops.js";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

class FakeRedis implements OperationalRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async ping() {
    return "PONG";
  }

  async set(key: string, value: string, _mode: "PX", ttlMs: number) {
    this.values.set(key, value);
    this.ttls.set(key, ttlMs);
    return "OK";
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async eval(
    _script: string,
    _numKeys: number,
    key: string | number,
    expected: string | number,
  ) {
    const safeKey = String(key);
    if (this.values.get(safeKey) === String(expected)) {
      this.values.delete(safeKey);
      this.ttls.delete(safeKey);
      return 1;
    }
    return 0;
  }

  async scan(
    _cursor: string,
    _match: "MATCH",
    pattern: string,
    _count: "COUNT",
    _countValue: number,
  ): Promise<[string, string[]]> {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    return ["0", [...this.values.keys()].filter((key) => key.startsWith(prefix))];
  }

  async mget(...keys: string[]) {
    return keys.map((key) => this.values.get(key) ?? null);
  }
}

function baseAdapters(
  overrides: Partial<ProductionOpsAdapters> = {},
): ProductionOpsAdapters {
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
      completed: 0,
      failed: 0,
      oldestWaitingAgeMs: null,
      oldestDelayedAgeMs: null,
    }),
    filesystemUsage: async () => [
      {
        name: "artifacts",
        optional: false,
        available: true,
        usedPercent: 40,
      },
    ],
    cleanupStatus: async () => ({
      records: 1,
      latest: {
        version: 1,
        workerId: "worker-1",
        ranAt: new Date(NOW - 60_000).toISOString(),
        kind: "scan",
        scanned: 10,
        deleted: 2,
        retained: 8,
        protected: 1,
        failures: 0,
        bounded: true,
        oldestRetainedFailedAgeMs: 3_600_000,
      },
      latestAgeMs: 60_000,
      workersWithFailures: 0,
      truncated: false,
    }),
    ...overrides,
  };
}

describe("production monitoring configuration", () => {
  test("uses production-safe defaults", () => {
    const config = getProductionMonitoringConfig({});
    expect(config.heartbeatIntervalMs).toBeLessThan(config.heartbeatMaxAgeMs);
    expect(config.heartbeatMaxAgeMs).toBeLessThan(config.heartbeatTtlMs);
    expect(config.diskWarningPercent).toBeLessThan(config.diskCriticalPercent);
  });

  test("rejects heartbeat settings that can report a dead worker as fresh", () => {
    expect(() =>
      getProductionMonitoringConfig({
        SHERLOCK_WORKER_HEARTBEAT_INTERVAL_SECONDS: "20",
        SHERLOCK_WORKER_HEARTBEAT_MAX_AGE_SECONDS: "20",
      }),
    ).toThrow(/INTERVAL_SECONDS/);
  });

  test("rejects inverted disk thresholds", () => {
    expect(() =>
      getProductionMonitoringConfig({
        SHERLOCK_DISK_WARNING_PERCENT: "95",
        SHERLOCK_DISK_CRITICAL_PERCENT: "90",
      }),
    ).toThrow(/DISK_WARNING_PERCENT/);
  });
});

describe("durable worker heartbeat", () => {
  test("reports a current worker heartbeat as fresh", async () => {
    const redis = new FakeRedis();
    const heartbeat = createWorkerHeartbeat({
      redis,
      workerId: "worker-a",
      intervalMs: 1_000,
      ttlMs: 60_000,
      now: () => NOW,
    });
    await heartbeat.beat();

    await expect(
      readWorkerHeartbeatSummary(redis, {
        now: () => NOW + 5_000,
        maxAgeMs: 30_000,
      }),
    ).resolves.toMatchObject({ total: 1, fresh: 1, stale: 0 });
  });

  test("reports an old heartbeat as stale", async () => {
    const redis = new FakeRedis();
    const heartbeat = createWorkerHeartbeat({
      redis,
      workerId: "worker-a",
      intervalMs: 1_000,
      ttlMs: 60_000,
      now: () => NOW,
    });
    await heartbeat.beat();

    const summary = await readWorkerHeartbeatSummary(redis, {
      now: () => NOW + 31_000,
      maxAgeMs: 30_000,
    });
    expect(summary).toMatchObject({ total: 1, fresh: 0, stale: 1 });
  });

  test("fails an exact health lookup when the heartbeat is missing", async () => {
    await expect(
      readWorkerHeartbeat(new FakeRedis(), "worker-a", {
        now: () => NOW,
        maxAgeMs: 30_000,
      }),
    ).resolves.toEqual({ healthy: false, ageMs: null });
  });

  test("summarizes multiple workers without one overwriting another", async () => {
    const redis = new FakeRedis();
    for (const workerId of ["worker-a", "worker-b"]) {
      const heartbeat = createWorkerHeartbeat({
        redis,
        workerId,
        intervalMs: 1_000,
        ttlMs: 60_000,
        now: () => NOW,
      });
      await heartbeat.beat();
    }
    const summary = await readWorkerHeartbeatSummary(redis, {
      now: () => NOW + 1_000,
      maxAgeMs: 30_000,
    });
    expect(summary).toMatchObject({ total: 2, fresh: 2, stale: 0 });
    expect(redis.values.size).toBe(2);
  });

  test("writes heartbeats with the configured Redis TTL", async () => {
    const redis = new FakeRedis();
    const heartbeat = createWorkerHeartbeat({
      redis,
      workerId: "worker-a",
      intervalMs: 1_000,
      ttlMs: 12_345,
      now: () => NOW,
    });
    await heartbeat.beat();
    expect(redis.ttls.get(`${WORKER_HEARTBEAT_KEY_PREFIX}worker-a`)).toBe(12_345);
  });

  test("coalesces ticks while a Redis heartbeat write is pending", async () => {
    const redis = new FakeRedis();
    let release!: (value: string) => void;
    const delayed = new Promise<string>((resolve) => { release = resolve; });
    const set = vi.spyOn(redis, "set").mockReturnValue(delayed);
    const heartbeat = createWorkerHeartbeat({
      redis,
      workerId: "worker-a",
      intervalMs: 1_000,
      ttlMs: 60_000,
      now: () => NOW,
    });

    const first = heartbeat.beat();
    const second = heartbeat.beat();
    expect(set).toHaveBeenCalledTimes(1);
    release("OK");
    await Promise.all([first, second]);
  });

  test("graceful shutdown removes its own heartbeat", async () => {
    const redis = new FakeRedis();
    const heartbeat = createWorkerHeartbeat({
      redis,
      workerId: "worker-a",
      intervalMs: 1_000,
      ttlMs: 60_000,
      now: () => NOW,
    });
    await heartbeat.beat();
    await heartbeat.stop();
    expect(redis.values.has(`${WORKER_HEARTBEAT_KEY_PREFIX}worker-a`)).toBe(false);
  });

  test("an old process cannot delete a replacement process heartbeat", async () => {
    const redis = new FakeRedis();
    const oldProcess = createWorkerHeartbeat({
      redis,
      workerId: "worker-a",
      intervalMs: 1_000,
      ttlMs: 60_000,
      now: () => NOW,
    });
    const replacement = createWorkerHeartbeat({
      redis,
      workerId: "worker-a",
      intervalMs: 1_000,
      ttlMs: 60_000,
      now: () => NOW + 1_000,
    });
    await oldProcess.beat();
    await replacement.beat();
    const replacementValue = redis.values.get(
      `${WORKER_HEARTBEAT_KEY_PREFIX}worker-a`,
    );

    await oldProcess.stop();
    expect(redis.values.get(`${WORKER_HEARTBEAT_KEY_PREFIX}worker-a`)).toBe(
      replacementValue,
    );
  });
});

describe("payload-free queue summary", () => {
  test("reports the five operational counts and oldest ages", async () => {
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: 2,
        active: 1,
        delayed: 3,
        completed: 40,
        failed: 4,
      }),
    };
    const redis = {
      lrange: vi.fn().mockResolvedValue(["wait-1", "wait-2"]),
      zrange: vi.fn().mockResolvedValue([
        "delay-1", String((NOW - 10_000) * 0x1000),
        "delay-2", String((NOW + 10_000) * 0x1000),
        "delay-3", String((NOW + 20_000) * 0x1000),
      ]),
      hmget: vi.fn(async (key: string, field: string) => {
        expect(field).toBe("timestamp");
        const timestamps: Record<string, number> = {
          "bull:test:wait-1": NOW - 70_000,
          "bull:test:wait-2": NOW - 20_000,
          "bull:test:delay-1": NOW - 30_000,
          "bull:test:delay-2": NOW - 20_000,
          "bull:test:delay-3": NOW - 10_000,
        };
        return [String(timestamps[key])];
      }),
    };
    const summary = await readQueueOperationalSummary(
      queue as never,
      redis as never,
      () => NOW,
    );
    expect(summary).toEqual({
      waiting: 2,
      active: 1,
      delayed: 3,
      completed: 40,
      failed: 4,
      oldestWaitingAgeMs: 70_000,
      oldestDelayedCreationAgeMs: 30_000,
      oldestDelayedOverdueAgeMs: 10_000,
      waitingAgeComplete: true,
      delayedCreationAgeComplete: true,
      delayedDueAgeComplete: true,
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  test("empty queues determine ages without reading any job hash", async () => {
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
      }),
      getJobs: vi.fn(),
      getJob: vi.fn(),
    };
    const redis = {
      lrange: vi.fn(),
      zrange: vi.fn(),
      hmget: vi.fn(),
      hgetall: vi.fn(),
    };
    const summary = await readQueueOperationalSummary(
      queue as never,
      redis as never,
      () => NOW,
    );
    expect(summary).toMatchObject({
      oldestWaitingAgeMs: null,
      oldestDelayedCreationAgeMs: null,
      oldestDelayedOverdueAgeMs: null,
      waitingAgeComplete: true,
      delayedCreationAgeComplete: true,
      delayedDueAgeComplete: true,
    });
    expect(redis.hmget).not.toHaveBeenCalled();
    expect(queue.getJobs).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  test("delayed creation age is distinct from scheduled overdue age", async () => {
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: 0,
        active: 0,
        delayed: 1,
        completed: 0,
        failed: 0,
      }),
    };
    const redis = {
      lrange: vi.fn(),
      zrange: vi
        .fn()
        .mockResolvedValue(["delay-1", String((NOW - 5_000) * 0x1000)]),
      hmget: vi.fn().mockResolvedValue([String(NOW - 600_000)]),
    };
    const summary = await readQueueOperationalSummary(
      queue as never,
      redis as never,
      () => NOW,
    );
    expect(summary.oldestDelayedCreationAgeMs).toBe(600_000);
    expect(summary.oldestDelayedOverdueAgeMs).toBe(5_000);
  });

  test("inspection is capped and reports creation ages as unproven", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `delay-${index}`);
    const entries = ids.flatMap((id, index) => [
      id,
      String((NOW + index * 1_000) * 0x1000),
    ]);
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: 101,
        active: 0,
        delayed: 101,
        completed: 0,
        failed: 0,
      }),
    };
    const redis = {
      lrange: vi.fn(),
      zrange: vi.fn().mockResolvedValue(entries),
      hmget: vi.fn().mockResolvedValue([String(NOW)]),
    };
    const summary = await readQueueOperationalSummary(
      queue as never,
      redis as never,
      () => NOW,
    );
    expect(redis.lrange).not.toHaveBeenCalled();
    expect(redis.zrange).toHaveBeenCalledWith(
      "bull:test:delayed",
      0,
      99,
      "WITHSCORES",
    );
    expect(redis.hmget).toHaveBeenCalledTimes(100);
    expect(summary.waitingAgeComplete).toBe(false);
    expect(summary.delayedCreationAgeComplete).toBe(false);
    expect(summary.oldestWaitingAgeMs).toBeNull();
    expect(summary.oldestDelayedCreationAgeMs).toBeNull();
  });

  test("missing or malformed exact timestamps make age unknown", async () => {
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: 1,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
      }),
    };
    const redis = {
      lrange: vi.fn().mockResolvedValue(["wait-1"]),
      zrange: vi.fn(),
      hmget: vi.fn().mockResolvedValue([null]),
    };
    const summary = await readQueueOperationalSummary(
      queue as never,
      redis as never,
      () => NOW,
    );
    expect(summary.waitingAgeComplete).toBe(false);
    expect(summary.oldestWaitingAgeMs).toBeNull();
  });

  test("old waiting work is a warning, not a false healthy result", async () => {
    const config = getProductionMonitoringConfig({
      SHERLOCK_QUEUE_MAX_WAIT_AGE_SECONDS: "60",
    });
    const report = await runProductionOpsCheck(
      config,
      baseAdapters({
        queueSummary: async () => ({
          waiting: 1,
          active: 0,
          delayed: 0,
          completed: 0,
          failed: 0,
          oldestWaitingAgeMs: 61_000,
          oldestDelayedAgeMs: null,
        }),
      }),
    );
    expect(report.checks.find((check) => check.name === "queue")?.status).toBe(
      "warn",
    );
  });

  test("large completed history alone does not make the queue unhealthy", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        queueSummary: async () => ({
          waiting: 0,
          active: 0,
          delayed: 0,
          completed: 999_999,
          failed: 20,
          oldestWaitingAgeMs: null,
          oldestDelayedAgeMs: null,
        }),
      }),
    );
    expect(report.checks.find((check) => check.name === "queue")?.status).toBe(
      "pass",
    );
  });
});

describe("filesystem capacity checks", () => {
  test("calculates usage with an injected statfs adapter", async () => {
    const usage = await readFilesystemUsage(
      [{ name: "artifacts", path: "/not-read", optional: false }],
      {
        statfs: async () => ({ blocks: 100, bavail: 25, bsize: 4_096 }),
      },
    );
    expect(usage[0]).toMatchObject({ available: true, usedPercent: 75 });
  });

  test("warning disk pressure produces an overall warning", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        filesystemUsage: async () => [{
          name: "artifacts",
          optional: false,
          available: true,
          usedPercent: 85,
        }],
      }),
    );
    expect(report.overall).toBe("warn");
    expect(report.exitCode).toBe(0);
  });

  test("critical disk pressure fails with a nonzero exit", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        filesystemUsage: async () => [{
          name: "artifacts",
          optional: false,
          available: true,
          usedPercent: 95,
        }],
      }),
    );
    expect(report.overall).toBe("fail");
    expect(report.exitCode).toBe(1);
  });

  test("optional unavailable Docker storage is reported truthfully as a warning", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        filesystemUsage: async () => [{
          name: "docker-storage",
          optional: true,
          available: false,
          usedPercent: null,
        }],
      }),
    );
    expect(report.checks[4]).toMatchObject({
      name: "filesystem:docker-storage",
      status: "warn",
    });
  });

  test("a required unavailable filesystem is a failure", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        filesystemUsage: async () => [{
          name: "artifacts",
          optional: false,
          available: false,
          usedPercent: null,
        }],
      }),
    );
    expect(report.exitCode).toBe(1);
  });
});

describe("cleanup visibility", () => {
  test("persists and reads only bounded cleanup counters", async () => {
    const redis = new FakeRedis();
    const record = cleanupScanOperationalRecord(
      "worker-a",
      {
        examined: 12,
        scanned: 10,
        deleted: 2,
        retained: 8,
        protected: 3,
        errors: 1,
        oldestRetainedFailedAgeMs: 600_000,
        bounded: true,
      },
      () => NOW,
    );
    await writeArtifactCleanupStatus(redis, record, 7_000);
    const summary = await readArtifactCleanupStatus(redis, () => NOW + 1_000);

    expect(summary.latest).toMatchObject({
      scanned: 10,
      deleted: 2,
      retained: 8,
      protected: 3,
      failures: 1,
      oldestRetainedFailedAgeMs: 600_000,
    });
    expect(redis.ttls.get(`${ARTIFACT_CLEANUP_STATUS_KEY_PREFIX}worker-a`)).toBe(
      7_000,
    );
  });

  test("cleanup failures are visible as a warning", async () => {
    const adapters = baseAdapters();
    const baseline = await adapters.cleanupStatus();
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        cleanupStatus: async () => ({
          ...baseline,
          workersWithFailures: 1,
        }),
      }),
    );
    expect(
      report.checks.find((check) => check.name === "artifact-cleanup")?.status,
    ).toBe("warn");
  });

  test("missing cleanup history is visible without failing service health", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        cleanupStatus: async () => ({
          records: 0,
          latest: null,
          latestAgeMs: null,
          workersWithFailures: 0,
          truncated: false,
        }),
      }),
    );
    expect(report.overall).toBe("warn");
    expect(report.exitCode).toBe(0);
  });
});

describe("operator command safety and failure semantics", () => {
  test("fresh heartbeat, normal queue, disk, and cleanup state pass", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters(),
    );
    expect(report.overall).toBe("pass");
    expect(report.exitCode).toBe(0);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  test("stale worker state with no fresh heartbeat is a failure", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        workerHeartbeats: async () => ({
          total: 1,
          fresh: 0,
          stale: 1,
          oldestAgeMs: null,
          truncated: false,
        }),
      }),
    );
    expect(
      report.checks.find((check) => check.name === "worker-heartbeat")?.status,
    ).toBe("fail");
    expect(report.exitCode).toBe(1);
  });

  test("missing worker state is a failure", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        workerHeartbeats: async () => ({
          total: 0,
          fresh: 0,
          stale: 0,
          oldestAgeMs: null,
          truncated: false,
        }),
      }),
    );
    expect(report.overall).toBe("fail");
    expect(report.exitCode).toBe(1);
  });

  test("API unavailability produces FAIL and a nonzero result", async () => {
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({ apiHealth: async () => { throw new Error("secret URL"); } }),
    );
    expect(report.exitCode).toBe(1);
    expect(formatProductionOpsReport(report)).not.toContain("secret URL");
  });

  test("Redis unavailability fails Redis, heartbeat, and queue checks safely", async () => {
    const unavailable = async () => {
      throw new Error("redis://user:password@private-host:6379");
    };
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        redisPing: unavailable,
        workerHeartbeats: unavailable,
        queueSummary: unavailable,
      }),
    );
    const output = formatProductionOpsReport(report);
    expect(report.exitCode).toBe(1);
    expect(output).not.toContain("password");
    expect(output).not.toContain("private-host");
  });

  test("queue payload secrets never enter operator output", async () => {
    const secret = "ghp_private-token-from-job-payload";
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: 1,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
      }),
      getJobs: vi.fn(() => { throw new Error(`forbidden ${secret}`); }),
      getJob: vi.fn(() => { throw new Error(`forbidden ${secret}`); }),
    };
    const redis = {
      lrange: vi.fn().mockResolvedValue(["wait-1"]),
      zrange: vi.fn(),
      hmget: vi.fn().mockResolvedValue([String(NOW)]),
      hgetall: vi.fn(() => { throw new Error(`forbidden ${secret}`); }),
    };
    const summary = await readQueueOperationalSummary(
      queue as never,
      redis as never,
      () => NOW,
    );
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({ queueSummary: async () => summary }),
    );
    expect(formatProductionOpsReport(report)).not.toContain(secret);
    expect(queue.getJobs).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  test("private artifact paths and contents from adapter errors are not printed", async () => {
    const privateValue = "/artifacts/inv_private/customer-source.ts: secret";
    const report = await runProductionOpsCheck(
      getProductionMonitoringConfig({}),
      baseAdapters({
        filesystemUsage: async () => { throw new Error(privateValue); },
        cleanupStatus: async () => { throw new Error(privateValue); },
      }),
    );
    expect(formatProductionOpsReport(report)).not.toContain(privateValue);
  });

  test("--test mode is deterministic and needs no live production dependency", async () => {
    const output: string[] = [];
    await expect(
      runOpsCheckCli({ args: ["--test"], env: {}, write: (line) => output.push(line) }),
    ).resolves.toBe(0);
    expect(output.join("\n")).toContain("OVERALL PASS");
  });
});

describe("production Compose monitoring controls", () => {
  test("all long-running services use bounded json-file logging", () => {
    const compose = readFileSync(path.resolve("docker-compose.prod.yml"), "utf8");
    expect(compose).toContain("x-logging: &bounded-logging");
    expect(compose).toContain("driver: json-file");
    expect(compose).toContain('max-size: "${SHERLOCK_DOCKER_LOG_MAX_SIZE:-10m}"');
    expect(compose).toContain('max-file: "${SHERLOCK_DOCKER_LOG_MAX_FILES:-3}"');
    expect(compose.match(/logging: \*bounded-logging/g)).toHaveLength(3);
  });

  test("worker health invokes the durable-heartbeat checker", () => {
    const compose = readFileSync(path.resolve("docker-compose.prod.yml"), "utf8");
    expect(compose).toContain(
      'test: ["CMD", "node", "./lib/backend/worker-health.js"]',
    );
  });
});
