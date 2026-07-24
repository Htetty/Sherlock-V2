// Eval runner (Phase 1.3/1.4).
//
// Calls the REAL investigation pipeline through a driver seam:
// - driver "real" (evals/driver-real.ts): runInvestigationPipeline() with the
//   policy mapped into pipeline options. Requires the dev host (Docker,
//   Playwright browsers, ANTHROPIC_API_KEY). Delivery side effects cannot
//   occur: the pipeline never calls GitHub delivery APIs and the runner never
//   invokes the delivery stage.
// - driver "selftest" (evals/driver-selftest.ts): deterministic fake driver
//   used to validate harness plumbing (task gating, budgets, graders,
//   records, report) without Docker or paid model calls. Self-test runs are
//   NOT evaluations and are labelled as such in the output.
//
// Gates enforced in code:
// - tasks without authorization are refused;
// - unreviewed/unredacted tasks are refused unless --allow-unreviewed;
// - full runs require an experiment manifest with an approved budget;
//   --smoke permits <= 5 tasks x 1 trial without a manifest;
// - budget caps (logical calls, cost, wall time) stop scheduling when hit.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runDeterministicGraders, hasHardSafetyFailure } from "./graders.js";
import { summarizePolicy, comparePolicyTrials } from "./report.js";
import type {
  EvalPolicyConfig,
  EvalTask,
  ExperimentManifest,
  TrialRecord,
} from "./types.js";
import type {
  InferenceBudgetGuard,
  InferenceBudgetReservation,
} from "../backend/services/inference.js";

export const SMOKE_TASK_LIMIT = 5;

export type DriverResult = {
  finalOutcome: string;
  reproduced: boolean;
  fixVerified: boolean;
  failureCode: string | null;
  reproductionPath: string | null;
  changedFiles: string[];
  diffText: string | null;
  observedFailureEvidence: string[];
  artifactDir: string | null;
};

export type PipelineDriver = (
  task: EvalTask,
  policy: EvalPolicyConfig,
  context: { trial: number; timeoutMs: number; budgetGuard?: InferenceBudgetGuard },
) => Promise<DriverResult>;

export type RunOptions = {
  tasks: EvalTask[];
  policies: EvalPolicyConfig[];
  driver: PipelineDriver;
  outDir: string;
  manifest: ExperimentManifest | null;
  smoke: boolean;
  allowUnreviewed: boolean;
  trialsPerTask: number;
  trialTimeoutMs?: number;
  baselinePolicyName?: string;
  selfTest?: boolean;
};

type UsageTotals = {
  logicalModelCalls: number;
  httpAttempts: number;
  estimatedTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  estimatedCostUsd: number | null;
  pricingWarnings: number;
};

async function readUsage(artifactDir: string | null): Promise<UsageTotals> {
  const empty: UsageTotals = {
    logicalModelCalls: 0,
    httpAttempts: 0,
    estimatedTokens: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    estimatedCostUsd: null,
    pricingWarnings: 0,
  };

  if (!artifactDir) {
    return empty;
  }

  try {
    const raw = await readFile(path.join(artifactDir, "inference-records.jsonl"), "utf8");
    const records = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, number | null>);

    const sum = (key: string): number | null => {
      const values = records.map((record) => record[key] ?? null);
      if (values.some((value) => value === null)) return null;
      return (values as number[]).reduce((total, value) => total + value, 0);
    };

    return {
      logicalModelCalls: records.length,
      httpAttempts: records.reduce(
        (total, record) => total + (record.attemptCount ?? 0),
        0,
      ),
      estimatedTokens:
        (sum("inputTokens") ?? 0) + (sum("outputTokens") ?? 0),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      estimatedCostUsd: sum("estimatedCostUsd"),
      pricingWarnings: records.filter((record) => record.estimatedCostUsd === null).length,
    };
  } catch {
    return empty;
  }
}

const PLACEHOLDER = /(^|\b)(pending|fill|set-me|todo|tbd)(\b|:|-)/i;

function isConcreteApproval(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !PLACEHOLDER.test(value);
}

export function validateManifest(
  manifest: ExperimentManifest,
  taskCount: number,
  trialsPerTask: number,
): void {
  if (manifest.schemaVersion !== 1) throw new Error("unsupported experiment manifest schema");
  if (!isConcreteApproval(manifest.budget?.approvedBy)) {
    throw new Error("experiment manifest budget requires a concrete approver; placeholders are rejected");
  }
  if (manifest.tasks !== taskCount || manifest.trialsPerTask !== trialsPerTask) {
    throw new Error(
      `manifest declares ${manifest.tasks} tasks x ${manifest.trialsPerTask} trials, but the run selected ${taskCount} tasks x ${trialsPerTask}`,
    );
  }
  if (manifest.ciMethod !== "bootstrap") {
    throw new Error('the implemented paired/unpaired comparison requires ciMethod="bootstrap"');
  }
  if (!/>=?\s*\d+(?:\.\d+)?%/.test(manifest.minimumEconomicEffect)) {
    throw new Error("minimumEconomicEffect must declare a percentage reduction, e.g. >=30%");
  }
  if (!/single|pre-registered/i.test(manifest.multipleComparisonPolicy)) {
    throw new Error("only a single pre-registered policy comparison is currently supported");
  }
  if (!/exclude/i.test(manifest.invalidTrialPolicy)) {
    throw new Error("invalidTrialPolicy must explicitly declare exclusion and reporting");
  }
  const caps = Object.entries(manifest.budget).filter(([key]) => key !== "approvedBy");
  if (caps.some(([, value]) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    throw new Error("every experiment budget cap must be a positive finite number");
  }
  const versionValues = [
    manifest.versions.taskSet,
    manifest.versions.code,
    manifest.versions.prompts,
    ...manifest.versions.models,
    manifest.versions.graders,
    manifest.versions.pricing,
    manifest.versions.environment,
  ];
  if (versionValues.some((value) => !isConcreteApproval(value))) {
    throw new Error("manifest version fields must be concrete; placeholders are rejected");
  }
}

class RunBudgetGuard implements InferenceBudgetGuard {
  logicalCalls = 0;
  httpAttempts = 0;
  estimatedTokens = 0;
  estimatedCostUsd = 0;
  stoppedReason: string | null = null;

  private readonly startedAt = Date.now();

  constructor(private readonly budget: ExperimentManifest["budget"]) {}

  private stop(message: string): never {
    this.stoppedReason ??= message;
    throw new Error(message);
  }

  private assertWallTime(): void {
    if (Date.now() - this.startedAt >= this.budget.maxWallTimeMinutes * 60_000) {
      this.stop(`budget cap reached: maxWallTimeMinutes=${this.budget.maxWallTimeMinutes}`);
    }
  }

  beforeLogicalCall(reservation: InferenceBudgetReservation): void {
    this.assertWallTime();
    if (reservation.estimatedCostUsd === null) {
      this.stop(
        `budget cap cannot be enforced: pricing is unknown for model "${reservation.model}"`,
      );
    }
    const tokens = reservation.estimatedInputTokens + reservation.maxOutputTokens;
    if (this.logicalCalls + 1 > this.budget.maxLogicalModelCalls) {
      this.stop(`budget cap reached: maxLogicalModelCalls=${this.budget.maxLogicalModelCalls}`);
    }
    if (this.estimatedTokens + tokens > this.budget.maxEstimatedTokens) {
      this.stop(`budget cap reached: maxEstimatedTokens=${this.budget.maxEstimatedTokens}`);
    }
    if (this.estimatedCostUsd + reservation.estimatedCostUsd > this.budget.maxEstimatedCostUsd) {
      this.stop(`budget cap reached: maxEstimatedCostUsd=${this.budget.maxEstimatedCostUsd}`);
    }
    this.logicalCalls += 1;
    this.estimatedTokens += tokens;
    this.estimatedCostUsd += reservation.estimatedCostUsd;
  }

  beforeHttpAttempt(): void {
    this.assertWallTime();
    if (this.httpAttempts + 1 > this.budget.maxHttpAttempts) {
      this.stop(`budget cap reached: maxHttpAttempts=${this.budget.maxHttpAttempts}`);
    }
    this.httpAttempts += 1;
  }
}

export function validateTaskGates(
  tasks: EvalTask[],
  allowUnreviewed: boolean,
): { ok: EvalTask[]; refused: Array<{ taskId: string; reason: string }> } {
  const ok: EvalTask[] = [];
  const refused: Array<{ taskId: string; reason: string }> = [];

  for (const task of tasks) {
    if (!isConcreteApproval(task.source?.authorization)) {
      refused.push({ taskId: task.taskId, reason: "missing or placeholder repository authorization" });
      continue;
    }

    const reviewed =
      task.provenance?.humanReviewed === true && task.provenance?.redactionStatus === "approved";

    if (!reviewed && !allowUnreviewed) {
      refused.push({
        taskId: task.taskId,
        reason: "not human-reviewed/redaction-approved (data-governance gate); rerun with --allow-unreviewed only for non-gold exploratory runs",
      });
      continue;
    }

    if (task.adversarial && (task.expected.safetyRules?.length ?? 0) === 0) {
      refused.push({ taskId: task.taskId, reason: "adversarial task has no machine-enforced safetyRules" });
      continue;
    }

    ok.push(task);
  }

  return { ok, refused };
}

export async function runEvals(options: RunOptions): Promise<{
  trials: TrialRecord[];
  refusedTasks: Array<{ taskId: string; reason: string }>;
  stoppedReason: string | null;
}> {
  const { ok: tasks, refused } = validateTaskGates(options.tasks, options.allowUnreviewed);

  if (options.smoke) {
    if (tasks.length > SMOKE_TASK_LIMIT) {
      throw new Error(`smoke runs are limited to ${SMOKE_TASK_LIMIT} tasks (got ${tasks.length})`);
    }
  }
  if (!options.selfTest && !options.manifest) {
    throw new Error(
      "every real evaluation, including smoke runs, requires an approved experiment manifest",
    );
  }

  const trialsPerTask = options.smoke ? 1 : options.trialsPerTask;
  if (options.manifest) validateManifest(options.manifest, tasks.length, trialsPerTask);
  const timeoutMs = options.trialTimeoutMs ?? 30 * 60_000;
  const budget = options.manifest?.budget ?? null;
  const budgetGuard = budget ? new RunBudgetGuard(budget) : undefined;
  const startedRun = Date.now();

  const trials: TrialRecord[] = [];
  let totalLogicalCalls = 0;
  let totalCostUsd = 0;
  let costUnknown = false;
  let stoppedReason: string | null = null;

  outer: for (const policy of options.policies) {
    for (const task of tasks) {
      for (let trial = 1; trial <= trialsPerTask; trial += 1) {
        if (budget) {
          if (totalLogicalCalls >= budget.maxLogicalModelCalls) {
            stoppedReason = `budget cap reached: maxLogicalModelCalls=${budget.maxLogicalModelCalls}`;
            break outer;
          }
          if (!costUnknown && totalCostUsd >= budget.maxEstimatedCostUsd) {
            stoppedReason = `budget cap reached: maxEstimatedCostUsd=${budget.maxEstimatedCostUsd}`;
            break outer;
          }
          if (Date.now() - startedRun >= budget.maxWallTimeMinutes * 60_000) {
            stoppedReason = `budget cap reached: maxWallTimeMinutes=${budget.maxWallTimeMinutes}`;
            break outer;
          }
        }

        const startedAt = new Date().toISOString();
        const startedMs = Date.now();
        let record: TrialRecord;

        try {
          const result = await options.driver(task, policy, { trial, timeoutMs, budgetGuard });
          const verdicts = runDeterministicGraders(task, {
            finalOutcome: result.finalOutcome,
            reproduced: result.reproduced,
            fixVerified: result.fixVerified,
            changedFiles: result.changedFiles,
            diffText: result.diffText,
            observedFailureEvidence: result.observedFailureEvidence,
          });
          const usage = await readUsage(result.artifactDir);

          totalLogicalCalls += usage.logicalModelCalls;
          if (usage.estimatedCostUsd === null && usage.logicalModelCalls > 0) {
            costUnknown = true;
          } else if (usage.estimatedCostUsd !== null) {
            totalCostUsd += usage.estimatedCostUsd;
          }

          record = {
            schemaVersion: 1,
            experimentId: options.manifest?.experimentId ?? (options.smoke ? "(smoke)" : "(unmanaged)"),
            taskId: task.taskId,
            policyName: policy.name,
            trial,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "completed",
            outcome: {
              reproduced: result.reproduced,
              fixVerified: result.fixVerified,
              finalOutcome: result.finalOutcome,
              failureCode: result.failureCode,
              reproductionPath: result.reproductionPath,
            },
            graders: verdicts,
            hardSafetyFailed: hasHardSafetyFailure(verdicts),
            usage: { ...usage, durationMs: Date.now() - startedMs },
            artifactDir: result.artifactDir,
          };
        } catch (error) {
          record = {
            schemaVersion: 1,
            experimentId: options.manifest?.experimentId ?? (options.smoke ? "(smoke)" : "(unmanaged)"),
            taskId: task.taskId,
            policyName: policy.name,
            trial,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: /timeout/i.test(String(error)) ? "timeout" : "infrastructure_failed",
            outcome: {
              reproduced: false,
              fixVerified: false,
              finalOutcome: `driver_error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
              failureCode: null,
              reproductionPath: null,
            },
            graders: [],
            hardSafetyFailed: false,
            usage: {
              logicalModelCalls: 0,
              httpAttempts: 0,
              estimatedTokens: 0,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              estimatedCostUsd: null,
              pricingWarnings: 0,
              durationMs: Date.now() - startedMs,
            },
            artifactDir: null,
          };
        }

        trials.push(record);
        if (budgetGuard?.stoppedReason) {
          stoppedReason = budgetGuard.stoppedReason;
          break outer;
        }
        if (/budget cap/i.test(record.outcome.finalOutcome)) {
          stoppedReason = record.outcome.finalOutcome.replace(/^driver_error:\s*/, "");
          break outer;
        }
      }
    }
  }

  // Persist trial records and the aggregate report.
  await mkdir(options.outDir, { recursive: true });
  await writeFile(
    path.join(options.outDir, "trials.jsonl"),
    `${trials.map((trial) => JSON.stringify(trial)).join("\n")}\n`,
    "utf8",
  );

  const adversarialIds = new Set(tasks.filter((task) => task.adversarial).map((task) => task.taskId));
  const byPolicy = new Map<string, TrialRecord[]>();
  for (const trial of trials) {
    byPolicy.set(trial.policyName, [...(byPolicy.get(trial.policyName) ?? []), trial]);
  }

  const summaries = [...byPolicy.entries()].map(([name, policyTrials]) =>
    summarizePolicy(name, policyTrials, adversarialIds, options.manifest?.confidenceLevel ?? 0.95),
  );

  const baselineName = options.baselinePolicyName ?? "baseline";
  const baseline = byPolicy.get(baselineName);
  const comparisons =
    baseline && options.manifest
      ? [...byPolicy.entries()]
          .filter(([name]) => name !== baselineName)
          .map(([name, candidateTrials]) => ({
            candidate: name,
            ...comparePolicyTrials(baseline, candidateTrials, options.manifest!),
          }))
      : [];

  await writeFile(
    path.join(options.outDir, "report.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        selfTest: options.selfTest ?? false,
        selfTestNote: options.selfTest
          ? "SELF-TEST RUN: synthetic driver, validates harness plumbing only; this is not an evaluation of any model or policy."
          : undefined,
        smoke: options.smoke,
        manifest: options.manifest,
        refusedTasks: refused,
        stoppedReason,
        policySummaries: summaries,
        nonInferiorityComparisons: comparisons,
      },
      null,
      2,
    ),
    "utf8",
  );

  return { trials, refusedTasks: refused, stoppedReason };
}

// --- Task/config loading ------------------------------------------------------

export async function loadTasks(
  dir: string,
): Promise<{ tasks: EvalTask[]; skipped: Array<{ file: string; reason: string }> }> {
  const tasks: EvalTask[] = [];
  const taskIds = new Set<string>();
  const skipped: Array<{ file: string; reason: string }> = [];

  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".json") && !entry.name.startsWith("_")) {
        // A malformed or incomplete task file must never crash the whole run:
        // it is skipped and reported so it can be fixed, not silently dropped.
        let parsed: EvalTask;
        try {
          parsed = JSON.parse(await readFile(full, "utf8")) as EvalTask;
        } catch (error) {
          skipped.push({ file: full, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
        if (parsed.schemaVersion === 1 && parsed.taskId && !taskIds.has(parsed.taskId)) {
          taskIds.add(parsed.taskId);
          tasks.push(parsed);
        } else if (taskIds.has(parsed.taskId)) {
          skipped.push({ file: full, reason: `duplicate taskId "${parsed.taskId}"` });
        } else {
          skipped.push({ file: full, reason: "missing schemaVersion:1 or taskId" });
        }
      }
    }
  };

  await walk(dir);
  return {
    tasks: tasks.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    skipped,
  };
}
