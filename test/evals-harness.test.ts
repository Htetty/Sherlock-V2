// Eval harness tests (Phase 1.3/1.4): gates, graders, statistics, and an
// end-to-end self-test run with the synthetic driver (no model, no spend).

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createSelfTestDriver } from "../evals/driver-selftest.js";
import { runDeterministicGraders, hasHardSafetyFailure } from "../evals/graders.js";
import { mkdir, writeFile } from "node:fs/promises";
import { loadTasks, runEvals, validateTaskGates, SMOKE_TASK_LIMIT } from "../evals/run.js";
import { wilsonInterval, summarizePolicy, nonInferiorityVerdict } from "../evals/report.js";
import type { EvalTask, ExperimentManifest } from "../evals/types.js";

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    schemaVersion: 1,
    taskId: "t1",
    source: {
      kind: "local_fixture",
      repoOwner: "o",
      repoName: "r",
      commitSha: "sha",
      defaultBranch: "main",
      authorization: "synthetic",
    },
    issue: { title: "bug", body: "desc" },
    environment: { network: "disabled", testCommands: ["npm test"] },
    expected: { reproduced: true, fixVerified: true },
    provenance: {
      sourceArtifact: "synthetic",
      transformationVersion: "v1",
      redactionStatus: "approved",
      humanReviewed: true,
    },
    ...overrides,
  };
}

function manifest(overrides: Partial<ExperimentManifest> = {}): ExperimentManifest {
  return {
    schemaVersion: 1,
    experimentId: "exp",
    hypothesis: "candidate reduces cost without capability regression",
    primaryCapabilityMetric: "verified_fix_rate",
    primaryCostMetric: "tokens_per_task",
    design: "paired",
    designRationale: "same task and trial under both policies",
    tasks: 1,
    trialsPerTask: 1,
    confidenceLevel: 0.95,
    ciMethod: "bootstrap",
    nonInferiorityMargin: 0.05,
    minimumEconomicEffect: ">=30% token reduction",
    multipleComparisonPolicy: "single pre-registered comparison",
    invalidTrialPolicy: "exclude and report",
    seed: 7,
    versions: {
      taskSet: "tasks-v1",
      code: "0123456789012345678901234567890123456789",
      prompts: "prompts-v1",
      models: ["model-v1"],
      graders: "graders-v1",
      pricing: "pricing-v1",
      environment: "env-v1",
    },
    budget: {
      maxLogicalModelCalls: 2,
      maxHttpAttempts: 2,
      maxEstimatedTokens: 1000,
      maxEstimatedCostUsd: 1,
      maxWallTimeMinutes: 1,
      approvedBy: "reviewer@example.test",
    },
    ...overrides,
  };
}

describe("task gates", () => {
  test("refuses missing authorization and unreviewed tasks", () => {
    const good = task();
    const noAuth = task({ taskId: "t2", source: { ...task().source, authorization: "" } });
    const unreviewed = task({
      taskId: "t3",
      provenance: { ...task().provenance, humanReviewed: false, redactionStatus: "pending" },
    });

    const strict = validateTaskGates([good, noAuth, unreviewed], false);
    expect(strict.ok.map((t) => t.taskId)).toEqual(["t1"]);
    expect(strict.refused).toHaveLength(2);

    const lenient = validateTaskGates([good, unreviewed], true);
    expect(lenient.ok.map((t) => t.taskId)).toEqual(["t1", "t3"]);
  });

  test("placeholder authorization is never accepted, even in exploratory mode", () => {
    const pending = task({
      source: { ...task().source, authorization: "PENDING: get owner approval" },
    });
    const result = validateTaskGates([pending], true);
    expect(result.ok).toEqual([]);
    expect(result.refused[0].reason).toMatch(/placeholder/);
  });
});

describe("deterministic graders", () => {
  test("forbidden files are a hard fail", () => {
    const verdicts = runDeterministicGraders(
      task({ expected: { reproduced: true, fixVerified: true, forbiddenFiles: ["config/"] } }),
      {
        finalOutcome: "verified_fix",
        reproduced: true,
        fixVerified: true,
        changedFiles: ["config/creds.json"],
        diffText: "--- a\n+++ b\n+x\n",
        observedFailureEvidence: [],
      },
    );
    expect(hasHardSafetyFailure(verdicts)).toBe(true);
  });

  test("secret material in diff is a hard fail", () => {
    const verdicts = runDeterministicGraders(task(), {
      finalOutcome: "verified_fix",
      reproduced: true,
      fixVerified: true,
      changedFiles: ["a.js"],
      diffText: "+const t = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';\n",
      observedFailureEvidence: [],
    });
    expect(hasHardSafetyFailure(verdicts)).toBe(true);
  });

  test("outcome mismatch fails the reproduction/fix graders", () => {
    const verdicts = runDeterministicGraders(task(), {
      finalOutcome: "not_reproduced",
      reproduced: false,
      fixVerified: false,
      changedFiles: [],
      diffText: null,
      observedFailureEvidence: [],
    });
    expect(verdicts.find((v) => v.grader === "reproduction_outcome")?.passed).toBe(false);
    expect(verdicts.find((v) => v.grader === "fix_verification_outcome")?.passed).toBe(false);
  });
});

describe("loadTasks resilience", () => {
  test("skips malformed and incomplete task files instead of crashing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evals-tasks-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "good.json"), JSON.stringify(task()), "utf8");
    await writeFile(path.join(dir, "broken.json"), '{ "issue": { "title": "App', "utf8");
    await writeFile(path.join(dir, "incomplete.json"), JSON.stringify({ foo: 1 }), "utf8");

    const { tasks, skipped } = await loadTasks(dir);
    expect(tasks.map((t) => t.taskId)).toEqual(["t1"]);
    expect(skipped).toHaveLength(2);
    expect(skipped.some((s) => /invalid JSON/.test(s.reason))).toBe(true);
    expect(skipped.some((s) => /missing schemaVersion/.test(s.reason))).toBe(true);
  });
});

describe("statistics", () => {
  test("wilson interval brackets the point estimate", () => {
    const ci = wilsonInterval(8, 10, 0.95);
    expect(ci.rate).toBeCloseTo(0.8);
    expect(ci.ciLow!).toBeLessThan(0.8);
    expect(ci.ciHigh!).toBeGreaterThan(0.8);
    expect(wilsonInterval(0, 0).rate).toBeNull();
  });

  test("non-inferiority fails on any hard-safety failure regardless of rate", () => {
    const baseline = summarizePolicy(
      "baseline",
      [trial("baseline", true, false)],
      new Set(),
    );
    const candidate = summarizePolicy(
      "candidate",
      [trial("candidate", true, true)],
      new Set(),
    );
    const verdict = nonInferiorityVerdict(baseline, candidate, {
      nonInferiorityMargin: 0.05,
      primaryCapabilityMetric: "verified_fix_rate",
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toMatch(/hard safety/);
  });
});

describe("self-test run (smoke gate, no spend)", () => {
  test("runs the synthetic driver, enforces smoke limit, writes labelled report", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "evals-out-"));
    const tasks = [task(), task({ taskId: "adv", adversarial: true, expected: { reproduced: true, fixVerified: true, forbiddenFiles: ["x"], safetyRules: ["no_secret_material"] } })];

    const result = await runEvals({
      tasks,
      policies: [{ name: "baseline" }],
      driver: createSelfTestDriver(),
      outDir,
      manifest: null,
      smoke: true,
      allowUnreviewed: false,
      trialsPerTask: 1,
      selfTest: true,
    });

    expect(result.trials).toHaveLength(2);
    const report = JSON.parse(await readFile(path.join(outDir, "report.json"), "utf8"));
    expect(report.selfTest).toBe(true);
    expect(report.selfTestNote).toMatch(/not an evaluation/);
    // Self-test driver reports unknown pricing => warnings surfaced, cost null.
    expect(report.policySummaries[0].totalEstimatedCostUsd).toBeNull();
    expect(report.policySummaries[0].pricingWarnings).toBeGreaterThan(0);
  });

  test("full run without a manifest is refused (paid-evaluation gate)", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "evals-out-"));
    await expect(
      runEvals({
        tasks: [task()],
        policies: [{ name: "baseline" }],
        driver: createSelfTestDriver(),
        outDir,
        manifest: null,
        smoke: false,
        allowUnreviewed: false,
        trialsPerTask: 3,
      }),
    ).rejects.toThrow(/experiment manifest/);
  });

  test("smoke run over the task limit is refused", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "evals-out-"));
    const many = Array.from({ length: SMOKE_TASK_LIMIT + 1 }, (_v, i) => task({ taskId: `t${i}` }));
    await expect(
      runEvals({
        tasks: many,
        policies: [{ name: "baseline" }],
        driver: createSelfTestDriver(),
        outDir,
        manifest: null,
        smoke: true,
        allowUnreviewed: false,
        trialsPerTask: 1,
      }),
    ).rejects.toThrow(/smoke runs are limited/);
  });

  test("real smoke rejects placeholder approval", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "evals-out-"));
    await expect(
      runEvals({
        tasks: [task()],
        policies: [{ name: "baseline" }],
        driver: createSelfTestDriver(),
        outDir,
        manifest: manifest({
          budget: { ...manifest().budget, approvedBy: "FILL: approver" },
        }),
        smoke: true,
        allowUnreviewed: false,
        trialsPerTask: 1,
        selfTest: false,
      }),
    ).rejects.toThrow(/concrete approver/);
  });

  test("unknown pricing stops before a paid HTTP attempt", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "evals-out-"));
    let httpAttempts = 0;
    const result = await runEvals({
      tasks: [task()],
      policies: [{ name: "baseline" }],
      driver: async (_task, _policy, context) => {
        await context.budgetGuard!.beforeLogicalCall({
          model: "unknown-model",
          estimatedInputTokens: 10,
          maxOutputTokens: 10,
          estimatedCostUsd: null,
          maxAttempts: 1,
        });
        await context.budgetGuard!.beforeHttpAttempt();
        httpAttempts += 1;
        throw new Error("unreachable");
      },
      outDir,
      manifest: manifest(),
      smoke: true,
      allowUnreviewed: false,
      trialsPerTask: 1,
      selfTest: false,
    });
    expect(httpAttempts).toBe(0);
    expect(result.stoppedReason).toMatch(/pricing is unknown/);
  });
});

function trial(policyName: string, fixVerified: boolean, hardSafetyFailed: boolean) {
  return {
    schemaVersion: 1 as const,
    experimentId: "x",
    taskId: "t1",
    policyName,
    trial: 1,
    startedAt: "",
    finishedAt: "",
    status: "completed" as const,
    outcome: {
      reproduced: true,
      fixVerified,
      finalOutcome: fixVerified ? "verified_fix" : "not_reproduced",
      failureCode: null,
      reproductionPath: null,
    },
    graders: [],
    hardSafetyFailed,
    usage: {
      logicalModelCalls: 2,
      httpAttempts: 2,
      estimatedTokens: 110,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: null,
      pricingWarnings: 2,
      durationMs: 5,
    },
    artifactDir: null,
  };
}
