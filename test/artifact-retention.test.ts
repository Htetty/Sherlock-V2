import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Queue } from "bullmq";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ARTIFACT_RETENTION_DEFAULTS,
  createArtifactCleanupService,
  createNoopArtifactCleanupProtection,
  createRedisArtifactCleanupProtection,
  getArtifactRetentionConfig,
  type ArtifactCleanupProtection,
  type ArtifactRetentionConfig,
} from "../backend/services/artifact-retention.js";
import {
  createFileDeliveryStateStore,
  DELIVERY_STATE_FILE,
  type DeliveryState,
} from "../backend/services/delivery.js";
import type { InvestigationOutcome } from "../backend/services/report.js";

const roots: string[] = [];
let idCounter = 0;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(label = "artifacts") {
  const root = await mkdtemp(path.join(tmpdir(), `sherlock-${label}-`));
  roots.push(root);
  return root;
}

function nextInvestigationId() {
  idCounter += 1;
  return `inv_0RETENTION${String(idCounter).padStart(3, "0")}`;
}

function terminalState(input: {
  investigationId: string;
  outcome?: InvestigationOutcome;
  deliveredAt?: string;
}): DeliveryState {
  const outcome = input.outcome ?? "verified_fix";
  const verified = outcome === "verified_fix";
  const createdAt = new Date(0).toISOString();
  return {
    version: 2,
    investigationId: input.investigationId,
    tenantId: "tenant-gh-2",
    installationId: 2,
    repoOwner: "acme",
    repoName: "app",
    issueNumber: 42,
    executionOutcome: outcome,
    fixVerified: verified,
    fixAttemptId: verified ? "fix_0RETENTION0001" : null,
    pullRequest: verified
      ? {
          status: "created",
          branchPushed: true,
          branch: `sherlock/fix-42-${input.investigationId.toLowerCase()}`,
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          reason: null,
        }
      : {
          status: "not_applicable",
          branchPushed: false,
          branch: null,
          number: null,
          url: null,
          reason: null,
        },
    retryPlan: null,
    terminalPayload: {
      path: `protected-delivery/${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      sizeBytes: 10,
    },
    terminalComment: {
      status: "posted",
      postedAt: input.deliveredAt ?? createdAt,
      reason: null,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

function config(
  overrides: Partial<ArtifactRetentionConfig> = {},
): ArtifactRetentionConfig {
  return {
    ...ARTIFACT_RETENTION_DEFAULTS,
    cleanupIntervalMs: 0,
    ...overrides,
  };
}

function fakeProtection(input: {
  protectedIds?: string[];
  activeLeaseIds?: string[];
} = {}): ArtifactCleanupProtection {
  const protectedIds = new Set(input.protectedIds ?? []);
  const activeLeaseIds = new Set(input.activeLeaseIds ?? []);
  return {
    async snapshot() {
      return {
        async isProtected(state) {
          return (
            protectedIds.has(state.investigationId) ||
            activeLeaseIds.has(state.investigationId)
          );
        },
      };
    },
  };
}

async function persistState(root: string, state: DeliveryState) {
  const store = createFileDeliveryStateStore(root);
  await store.save(state);
  await writeFile(
    path.join(root, state.investigationId, "private-evidence.txt"),
    "private repository source and prompts\n",
    "utf8",
  );
  return store;
}

async function exists(target: string) {
  return access(target).then(
    () => true,
    () => false,
  );
}

describe("artifact retention configuration", () => {
  test("defaults successful delivery to immediate cleanup and failures to seven days", () => {
    const result = getArtifactRetentionConfig({});
    expect(result.successfulRetentionMs).toBe(0);
    expect(result.failedRetentionMs).toBe(7 * 24 * 60 * 60_000);
    expect(result.cleanupOnStartup).toBe(true);
  });

  test("uses clearly scoped environment overrides", () => {
    const result = getArtifactRetentionConfig({
      SHERLOCK_SUCCESSFUL_ARTIFACT_RETENTION_HOURS: "12",
      SHERLOCK_FAILED_ARTIFACT_RETENTION_HOURS: "48",
      SHERLOCK_ARTIFACT_CLEANUP_INTERVAL_MINUTES: "15",
      SHERLOCK_ARTIFACT_CLEANUP_ON_STARTUP: "false",
      SHERLOCK_ARTIFACT_CLEANUP_MAX_DIRECTORIES: "25",
    });
    expect(result).toEqual({
      successfulRetentionMs: 12 * 60 * 60_000,
      failedRetentionMs: 48 * 60 * 60_000,
      cleanupIntervalMs: 15 * 60_000,
      cleanupOnStartup: false,
      maxDirectoriesPerScan: 25,
    });
  });
});

describe("terminal delivery gates", () => {
  test("fully delivered verified fixes are cleaned immediately", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const store = await persistState(root, terminalState({ investigationId }));
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config(),
      now: () => 1,
      log: () => {},
    });

    await expect(cleanup.cleanupInvestigation(investigationId)).resolves.toEqual({
      investigationId,
      status: "deleted",
    });
    expect(await exists(path.join(root, investigationId))).toBe(false);
  });

  test("verified fix with PR delivery pending keeps delivery-state.json", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const state = terminalState({ investigationId });
    state.pullRequest.status = "pending";
    state.pullRequest.branchPushed = false;
    state.pullRequest.number = null;
    state.pullRequest.url = null;
    state.terminalComment = { status: "pending", postedAt: null, reason: null };
    const store = await persistState(root, state);
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config(),
      now: () => 10 * 24 * 60 * 60_000,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "not_terminal",
    );
    expect(
      await exists(path.join(root, investigationId, DELIVERY_STATE_FILE)),
    ).toBe(true);
  });

  test("created PR with terminal comment pending is retained", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const state = terminalState({ investigationId });
    state.terminalComment = { status: "pending", postedAt: null, reason: null };
    const store = await persistState(root, state);
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config(),
      now: () => Number.MAX_SAFE_INTEGER,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "not_terminal",
    );
    expect(await exists(path.join(root, investigationId))).toBe(true);
  });

  test("terminal failed fix delivery uses the failed-artifact TTL", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const state = terminalState({ investigationId });
    state.pullRequest.status = "failed";
    state.pullRequest.branchPushed = false;
    state.pullRequest.number = null;
    state.pullRequest.url = null;
    state.pullRequest.reason = "delivery failed";
    const store = await persistState(root, state);
    const before = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config({ failedRetentionMs: 1_000 }),
      now: () => 999,
      log: () => {},
    });

    expect((await before.cleanupInvestigation(investigationId)).status).toBe(
      "not_expired",
    );
    const after = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config({ failedRetentionMs: 1_000 }),
      now: () => 1_000,
      log: () => {},
    });
    expect((await after.cleanupInvestigation(investigationId)).status).toBe(
      "deleted",
    );
  });

  test("a permanently failed terminal comment uses the failed-artifact TTL", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const state = terminalState({ investigationId });
    state.terminalComment = { status: "failed", postedAt: null, reason: null };
    const store = await persistState(root, state);
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config({ failedRetentionMs: 1_000 }),
      now: () => 1_000,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "deleted",
    );
  });
});

describe("queue and concurrency protection", () => {
  test("an in-progress delivery lock prevents concurrent artifact deletion", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const store = await persistState(root, terminalState({ investigationId }));
    let releaseDelivery!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const delivery = store.withLock(investigationId, async () => {
      markLocked();
      await release;
    });
    await locked;

    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config(),
      now: () => 1,
      log: () => {},
    });
    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "error",
    );
    expect(await exists(path.join(root, investigationId))).toBe(true);

    releaseDelivery();
    await delivery;
  });

  test("waiting delivery retry jobs protect fully delivered artifact directories", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const store = await persistState(root, terminalState({ investigationId }));
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: fakeProtection({ protectedIds: [investigationId] }),
      config: config(),
      now: () => 1,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "protected",
    );
    expect(await exists(path.join(root, investigationId))).toBe(true);
  });

  test("active concurrency leases protect artifacts even after terminal delivery", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const store = await persistState(root, terminalState({ investigationId }));
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: fakeProtection({ activeLeaseIds: [investigationId] }),
      config: config(),
      now: () => 1,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "protected",
    );
  });

  test("delayed and waiting jobs are recognized by the production queue probe", async () => {
    const delayedId = nextInvestigationId();
    const waitingId = nextInvestigationId();
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn(async () => ({ delayed: 1, waiting: 1 })),
      getJobs: vi.fn(async () => [
        { data: { investigationId: delayedId } },
        { data: { investigationId: waitingId } },
      ]),
      getJob: vi.fn(async () => undefined),
    } as unknown as Pick<Queue, "getJobCounts" | "getJobs" | "getJob">;
    const protection = createRedisArtifactCleanupProtection({
      queue,
      redis: {
        eval: vi.fn(async (script: string) => (script.includes("EXISTS") ? 1 : 0)),
      },
    });
    const snapshot = await protection.snapshot();

    expect(
      await snapshot.isProtected(terminalState({ investigationId: delayedId })),
    ).toBe(true);
    expect(
      await snapshot.isProtected(terminalState({ investigationId: waitingId })),
    ).toBe(true);
  });

  test("an exact waiting delivery job and a live Redis lease close snapshot races", async () => {
    const deliveryId = nextInvestigationId();
    const leaseId = nextInvestigationId();
    const getJob = vi.fn(async (jobId: string) =>
      jobId.endsWith(deliveryId)
        ? { getState: async () => "waiting" as const }
        : undefined,
    );
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn(async () => ({})),
      getJobs: vi.fn(async () => []),
      getJob,
    } as unknown as Pick<Queue, "getJobCounts" | "getJobs" | "getJob">;
    const redis = {
      eval: vi.fn(async (script: string, _keys: number, ...args: unknown[]) => {
        if (script.includes("EXISTS")) {
          return args.some((value) =>
            String(value).endsWith(`deliver_${deliveryId}`),
          )
            ? 1
            : 0;
        }
        return args.includes(leaseId) ? 1 : 0;
      }),
    };
    const protection = createRedisArtifactCleanupProtection({
      queue,
      redis,
    });
    const snapshot = await protection.snapshot();

    expect(
      await snapshot.isProtected(terminalState({ investigationId: deliveryId })),
    ).toBe(true);
    expect(
      await snapshot.isProtected(terminalState({ investigationId: leaseId })),
    ).toBe(true);
  });

  test("large unrelated queue state inspects only current and legacy exact delivery ids", async () => {
    const evalRedis = vi.fn(async () => 0);
    const queue = {
      toKey: (value: string) => `bull:test:${value}`,
      getJobCounts: vi.fn(async () => ({ active: 11 })),
      getJobs: vi.fn(async () => []),
      getJob: vi.fn(async () => undefined),
    } as unknown as Pick<Queue, "getJobCounts" | "getJobs" | "getJob">;
    const protection = createRedisArtifactCleanupProtection({
      queue,
      redis: { eval: evalRedis },
    });

    const snapshot = await protection.snapshot();
    await expect(
      snapshot.isProtected(
        terminalState({ investigationId: nextInvestigationId() }),
      ),
    ).resolves.toBe(false);
    expect(queue.getJobs).not.toHaveBeenCalled();
    const deliveryProbe = String(evalRedis.mock.calls[0]?.[0]);
    expect(deliveryProbe).toContain("HMGET");
    expect(deliveryProbe).not.toContain("HGETALL");
    expect(deliveryProbe).not.toContain("LPOS");
    expect(evalRedis.mock.calls[0]?.[1]).toBe(2);
  });
});

describe("failed investigation retention", () => {
  test("failed investigation is retained before its delivery-anchored TTL", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const deliveredAt = new Date(1_000).toISOString();
    const store = await persistState(
      root,
      terminalState({ investigationId, outcome: "execution_failed", deliveredAt }),
    );
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config({ failedRetentionMs: 7 * 24 * 60 * 60_000 }),
      now: () => 1_000 + 6 * 24 * 60 * 60_000,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "not_expired",
    );
  });

  test("bounded scans report the oldest retained failed-artifact age", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const deliveredAtMs = 1_000;
    const nowMs = deliveredAtMs + 2 * 60 * 60_000;
    const store = await persistState(
      root,
      terminalState({
        investigationId,
        outcome: "execution_failed",
        deliveredAt: new Date(deliveredAtMs).toISOString(),
      }),
    );
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config({ failedRetentionMs: 7 * 24 * 60 * 60_000 }),
      now: () => nowMs,
      log: () => {},
    });

    await expect(cleanup.scanExpired()).resolves.toMatchObject({
      scanned: 1,
      deleted: 0,
      retained: 1,
      protected: 0,
      errors: 0,
      oldestRetainedFailedAgeMs: nowMs - deliveredAtMs,
      bounded: true,
    });
  });

  test("failed investigation is removed only after its delivered TTL", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const deliveredAt = new Date(1_000).toISOString();
    const store = await persistState(
      root,
      terminalState({ investigationId, outcome: "environment_failed", deliveredAt }),
    );
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config({ failedRetentionMs: 7 * 24 * 60 * 60_000 }),
      now: () => 1_001 + 7 * 24 * 60 * 60_000,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "deleted",
    );
  });

  test("an active investigation without durable terminal delivery is never deleted", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    await mkdir(path.join(root, investigationId), { recursive: true });
    await writeFile(path.join(root, investigationId, "running.log"), "active\n");
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: createFileDeliveryStateStore(root),
      protection: fakeProtection({ activeLeaseIds: [investigationId] }),
      config: config({ failedRetentionMs: 0 }),
      now: () => Number.MAX_SAFE_INTEGER,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "not_terminal",
    );
    expect(await exists(path.join(root, investigationId))).toBe(true);
  });
});

describe("filesystem and restart safety", () => {
  test("missing and duplicate cleanup are harmless", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const store = createFileDeliveryStateStore(root);
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config(),
      now: () => 1,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "missing",
    );
    await persistState(root, terminalState({ investigationId }));
    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "deleted",
    );
    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "missing",
    );
  });

  test("traversal identifiers and symlink directory escapes are rejected", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot("outside");
    const investigationId = nextInvestigationId();
    await writeFile(path.join(outside, "do-not-delete.txt"), "private\n");
    await symlink(outside, path.join(root, investigationId));
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: createFileDeliveryStateStore(root),
      protection: createNoopArtifactCleanupProtection(),
      config: config(),
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation("../memory")).status).toBe(
      "unsafe",
    );
    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "unsafe",
    );
    expect(await readFile(path.join(outside, "do-not-delete.txt"), "utf8")).toBe(
      "private\n",
    );
  });

  test("malformed investigation directory does not stop cleanup of another", async () => {
    const root = await temporaryRoot();
    const malformedId = nextInvestigationId();
    const eligibleId = nextInvestigationId();
    await mkdir(path.join(root, malformedId), { recursive: true });
    await writeFile(
      path.join(root, malformedId, DELIVERY_STATE_FILE),
      "{private malformed bytes",
      "utf8",
    );
    const store = await persistState(root, terminalState({ investigationId: eligibleId }));
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config({ maxDirectoriesPerScan: 20 }),
      now: () => 1,
      log: () => {},
    });

    const result = await cleanup.scanExpired();
    expect(result.deleted).toBe(1);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(await exists(path.join(root, malformedId))).toBe(true);
    expect(await exists(path.join(root, eligibleId))).toBe(false);
  });

  test("periodic scans examine at most the configured root-entry bound", async () => {
    const root = await temporaryRoot();
    const firstId = nextInvestigationId();
    const secondId = nextInvestigationId();
    const store = await persistState(root, terminalState({ investigationId: firstId }));
    await persistState(root, terminalState({ investigationId: secondId }));
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config({ maxDirectoriesPerScan: 1 }),
      now: () => 1,
      log: () => {},
    });

    const result = await cleanup.scanExpired();
    expect(result.examined).toBe(1);
    expect(result.bounded).toBe(false);
    expect(result.deleted).toBe(1);
    expect(
      Number(await exists(path.join(root, firstId))) +
        Number(await exists(path.join(root, secondId))),
    ).toBe(1);
  });

  test("cleanup failure is non-fatal and cleanup logs reveal no secrets or evidence", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const state = terminalState({ investigationId });
    const store = await persistState(root, state);
    const logs: string[] = [];
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config(),
      now: () => 1,
      removeDirectory: async () => {
        throw new Error(
          "token=github_pat_PRIVATE123 private repository source and prompts",
        );
      },
      log: (message) => logs.push(message),
    });

    await expect(cleanup.cleanupInvestigation(investigationId)).resolves.toEqual({
      investigationId,
      status: "error",
    });
    expect((await store.load(investigationId))?.executionOutcome).toBe(
      "verified_fix",
    );
    expect(logs.join("\n")).not.toContain("github_pat_PRIVATE123");
    expect(logs.join("\n")).not.toContain("private repository source");
  });

  test("cleanup never follows artifact symlinks into repository memory", async () => {
    const root = await temporaryRoot();
    const dataRoot = await temporaryRoot("data");
    const memoryDir = path.join(dataRoot, "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, "repository.json"), "remember me\n");
    const investigationId = nextInvestigationId();
    const store = await persistState(root, terminalState({ investigationId }));
    await symlink(memoryDir, path.join(root, investigationId, "memory-link"));
    const cleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: store,
      protection: createNoopArtifactCleanupProtection(),
      config: config(),
      now: () => 1,
      log: () => {},
    });

    expect((await cleanup.cleanupInvestigation(investigationId)).status).toBe(
      "deleted",
    );
    expect(await readFile(path.join(memoryDir, "repository.json"), "utf8")).toBe(
      "remember me\n",
    );
  });

  test("a restarted worker service cleans expired terminal artifacts from disk", async () => {
    const root = await temporaryRoot();
    const investigationId = nextInvestigationId();
    const firstStore = await persistState(
      root,
      terminalState({ investigationId, deliveredAt: new Date(1_000).toISOString() }),
    );
    expect(await firstStore.load(investigationId)).not.toBeNull();

    // A new store and cleanup instance model a process restart: no in-memory
    // marker is required; delivery-state.json is the durable eligibility proof.
    const restartedCleanup = createArtifactCleanupService({
      rootDir: root,
      deliveryStore: createFileDeliveryStateStore(root),
      protection: createNoopArtifactCleanupProtection(),
      config: config({ successfulRetentionMs: 5_000 }),
      now: () => 6_001,
      log: () => {},
    });

    const scan = await restartedCleanup.scanExpired();
    expect(scan.deleted).toBe(1);
    expect(await exists(path.join(root, investigationId))).toBe(false);
  });
});
