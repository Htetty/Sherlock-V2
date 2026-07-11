// Live-exploration vs official-replay divergence (REPRODUCER_LOOP_UPGRADE_PROMPT.md,
// Change 4b). Pure string/set comparison — no inference, no model calls, no
// agent imports. The dominant reproducer failure mode is a plan that worked
// live but fails in replay because exploration state did not carry over; this
// module surfaces exactly what was observed live and is absent from the
// replay, so the model can add the missing setup steps.

import type { ReproductionPlan } from "./plan.js";
import type { ReproductionResult } from "./playwright.js";
import { stripUrlOrigins, truncateUtf8Bytes } from "./reproduction-evidence.js";
import { redactSecrets } from "./report.js";

// Structural view of a reproducer finding (kept local so this module never
// imports an agent; ReproducerFinding is assignable to it).
export type LiveFinding = {
  kind: string;
  observation: string;
};

export type ReproducerDivergence = {
  // Failure signals seen live with no corresponding replay observation.
  missingInReplay: Array<{ kind: "response" | "runtime_error"; observation: string }>;
  // Routes requested/observed live (origin-free METHOD + path) that no plan step covers.
  uncoveredRoutes: string[];
  // Live element interactions with no counterpart plan step (by action + target text).
  uncoveredActions: string[];
  // True only when a live failure signal exists AND the replay ran clean.
  likelyMissingSetup: boolean;
};

export const MAX_DIVERGENCE_ITEMS = 5;
export const MAX_DIVERGENCE_ITEM_BYTES = 300;

function boundItem(text: string): string {
  return truncateUtf8Bytes(
    redactSecrets(text).replace(/\s+/g, " ").trim(),
    MAX_DIVERGENCE_ITEM_BYTES,
  );
}

function cap<T>(items: T[]): T[] {
  return items.slice(0, MAX_DIVERGENCE_ITEMS);
}

function originFreePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return stripUrlOrigins(url).trim() || url;
  }
}

// Parses "METHOD <url-or-path> -> STATUS" observations (the format produced by
// the reproducer's response findings and evidence renderers).
function parseResponseObservation(
  observation: string,
): { method: string; path: string; status: string } | null {
  const match = observation.match(/\b([A-Z]+)\s+(\S+)\s*->\s*(\S+)/);

  if (!match) {
    return null;
  }

  return { method: match[1], path: originFreePath(match[2]), status: match[3] };
}

function isFailureStatus(status: string): boolean {
  const parsed = Number(status);
  return Number.isFinite(parsed) && parsed >= 400;
}

export function computeReproducerDivergence(
  findings: LiveFinding[],
  plan: ReproductionPlan,
  replay: ReproductionResult,
): ReproducerDivergence {
  // --- Replay observation sets (origin-free) -------------------------------
  const replayResponses = new Set<string>();

  for (const response of replay.apiResponses ?? []) {
    replayResponses.add(
      `${response.method} ${originFreePath(response.url)} -> ${response.status}`,
    );
  }

  for (const failure of replay.networkFailures ?? []) {
    replayResponses.add(
      `${failure.method} ${originFreePath(failure.url)} -> ${failure.status ?? failure.failure}`,
    );
  }

  const replayErrors = [
    ...(replay.consoleErrors ?? []),
    ...(replay.pageErrors ?? []),
  ].map((error) => redactSecrets(error));

  // Plan coverage: routes referenced by goto/request steps, and the raw JSON
  // for target-text matching.
  const planPaths = new Set<string>();

  for (const step of plan.steps ?? []) {
    if ("path" in step && typeof step.path === "string") {
      planPaths.add(originFreePath(step.path));
    }
  }

  const planText = JSON.stringify(plan.steps ?? []);

  // --- Missing failure signals ------------------------------------------------
  const missingInReplay: ReproducerDivergence["missingInReplay"] = [];

  for (const finding of findings) {
    if (finding.kind === "response") {
      const parsed = parseResponseObservation(finding.observation);

      if (
        parsed &&
        isFailureStatus(parsed.status) &&
        !replayResponses.has(`${parsed.method} ${parsed.path} -> ${parsed.status}`)
      ) {
        missingInReplay.push({
          kind: "response",
          observation: boundItem(`${parsed.method} ${parsed.path} -> ${parsed.status}`),
        });
      }
    } else if (finding.kind === "runtime_error") {
      const observation = finding.observation;
      const seenInReplay = replayErrors.some(
        (error) => error.includes(observation) || observation.includes(error),
      );

      if (!seenInReplay) {
        missingInReplay.push({ kind: "runtime_error", observation: boundItem(observation) });
      }
    }
  }

  // --- Uncovered routes ---------------------------------------------------------
  const uncoveredRoutes: string[] = [];

  for (const finding of findings) {
    if (finding.kind !== "route" && finding.kind !== "response") {
      continue;
    }

    if (finding.kind === "response") {
      const parsed = parseResponseObservation(finding.observation);

      if (parsed && !planPaths.has(parsed.path)) {
        uncoveredRoutes.push(boundItem(`${parsed.method} ${parsed.path}`));
      }
      continue;
    }

    // route findings: extract origin-free paths mentioned in the observation.
    const stripped = stripUrlOrigins(finding.observation);
    const pathMatch = stripped.match(/(^|\s)(\/[^\s"|]*)/);

    if (pathMatch && !planPaths.has(originFreePath(pathMatch[2]))) {
      uncoveredRoutes.push(boundItem(pathMatch[2]));
    }
  }

  // --- Uncovered element interactions ---------------------------------------------
  const uncoveredActions: string[] = [];

  for (const finding of findings) {
    if (finding.kind !== "element") {
      continue;
    }

    // Element observations embed target values as quoted strings (from the
    // JSON-serialized intent target). Covered when any value appears in the
    // plan's steps.
    const values = [...finding.observation.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    if (values.length === 0) {
      continue; // Nothing comparable.
    }

    const covered = values.some((value) => planText.includes(value));

    if (!covered) {
      uncoveredActions.push(boundItem(finding.observation));
    }
  }

  const bounded: ReproducerDivergence = {
    missingInReplay: cap(dedupeBy(missingInReplay, (item) => `${item.kind}|${item.observation}`)),
    uncoveredRoutes: cap([...new Set(uncoveredRoutes)]),
    uncoveredActions: cap([...new Set(uncoveredActions)]),
    likelyMissingSetup: false,
  };

  bounded.likelyMissingSetup =
    bounded.missingInReplay.length > 0 && replay.outcome === "not_reproduced";

  return bounded;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const k = key(item);

    if (!seen.has(k)) {
      seen.add(k);
      result.push(item);
    }
  }

  return result;
}

export function hasDivergence(divergence: ReproducerDivergence): boolean {
  return (
    divergence.missingInReplay.length > 0 ||
    divergence.uncoveredRoutes.length > 0 ||
    divergence.uncoveredActions.length > 0
  );
}

// Rendered into replay feedback. Diagnostic wording only — divergence never
// proves anything. The "Likely cause" line appears ONLY when a live failure
// signal exists and the replay ran clean.
export function formatReproducerDivergence(divergence: ReproducerDivergence): string {
  if (!hasDivergence(divergence)) {
    return "";
  }

  const lines = ["DIVERGENCE (live exploration vs this replay):"];

  for (const item of divergence.missingInReplay) {
    lines.push(`- Observed live but absent from the replay: ${item.observation}`);
  }

  if (divergence.uncoveredRoutes.length > 0) {
    lines.push(`- Routes you used live with no plan step: ${divergence.uncoveredRoutes.join(", ")}`);
  }

  if (divergence.uncoveredActions.length > 0) {
    lines.push(`- Live interactions with no plan step: ${divergence.uncoveredActions.join("; ")}`);
  }

  if (divergence.likelyMissingSetup) {
    lines.push(
      "Likely cause: the plan depends on state your exploration created. Add the setup steps (and waits after async work) that produce that state, then resubmit.",
    );
  }

  return lines.join("\n");
}
