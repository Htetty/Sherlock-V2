// Replays a saved reproduction plan without calling Claude.
//
// Usage:
//   npm run replay -- artifacts/inv_123/reproduction-plan.json
//   npm run replay -- inv_123
//
// Results are written to artifacts/<id>/replays/<timestamp>/ so the original
// reproduction-result.json is never overwritten.

import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createReplayStore,
  getArtifactsRoot,
  isInvestigationId,
  readJsonArtifact,
  writeExecutionArtifacts,
} from "./services/artifacts.js";
import { validateReproductionPlan } from "./services/plan.js";
import {
  executeReproductionPlan,
  type ReproductionOutcome,
  type ReproductionResult,
} from "./services/playwright.js";

export type ReplayOutcome = ReproductionOutcome | "plan_failed";

export type ReplayResult = {
  investigationId: string;
  planPath: string;
  replayDir: string | null;
  outcome: ReplayOutcome;
  originalOutcome: string | null;
  sameFailureObserved: boolean | null;
  planErrors: string[];
  result: ReproductionResult | null;
};

export async function replayInvestigation(target: string): Promise<ReplayResult> {
  const { investigationDir, planPath } = resolveTarget(target);
  const investigationId = path.basename(investigationDir);

  const originalOutcome = await readOriginalOutcome(investigationDir);

  let planJson: unknown;

  try {
    planJson = await readJsonArtifact(planPath);
  } catch (error) {
    return {
      investigationId,
      planPath,
      replayDir: null,
      outcome: "plan_failed",
      originalOutcome,
      sameFailureObserved: null,
      planErrors: [
        `Could not read reproduction plan: ${error instanceof Error ? error.message : String(error)}`,
      ],
      result: null,
    };
  }

  const validation = validateReproductionPlan(planJson);

  if (!validation.ok) {
    return {
      investigationId,
      planPath,
      replayDir: null,
      outcome: "plan_failed",
      originalOutcome,
      sameFailureObserved: null,
      planErrors: validation.errors,
      result: null,
    };
  }

  const store = await createReplayStore(investigationDir);
  const result = await executeReproductionPlan(validation.plan, store);
  await writeExecutionArtifacts(store, result);
  await store.writeJson("replay-summary.json", {
    investigationId,
    planPath,
    replayedAt: result.startedAt,
    outcome: result.outcome,
    originalOutcome,
    sameFailureObserved: result.outcome === "reproduced",
  });

  return {
    investigationId,
    planPath,
    replayDir: store.dir,
    outcome: result.outcome,
    originalOutcome,
    sameFailureObserved: result.outcome === "reproduced",
    planErrors: [],
    result,
  };
}

function resolveTarget(target: string) {
  if (isInvestigationId(target)) {
    const investigationDir = path.join(getArtifactsRoot(), target);

    return {
      investigationDir,
      planPath: path.join(investigationDir, "reproduction-plan.json"),
    };
  }

  const planPath = path.resolve(target);

  return {
    investigationDir: path.dirname(planPath),
    planPath,
  };
}

async function readOriginalOutcome(investigationDir: string) {
  try {
    const original = (await readJsonArtifact(
      path.join(investigationDir, "reproduction-result.json"),
    )) as { outcome?: unknown };

    return typeof original.outcome === "string" ? original.outcome : null;
  } catch {
    return null;
  }
}

async function main() {
  const target = process.argv[2];

  if (!target) {
    console.error(
      "Usage: npm run replay -- <artifacts/inv_.../reproduction-plan.json | inv_...>",
    );
    process.exit(1);
  }

  const replay = await replayInvestigation(target);

  console.log(`Investigation: ${replay.investigationId}`);
  console.log(`Plan: ${replay.planPath}`);
  console.log(`Outcome: ${replay.outcome}`);

  if (replay.originalOutcome) {
    console.log(`Original outcome: ${replay.originalOutcome}`);
  }

  if (replay.sameFailureObserved !== null) {
    console.log(
      replay.sameFailureObserved
        ? "The same failure was observed again."
        : "The failure was NOT observed on this replay.",
    );
  }

  if (replay.planErrors.length > 0) {
    console.log(`Plan errors:\n${replay.planErrors.join("\n")}`);
  }

  if (replay.replayDir) {
    console.log(`Replay artifacts: ${replay.replayDir}`);
  }

  process.exit(replay.outcome === "reproduced" ? 0 : 1);
}

const isCliEntry =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

if (isCliEntry) {
  main().catch((error) => {
    console.error("Replay failed:", error);
    process.exit(1);
  });
}
