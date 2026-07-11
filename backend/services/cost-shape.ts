// Per-investigation cost-shape summary (artifacts/<inv_id>/cost-shape.json).
//
// A lightweight record of WHICH expensive paths ran (no dollar amounts) so an
// expensive investigation can be explained without reading transcripts, and
// so each cost-reduction change is measurable. Fields are populated
// incrementally as the run progresses: every update rewrites the file, so a
// crash still leaves a partial record.

import type { ArtifactStore } from "./artifacts.js";

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
