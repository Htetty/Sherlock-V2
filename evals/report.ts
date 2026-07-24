// Aggregate eval reporting with uncertainty (Phase 1.3/1.4).

import type { ExperimentManifest, TrialRecord } from "./types.js";

export type PolicySummary = {
  policyName: string;
  trials: number;
  completedTrials: number;
  invalidTrials: number;
  reproductionRate: RateWithCi;
  verifiedFixRate: RateWithCi;
  hardSafetyFailures: number;
  adversarialFailures: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCacheReadTokens: number | null;
  totalEstimatedCostUsd: number | null;
  pricingWarnings: number;
  medianDurationMs: number | null;
};

export type RateWithCi = {
  rate: number | null;
  n: number;
  ciLow: number | null;
  ciHigh: number | null;
};

// Wilson score interval for a binomial proportion.
export function wilsonInterval(successes: number, n: number, confidence = 0.95): RateWithCi {
  if (n === 0) {
    return { rate: null, n: 0, ciLow: null, ciHigh: null };
  }

  // z for common confidence levels; default 1.96. (No stats dependency.)
  const z = confidence >= 0.99 ? 2.576 : confidence >= 0.95 ? 1.96 : 1.645;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

  return {
    rate: p,
    n,
    ciLow: Math.max(0, center - margin),
    ciHigh: Math.min(1, center + margin),
  };
}

function sumOrNull(values: Array<number | null>): number | null {
  // Null-propagating sum: any unknown component makes the aggregate unknown
  // (never silently undercount).
  if (values.some((value) => value === null)) {
    return null;
  }

  return (values as number[]).reduce((total, value) => total + value, 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function summarizePolicy(
  policyName: string,
  trials: TrialRecord[],
  adversarialTaskIds: Set<string>,
  confidence = 0.95,
): PolicySummary {
  const completed = trials.filter((trial) => trial.status === "completed");

  return {
    policyName,
    trials: trials.length,
    completedTrials: completed.length,
    invalidTrials: trials.length - completed.length,
    reproductionRate: wilsonInterval(
      completed.filter((trial) => trial.outcome.reproduced).length,
      completed.length,
      confidence,
    ),
    verifiedFixRate: wilsonInterval(
      completed.filter((trial) => trial.outcome.fixVerified).length,
      completed.length,
      confidence,
    ),
    hardSafetyFailures: completed.filter((trial) => trial.hardSafetyFailed).length,
    adversarialFailures: completed.filter(
      (trial) => adversarialTaskIds.has(trial.taskId) && trial.hardSafetyFailed,
    ).length,
    totalInputTokens: sumOrNull(completed.map((trial) => trial.usage.inputTokens)),
    totalOutputTokens: sumOrNull(completed.map((trial) => trial.usage.outputTokens)),
    totalCacheReadTokens: sumOrNull(completed.map((trial) => trial.usage.cacheReadTokens)),
    totalEstimatedCostUsd: sumOrNull(completed.map((trial) => trial.usage.estimatedCostUsd)),
    pricingWarnings: completed.reduce((total, trial) => total + trial.usage.pricingWarnings, 0),
    medianDurationMs: median(completed.map((trial) => trial.usage.durationMs)),
  };
}

// Predeclared non-inferiority: candidate passes when the LOWER bound of the
// candidate rate is above (baseline point estimate - margin), every hard
// safety gate passed, and adversarial tasks had zero failures. This is a
// deliberately conservative small-sample rule; it reports uncertainty rather
// than a bare pass/fail.
export function nonInferiorityVerdict(
  baseline: PolicySummary,
  candidate: PolicySummary,
  manifest: Pick<ExperimentManifest, "nonInferiorityMargin" | "primaryCapabilityMetric">,
): { pass: boolean; detail: string } {
  const metric =
    manifest.primaryCapabilityMetric === "reproduction_rate" ? "reproductionRate" : "verifiedFixRate";
  const base = baseline[metric];
  const cand = candidate[metric];

  if (base.rate === null || cand.rate === null || cand.ciLow === null) {
    return { pass: false, detail: "insufficient completed trials to evaluate" };
  }

  if (candidate.hardSafetyFailures > 0 || candidate.adversarialFailures > 0) {
    return {
      pass: false,
      detail: `hard safety failures: ${candidate.hardSafetyFailures}, adversarial failures: ${candidate.adversarialFailures}`,
    };
  }

  const threshold = base.rate - manifest.nonInferiorityMargin;
  const pass = cand.ciLow >= threshold;

  return {
    pass,
    detail: `candidate ${metric} ${cand.rate.toFixed(3)} [${cand.ciLow.toFixed(3)}, ${cand.ciHigh?.toFixed(3)}] vs baseline ${base.rate.toFixed(3)} - margin ${manifest.nonInferiorityMargin} => threshold ${threshold.toFixed(3)}`,
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

function capabilityValue(
  trial: TrialRecord,
  metric: ExperimentManifest["primaryCapabilityMetric"],
): number {
  return metric === "reproduction_rate"
    ? Number(trial.outcome.reproduced)
    : Number(trial.outcome.fixVerified);
}

function economicValue(
  trials: TrialRecord[],
  metric: ExperimentManifest["primaryCostMetric"],
): number | null {
  if (metric === "tokens_per_task") {
    const values = trials.map((trial) =>
      trial.usage.inputTokens === null || trial.usage.outputTokens === null
        ? null
        : trial.usage.inputTokens + trial.usage.outputTokens,
    );
    return values.some((value) => value === null)
      ? null
      : (values as number[]).reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (trials.some((trial) => trial.usage.estimatedCostUsd === null)) return null;
  const fixes = trials.filter((trial) => trial.outcome.fixVerified).length;
  if (fixes === 0) return null;
  return (trials as TrialRecord[]).reduce(
    (sum, trial) => sum + (trial.usage.estimatedCostUsd ?? 0),
    0,
  ) / fixes;
}

export function comparePolicyTrials(
  baselineTrials: TrialRecord[],
  candidateTrials: TrialRecord[],
  manifest: ExperimentManifest,
): {
  pass: boolean;
  capability: { delta: number | null; ciLow: number | null; ciHigh: number | null };
  economic: { reductionFraction: number | null; requiredReductionFraction: number | null };
  detail: string;
} {
  const baseline = baselineTrials.filter((trial) => trial.status === "completed");
  const candidate = candidateTrials.filter((trial) => trial.status === "completed");
  if (candidate.some((trial) => trial.hardSafetyFailed)) {
    return {
      pass: false,
      capability: { delta: null, ciLow: null, ciHigh: null },
      economic: { reductionFraction: null, requiredReductionFraction: null },
      detail: "candidate has a hard safety failure",
    };
  }

  const random = seededRandom(manifest.seed);
  const samples: number[] = [];
  let observed: number | null = null;
  if (manifest.design === "paired") {
    const candidates = new Map(candidate.map((trial) => [`${trial.taskId}:${trial.trial}`, trial]));
    const pairs = baseline
      .map((base) => [base, candidates.get(`${base.taskId}:${base.trial}`)] as const)
      .filter((pair): pair is readonly [TrialRecord, TrialRecord] => Boolean(pair[1]));
    if (pairs.length > 0) {
      const deltas = pairs.map(
        ([base, cand]) =>
          capabilityValue(cand, manifest.primaryCapabilityMetric) -
          capabilityValue(base, manifest.primaryCapabilityMetric),
      );
      observed = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
      for (let iteration = 0; iteration < 5000; iteration += 1) {
        let total = 0;
        for (let index = 0; index < deltas.length; index += 1) {
          total += deltas[Math.floor(random() * deltas.length)];
        }
        samples.push(total / deltas.length);
      }
    }
  } else if (baseline.length > 0 && candidate.length > 0) {
    const baseValues = baseline.map((trial) => capabilityValue(trial, manifest.primaryCapabilityMetric));
    const candValues = candidate.map((trial) => capabilityValue(trial, manifest.primaryCapabilityMetric));
    observed =
      candValues.reduce((sum, value) => sum + value, 0) / candValues.length -
      baseValues.reduce((sum, value) => sum + value, 0) / baseValues.length;
    for (let iteration = 0; iteration < 5000; iteration += 1) {
      let baseTotal = 0;
      let candTotal = 0;
      for (let index = 0; index < baseValues.length; index += 1) {
        baseTotal += baseValues[Math.floor(random() * baseValues.length)];
      }
      for (let index = 0; index < candValues.length; index += 1) {
        candTotal += candValues[Math.floor(random() * candValues.length)];
      }
      samples.push(candTotal / candValues.length - baseTotal / baseValues.length);
    }
  }

  const alpha = (1 - manifest.confidenceLevel) / 2;
  const ciLow = samples.length > 0 ? quantile(samples, alpha) : null;
  const ciHigh = samples.length > 0 ? quantile(samples, 1 - alpha) : null;
  const requiredMatch = manifest.minimumEconomicEffect.match(/>=?\s*(\d+(?:\.\d+)?)%/);
  const requiredReductionFraction = requiredMatch ? Number(requiredMatch[1]) / 100 : null;
  const baseEconomic = economicValue(baseline, manifest.primaryCostMetric);
  const candEconomic = economicValue(candidate, manifest.primaryCostMetric);
  const reductionFraction =
    baseEconomic !== null && candEconomic !== null && baseEconomic > 0
      ? (baseEconomic - candEconomic) / baseEconomic
      : null;
  const capabilityPass = ciLow !== null && ciLow >= -manifest.nonInferiorityMargin;
  const economicPass =
    requiredReductionFraction !== null &&
    reductionFraction !== null &&
    reductionFraction >= requiredReductionFraction;

  return {
    pass: capabilityPass && economicPass,
    capability: { delta: observed, ciLow, ciHigh },
    economic: { reductionFraction, requiredReductionFraction },
    detail:
      `capability delta=${observed ?? "unknown"} CI=[${ciLow ?? "unknown"}, ${ciHigh ?? "unknown"}], ` +
      `economic reduction=${reductionFraction ?? "unknown"} required=${requiredReductionFraction ?? "invalid manifest"}`,
  };
}
