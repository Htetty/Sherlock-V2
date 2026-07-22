import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  processInvestigationJob,
  type WorkerDeps,
} from "../backend/queue/process-investigation.js";
import type { InvestigationJobPayload } from "../backend/queue/investigation-queue.js";
import {
  createFileDeliveryStateStore,
  createInMemoryDeliveryStateStore,
  TERMINAL_FAILURE_FILE,
  type DeliveryStateStore,
} from "../backend/services/delivery.js";

const INV = "inv_0TERMINALF01";
const payload: InvestigationJobPayload = {
  investigationId: INV,
  tenantId: "tenant-gh-2",
  installationId: 2,
  repositoryOwner: "acme",
  repositoryName: "app",
  repositoryUrl: "https://github.com/acme/app",
  defaultBranch: "main",
  issueNumber: 42,
  issueTitle: "Infrastructure failure",
  issueBody: "customer issue body",
  issueUrl: "https://github.com/acme/app/issues/42",
  triggeringCommentId: 99,
  triggerComment: "/sherlock investigate",
  triggeredBy: "octocat",
  sourceRef: null,
  deliveryId: null,
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function deps(store: DeliveryStateStore, failure: unknown): WorkerDeps {
  return {
    delivery: {
      store,
      enqueue: async () => {},
      createGitHubClient: () => {
        throw new Error("delivery is unreachable");
      },
      findTerminalComment: async () => false,
    },
    runPipeline: async () => {
      throw failure;
    },
    getInstallationToken: async () => ({ token: "fresh", permissions: null }),
    postIssueComment: async () => {},
  };
}

describe("exhausted investigation terminalization", () => {
  test("a transient clone failure remains nonterminal while a retry remains", async () => {
    const store = createInMemoryDeliveryStateStore();
    const cloneFailure = Object.assign(new Error("clone failed: early EOF"), {
      code: "ECONNRESET",
    });
    const fixture = deps(store, cloneFailure);
    const runPipeline = vi.fn(fixture.runPipeline);
    fixture.runPipeline = runPipeline;
    await expect(
      processInvestigationJob(
        { data: payload, attemptsMade: 0, opts: { attempts: 3 } },
        fixture,
      ),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
    // A fresh worker process sees no terminal marker and performs the normal
    // next pipeline attempt; only exhaustion may create the marker.
    await expect(
      processInvestigationJob(
        { data: payload, attemptsMade: 1, opts: { attempts: 3 } },
        fixture,
      ),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(runPipeline).toHaveBeenCalledTimes(2);
    await expect(store.loadTerminalFailure(INV)).resolves.toBeNull();
  });

  test("the final transient clone failure writes bounded durable delivery state", async () => {
    const store = createInMemoryDeliveryStateStore();
    const secret = "Authorization: Bearer clone-secret customer/source.ts";
    const cloneFailure = Object.assign(new Error(secret), {
      code: "ECONNRESET",
    });
    await expect(
      processInvestigationJob(
        { data: payload, attemptsMade: 2, opts: { attempts: 3 } },
        deps(store, cloneFailure),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const terminal = await store.load(INV);
    expect(terminal).toMatchObject({
      investigationId: INV,
      executionOutcome: "failed",
      fixVerified: false,
      pullRequest: { status: "not_applicable" },
      terminalComment: { status: "posted" },
    });
    const serialized = JSON.stringify(terminal);
    expect(serialized).not.toContain("clone-secret");
    expect(serialized).not.toContain("customer/source.ts");
  });

  test("a final preflight failure terminalizes without running the pipeline", async () => {
    const store = createInMemoryDeliveryStateStore();
    const runPipeline = vi.fn();
    const fixture = deps(store, new Error("unused"));
    fixture.runPipeline = runPipeline;
    fixture.getInstallationToken = async () => {
      throw new Error("installation auth unavailable");
    };
    await expect(
      processInvestigationJob(
        { data: payload, attemptsMade: 0, opts: { attempts: 3 } },
        fixture,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(runPipeline).not.toHaveBeenCalled();
    await expect(store.load(INV)).resolves.toMatchObject({
      executionOutcome: "failed",
      terminalComment: { status: "posted" },
    });
  });

  test("a restart after terminalization never reruns the pipeline", async () => {
    const store = createInMemoryDeliveryStateStore();
    await store.saveTerminalFailure({
      version: 1,
      investigationId: INV,
      tenantId: payload.tenantId,
      repoOwner: payload.repositoryOwner,
      repoName: payload.repositoryName,
      category: "infrastructure",
      stage: "running",
      terminalAt: new Date(0).toISOString(),
    });
    const runPipeline = vi.fn();
    const fixture = deps(store, new Error("unused"));
    fixture.runPipeline = runPipeline;
    await expect(
      processInvestigationJob(
        { data: payload, attemptsMade: 0, opts: { attempts: 3 } },
        fixture,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(runPipeline).not.toHaveBeenCalled();
  });
});

describe("terminal-failure artifact persistence", () => {
  test("the on-disk terminal record contains no raw exception or repository content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sherlock-terminal-metadata-"));
    roots.push(root);
    const store = createFileDeliveryStateStore(root);
    await store.saveTerminalFailure({
      version: 1,
      investigationId: INV,
      tenantId: payload.tenantId,
      repoOwner: payload.repositoryOwner,
      repoName: payload.repositoryName,
      category: "infrastructure",
      stage: "running",
      terminalAt: new Date(0).toISOString(),
    });
    const raw = await readFile(path.join(root, INV, TERMINAL_FAILURE_FILE), "utf8");
    expect(raw).not.toContain("Authorization");
    expect(raw).not.toContain("customer/source.ts");
    expect(raw.length).toBeLessThan(2_000);
  });
});
