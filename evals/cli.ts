// Eval CLI (Phase 1.3/1.4). Usage:
//
//   node lib/evals/cli.js --driver selftest --smoke --tasks evals/tasks
//   node lib/evals/cli.js --driver real --manifest evals/manifests/<id>.json \
//        --tasks evals/tasks --out evals/out/<id>
//
// Gates enforced by evals/run.ts: authorization + human review, smoke <= 5
// tasks / 1 trial without a manifest, approved budget for full runs, hard
// budget caps. --driver selftest never spends money and labels its report as
// a self-test (not an evaluation).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRealDriver } from "./driver-real.js";
import { createSelfTestDriver } from "./driver-selftest.js";
import { loadTasks, runEvals } from "./run.js";
import type { EvalPolicyConfig, ExperimentManifest } from "./types.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        index += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const driverName = String(args.driver ?? "selftest");
  const booleanArg = (name: string): boolean => {
    const value = args[name];
    if (value === undefined) return false;
    if (value === true || value === "true") return true;
    if (value === "false") return false;
    throw new Error(`--${name} must be "true" or "false" when a value is supplied`);
  };
  if (driverName !== "real" && driverName !== "selftest") {
    throw new Error(`unknown --driver "${driverName}"; expected "real" or "selftest"`);
  }
  const smoke = booleanArg("smoke");
  const tasksDir = String(args.tasks ?? "evals/tasks");
  const outDir = String(args.out ?? `evals/out/${driverName}-${Date.now()}`);
  const allowUnreviewed = booleanArg("allow-unreviewed");

  const { tasks, skipped } = await loadTasks(path.resolve(tasksDir));
  for (const entry of skipped) {
    console.log(`[evals] SKIPPED task file ${entry.file}: ${entry.reason}`);
  }

  let manifest: ExperimentManifest | null = null;
  if (args.manifest) {
    manifest = JSON.parse(await readFile(path.resolve(String(args.manifest)), "utf8")) as ExperimentManifest;
  }

  let policies: EvalPolicyConfig[] = [{ name: "baseline" }];
  if (args.policies) {
    policies = JSON.parse(await readFile(path.resolve(String(args.policies)), "utf8")) as EvalPolicyConfig[];
  }

  const driver = driverName === "real" ? createRealDriver() : createSelfTestDriver();

  const result = await runEvals({
    tasks,
    policies,
    driver,
    outDir: path.resolve(outDir),
    manifest,
    smoke,
    allowUnreviewed,
    trialsPerTask: manifest?.trialsPerTask ?? 1,
    baselinePolicyName: "baseline",
    selfTest: driverName === "selftest",
  });

  console.log(
    `[evals] driver=${driverName} smoke=${smoke} trials=${result.trials.length} refused=${result.refusedTasks.length}${result.stoppedReason ? ` stopped=${result.stoppedReason}` : ""}`,
  );
  console.log(`[evals] report written to ${path.join(path.resolve(outDir), "report.json")}`);
  if (driverName === "selftest") {
    console.log("[evals] NOTE: self-test driver — validates harness plumbing only, not an evaluation.");
  }
  for (const refused of result.refusedTasks) {
    console.log(`[evals] refused ${refused.taskId}: ${refused.reason}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
