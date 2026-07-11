// Shared, pure reproduction evidence contract (AGENT_LOOP_UPGRADE_PROMPT.md,
// Change 1). One bounded summary + deterministic signature used by the
// verifier (fix.ts), fixer retry feedback and compaction (fixer.ts), and
// failed-attempt memory (memory.ts). Pure: never mutates ReproductionResult,
// never imports an agent.

import type { ReproductionOutcome, ReproductionResult } from "./playwright.js";
import { redactSecrets } from "./report.js";

// --- Limits ------------------------------------------------------------------

export const MAX_EVIDENCE_ITEMS_PER_KIND = 5;
export const MAX_EVIDENCE_ITEM_BYTES = 300;
export const MAX_FAILURE_SIGNATURE_BYTES = 800;
export const MAX_EVIDENCE_SUMMARY_BYTES = 4 * 1024;

// --- Contract ------------------------------------------------------------------

export type ReproductionEvidenceSummary = {
  outcome: ReproductionOutcome;
  outcomeReason: string;
  assertion: {
    observed: string | null;
    detail: string;
    matchedFailure: boolean;
    matchedExpected: boolean;
  } | null;
  failedStep: {
    id: string;
    action: string;
    error: string;
    ambiguous: boolean;
  } | null;
  consoleErrors: string[];
  consoleErrorCount: number;
  pageErrors: string[];
  pageErrorCount: number;
  networkFailures: string[];
  networkFailureCount: number;
  apiResponses: string[];
  apiResponseCount: number;
  signature: string;
};

// --- UTF-8 byte-bounded truncation ----------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);

  if (bytes.length <= maxBytes) {
    return text;
  }

  // Decode the prefix; a code point split at the boundary is dropped by
  // decoding with replacement then stripping the trailing replacement char.
  const decoded = decoder.decode(bytes.slice(0, Math.max(0, maxBytes)));
  return decoded.replace(/�+$/u, "");
}

function boundItem(text: string): string {
  return truncateUtf8Bytes(redactSecrets(text), MAX_EVIDENCE_ITEM_BYTES);
}

function boundItems(items: string[]): string[] {
  return items.slice(0, MAX_EVIDENCE_ITEMS_PER_KIND).map(boundItem);
}

// --- Origin stripping (signature stability across runs) --------------------------
//
// Signatures are persisted into memory and compared across investigations,
// but the sandbox origin (http://localhost:<ephemeral port>) differs between
// runs. Signature components must be origin-free: METHOD path -> status.

export function stripUrlOrigins(text: string): string {
  return text.replace(/https?:\/\/[^/\s"')\]]+/gi, "");
}

// --- Summary --------------------------------------------------------------------

export function summarizeReproductionEvidence(
  result: ReproductionResult,
): ReproductionEvidenceSummary {
  // Defensive against loosely-shaped results (e.g. injected test fixtures):
  // missing arrays become empty, missing strings become placeholders.
  const steps = result.steps ?? [];
  const failedRecord = steps.find((step) => step.outcome === "failed") ?? null;

  const failedStep = failedRecord
    ? {
        id: boundItem(failedRecord.id),
        action: boundItem(failedRecord.action),
        error: boundItem(failedRecord.error ?? "(no error recorded)"),
        ambiguous: failedRecord.ambiguous ?? false,
      }
    : null;

  const assertion = result.assertion
    ? {
        observed:
          result.assertion.observed == null
            ? null
            : boundItem(result.assertion.observed),
        detail: boundItem(result.assertion.detail ?? ""),
        matchedFailure: result.assertion.matchedFailure ?? false,
        matchedExpected: result.assertion.matchedExpected ?? false,
      }
    : null;

  const summary: ReproductionEvidenceSummary = {
    outcome: result.outcome,
    outcomeReason: boundItem(result.outcomeReason ?? ""),
    assertion,
    failedStep,
    consoleErrors: boundItems(result.consoleErrors ?? []),
    consoleErrorCount: (result.consoleErrors ?? []).length,
    pageErrors: boundItems(result.pageErrors ?? []),
    pageErrorCount: (result.pageErrors ?? []).length,
    networkFailures: boundItems(
      (result.networkFailures ?? []).map(
        (failure) =>
          `${failure.method} ${failure.url} -> ${failure.status ?? failure.failure}`,
      ),
    ),
    networkFailureCount: (result.networkFailures ?? []).length,
    apiResponses: boundItems(
      (result.apiResponses ?? []).map(
        (response) => `${response.method} ${response.url} -> ${response.status}`,
      ),
    ),
    apiResponseCount: (result.apiResponses ?? []).length,
    signature: "",
  };

  summary.signature = buildSignature(summary, result);
  return enforceSummaryByteCap(summary);
}

// Drop bounded detail arrays before core evidence when the aggregate JSON
// representation exceeds the advertised contract cap. Counts preserve the
// size of the original evidence even when individual items are omitted.
function enforceSummaryByteCap(
  summary: ReproductionEvidenceSummary,
): ReproductionEvidenceSummary {
  const bounded: ReproductionEvidenceSummary = {
    ...summary,
    consoleErrors: [...summary.consoleErrors],
    pageErrors: [...summary.pageErrors],
    networkFailures: [...summary.networkFailures],
    apiResponses: [...summary.apiResponses],
  };
  const arrays = [
    bounded.apiResponses,
    bounded.networkFailures,
    bounded.consoleErrors,
    bounded.pageErrors,
  ];

  while (
    Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_EVIDENCE_SUMMARY_BYTES &&
    arrays.some((items) => items.length > 0)
  ) {
    const largest = arrays.reduce((current, items) =>
      items.length > current.length ? items : current,
    );
    largest.pop();
  }

  // Core fields are individually bounded, so removing arrays should normally
  // be sufficient. Keep the aggregate guarantee defensive for unusually long
  // step ids/actions or future contract additions.
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_EVIDENCE_SUMMARY_BYTES) {
    bounded.outcomeReason = truncateUtf8Bytes(bounded.outcomeReason, 128);
    if (bounded.assertion) {
      bounded.assertion.observed = bounded.assertion.observed === null
        ? null
        : truncateUtf8Bytes(bounded.assertion.observed, 128);
      bounded.assertion.detail = truncateUtf8Bytes(bounded.assertion.detail, 128);
    }
    if (bounded.failedStep) {
      bounded.failedStep.id = truncateUtf8Bytes(bounded.failedStep.id, 96);
      bounded.failedStep.action = truncateUtf8Bytes(bounded.failedStep.action, 64);
      bounded.failedStep.error = truncateUtf8Bytes(bounded.failedStep.error, 128);
    }
  }

  return bounded;
}

// Deterministic, bounded, origin-free failure signature. Priority order:
// outcome, assertion observed/detail, first failed step, first console/page
// error, first API/network status. Not cryptographic — a comparison key.
function buildSignature(
  summary: ReproductionEvidenceSummary,
  result: ReproductionResult,
): string {
  const parts: string[] = [summary.outcome];

  if (summary.assertion) {
    parts.push(
      summary.assertion.observed !== null
        ? `assertion observed ${JSON.stringify(summary.assertion.observed)}`
        : `assertion ${summary.assertion.detail}`,
    );
  }

  if (summary.failedStep) {
    parts.push(
      `step ${summary.failedStep.id} (${summary.failedStep.action}): ${summary.failedStep.error}`,
    );
  }

  const firstError = summary.pageErrors[0] ?? summary.consoleErrors[0];

  if (firstError) {
    parts.push(firstError);
  }

  const networkFailures = result.networkFailures ?? [];
  const errorResponse = (result.apiResponses ?? []).find(
    (response) => response.status >= 400,
  );
  const firstNetwork = networkFailures[0]
    ? redactSecrets(
        `${networkFailures[0].method} ${originFreePath(networkFailures[0].url)} -> ${networkFailures[0].status ?? networkFailures[0].failure}`,
      )
    : errorResponse
      ? `${errorResponse.method} ${originFreePath(errorResponse.url)} -> ${errorResponse.status}`
      : null;

  if (firstNetwork) {
    parts.push(firstNetwork);
  }

  return truncateUtf8Bytes(
    stripUrlOrigins(parts.join(" | ")).replace(/\s+/g, " ").trim(),
    MAX_FAILURE_SIGNATURE_BYTES,
  );
}

function originFreePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return stripUrlOrigins(url);
  }
}

// --- Delta formatting --------------------------------------------------------------
//
// Rendered into fixer retry feedback. Signature lines must survive
// truncation: the core block is built first and never trimmed; detail lines
// are appended only while they fit within maxBytes.

export function formatReproductionEvidenceDelta(
  before: ReproductionEvidenceSummary,
  after: ReproductionEvidenceSummary,
  maxBytes: number,
): string {
  const changed = before.signature !== after.signature;

  const fixedCore = [
    "EVIDENCE DELTA",
    "Before signature: ",
    "After signature:  ",
    `Signature changed: ${changed ? "yes" : "no"}`,
  ].join("\n");
  const signatureBudget = Math.max(
    0,
    Math.floor(
      (maxBytes - encoder.encode(fixedCore).length) / 2,
    ),
  );
  const core = [
    "EVIDENCE DELTA",
    `Before signature: ${truncateUtf8Bytes(before.signature, signatureBudget)}`,
    `After signature:  ${truncateUtf8Bytes(after.signature, signatureBudget)}`,
    `Signature changed: ${changed ? "yes" : "no"}`,
  ].join("\n");

  const newErrors = [...after.consoleErrors, ...after.pageErrors].filter(
    (error) => !before.consoleErrors.includes(error) && !before.pageErrors.includes(error),
  );

  const details = [
    `Before assertion observed: ${before.assertion?.observed ?? "(none)"}`,
    `After assertion observed: ${after.assertion?.observed ?? "(none)"}`,
    `Before failed step: ${before.failedStep ? `${before.failedStep.id} (${before.failedStep.action})` : "(none)"}`,
    `After failed step: ${after.failedStep ? `${after.failedStep.id} (${after.failedStep.action})` : "(none)"}`,
    `Console errors: before ${before.consoleErrorCount}, after ${after.consoleErrorCount}`,
    `Page errors: before ${before.pageErrorCount}, after ${after.pageErrorCount}`,
    `New post-patch errors: ${newErrors.length > 0 ? newErrors.join(" | ") : "(none)"}`,
    "",
    "Interpretation:",
    "- An identical signature means this exact patch did not move the observed failure. Do not retry the same hypothesis unchanged.",
    "- A changed signature means the patch affected behavior. Use the new evidence to refine the patch, but do not assume the change is an improvement.",
  ];

  let text = core;

  for (const line of details) {
    const candidate = `${text}\n${line}`;

    if (encoder.encode(candidate).length > maxBytes) {
      break;
    }

    text = candidate;
  }

  return truncateUtf8Bytes(text, maxBytes);
}
