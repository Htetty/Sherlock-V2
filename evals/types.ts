// Eval task and trial schemas (FABLE_IMPLEMENTATION_PROMPT.md Phase 1.3/1.4).

import type { AgentPhase, InferencePolicy } from "../backend/services/inference.js";

export interface EvalTask {
  schemaVersion: 1;
  taskId: string;
  source: {
    kind: "local_fixture" | "authorized_remote";
    repoOwner: string;
    repoName: string;
    repoUrl?: string;
    commitSha: string;
    defaultBranch: string;
    // The recorded authority to process this repository (data-governance
    // gate). The runner refuses tasks whose authorization is empty.
    authorization: string;
  };
  issue: {
    number?: number;
    title: string;
    body: string;
  };
  environment: {
    setupCommands?: string[];
    requiredServices?: string[];
    network: "disabled" | "allowlisted";
    testCommands: string[];
    fixtures?: string[];
  };
  expected: {
    reproduced: boolean;
    fixVerified: boolean;
    expectedFailureEvidence?: string[];
    // Prefer forbidden paths + required outcomes over exact allowed paths so
    // a valid alternative fix is not rejected.
    forbiddenFiles?: string[];
    advisoryFiles?: string[];
    requiredOutcomes?: string[];
    safetyRules?: Array<
      | "no_secret_material"
      | "no_auth_bypass"
      | "no_test_weakening"
      | "no_workflow_changes"
    >;
  };
  provenance: {
    sourceArtifact: string;
    transformationVersion: string;
    redactionStatus: "pending" | "approved";
    humanReviewed: boolean;
    reviewer?: string;
  };
  // Hard gate: adversarial tasks fail the whole run on any safety violation,
  // regardless of aggregate scores.
  adversarial?: boolean;
}

export interface EvalPolicyConfig {
  name: string;
  budgetProfile?: "standard" | "deep";
  compaction?: boolean;
  parallelReads?: boolean;
  inference?: Partial<Record<AgentPhase, InferencePolicy>>;
}

// Experiment manifest (Phase 1.4): predeclared statistical contract. The
// runner refuses a full run without one; smoke runs (<= smokeTaskLimit tasks,
// 1 trial) are exempt.
export interface ExperimentManifest {
  schemaVersion: 1;
  experimentId: string;
  hypothesis: string;
  primaryCapabilityMetric: "verified_fix_rate" | "reproduction_rate";
  primaryCostMetric: "cost_per_verified_fix_usd" | "tokens_per_task";
  design: "paired" | "unpaired";
  designRationale: string;
  tasks: number;
  trialsPerTask: number;
  confidenceLevel: number; // e.g. 0.95
  ciMethod: "wilson" | "bootstrap";
  nonInferiorityMargin: number; // absolute rate, e.g. 0.05
  minimumEconomicEffect: string; // e.g. ">=30% input-token reduction"
  multipleComparisonPolicy: string;
  invalidTrialPolicy: string;
  seed: number;
  versions: {
    taskSet: string;
    code: string; // git SHA
    prompts: string;
    models: string[];
    graders: string;
    pricing: string;
    environment: string;
  };
  budget: {
    maxLogicalModelCalls: number;
    maxHttpAttempts: number;
    maxEstimatedTokens: number;
    maxEstimatedCostUsd: number;
    maxWallTimeMinutes: number;
    approvedBy: string; // paid-evaluation gate approval
  };
}

export type GraderVerdict = {
  grader: string;
  kind: "deterministic" | "heuristic" | "model";
  passed: boolean | null; // null = not applicable / could not run
  severity?: "info" | "warning" | "hard_fail";
  detail: string;
};

export interface TrialRecord {
  schemaVersion: 1;
  experimentId: string;
  taskId: string;
  policyName: string;
  trial: number;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "invalid_setup" | "infrastructure_failed" | "timeout" | "grader_failed";
  outcome: {
    reproduced: boolean;
    fixVerified: boolean;
    finalOutcome: string;
    failureCode: string | null;
    reproductionPath: string | null;
  };
  graders: GraderVerdict[];
  hardSafetyFailed: boolean;
  usage: {
    logicalModelCalls: number;
    httpAttempts: number;
    estimatedTokens: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    estimatedCostUsd: number | null; // null when any call had unknown pricing
    pricingWarnings: number;
    durationMs: number;
  };
  artifactDir: string | null;
}
