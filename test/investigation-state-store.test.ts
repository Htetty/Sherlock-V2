import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyEvent,
  createFileInvestigationStateStore,
  createInMemoryInvestigationStateStore,
  createInvestigationStateStoreFromEnv,
  createNoopInvestigationStateStore,
  resolveStateFilePath,
  safeRepoUrl,
  type InvestigationStateEvent,
  type InvestigationStateRecord,
  type InvestigationStateStore,
} from "../backend/services/investigation-state-store.js";
import { runInvestigationPipeline } from "../backend/services/investigation.js";
import { RepositoryError } from "../backend/services/repo-auth.js";

const INV = "inv_123ABC456DEF";

// A full, ordered lifecycle for one investigation. Mirrors the events the
// pipeline emits so the reducer is exercised end-to-end.
function lifecycleEvents(investigationId = INV): InvestigationStateEvent[] {
  return [
    {
      type: "created",
      investigationId,
      at: "2026-07-08T00:00:00.000Z",
      repoOwner: "acme",
      repoName: "web",
      repoUrl: "https://github.com/acme/web",
      issueNumber: 7,
      issueTitle: "Login 500s",
      issueUrl: "https://github.com/acme/web/issues/7",
      triggeredBy: "octocat",
    },
    { type: "stage_changed", investigationId, at: "2026-07-08T00:00:01.000Z", stage: "reproducing" },
    {
      type: "reproduction",
      investigationId,
      at: "2026-07-08T00:00:02.000Z",
      path: "one_shot",
      mode: "browser",
      outcome: "reproduced",
      commit: "abc123",
    },
    { type: "stage_changed", investigationId, at: "2026-07-08T00:00:03.000Z", stage: "fixing" },
    {
      type: "fixer_attempts",
      investigationId,
      at: "2026-07-08T00:00:04.000Z",
      status: "verified",
      attempts: 2,
      outcome: "verified",
      changedFiles: ["src/login.ts"],
      verifiedFixAttemptId: "fix_999ZZZ000AAA",
    },
    {
      type: "repository_validation",
      investigationId,
      at: "2026-07-08T00:00:05.000Z",
      aggregate: "passed",
      categories: [
        { category: "test", status: "passed" },
        { category: "build", status: "passed" },
      ],
    },
    {
      type: "regression_proof",
      investigationId,
      at: "2026-07-08T00:00:06.000Z",
      status: "proven",
      testName: "login-500-regression",
      prePatch: "failed_as_expected",
      postPatch: "passed",
      hashMatched: true,
    },
    {
      type: "pull_request",
      investigationId,
      at: "2026-07-08T00:00:07.000Z",
      status: "created",
      number: 42,
      url: "https://github.com/acme/web/pull/42",
      branch: "sherlock/fix-login-500",
    },
    {
      type: "final_outcome",
      investigationId,
      at: "2026-07-08T00:00:08.000Z",
      outcome: "verified_fix",
      originalOutcome: "reproduced",
      pullRequestStatus: "created",
      error: null,
    },
  ];
}

function foldAll(events: InvestigationStateEvent[]): InvestigationStateRecord {
  let record: InvestigationStateRecord | null = null;
  for (const event of events) {
    record = applyEvent(record, event);
  }
  return record!;
}

describe("applyEvent reducer", () => {
  test("folds a full lifecycle into a dashboard-friendly record", () => {
    const record = foldAll(lifecycleEvents());

    expect(record).toMatchObject({
      investigationId: INV,
      status: "finished",
      stage: "fixing",
      repoOwner: "acme",
      repoName: "web",
      issueNumber: 7,
      commit: "abc123",
      outcome: "verified_fix",
      finishedAt: "2026-07-08T00:00:08.000Z",
    });
    expect(record.createdAt).toBe("2026-07-08T00:00:00.000Z");
    expect(record.updatedAt).toBe("2026-07-08T00:00:08.000Z");
    expect(record.reproduction).toEqual({ path: "one_shot", mode: "browser", outcome: "reproduced" });
    expect(record.fixer).toMatchObject({ status: "verified", attempts: 2, verifiedFixAttemptId: "fix_999ZZZ000AAA" });
    expect(record.repositoryValidation?.aggregate).toBe("passed");
    expect(record.regressionProof).toMatchObject({ status: "proven", hashMatched: true });
    expect(record.pullRequest).toMatchObject({ status: "created", number: 42 });
    expect(record.errors).toEqual([]);
  });

  test("starts a fresh record from a null previous state", () => {
    const record = applyEvent(null, {
      type: "stage_changed",
      investigationId: INV,
      at: "2026-07-08T00:00:00.000Z",
      stage: "reproducing",
    });

    expect(record.investigationId).toBe(INV);
    expect(record.status).toBe("running");
    expect(record.stage).toBe("reproducing");
  });

  test("accumulates error events and redacts secrets from their messages", () => {
    const secret = "SECRET_TOKEN=redact-me";
    let record = applyEvent(null, {
      type: "error",
      investigationId: INV,
      at: "2026-07-08T00:00:00.000Z",
      stage: "fixing",
      message: `boom with ${secret}`,
    });
    record = applyEvent(record, {
      type: "final_outcome",
      investigationId: INV,
      at: "2026-07-08T00:00:01.000Z",
      outcome: "execution_failed",
      error: `final failure ${secret}`,
    });

    expect(record.errors).toHaveLength(2);
    expect(record.status).toBe("finished");
    for (const entry of record.errors) {
      expect(entry.message).not.toContain("redact-me");
      expect(entry.message).toContain("[REDACTED]");
    }
  });
});

describe("in-memory store", () => {
  test("applies events and exposes get/list/snapshot", async () => {
    const store = createInMemoryInvestigationStateStore();
    for (const event of lifecycleEvents()) {
      await store.record(event);
    }

    const record = await store.get?.(INV);
    expect(record?.outcome).toBe("verified_fix");
    expect(await store.list?.()).toHaveLength(1);
    expect(store.snapshot()).toHaveLength(1);
  });
});

describe("file store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sherlock-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips one JSON file per investigation", async () => {
    const store = createFileInvestigationStateStore(dir);
    for (const event of lifecycleEvents()) {
      await store.record(event);
    }

    const onDisk = JSON.parse(await readFile(path.join(dir, `${INV}.json`), "utf8"));
    expect(onDisk.outcome).toBe("verified_fix");
    expect(onDisk.pullRequest.number).toBe(42);

    const record = await store.get?.(INV);
    expect(record?.investigationId).toBe(INV);
    expect(await store.list?.()).toHaveLength(1);
  });

  test("list returns [] when the directory does not exist yet", async () => {
    const store = createFileInvestigationStateStore(path.join(dir, "missing"));
    expect(await store.list?.()).toEqual([]);
    expect(await store.get?.(INV)).toBeNull();
  });
});

describe("no-op and env factory", () => {
  test("no-op store records nothing and never throws", async () => {
    const store = createNoopInvestigationStateStore();
    await expect(store.record(lifecycleEvents()[0])).resolves.toBeUndefined();
    expect(store.get).toBeUndefined();
  });

  test("env factory returns file store only when explicitly enabled", () => {
    expect(createInvestigationStateStoreFromEnv({}).get).toBeUndefined();
    const enabled = createInvestigationStateStoreFromEnv({
      SHERLOCK_STATE_STORE: "file",
      SHERLOCK_STATE_STORE_DIR: "/tmp/does-not-matter",
    } as NodeJS.ProcessEnv);
    expect(typeof enabled.get).toBe("function");
  });
});

describe("metadata redaction", () => {
  const SECRET = "SECRET_TOKEN=redact-me";

  test("scrubs secrets from all free-text metadata in the created event", () => {
    const record = applyEvent(null, {
      type: "created",
      investigationId: INV,
      at: "2026-07-08T00:00:00.000Z",
      repoOwner: "acme",
      repoName: "web",
      // A caller-supplied URL that smuggles credentials must not be stored.
      repoUrl: "https://user:redact-me@github.com/acme/web",
      issueNumber: 7,
      issueTitle: `Login breaks when token ${SECRET} is set`,
      issueUrl: "https://github.com/acme/web/issues/7",
      triggeredBy: "octocat",
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("redact-me");
    expect(record.issueTitle).toContain("[REDACTED]");
    expect(record.repoUrl).not.toContain("redact-me");
    // Non-secret identifiers survive untouched.
    expect(record.repoOwner).toBe("acme");
    expect(record.triggeredBy).toBe("octocat");
  });

  test("safeRepoUrl derives a clean canonical URL from owner/name", () => {
    expect(safeRepoUrl("acme", "web")).toBe("https://github.com/acme/web");
  });
});

describe("file store path hardening", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sherlock-state-guard-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const unsafeIds = [
    "../evil",
    "../../etc/passwd",
    "inv_ABC/../../secret",
    "inv_123ABC456DEF/../../escape",
    "foo/bar",
    "..",
    "inv_lowercase123",
    "inv_ABC",
    "",
  ];

  test("resolveStateFilePath rejects traversal and unsafe ids", () => {
    for (const id of unsafeIds) {
      expect(() => resolveStateFilePath(dir, id)).toThrow();
    }
  });

  test("resolveStateFilePath keeps valid ids contained in the root", () => {
    const resolved = resolveStateFilePath(dir, INV);
    expect(resolved).toBe(path.join(path.resolve(dir), `${INV}.json`));
    expect(resolved.startsWith(path.resolve(dir) + path.sep)).toBe(true);
  });

  test("file store record/get reject traversal ids and write nothing outside the root", async () => {
    const store = createFileInvestigationStateStore(dir);

    await expect(
      store.record({
        type: "stage_changed",
        investigationId: "../escape",
        at: "2026-07-08T00:00:00.000Z",
        stage: "running",
      }),
    ).rejects.toThrow();

    await expect(store.get?.("../../escape")).rejects.toThrow();

    // Nothing leaked outside the state directory.
    const parent = path.dirname(path.resolve(dir));
    const siblings = await readdir(parent);
    expect(siblings).not.toContain("escape.json");
    await expect(access(path.join(parent, "escape.json"))).rejects.toThrow();
  });
});

describe("pipeline lifecycle writes", () => {
  const basePayload = {
    repoOwner: "acme",
    repoName: "private-app",
    repoUrl: "https://github.com/acme/private-app",
    defaultBranch: "main",
    issueNumber: 7,
    issueTitle: "Example bug",
    issueBody: "",
    triggeredBy: "octocat",
  };

  test("records created, stage, and final outcome for a real (failed) run", async () => {
    const store = createInMemoryInvestigationStateStore();

    const result = await runInvestigationPipeline(basePayload, {
      stateStore: store,
      cloneRepo: async () => {
        throw new RepositoryError("access_denied", "no access", false);
      },
    });

    expect(result.outcome).toBe("environment_failed");

    const [record] = store.snapshot();
    expect(record).toBeDefined();
    expect(record.investigationId).toBe(result.investigationId);
    expect(record.repoOwner).toBe("acme");
    expect(record.triggeredBy).toBe("octocat");
    // reportStage("reproducing") fires before the created event.
    expect(record.stage).toBe("reproducing");
    expect(record.status).toBe("finished");
    expect(record.outcome).toBe("environment_failed");
    expect(record.finishedAt).not.toBeNull();
  });

  test("storage failures are non-fatal: the investigation still completes", async () => {
    let attempts = 0;
    const throwingStore: InvestigationStateStore = {
      async record() {
        attempts += 1;
        throw new Error("state backend is down");
      },
    };

    const result = await runInvestigationPipeline(basePayload, {
      stateStore: throwingStore,
      cloneRepo: async () => {
        throw new RepositoryError("access_denied", "no access", false);
      },
    });

    // The store was called (and threw) but the pipeline produced its normal
    // terminal result instead of failing.
    expect(attempts).toBeGreaterThan(0);
    expect(result.outcome).toBe("environment_failed");
    expect(result.githubComment).toContain("environment");
  });
});
