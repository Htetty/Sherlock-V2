// Pure, deterministic Markdown renderer for the public GitHub issue report.
//
// This module owns the VISIBLE structure of every Sherlock issue comment:
// the queued placeholder, the terminal investigation report, and the
// pre-pipeline worker-failure report. It never talks to GitHub, never reads
// the filesystem, and never consumes preformatted Markdown from another
// renderer — it renders from structured data only.
//
// Privacy contract (enforced per field, before assembly):
//   - no investigation or fix-attempt ids in visible text (hidden markers are
//     appended by the callers, never rendered here);
//   - no localhost/loopback/container/ephemeral-port URLs (origins stripped);
//   - no secrets (redactSecrets);
//   - no raw HTML or embedded comment markers from field text;
//   - every field is bounded BEFORE rendering so headings, lists, and
//     <details> blocks stay structurally valid — the finished document is
//     never truncated as a whole.

import { redactSecrets, type InvestigationSummary } from "./report.js";
import type { FixAttemptResult } from "./fix.js";

// --- Structured report data (persisted as the v2 terminal payload) -----------

export type ReportCheck = {
  name: string;
  status: "passed" | "failed" | "advisory";
  detail: string;
};

export type ReportRegression = {
  status: "proven" | "blocked" | "unavailable";
  testName: string | null;
  prePatch: string | null;
  postPatch: string | null;
  hashMatched: boolean | null;
  reason: string | null;
};

export type InvestigationReportData = {
  // Terminal pipeline outcome, or "failed" for pre-pipeline worker failures.
  outcome: string;
  originalOutcome: string | null;
  // Trustworthy root cause: only set from a verified fix attempt. When null,
  // the report says the root cause was not established instead of promoting
  // an unverified guess.
  rootCause: string | null;
  fixSummary: string | null;
  // Non-verified fix attempts: what happened and why, without claiming a fix.
  fixOutcome: string | null;
  fixReason: string | null;
  changedFiles: string[];
  verification: {
    // Outcome of replaying the exact saved reproduction after the patch.
    exactReplay: "passed" | "failed" | null;
    repository: { category: string; status: string }[] | null;
    regression: ReportRegression | null;
  };
  limitations: string[];
  technicalEvidence: {
    expected: string | null;
    observed: string | null;
    reproductionMode: string | null;
    evidence: {
      screenshots: number;
      consoleErrors: number;
      networkFailures: number;
      failedAssertions: number;
    } | null;
    failedChecks: ReportCheck[];
    stage: string | null;
    error: string | null;
    planErrors: string[];
    analysis: string | null;
  };
};

// Pull-request delivery state, provided by the caller at render time (the
// delivery layer after reconciliation, or the pipeline's pre-delivery view).
export type ReportPullRequest = {
  status:
    | "created"
    | "reused"
    | "merged"
    | "blocked"
    | "failed"
    | "pending"
    | "not_applicable";
  url: string | null;
};

// --- Field sanitization -------------------------------------------------------

const MAX_ROOT_CAUSE_CHARS = 700;
const MAX_FIX_SUMMARY_CHARS = 400;
const MAX_LIMITATION_CHARS = 300;
const MAX_OBSERVED_CHARS = 400;
const MAX_ERROR_CHARS = 1_600;
const MAX_ANALYSIS_CHARS = 900;
const MAX_PLAN_ERROR_CHARS = 250;
const MAX_PLAN_ERRORS = 3;
const MAX_CHECK_DETAIL_CHARS = 300;
const MAX_FAILED_CHECKS = 8;
const MAX_CHANGED_FILES = 20;
const MAX_FILE_PATH_CHARS = 200;
const MAX_LIMITATIONS = 8;
const MAX_REASON_CHARS = 300;

// Sherlock-internal tokens and operational details that must never surface in
// public text, even when they arrive through a model field, error, command, or
// repository-controlled filename.
// Generated ids use an uppercase alphanumeric body (see artifacts.ts). Some
// operational surfaces decorate that identity with underscore-delimited
// suffixes, so consume those suffixes as part of the same private value. Keep
// the uppercase core deliberate: ordinary repository prose such as
// `fix_config` is not an internal id.
const INTERNAL_ID_PATTERN =
  /\b(?:inv|fix)_[0-9A-Z]{6,}(?:_[0-9A-Za-z-]+)*(?![0-9A-Za-z_])/g;
const INTERNAL_MARKER_PATTERN =
  /sherlock-(?:delivery|terminal)-comment\s*:[^\s<`]*/gi;
const INTERNAL_RUNTIME_DIRECTORY =
  String.raw`(?:artifacts|fix-attempts|protected-delivery|_delivery-locks|screenshots?|evidence|tool-calls|workspaces?|memory|graphs|graphify-out|repro-agent|fix-agent|exploration|replays|replay-\d+)`;
const INTERNAL_PATH_PATTERN = new RegExp(
  String.raw`(?:\.{0,2}[\\/])?(?:[^\s\x60"')\]]+[\\/])*${INTERNAL_RUNTIME_DIRECTORY}[\\/][^\s\x60"')\]]+|[\\/](?:private[\\/])?(?:tmp|var[\\/]folders)[\\/][^\s\x60"')\]]+`,
  "gi",
);
const INTERNAL_WORKSPACE_PATH_PATTERN =
  /(?:\S*[\\/])?(?:sherlock-(?:runtime|delivery-index|git-auth)-|handoff-)[0-9A-Za-z._-]+[\\/][^\s`"')\]]+/gi;
// Exact Sherlock artifact basenames. Exact matching avoids treating ordinary
// repository JSON such as src/config/settings.json as an internal artifact.
const INTERNAL_ARTIFACT_FILENAMES = [
  "api-trace.json",
  "build-result.json",
  "claude-analysis.json",
  "commit-result.json",
  "console-errors.json",
  "cost-shape.json",
  "delivery-state.json",
  "failure-evidence.json",
  "fix-proposal.json",
  "git-diff.patch",
  "investigation.json",
  "mode.json",
  "rendered.txt",
  "selection.json",
  "graph.json",
  "network-failures.json",
  "patch-validation.json",
  "playwright-events.json",
  "post-patch-reproduction-result.json",
  "proposed.patch",
  "pull-request-result.json",
  "regression-postpatch-result.json",
  "regression-prepatch-result.json",
  "regression-test-source.mjs",
  "regression-test.json",
  "replay-mode.json",
  "replay-summary.json",
  "repo-context-refined.json",
  "repo-context.json",
  "repository-validation.json",
  "reproducer-findings.json",
  "reproduction-evidence-summary.json",
  "reproduction-plan-raw.json",
  "reproduction-plan.json",
  "reproduction-result.json",
  "summary.json",
  "terminal-failure.json",
  "test-results.json",
  "transcript.json",
  "verification-result.json",
  "validation-build-stderr.log",
  "validation-build-stdout.log",
  "validation-lint-stderr.log",
  "validation-lint-stdout.log",
  "validation-test-stderr.log",
  "validation-test-stdout.log",
  "validation-typecheck-stderr.log",
  "validation-typecheck-stdout.log",
  "visual-evidence.json",
  "workspace-after.json",
  "workspace-before.json",
] as const;
const INTERNAL_ARTIFACT_PATTERN = new RegExp(
  `(?<![A-Za-z0-9._/\\-])(?:${INTERNAL_ARTIFACT_FILENAMES.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})(?![A-Za-z0-9._/\\-])`,
  "gi",
);
const CONTAINER_NAME_PATTERN =
  /\b(?:host\.docker\.internal|[0-9a-f]{12,64}|(?:sherlock|docker|compose|container)[-_](?:target|app|sandbox|worker|service|container)?[-_]?[0-9a-z][0-9a-z_-]{2,})\b/gi;
const SERVICE_HOST =
  String.raw`(?:db|database|redis|postgres|postgresql|mysql|mariadb|mongo(?:db)?|cache|queue|broker|app|api|web|frontend|backend|server|service|worker|container)(?:[-_][a-z0-9][a-z0-9_-]*)?`;
const SERVICE_ENDPOINT_URL_PATTERN = new RegExp(
  String.raw`\b[a-z][a-z0-9+.-]*:\/\/${SERVICE_HOST}:\d{2,5}(?:[^\s<]*)?`,
  "gi",
);
const SERVICE_ENDPOINT_PATTERN = new RegExp(
  String.raw`\b${SERVICE_HOST}:\d{2,5}\b`,
  "gi",
);
// Compose permits arbitrary service labels. Match arbitrary single-label
// services only on common application/infrastructure ports; hyphenated or
// underscored service labels are sufficiently endpoint-shaped to accept any
// port. This avoids corrupting source locations such as server.ts:42.
const COMPOSE_COMMON_PORT =
  String.raw`(?:3000|3306|4000|4200|5000|5173|5432|6379|8000|8080|8443|9000|9090|27017|49152)`;
const COMPOSE_ENDPOINT_PATTERN = new RegExp(
  String.raw`\b(?:[a-z][a-z0-9_-]{0,62}[-_][a-z0-9][a-z0-9_-]{0,62}:\d{2,5}|[a-z][a-z0-9_-]{1,62}:${COMPOSE_COMMON_PORT})\b`,
  "gi",
);
const COMPOSE_ENDPOINT_URL_PATTERN = new RegExp(
  String.raw`\b(?:https?|wss?):\/\/(?:[a-z][a-z0-9_-]{0,62}[-_][a-z0-9][a-z0-9_-]{0,62}:\d{2,5}|[a-z][a-z0-9_-]{1,62}:${COMPOSE_COMMON_PORT})(?:[^\s<]*)?`,
  "gi",
);
const PRIVATE_IPV4 =
  String.raw`(?:0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})`;
const PRIVATE_IPV6 =
  String.raw`(?:::1|0:0:0:0:0:0:0:1|::ffff:127\.0\.0\.1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*)`;
const PRIVATE_ENDPOINT_URL_PATTERN = new RegExp(
  String.raw`\b(?:https?|wss?):\/\/(?:${PRIVATE_IPV4}|\[${PRIVATE_IPV6}\]):\d{1,5}(?:[^\s<]*)?`,
  "gi",
);
const PROTOCOL_RELATIVE_PRIVATE_ENDPOINT_PATTERN = new RegExp(
  String.raw`\/\/(?:${PRIVATE_IPV4}|\[${PRIVATE_IPV6}\]):\d{1,5}(?:[^\s<]*)?`,
  "gi",
);
const BARE_PRIVATE_ENDPOINT_PATTERN = new RegExp(
  String.raw`(?:\b${PRIVATE_IPV4}:\d{1,5}\b|\[${PRIVATE_IPV6}\]:\d{1,5})`,
  "gi",
);
const LOCAL_HOST =
  String.raw`(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[?(?:::1|0:0:0:0:0:0:0:1|::ffff:127\.0\.0\.1)\]?)`;
const LOCAL_URL_PATTERN = new RegExp(
  String.raw`\b(?:https?|wss?):\/\/${LOCAL_HOST}(?::\d{1,5})?[^\s<]*`,
  "gi",
);
const PROTOCOL_RELATIVE_LOCAL_PATTERN = new RegExp(
  String.raw`\/\/${LOCAL_HOST}(?::\d{1,5})?[^\s<]*`,
  "gi",
);
const BARE_LOCAL_PATTERN = new RegExp(
  String.raw`\b${LOCAL_HOST}(?::\d{1,5})?\b`,
  "gi",
);
const BARE_IPV6_LOOPBACK_PATTERN =
  /(?:\[?(?:::1|0:0:0:0:0:0:0:1|::ffff:127\.0\.0\.1)\]?)(?::\d{1,5})?/gi;
const ENCODED_LOCAL_URL_PATTERN =
  /(?:https?|wss?)%3a%2f%2f(?:localhost|0%2e0%2e0%2e0|127(?:%2e\d{1,3}){3}|%5b?%3a%3a1%5d?)(?:%3a\d{1,5})?(?:%2f[^\s]*)?/gi;
const ANY_WEB_URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s<>()\]]+/gi;
const RAW_PATCH_PATTERN = /(?:^|\s)(?:diff --git\b|\*\*\* Begin Patch\b)[\s\S]*/gim;

function stripHtmlAndMarkers(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(INTERNAL_MARKER_PATTERN, "[internal marker]")
    .replace(/<\/?(?:details|summary)\b[^>]*>/gi, " ")
    .replace(/<(?=[a-zA-Z/!])/g, "&lt;");
}

// Privacy scrub shared by each context-specific sanitizer below. Markdown is
// deliberately handled later because prose, titles, code spans, and diagnostic
// blocks require different escaping rules.
function scrubPublicText(text: string): string {
  return stripHtmlAndMarkers(redactSecrets(text))
    .replace(PRIVATE_ENDPOINT_URL_PATTERN, "[private endpoint]")
    .replace(PROTOCOL_RELATIVE_PRIVATE_ENDPOINT_PATTERN, "[private endpoint]")
    .replace(BARE_PRIVATE_ENDPOINT_PATTERN, "[private endpoint]")
    .replace(COMPOSE_ENDPOINT_URL_PATTERN, "[service endpoint]")
    .replace(SERVICE_ENDPOINT_URL_PATTERN, "[service endpoint]")
    .replace(SERVICE_ENDPOINT_PATTERN, "[service endpoint]")
    .replace(COMPOSE_ENDPOINT_PATTERN, "[service endpoint]")
    .replace(ENCODED_LOCAL_URL_PATTERN, "[local address]")
    .replace(LOCAL_URL_PATTERN, "[local address]")
    .replace(PROTOCOL_RELATIVE_LOCAL_PATTERN, "[local address]")
    .replace(BARE_IPV6_LOOPBACK_PATTERN, "[local address]")
    .replace(BARE_LOCAL_PATTERN, "[local address]")
    .replace(ANY_WEB_URL_PATTERN, "[external link removed]")
    .replace(INTERNAL_WORKSPACE_PATH_PATTERN, "[internal workspace]")
    .replace(INTERNAL_PATH_PATTERN, "[internal path]")
    .replace(INTERNAL_ARTIFACT_PATTERN, "[internal artifact]")
    .replace(INTERNAL_ID_PATTERN, "[internal id]")
    .replace(CONTAINER_NAME_PATTERN, "[container]")
    .replace(RAW_PATCH_PATTERN, " [patch omitted]")
    .replace(/\bPORT\s*=\s*\d{2,5}\b/gi, "PORT=<dynamic>");
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function escapeInlineMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([`\[\]|])/g, "\\$1")
    .replace(/^([#>])(?=\s|$)/, "\\$1")
    .replace(/^([-+*])(?=\s)/, "\\$1")
    .replace(/^(\d+)\.(?=\s)/, "$1\\.");
}

// Single-line prose: safe at the beginning of a paragraph, list cell, or
// table cell. Links/images, headings, blockquotes, lists, code spans, pipes,
// HTML, and hidden markers cannot escape the renderer-owned structure.
export function sanitizeProseField(
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string") return null;
  const cleaned = escapeInlineMarkdown(
    scrubPublicText(value).replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? truncate(cleaned, maxChars) : null;
}

// Plain single-line title/label. GitHub titles are not Markdown bodies, so
// control syntax is removed rather than escaped with visible backslashes.
export function sanitizeTitleField(
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string") return null;
  const cleaned = scrubPublicText(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[`*_{}\[\]()#!>|\\<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? truncate(cleaned, maxChars) : null;
}

// Repository paths and other inline-code values retain useful slashes, dots,
// and digits while receiving the complete privacy scrub. Code-span fencing is
// handled separately by safeInlineCode.
export function sanitizeInlineCodeField(
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string") return null;
  const cleaned = scrubPublicText(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? truncate(cleaned, maxChars) : null;
}

export function sanitizeCommandField(
  value: unknown,
  maxChars: number,
): string | null {
  return sanitizeInlineCodeField(value, maxChars);
}

// Multi-line diagnostic text is rendered inside renderer-owned <pre><code>
// tags, not interpolated into Markdown lists or fences.
function diagnosticField(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = scrubPublicText(value)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned ? truncate(cleaned, maxChars) : null;
}

// Backward-compatible export name used by the PR renderer in the initial
// reporting refactor. It now has the stricter prose semantics.
export const sanitizeInlineField = sanitizeProseField;
const inlineField = sanitizeProseField;

export function safeInlineCode(value: string): string {
  const safe = value.replace(/\|/g, "&#124;");
  const runs = safe.match(/`+/g) ?? [];
  const fence = "`".repeat(
    Math.max(1, ...runs.map((run) => run.length + 1)),
  );
  const pad = /^`|`$|^ | $/.test(safe) ? " " : "";
  return `${fence}${pad}${safe}${pad}${fence}`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function diagnosticBlock(value: string): string {
  return `<pre><code>${escapeHtmlText(value)}</code></pre>`;
}

// --- Building report data from pipeline results --------------------------------

export function extractAnalysisText(analysis: unknown): string | null {
  if (typeof analysis === "string") {
    return analysis;
  }

  if (
    analysis &&
    typeof analysis === "object" &&
    "type" in analysis &&
    (analysis as { type?: unknown }).type === "text" &&
    typeof (analysis as { text?: unknown }).text === "string"
  ) {
    return (analysis as unknown as { text: string }).text;
  }

  return null;
}

export type InvestigationReportInput = {
  summary: InvestigationSummary;
  fixAttempt?: Pick<
    FixAttemptResult,
    | "outcome"
    | "reason"
    | "rootCause"
    | "summary"
    | "changedFiles"
    | "checks"
    | "postPatchOutcome"
    | "repositoryValidation"
    | "regressionTest"
  > | null;
  // Diagnostic model analysis (free text or a { type: "text", text } block).
  // Only ever rendered inside collapsed technical evidence, bounded.
  analysis?: unknown;
};

export function buildInvestigationReportData(
  input: InvestigationReportInput,
): InvestigationReportData {
  const { summary } = input;
  const fixAttempt = input.fixAttempt ?? null;
  const fixVerified = fixAttempt?.outcome === "verified";

  const limitations: string[] = [];
  const regression = fixAttempt?.regressionTest ?? null;
  const repository = fixAttempt?.repositoryValidation ?? null;

  if (fixVerified) {
    limitations.push(
      "The fix was verified in an isolated Sherlock workspace by replaying the recorded reproduction; adjacent behavior was not separately verified.",
    );
  }

  if (regression?.status === "blocked") {
    limitations.push(
      "The generated regression test could not prove the fix; verification relied on the exact reproduction replay.",
    );
  } else if (fixAttempt && regression?.status === "unavailable") {
    limitations.push(
      "No generated regression test was available for this fix.",
    );
  }

  if (fixAttempt && repository?.aggregate === "not_available") {
    limitations.push(
      "The repository declares no runnable validation scripts (test, typecheck, lint, or build), so repository validation could not run.",
    );
  } else if (repository) {
    for (const item of repository.categories) {
      if (item.status === "timed_out") {
        limitations.push(`The repository ${item.category} command timed out during validation.`);
      }
    }
  }

  return {
    outcome: summary.outcome,
    originalOutcome: summary.originalOutcome ?? null,
    rootCause: fixVerified ? (fixAttempt?.rootCause ?? null) : null,
    fixSummary: fixVerified ? (fixAttempt?.summary ?? null) : null,
    fixOutcome: fixAttempt && !fixVerified ? fixAttempt.outcome : null,
    fixReason: fixAttempt && !fixVerified ? (fixAttempt.reason || null) : null,
    changedFiles: fixVerified ? (fixAttempt?.changedFiles ?? []) : [],
    verification: fixAttempt
      ? {
          exactReplay:
            fixAttempt.postPatchOutcome === "not_reproduced"
              ? "passed"
              : fixAttempt.postPatchOutcome === "reproduced"
                ? "failed"
                : null,
          repository:
            repository?.categories.map((item) => ({
              category: item.category,
              status: item.status,
            })) ?? null,
          regression: regression
            ? {
                status: regression.status,
                testName: regression.testName,
                prePatch: regression.prePatch,
                postPatch: regression.postPatch,
                hashMatched: regression.hashMatched,
                reason: regression.reason,
              }
            : null,
        }
      : { exactReplay: null, repository: null, regression: null },
    limitations,
    technicalEvidence: {
      expected: summary.expected ?? null,
      observed: summary.observed ?? null,
      reproductionMode: summary.reproductionMode ?? null,
      evidence: summary.evidence ?? null,
      failedChecks:
        fixAttempt?.checks
          .filter((check) => check.status === "failed")
          .map((check) => ({
            name: check.name,
            status: check.status,
            detail: check.detail,
          })) ?? [],
      stage: summary.stage ?? null,
      error: summary.error ?? null,
      planErrors: summary.planErrors ?? [],
      analysis: extractAnalysisText(input.analysis ?? null),
    },
  };
}

export function buildWorkerFailureReportData(input: {
  error: string;
  stage?: string | null;
}): InvestigationReportData {
  return {
    outcome: "failed",
    originalOutcome: null,
    rootCause: null,
    fixSummary: null,
    fixOutcome: null,
    fixReason: null,
    changedFiles: [],
    verification: {
      exactReplay: null,
      repository: null,
      regression: null,
    },
    limitations: [
      "No investigation result is available. Any artifacts collected before the failure were preserved on the Sherlock server.",
    ],
    technicalEvidence: {
      expected: null,
      observed: null,
      reproductionMode: null,
      evidence: null,
      failedChecks: [],
      stage: input.stage ?? null,
      error: input.error,
      planErrors: [],
      analysis: null,
    },
  };
}

// Defensive normalization for report data loaded from a persisted payload.
// Rejects grossly invalid shapes; renderIssueReport additionally sanitizes
// and bounds every field at render time.
const REPORT_OUTCOMES = new Set([
  "verified_fix",
  "reproduced",
  "not_reproduced",
  "plan_failed",
  "environment_failed",
  "execution_failed",
  "failed",
]);
const ORIGINAL_OUTCOMES = new Set([
  "reproduced",
  "not_reproduced",
  "plan_failed",
  "environment_failed",
  "execution_failed",
]);
const FIX_OUTCOMES = new Set(Object.keys({
  rejected_reproduction_still_fails: true,
  rejected_build_failed: true,
  rejected_tests_failed: true,
  rejected_patch_invalid: true,
  rejected_environment_failed: true,
  rejected_verification_inconclusive: true,
  rejected_regression_test_failed: true,
}));
const REPOSITORY_CATEGORIES = new Set(["test", "typecheck", "lint", "build"]);
const REPOSITORY_STATUSES = new Set([
  "passed",
  "failed",
  "not_available",
  "timed_out",
]);
const REGRESSION_STATUSES = new Set(["proven", "blocked", "unavailable"]);
const REGRESSION_RUN_STATUSES = new Set([
  "failed_as_expected",
  "unexpectedly_passed",
  "invalid_test",
  "invalid_failure",
  "timed_out",
  "execution_failed",
  "passed",
  "failed",
]);

function boundedPayloadString(
  value: unknown,
  maxChars: number,
  label: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Investigation report ${label} is not a string.`);
  }
  return truncate(value, maxChars);
}

function boundedPayloadStrings(
  value: unknown,
  maxItems: number,
  maxChars: number,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Investigation report ${label} has an invalid size.`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`Investigation report ${label} contains a non-string.`);
    }
    return truncate(item, maxChars);
  });
}

function requirePayloadKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(
      `Investigation report ${label} is missing required fields: ${missing.join(", ")}.`,
    );
  }
}

// Strict runtime normalization for integrity-valid protected v2 payloads.
// Unknown enums and contradictory verified/failed claims are rejected before
// the delivery layer performs a comment create or update.
export function normalizeInvestigationReportData(
  value: unknown,
): InvestigationReportData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Investigation report data is not an object.");
  }
  const data = value as Record<string, unknown>;
  requirePayloadKeys(
    data,
    [
      "outcome",
      "originalOutcome",
      "rootCause",
      "fixSummary",
      "fixOutcome",
      "fixReason",
      "changedFiles",
      "verification",
      "limitations",
      "technicalEvidence",
    ],
    "data",
  );
  if (typeof data.outcome !== "string" || !REPORT_OUTCOMES.has(data.outcome)) {
    throw new Error("Investigation report data has an unknown outcome.");
  }
  if (!data.verification || typeof data.verification !== "object") {
    throw new Error("Investigation report verification is missing.");
  }
  if (!data.technicalEvidence || typeof data.technicalEvidence !== "object") {
    throw new Error("Investigation report technical evidence is missing.");
  }

  const verification = data.verification as Record<string, unknown>;
  const evidence = data.technicalEvidence as Record<string, unknown>;
  requirePayloadKeys(
    verification,
    ["exactReplay", "repository", "regression"],
    "verification",
  );
  requirePayloadKeys(
    evidence,
    [
      "expected",
      "observed",
      "reproductionMode",
      "evidence",
      "failedChecks",
      "stage",
      "error",
      "planErrors",
      "analysis",
    ],
    "technical evidence",
  );
  const originalOutcome = boundedPayloadString(
    data.originalOutcome,
    40,
    "original outcome",
  );
  if (originalOutcome !== null && !ORIGINAL_OUTCOMES.has(originalOutcome)) {
    throw new Error("Investigation report has an unknown original outcome.");
  }
  const rootCause = boundedPayloadString(data.rootCause, 2_000, "root cause");
  const fixSummary = boundedPayloadString(data.fixSummary, 1_000, "fix summary");
  const fixOutcome = boundedPayloadString(data.fixOutcome, 80, "fix outcome");
  if (fixOutcome !== null && !FIX_OUTCOMES.has(fixOutcome)) {
    throw new Error("Investigation report has an unknown fix outcome.");
  }
  const changedFiles = boundedPayloadStrings(
    data.changedFiles,
    MAX_CHANGED_FILES,
    500,
    "changed files",
  );

  const exactReplay = verification.exactReplay;
  if (exactReplay !== null && exactReplay !== "passed" && exactReplay !== "failed") {
    throw new Error("Investigation report has an unknown replay status.");
  }

  let repository: { category: string; status: string }[] | null = null;
  if (verification.repository !== null) {
    if (!Array.isArray(verification.repository) || verification.repository.length > 4) {
      throw new Error("Investigation report repository validation is invalid.");
    }
    repository = verification.repository.map((item) => {
      if (!item || typeof item !== "object") {
        throw new Error("Investigation report repository validation is invalid.");
      }
      const entry = item as Record<string, unknown>;
      requirePayloadKeys(entry, ["category", "status"], "repository validation");
      if (
        typeof entry.category !== "string" ||
        !REPOSITORY_CATEGORIES.has(entry.category) ||
        typeof entry.status !== "string" ||
        !REPOSITORY_STATUSES.has(entry.status)
      ) {
        throw new Error("Investigation report repository validation is invalid.");
      }
      return { category: entry.category, status: entry.status };
    });
  }

  let regression: ReportRegression | null = null;
  if (verification.regression !== null) {
    if (!verification.regression || typeof verification.regression !== "object") {
      throw new Error("Investigation report regression validation is invalid.");
    }
    const item = verification.regression as Record<string, unknown>;
    requirePayloadKeys(
      item,
      ["status", "testName", "prePatch", "postPatch", "hashMatched", "reason"],
      "regression validation",
    );
    if (typeof item.status !== "string" || !REGRESSION_STATUSES.has(item.status)) {
      throw new Error("Investigation report regression validation is invalid.");
    }
    const prePatch = boundedPayloadString(item.prePatch, 60, "regression pre-patch");
    const postPatch = boundedPayloadString(item.postPatch, 60, "regression post-patch");
    if (
      (prePatch !== null && !REGRESSION_RUN_STATUSES.has(prePatch)) ||
      (postPatch !== null && !REGRESSION_RUN_STATUSES.has(postPatch)) ||
      (item.hashMatched !== null && typeof item.hashMatched !== "boolean")
    ) {
      throw new Error("Investigation report regression validation is invalid.");
    }
    regression = {
      status: item.status as ReportRegression["status"],
      testName: boundedPayloadString(item.testName, 120, "regression test name"),
      prePatch,
      postPatch,
      hashMatched: item.hashMatched as boolean | null,
      reason: boundedPayloadString(item.reason, 600, "regression reason"),
    };
  }

  const counts = evidence.evidence;
  let evidenceCounts: InvestigationReportData["technicalEvidence"]["evidence"] = null;
  if (counts !== null) {
    if (!counts || typeof counts !== "object") {
      throw new Error("Investigation report evidence counts are invalid.");
    }
    const record = counts as Record<string, unknown>;
    requirePayloadKeys(
      record,
      ["screenshots", "consoleErrors", "networkFailures", "failedAssertions"],
      "evidence counts",
    );
    const values = [
      record.screenshots,
      record.consoleErrors,
      record.networkFailures,
      record.failedAssertions,
    ];
    if (
      !values.every(
        (count) => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000_000,
      )
    ) {
      throw new Error("Investigation report evidence counts are invalid.");
    }
    evidenceCounts = {
      screenshots: record.screenshots as number,
      consoleErrors: record.consoleErrors as number,
      networkFailures: record.networkFailures as number,
      failedAssertions: record.failedAssertions as number,
    };
  }

  if (!Array.isArray(evidence.failedChecks) || evidence.failedChecks.length > MAX_FAILED_CHECKS) {
    throw new Error("Investigation report failed checks are invalid.");
  }
  const failedChecks = evidence.failedChecks.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Investigation report failed checks are invalid.");
    }
    const check = item as Record<string, unknown>;
    requirePayloadKeys(check, ["name", "status", "detail"], "failed check");
    if (
      typeof check.name !== "string" ||
      check.status !== "failed" ||
      typeof check.detail !== "string"
    ) {
      throw new Error("Investigation report failed checks are invalid.");
    }
    return {
      name: truncate(check.name, 100),
      status: "failed" as const,
      detail: truncate(check.detail, 600),
    };
  });

  const normalized: InvestigationReportData = {
    outcome: data.outcome,
    originalOutcome,
    rootCause,
    fixSummary,
    fixOutcome,
    fixReason: boundedPayloadString(data.fixReason, 600, "fix reason"),
    changedFiles,
    verification: { exactReplay: exactReplay as "passed" | "failed" | null, repository, regression },
    limitations: boundedPayloadStrings(
      data.limitations,
      MAX_LIMITATIONS,
      600,
      "limitations",
    ),
    technicalEvidence: {
      expected: boundedPayloadString(evidence.expected, 800, "expected behavior"),
      observed: boundedPayloadString(evidence.observed, 800, "observed behavior"),
      reproductionMode: boundedPayloadString(
        evidence.reproductionMode,
        40,
        "reproduction mode",
      ),
      evidence: evidenceCounts,
      failedChecks,
      stage: boundedPayloadString(evidence.stage, 120, "failure stage"),
      error: boundedPayloadString(evidence.error, 4_000, "error"),
      planErrors: boundedPayloadStrings(
        evidence.planErrors,
        MAX_PLAN_ERRORS,
        500,
        "plan errors",
      ),
      analysis: boundedPayloadString(evidence.analysis, 2_000, "analysis"),
    },
  };

  if (
    normalized.outcome === "verified_fix" &&
    (normalized.originalOutcome !== "reproduced" ||
      !normalized.rootCause ||
      !normalized.fixSummary ||
      normalized.changedFiles.length === 0 ||
      normalized.verification.exactReplay !== "passed" ||
      normalized.fixOutcome !== null)
  ) {
    throw new Error("Verified-fix report data is internally inconsistent.");
  }
  if (
    normalized.outcome !== "verified_fix" &&
    (normalized.rootCause !== null ||
      normalized.fixSummary !== null ||
      normalized.changedFiles.length > 0)
  ) {
    throw new Error("Unverified report data claims verified-fix details.");
  }
  if (
    normalized.outcome === "failed" &&
    (normalized.originalOutcome !== null ||
      normalized.fixOutcome !== null ||
      normalized.verification.exactReplay !== null ||
      normalized.verification.repository !== null ||
      normalized.verification.regression !== null ||
      normalized.technicalEvidence.error === null)
  ) {
    throw new Error("Failed worker report data is internally inconsistent.");
  }
  if (normalized.fixOutcome !== null && normalized.outcome !== "reproduced") {
    throw new Error("Fix-attempt report data is internally inconsistent.");
  }

  return normalized;
}

// --- Rendering ------------------------------------------------------------------

const OUTCOME_CALLOUTS: Record<string, { kind: string; title: string; text: string }> = {
  verified_fix: { kind: "TIP", title: "Fix verified", text: "Sherlock reproduced the reported failure and verified a fix." },
  reproduced: { kind: "WARNING", title: "Failure reproduced; no verified fix", text: "Sherlock reproduced the failure, but no candidate fix passed verification." },
  not_reproduced: { kind: "NOTE", title: "Failure not reproduced", text: "Sherlock completed the reproduction plan without observing the reported failure." },
  plan_failed: { kind: "WARNING", title: "Investigation incomplete", text: "Sherlock could not produce a valid reproduction plan for this report." },
  environment_failed: { kind: "WARNING", title: "Environment unavailable", text: "Sherlock could not start the application environment needed for reproduction." },
  execution_failed: { kind: "WARNING", title: "Reproduction incomplete", text: "Sherlock could not complete the reproduction plan." },
  failed: { kind: "CAUTION", title: "Investigation failed", text: "Sherlock could not complete this investigation because of an internal failure." },
};

const FIX_OUTCOME_NOTES: Record<string, string> = {
  rejected_reproduction_still_fails:
    "Sherlock generated a candidate fix, but the original failure still occurred with it applied.",
  rejected_build_failed:
    "Sherlock generated a candidate fix, but the application failed to rebuild or restart with it.",
  rejected_tests_failed:
    "Sherlock generated a candidate fix, but verification failed.",
  rejected_patch_invalid:
    "Sherlock generated a candidate fix, but it was rejected before being applied.",
  rejected_environment_failed:
    "Sherlock generated a candidate fix, but the application environment failed during verification.",
  rejected_verification_inconclusive:
    "Sherlock generated a candidate fix, but could not conclusively verify it.",
  rejected_regression_test_failed:
    "Sherlock generated a candidate fix, but the generated regression test did not prove it.",
};

const VALIDATION_CATEGORY_LABELS: Record<string, string> = {
  test: "Repository tests",
  typecheck: "Typecheck",
  lint: "Lint",
  build: "Build",
};

const VALIDATION_STATUS_LABELS: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  not_available: "Not configured",
  timed_out: "Timed out",
};

const REGRESSION_RUN_LABELS: Record<string, string> = {
  failed_as_expected: "Failed as expected",
  unexpectedly_passed: "Unexpectedly passed",
  invalid_test: "Invalid test",
  invalid_failure: "Failed for an unrelated reason",
  timed_out: "Timed out",
  execution_failed: "Could not run",
  passed: "Passed",
  failed: "Failed",
};

const CHECK_LABELS: Record<string, string> = {
  original_reproduced: "Original failure reproduced",
  workspace_at_source_commit: "Source workspace",
  workspace_clean: "Clean source workspace",
  patch_valid: "Patch safety",
  changes_within_scope: "Change scope",
  application_restarted: "Application restart",
  exact_plan_replayed: "Exact reproduction replay",
  failure_no_longer_observed: "Reported failure absent",
  repository_validation: "Repository validation",
  regression_test: "Generated regression test",
};

const STAGE_LABELS: Record<string, string> = {
  bootstrap: "Worker startup",
  dequeue: "Job startup",
  preparation: "Workspace preparation",
  reproduction: "Failure reproduction",
  analysis: "Failure analysis",
  fix: "Fix generation",
  verification: "Fix verification",
  delivery: "GitHub delivery",
};

function outcomeCallout(report: InvestigationReportData): string {
  const callout = OUTCOME_CALLOUTS[report.outcome] ?? {
    kind: "NOTE",
    title: "Investigation complete",
    text: "Sherlock completed this investigation.",
  };
  return `> [!${callout.kind}]\n> **${callout.title}** — ${callout.text}`;
}

export function canonicalGitHubPullRequestUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return null;
    const [, owner, repo, number] = match;
    return `https://github.com/${encodeURIComponent(decodeURIComponent(owner))}/${encodeURIComponent(decodeURIComponent(repo))}/pull/${number}`;
  } catch {
    return null;
  }
}

function pullRequestLine(pullRequest: ReportPullRequest): string | null {
  const url = canonicalGitHubPullRequestUrl(pullRequest.url);
  const link = url
    ? `[View pull request #${url.slice(url.lastIndexOf("/") + 1)}](${url})`
    : null;
  switch (pullRequest.status) {
    case "created":
      return link
        ? `Sherlock opened the verified fix: ${link}.`
        : "Sherlock opened a pull request with the verified fix.";
    case "reused":
      return link
        ? `An existing Sherlock pull request contains this fix: ${link}.`
        : "An existing Sherlock pull request contains this fix.";
    case "merged":
      return link
        ? `The Sherlock pull request was already merged: ${link}.`
        : "The Sherlock pull request with this fix was already merged.";
    case "blocked":
      return "A pull request for this fix was closed without being merged; Sherlock did not open a replacement.";
    case "failed":
      return "Sherlock verified the fix locally but did not open a pull request because GitHub delivery failed.";
    case "pending":
      return "The verified fix is queued for pull-request delivery; this report will be finalized once delivery completes.";
    case "not_applicable":
      return null;
  }
}

function validationRows(report: InvestigationReportData): string[] {
  const rows: string[] = [];
  const { exactReplay, repository, regression } = report.verification;

  if (report.originalOutcome === "reproduced") {
    rows.push("| Original failure reproduced | Passed |");
  } else if (report.originalOutcome === "not_reproduced") {
    rows.push("| Original failure reproduced | Inconclusive |");
  }
  if (exactReplay === "passed") {
    rows.push("| Exact reproduction replay | Passed — failure no longer observed |");
  } else if (exactReplay === "failed") {
    rows.push("| Exact reproduction replay | Failed — failure still observed |");
  }
  if (repository && repository.length > 0) {
    for (const item of repository) {
      rows.push(`| ${VALIDATION_CATEGORY_LABELS[item.category] ?? "Repository check"} | ${VALIDATION_STATUS_LABELS[item.status] ?? "Not available"} |`);
    }
  } else if (repository) {
    rows.push("| Repository checks | Not configured |");
  }
  if (regression) {
    if (regression.status === "proven") {
      const testName = sanitizeInlineCodeField(regression.testName, 80);
      const name = testName ? ` (${safeInlineCode(testName)})` : "";
      const changed = regression.hashMatched === false
        ? " — test source changed between runs"
        : "";
      rows.push(`| Generated regression test${name} | Proven — failed before and passed after${changed} |`);
    } else if (regression.status === "blocked") {
      const before = regression.prePatch
        ? REGRESSION_RUN_LABELS[regression.prePatch] ?? "Not available"
        : null;
      const after = regression.postPatch
        ? REGRESSION_RUN_LABELS[regression.postPatch] ?? "Not available"
        : null;
      const detail = [before ? `before: ${before}` : null, after ? `after: ${after}` : null]
        .filter(Boolean)
        .join(", ");
      rows.push(`| Generated regression test | Inconclusive${detail ? ` — ${detail}` : ""} |`);
    } else {
      const reason = inlineField(regression.reason, MAX_REASON_CHARS);
      rows.push(`| Generated regression test | Not available${reason ? ` — ${reason}` : ""} |`);
    }
  }
  return rows;
}

function technicalEvidenceLines(report: InvestigationReportData): string[] {
  const evidence = report.technicalEvidence;
  const lines: string[] = [];

  if (evidence.reproductionMode) {
    const mode = evidence.reproductionMode === "browser"
      ? "Browser"
      : evidence.reproductionMode === "api"
        ? "API"
        : evidence.reproductionMode === "browser_and_api"
          ? "Browser and API"
          : "Recorded reproduction";
    lines.push(`- Evidence source: ${mode}`);
  }

  const expected = inlineField(evidence.expected, MAX_OBSERVED_CHARS);
  if (expected) lines.push(`- Expected: ${expected}`);
  const observed = inlineField(evidence.observed, MAX_OBSERVED_CHARS);
  if (observed) lines.push(`- Observed: ${observed}`);

  if (evidence.evidence) {
    const counts = evidence.evidence;
    lines.push(
      `- Evidence collected: ${counts.screenshots} screenshot${counts.screenshots === 1 ? "" : "s"}, ` +
        `${counts.consoleErrors} console error${counts.consoleErrors === 1 ? "" : "s"}, ` +
        `${counts.networkFailures} failed network request${counts.networkFailures === 1 ? "" : "s"}, ` +
        `${counts.failedAssertions} failed assertion${counts.failedAssertions === 1 ? "" : "s"}`,
    );
  }

  if (evidence.stage) {
    lines.push(`- Failure stage: ${STAGE_LABELS[evidence.stage] ?? "Investigation processing"}`);
  }

  const error = diagnosticField(evidence.error, MAX_ERROR_CHARS);
  if (error) {
    lines.push(`- Error\n\n${diagnosticBlock(error)}`);
  }

  for (const planError of evidence.planErrors.slice(0, MAX_PLAN_ERRORS)) {
    const bounded = inlineField(planError, MAX_PLAN_ERROR_CHARS);
    if (bounded) lines.push(`- Plan problem: ${bounded}`);
  }

  for (const check of evidence.failedChecks.slice(0, MAX_FAILED_CHECKS)) {
    const name = CHECK_LABELS[check.name] ?? "Verification check";
    const detail = inlineField(check.detail, MAX_CHECK_DETAIL_CHARS);
    lines.push(`- ${name}: Failed${detail ? ` — ${detail}` : ""}`);
  }

  const analysis = diagnosticField(evidence.analysis, MAX_ANALYSIS_CHARS);
  if (analysis) {
    lines.push(`- Diagnostic analysis (unverified)\n\n${diagnosticBlock(analysis)}`);
  }

  return lines;
}

// Renders the terminal issue report body. Hidden markers are appended by the
// delivery layer, never rendered here.
export function renderIssueReport(
  report: InvestigationReportData,
  pullRequest: ReportPullRequest | null,
): string {
  const sections: string[] = ["## Sherlock Investigation", outcomeCallout(report)];

  const rootCause = inlineField(report.rootCause, MAX_ROOT_CAUSE_CHARS);
  if (rootCause) {
    sections.push(`### Root cause\n\n${rootCause}`);
  } else if (report.outcome === "reproduced") {
    sections.push(
      "### Root cause\n\nNot established. The failure was reproduced, but no fix passed verification, so no root cause is confirmed.",
    );
  }

  const fixSummary = inlineField(report.fixSummary, MAX_FIX_SUMMARY_CHARS);
  const fixLines: string[] = [];
  if (fixSummary) fixLines.push(fixSummary);
  if (report.changedFiles.length > 0) {
    const files = report.changedFiles
      .slice(0, MAX_CHANGED_FILES)
      .map((file) => sanitizeInlineCodeField(file, MAX_FILE_PATH_CHARS))
      .filter((file): file is string => file !== null)
      .map(safeInlineCode);
    const more = report.changedFiles.length - files.length;
    fixLines.push(
      `Changed files: ${files.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
    );
  }
  if (fixLines.length > 0) {
    sections.push(`### Fix\n\n${fixLines.join("\n\n")}`);
  }

  if (report.fixOutcome) {
    const note =
      FIX_OUTCOME_NOTES[report.fixOutcome] ??
      "Sherlock attempted a fix, but it did not pass verification.";
    const reason = inlineField(report.fixReason, MAX_REASON_CHARS);
    sections.push(
      `### Fix attempt\n\n${note}${reason ? `\n\nReason: ${reason}` : ""}\n\nNo pull request was opened for it.`,
    );
  }

  const validation = validationRows(report);
  if (validation.length > 0) {
    sections.push(`### Validation\n\n| Check | Result |\n| --- | --- |\n${validation.join("\n")}`);
  }

  const limitations = report.limitations
    .slice(0, MAX_LIMITATIONS)
    .map((item) => inlineField(item, MAX_LIMITATION_CHARS))
    .filter((item): item is string => item !== null);
  if (limitations.length > 0) {
    sections.push(
      `### Limitations\n\n${limitations.map((item) => `- ${item}`).join("\n")}`,
    );
  }

  const prLine = pullRequest ? pullRequestLine(pullRequest) : null;
  if (prLine) {
    sections.push(`### Pull request\n\n${prLine}`);
  }

  const evidence = technicalEvidenceLines(report);
  if (evidence.length > 0) {
    sections.push(
      [
        "<details>",
        "<summary><strong>Technical evidence</strong></summary>",
        "",
        evidence.join("\n"),
        "",
        "</details>",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

// Queued placeholder body. The caller appends the hidden delivery marker so
// terminal delivery can find and update this exact comment.
export function renderQueuedIssueReport(): string {
  return [
    "## Sherlock Investigation",
    "",
    "> [!NOTE]",
    "> **Investigation queued** — Sherlock will update this comment when the investigation is complete.",
  ].join("\n");
}

// Pre-pipeline worker failure body (no pipeline result exists). The caller
// appends the hidden markers and reconciles the queued comment.
export function renderWorkerFailureIssueReport(input: { error: string }): string {
  return renderIssueReport(buildWorkerFailureReportData(input), null);
}
