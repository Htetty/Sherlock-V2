// Per-investigation cost-shape summary (artifacts/<inv_id>/cost-shape.json).
//
// A lightweight record of WHICH expensive paths ran (no dollar amounts) so an
// expensive investigation can be explained without reading transcripts, and
// so each cost-reduction change is measurable. Fields are populated
// incrementally as the run progresses: every update rewrites the file, so a
// crash still leaves a partial record.

import type { ArtifactStore } from "./artifacts.js";
import type { EfficiencyPolicy } from "./efficiency-policy.js";

export type BudgetProfileName = "standard" | "deep";

export type CostShape = {
  memoryReplayTried: boolean;
  memoryReplaySucceeded: boolean;
  oneShotPlanTried: boolean;
  oneShotPlanSucceeded: boolean;
  reproducerAgentUsed: boolean;
  fixerAgentUsed: boolean;
  analyzeIssueCalled: boolean;
  memoryReflectionCalled: boolean;
  reproducerTurns: number;
  reproducerFailureCode: string | null;
  fixerTurns: number;
  fixerPatchAttempts: number;
  fixerFailureCode: string | null;
  budgetProfile: BudgetProfileName;
  compactionEvents: number;
  // --- fable/16 tool-call efficiency observability ---------------------------
  // The immutable policy resolved at investigation start (null until set).
  resolvedEfficiencyPolicy: EfficiencyPolicy | null;
  // Token totals derived from the append-only inference JSONL (one record per
  // LOGICAL call, so retries are never double counted). Null until derived.
  inputTokensTotal: number | null;
  outputTokensTotal: number | null;
  cacheReadTokensTotal: number | null;
  cacheWriteTokensTotal: number | null;
  // Sum of per-record estimatedCostUsd. Null when pricing was unknown for any
  // successful record (never a guess).
  estimatedInferenceCostUsd: number | null;
  // Calls whose usage reported nonzero cache reads vs none.
  cacheHitTurns: number;
  cacheMissTurns: number;
  // Fixer dense/batched tooling.
  fixerParallelBatches: number;
  fixerBatchedReads: number;
  fixerReadManyCalls: number;
  fixerFilesReadThroughReadMany: number;
  fixerRunCodeCalls: number;
  fixerRunCodeTimeouts: number;
  fixerRunCodeInvalidResults: number;
  fixerSuccessfulInspections: number;
  // Reproducer batching/deltas.
  reproducerRunStepsCalls: number;
  reproducerBatchedActions: number;
  reproducerActionDeltaBytes: number;
  reproducerReadPageCalls: number;
  // Warm start (prior scripted attempt handed to the reproducer).
  warmStartUsed: boolean;
};

export type CostShapeTracker = {
  readonly shape: CostShape;
  // Merge fields and persist. Never throws: cost-shape is telemetry and must
  // not fail an investigation.
  update: (fields: Partial<CostShape>) => Promise<void>;
};

export function createCostShapeTracker(
  store: ArtifactStore,
  budgetProfile: BudgetProfileName,
): CostShapeTracker {
  const shape: CostShape = {
    memoryReplayTried: false,
    memoryReplaySucceeded: false,
    oneShotPlanTried: false,
    oneShotPlanSucceeded: false,
    reproducerAgentUsed: false,
    fixerAgentUsed: false,
    analyzeIssueCalled: false,
    memoryReflectionCalled: false,
    reproducerTurns: 0,
    reproducerFailureCode: null,
    fixerTurns: 0,
    fixerPatchAttempts: 0,
    fixerFailureCode: null,
    budgetProfile,
    compactionEvents: 0,
    resolvedEfficiencyPolicy: null,
    inputTokensTotal: null,
    outputTokensTotal: null,
    cacheReadTokensTotal: null,
    cacheWriteTokensTotal: null,
    estimatedInferenceCostUsd: null,
    cacheHitTurns: 0,
    cacheMissTurns: 0,
    fixerParallelBatches: 0,
    fixerBatchedReads: 0,
    fixerReadManyCalls: 0,
    fixerFilesReadThroughReadMany: 0,
    fixerRunCodeCalls: 0,
    fixerRunCodeTimeouts: 0,
    fixerRunCodeInvalidResults: 0,
    fixerSuccessfulInspections: 0,
    reproducerRunStepsCalls: 0,
    reproducerBatchedActions: 0,
    reproducerActionDeltaBytes: 0,
    reproducerReadPageCalls: 0,
    warmStartUsed: false,
  };

  return {
    shape,
    update: async (fields) => {
      Object.assign(shape, fields);

      try {
        await store.writeJson("cost-shape.json", shape);
      } catch {
        // Telemetry only; never fail the investigation over it.
      }
    },
  };
}
