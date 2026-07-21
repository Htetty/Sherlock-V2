// End-to-end tests for deterministic plan execution and replay against a
// small controlled fixture app (see test/fixtures/fixture-app/server.mjs).
//
// ANTHROPIC_API_KEY is removed before any plan executes. backend/replay.ts and
// its transitive imports never load the Claude client (whose constructor
// throws without an API key), so a replay here proves saved plans run without
// calling Claude.
delete process.env.ANTHROPIC_API_KEY;

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  createArtifactStore,
  createInvestigationId,
  isInvestigationId,
  writeExecutionArtifacts,
} from "../backend/services/artifacts.js";
import {
  validateReproductionPlan,
  REPRODUCTION_PLAN_VERSION,
  type ReproductionPlan,
} from "../backend/services/plan.js";
import { executeReproductionPlan } from "../backend/services/playwright.js";
import { replayInvestigation } from "../backend/replay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_APP = path.join(__dirname, "fixtures/fixture-app/server.mjs");

let runningApps: ChildProcess[] = [];

afterEach(() => {
  for (const app of runningApps) {
    app.kill("SIGKILL");
  }

  runningApps = [];
});

function buildLoginPlan(baseUrl: string): ReproductionPlan {
  const plan = {
    version: REPRODUCTION_PLAN_VERSION,
    baseUrl,
    steps: [
      { id: "step-1", action: "goto", path: "/" },
      {
        id: "step-2",
        action: "fill",
        selector: "[name='email']",
        value: "unknown@example.com",
      },
      {
        id: "step-3",
        action: "fill",
        selector: "[name='password']",
        value: "wrong-password",
      },
      { id: "step-4", action: "click", selector: "button[type='submit']" },
      { id: "step-5", action: "screenshot" },
    ],
    expectedBehavior: "Login with unknown credentials returns HTTP 401.",
    failureCondition: "Login request returns HTTP 500.",
    assertion: {
      type: "response_status",
      pathPattern: "/api/login",
      method: "POST",
      expected: 401,
      failureValue: 500,
    },
  };

  const validation = validateReproductionPlan(plan);

  if (!validation.ok) {
    throw new Error(`Test plan is invalid: ${validation.errors.join(", ")}`);
  }

  return validation.plan;
}

async function startFixtureApp({ buggy }: { buggy: boolean }) {
  const port = await getFreePort();
  const app = spawn(process.execPath, [FIXTURE_APP], {
    env: { ...process.env, PORT: String(port), BUGGY: buggy ? "1" : "0" },
    stdio: "ignore",
  });
  runningApps.push(app);

  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
      return baseUrl;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error("Fixture app did not start in time.");
}

function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate port."));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "sherlock-artifacts-"));
  const investigationId = createInvestigationId();

  return createArtifactStore(investigationId, path.join(dir, investigationId));
}

describe("investigation IDs", () => {
  test("are unique and match the inv_ format", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createInvestigationId()));

    expect(ids.size).toBe(50);

    for (const id of ids) {
      expect(isInvestigationId(id)).toBe(true);
    }
  });
});

describe("deterministic reproduction", () => {
  test(
    "classifies the seeded login bug as reproduced and persists evidence",
    { timeout: 60_000 },
    async () => {
      const baseUrl = await startFixtureApp({ buggy: true });
      const plan = buildLoginPlan(baseUrl);
      const store = await makeStore();

      const result = await executeReproductionPlan(plan, store);
      await store.writeJson("reproduction-plan.json", plan);
      await writeExecutionArtifacts(store, result);

      expect(result.outcome).toBe("reproduced");
      expect(result.assertion?.observed).toBe("500");
      expect(result.assertion?.matchedFailure).toBe(true);
      expect(result.steps.every((step) => step.outcome === "passed")).toBe(true);
      expect(result.steps.map((step) => step.id)).toEqual([
        "step-1",
        "step-2",
        "step-3",
        "step-4",
        "step-5",
      ]);
      expect(result.networkFailures.length).toBeGreaterThan(0);
      expect(result.apiResponses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "POST",
            status: 500,
            body: expect.stringContaining("Internal Server Error"),
          }),
        ]),
      );
      expect(result.screenshots.length).toBeGreaterThan(0);

      // Evidence files exist on disk.
      for (const fileName of [
        "reproduction-plan.json",
        "reproduction-result.json",
        "playwright-events.json",
        "console-errors.json",
        "network-failures.json",
      ]) {
        const info = await stat(path.join(store.dir, fileName));
        expect(info.isFile()).toBe(true);
      }

      const screenshotFiles = await readdir(store.screenshotsDir);
      expect(screenshotFiles.length).toBe(result.screenshots.length);

      const savedResult = JSON.parse(
        await readFile(path.join(store.dir, "reproduction-result.json"), "utf8"),
      );
      expect(savedResult.investigationId).toBe(store.investigationId);
      expect(savedResult.outcome).toBe("reproduced");
    },
  );

  test(
    "classifies the fixed fixture as not_reproduced",
    { timeout: 60_000 },
    async () => {
      const baseUrl = await startFixtureApp({ buggy: false });
      const plan = buildLoginPlan(baseUrl);
      const store = await makeStore();

      const result = await executeReproductionPlan(plan, store);

      expect(result.outcome).toBe("not_reproduced");
      expect(result.assertion?.observed).toBe("401");
      expect(result.assertion?.matchedExpected).toBe(true);
    },
  );

  test(
    "reproduces an API-only bug with wait and response_body assertion",
    { timeout: 60_000 },
    async () => {
      const baseUrl = await startFixtureApp({ buggy: true });
      const store = await makeStore();

      // Pure-API plan: no browser steps, so a console_error assertion would
      // be rejected by validation; response_body inspects the state instead,
      // and the wait step lets any async server work settle first.
      const validation = validateReproductionPlan({
        version: REPRODUCTION_PLAN_VERSION,
        baseUrl,
        steps: [
          {
            id: "step-1",
            action: "request",
            method: "POST",
            path: "/api/login",
            body: { email: "unknown@example.com" },
          },
          { id: "step-2", action: "wait", ms: 300 },
          {
            id: "step-3",
            action: "request",
            method: "POST",
            path: "/api/login",
            body: { email: "unknown@example.com" },
          },
        ],
        expectedBehavior: "Login rejects unknown users with an Invalid credentials body.",
        failureCondition: "Login responds with an Internal Server Error body.",
        assertion: {
          type: "response_body",
          pathPattern: "/api/login",
          method: "POST",
          failureContains: "Internal Server Error",
          expectedContains: "Invalid credentials",
        },
      });

      expect(validation.ok).toBe(true);

      if (!validation.ok) {
        return;
      }

      const result = await executeReproductionPlan(validation.plan, store);

      expect(result.outcome).toBe("reproduced");
      expect(result.assertion?.matchedFailure).toBe(true);
      expect(result.assertion?.observed).toContain("Internal Server Error");
      expect(result.steps.map((step) => step.outcome)).toEqual([
        "passed",
        "passed",
        "passed",
      ]);
    },
  );

  test(
    "classifies an unreachable application as environment_failed",
    { timeout: 30_000 },
    async () => {
      const deadPort = await getFreePort();
      const plan = buildLoginPlan(`http://localhost:${deadPort}`);
      const store = await makeStore();

      const result = await executeReproductionPlan(plan, store, {
        probeTimeoutMs: 1_500,
      });

      expect(result.outcome).toBe("environment_failed");
      expect(result.outcomeReason).toContain("not reachable");
    },
  );

  test(
    "classifies a plan that cannot complete as execution_failed",
    { timeout: 60_000 },
    async () => {
      const baseUrl = await startFixtureApp({ buggy: true });
      const plan = buildLoginPlan(baseUrl);
      plan.steps.splice(1, 0, {
        id: "step-missing",
        action: "click",
        selector: "#does-not-exist",
      });
      const store = await makeStore();

      const result = await executeReproductionPlan(plan, store);

      expect(result.outcome).toBe("execution_failed");
      expect(result.outcomeReason).toContain("step-missing");

      const missingStep = result.steps.find((step) => step.id === "step-missing");
      expect(missingStep?.outcome).toBe("failed");

      const laterSteps = result.steps.slice(
        result.steps.findIndex((step) => step.id === "step-missing") + 1,
      );
      expect(laterSteps.every((step) => step.outcome === "skipped")).toBe(true);
    },
  );
});

describe("replay", () => {
  test(
    "replays a saved plan without Claude and preserves the original result",
    { timeout: 60_000 },
    async () => {
      const baseUrl = await startFixtureApp({ buggy: true });
      const plan = buildLoginPlan(baseUrl);
      const store = await makeStore();

      // Original investigation run.
      const original = await executeReproductionPlan(plan, store);
      const planPath = await store.writeJson("reproduction-plan.json", plan);
      await writeExecutionArtifacts(store, original);
      expect(original.outcome).toBe("reproduced");

      const originalResultRaw = await readFile(
        path.join(store.dir, "reproduction-result.json"),
        "utf8",
      );

      // Replay from the saved plan file (ANTHROPIC_API_KEY is not set).
      const replay = await replayInvestigation(planPath);

      expect(replay.outcome).toBe("reproduced");
      expect(replay.sameFailureObserved).toBe(true);
      expect(replay.originalOutcome).toBe("reproduced");
      expect(replay.replayDir).toContain(path.join(store.dir, "replays"));

      // The replay produced its own result artifact...
      const replayResult = JSON.parse(
        await readFile(path.join(replay.replayDir!, "reproduction-result.json"), "utf8"),
      );
      expect(replayResult.outcome).toBe("reproduced");

      // ...and the original result artifact is untouched.
      const originalResultAfter = await readFile(
        path.join(store.dir, "reproduction-result.json"),
        "utf8",
      );
      expect(originalResultAfter).toBe(originalResultRaw);
    },
  );

  test("video recording is off by default: no video reference, no videos dir", { timeout: 60_000 }, async () => {
    const baseUrl = await startFixtureApp({ buggy: true });
    const plan = buildLoginPlan(baseUrl);
    const store = await makeStore();

    const result = await executeReproductionPlan(plan, store);

    expect(result.outcome).toBe("reproduced");
    expect(result.video ?? null).toBeNull();
    await expect(stat(path.join(store.dir, "videos"))).rejects.toThrow();
    await expect(
      readFile(path.join(store.dir, "video-evidence.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("records a video when enabled and harvests it deterministically", { timeout: 60_000 }, async () => {
    const baseUrl = await startFixtureApp({ buggy: true });
    const plan = buildLoginPlan(baseUrl);
    const store = await makeStore();

    const result = await executeReproductionPlan(plan, store, {
      recordVideo: true,
    });

    expect(result.outcome).toBe("reproduced");
    expect(result.video).toBe(path.join("videos", "run.webm"));

    const videoStat = await stat(path.join(store.dir, "videos", "run.webm"));
    expect(videoStat.size).toBeGreaterThan(0);

    const videoEvidence = JSON.parse(
      await readFile(path.join(store.dir, "video-evidence.json"), "utf8"),
    ) as { video: string | null };
    expect(videoEvidence.video).toBe(path.join("videos", "run.webm"));

    const visualEvidence = JSON.parse(
      await readFile(path.join(store.dir, "visual-evidence.json"), "utf8"),
    ) as { videoRecording?: { enabled: boolean } };
    expect(visualEvidence.videoRecording?.enabled).toBe(true);
  });

  test("rejects an invalid saved plan as plan_failed", async () => {
    const store = await makeStore();
    const planPath = await store.writeJson("reproduction-plan.json", {
      version: REPRODUCTION_PLAN_VERSION,
      baseUrl: "http://localhost:3000",
      steps: [{ id: "step-1", action: "hack-the-planet" }],
      expectedBehavior: "x",
      failureCondition: "y",
      assertion: { type: "console_error", contains: "boom" },
    });

    const replay = await replayInvestigation(planPath);

    expect(replay.outcome).toBe("plan_failed");
    expect(replay.planErrors.join(" ")).toContain("unsupported action");
    expect(replay.replayDir).toBeNull();
  });
});
