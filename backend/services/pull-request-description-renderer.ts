// Pure, deterministic Markdown renderer for Sherlock pull-request titles and
// descriptions. It renders from structured fix/verification data only and
// never consumes issue-report Markdown (and vice versa).
//
// Privacy contract (enforced per field, before assembly):
//   - no investigation or fix-attempt ids;
//   - no internal artifact names or filesystem/screenshot paths;
//   - no localhost/loopback/container/ephemeral-port URLs (origins stripped);
//   - no raw diff contents (GitHub's native compare view is linked instead);
//   - no secrets (redactSecrets);
//   - verification check DETAILS are never rendered (they can carry temporary
//     application URLs); only structured names and statuses are.
//
// Every field is bounded before rendering, so the finished document is never
// truncated as a whole and its Markdown structure stays valid.

import {
  canonicalEvidenceUrl,
  safeInlineCode,
  sanitizeCommandField,
  sanitizeInlineCodeField,
  sanitizeProseField,
  sanitizeTitleField,
} from "./issue-report-renderer.js";

// --- Structured description data ------------------------------------------------

export type PullRequestChange = {
  path: string;
  // Trustworthy per-file explanation. The current fixer schema does not
  // author one, so this is null today and the renderer falls back to a clean
  // file list. Explanations are never invented from a diff.
  explanation: string | null;
};

export type PullRequestValidationData = {
  postPatchOutcome: string | null;
  checks: { name: string; status: "passed" | "failed" | "advisory" }[];
  repository: { category: string; status: string }[] | null;
  regression: {
    status: string;
    testName: string | null;
    prePatch: string | null;
    postPatch: string | null;
    hashMatched: boolean | null;
  } | null;
  testRuns: {
    command: string;
    exitCode: number;
    targeted: boolean;
    durationMs: number;
    timedOut: boolean;
  }[];
};

export type PullRequestDescriptionData = {
  issueNumber: number;
  issueTitle: string;
  summary: string | null;
  rootCause: string | null;
  reproduction: {
    stepCount: number;
    mode: string | null;
    expectedBehavior: string | null;
    failureCondition: string | null;
  } | null;
  changes: PullRequestChange[];
  validation: PullRequestValidationData;
  limitations: string[];
  // Derived only from explicit structured signals (risk, assumptions,
  // advisory/failed checks, validation gaps). Empty means the section is
  // omitted entirely — never filled with generic advice.
  reviewFocus: string[];
  replayEvidence: {
    gifUrl: string | null;
    videoUrl: string | null;
  } | null;
  // GitHub's native compare view for this branch. The PR number does not
  // exist yet when the protected retry payload is captured, so the
  // repository compare URL is the stable native diff link.
  compareUrl: string;
};

// --- Bounds ------------------------------------------------------------------------

const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 600;
const MAX_ROOT_CAUSE_CHARS = 1_000;
const MAX_BEHAVIOR_CHARS = 300;
const MAX_EXPLANATION_CHARS = 300;
const MAX_FILE_PATH_CHARS = 200;
const MAX_FILES = 20;
const MAX_CHECKS = 16;
const MAX_TEST_RUNS = 8;
const MAX_COMMAND_CHARS = 200;
const MAX_LIMITATION_CHARS = 300;
const MAX_LIMITATIONS = 8;
const MAX_REVIEW_FOCUS_ITEMS = 8;
const MAX_REVIEW_FOCUS_CHARS = 300;

// Shared sanitization pipeline (secrets, URL origins, internal ids/paths,
// container names, HTML) from the issue-report renderer.
const inlineField = sanitizeProseField;

// --- Building description data from structured inputs -----------------------------

export type PullRequestReportingProposal = {
  risk: "low" | "medium" | "high";
  assumptions: string[];
  relevantTests: string[];
};

export type PullRequestDescriptionInput = {
  owner: string;
  repo: string;
  baseBranch: string;
  branch: string;
  issueNumber: number;
  issueTitle: string;
  plan: {
    stepCount: number;
    mode: string | null;
    expectedBehavior: string;
    failureCondition: string;
  };
  fixAttempt: {
    summary: string | null;
    rootCause: string | null;
    changedFiles: string[];
    postPatchOutcome: string | null;
    checks: { name: string; status: "passed" | "failed" | "advisory" }[];
    repositoryValidation: {
      aggregate: string;
      categories: { category: string; status: string }[];
    } | null;
    regressionTest: {
      status: string;
      testName: string | null;
      prePatch: string | null;
      postPatch: string | null;
      hashMatched: boolean | null;
      reason: string | null;
    } | null;
    testRuns: {
      command: string;
      exitCode: number;
      targeted: boolean;
      durationMs: number;
      timedOut: boolean;
    }[];
  };
  // Validated reporting fields from the persisted fix proposal, when
  // trustworthy structured data is available; null otherwise.
  proposal: PullRequestReportingProposal | null;
  replayEvidence?: {
    gifUrl: string | null;
    videoUrl: string | null;
  } | null;
};

export function buildCompareUrl(input: {
  owner: string;
  repo: string;
  baseBranch: string;
  branch: string;
}): string {
  return `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/compare/${encodeURIComponent(input.baseBranch)}...${encodeURIComponent(input.branch)}`;
}

export function canonicalGitHubCompareUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password
    ) return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/compare\/([^/]+)\.\.\.([^/]+)\/?$/);
    if (!match) return null;
    const [, owner, repo, base, branch] = match;
    return `https://github.com/${encodeURIComponent(decodeURIComponent(owner))}/${encodeURIComponent(decodeURIComponent(repo))}/compare/${encodeURIComponent(decodeURIComponent(base))}...${encodeURIComponent(decodeURIComponent(branch))}`;
  } catch {
    return null;
  }
}

export function buildPullRequestDescriptionData(
  input: PullRequestDescriptionInput,
): PullRequestDescriptionData {
  const { fixAttempt, proposal } = input;
  const regression = fixAttempt.regressionTest;
  const repository = fixAttempt.repositoryValidation;

  const limitations: string[] = [
    "Only the recorded reproduction scenario and the listed checks were exercised; adjacent behavior was not separately verified.",
    "The patch was verified in an isolated Sherlock workspace, not in a production environment.",
  ];
  if (regression?.status === "blocked") {
    limitations.push(
      "The generated regression test could not prove the fix; verification relied on the exact reproduction replay.",
    );
  } else if (regression?.status === "unavailable") {
    limitations.push("No generated regression test was available for this fix.");
  }
  if (repository?.aggregate === "not_available") {
    limitations.push(
      "The repository declares no runnable validation scripts (test, typecheck, lint, or build), so repository validation could not run.",
    );
  }
  // Phase 3.3 truthfulness: state security posture explicitly. Diff-risk
  // heuristics (Phase 3.1) are advisory pattern checks, never a security
  // verification; if they did not run, say so rather than imply the diff was
  // security-reviewed.
  const ranDiffRisk = fixAttempt.checks.some((check) =>
    check.name.startsWith("diff-risk"),
  );
  limitations.push(
    ranDiffRisk
      ? "Advisory diff-risk heuristics ran; they flag known-risky patterns only and are NOT a security verification."
      : "No automated security or diff-risk scan was performed on this patch; reviewers should assess security implications.",
  );

  // Review focus: explicit structured signals only. No generic filler.
  const reviewFocus: string[] = [];
  if (proposal && (proposal.risk === "medium" || proposal.risk === "high")) {
    reviewFocus.push(`The fixer assessed this change as ${proposal.risk} risk.`);
  }
  if (proposal) {
    for (const assumption of proposal.assumptions.slice(0, 5)) {
      if (assumption.trim()) {
        reviewFocus.push(`Assumption: ${assumption}`);
      }
    }
  }
  for (const check of fixAttempt.checks) {
    if (check.status === "failed") {
      reviewFocus.push(`${checkLabel(check.name)} failed.`);
    }
  }
  if (regression?.status === "blocked" || regression?.status === "unavailable") {
    reviewFocus.push(
      "No proven regression test accompanies this change; the exact reproduction replay is the primary behavioral evidence.",
    );
  }
  if (repository) {
    for (const item of repository.categories) {
      if (item.status === "not_available") {
        reviewFocus.push(`${VALIDATION_CATEGORY_LABELS[item.category] ?? "A repository check"} was not configured.`);
      } else if (item.status === "timed_out") {
        reviewFocus.push(`${VALIDATION_CATEGORY_LABELS[item.category] ?? "A repository check"} timed out during validation.`);
      }
    }
  }

  return {
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    summary: fixAttempt.summary,
    rootCause: fixAttempt.rootCause,
    reproduction: {
      stepCount: input.plan.stepCount,
      mode: input.plan.mode,
      expectedBehavior: input.plan.expectedBehavior,
      failureCondition: input.plan.failureCondition,
    },
    changes: fixAttempt.changedFiles.map((path) => ({
      path,
      // No trustworthy per-file explanation exists in the current fixer
      // schema; render a clean file list instead of inventing one.
      explanation: null,
    })),
    validation: {
      postPatchOutcome: fixAttempt.postPatchOutcome,
      checks: fixAttempt.checks.map((check) => ({
        name: check.name,
        status: check.status,
      })),
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
          }
        : null,
      testRuns: fixAttempt.testRuns.map((run) => ({
        command: run.command,
        exitCode: run.exitCode,
        targeted: run.targeted,
        durationMs: run.durationMs,
        timedOut: run.timedOut,
      })),
    },
    limitations,
    reviewFocus,
    replayEvidence: input.replayEvidence ?? null,
    compareUrl: buildCompareUrl(input),
  };
}

// --- Rendering ------------------------------------------------------------------------

export function renderPullRequestTitle(summary: string | null): string {
  const text = sanitizeTitleField(
    summary ?? "Fix verified by reproduction replay",
    MAX_TITLE_CHARS - "Sherlock: ".length,
  ) ?? "Fix verified by reproduction replay";
  return `Sherlock: ${text}`.slice(0, MAX_TITLE_CHARS);
}

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

function checkLabel(name: string): string {
  return CHECK_LABELS[name] ?? "Verification check";
}

function resultLabel(status: "passed" | "failed" | "advisory"): string {
  return status === "passed" ? "Passed" : status === "failed" ? "Failed" : "Advisory";
}

export function renderPullRequestDescription(
  data: PullRequestDescriptionData,
): string {
  const sections: string[] = [];

  // --- Summary ---------------------------------------------------------------
  const summaryLines: string[] = [];
  const summary = inlineField(data.summary, MAX_SUMMARY_CHARS);
  summaryLines.push(
    summary ?? "Sherlock verified a minimal fix by replaying the saved reproduction.",
  );
  const issueTitle = inlineField(data.issueTitle, 150);
  summaryLines.push(
    `Fixes the failure reported in #${data.issueNumber}${issueTitle ? ` (${issueTitle})` : ""}.`,
  );
  if (data.reproduction) {
    const expected = inlineField(data.reproduction.expectedBehavior, MAX_BEHAVIOR_CHARS);
    const failure = inlineField(data.reproduction.failureCondition, MAX_BEHAVIOR_CHARS);
    if (expected) summaryLines.push(`- Expected: ${expected}`);
    if (failure) summaryLines.push(`- Observed before the fix: ${failure}`);
    const mode = data.reproduction.mode === "browser"
      ? "browser"
      : data.reproduction.mode === "api"
        ? "API"
        : data.reproduction.mode === "browser_and_api"
          ? "browser and API"
          : null;
    summaryLines.push(
      `- Verified by replaying the recorded ${mode ? `${mode} ` : ""}reproduction (${data.reproduction.stepCount} step${data.reproduction.stepCount === 1 ? "" : "s"}) against the patched application.`,
    );
  }
  sections.push(`## Summary\n\n${summaryLines.join("\n")}`);

  // --- Root cause ------------------------------------------------------------
  const rootCause = inlineField(data.rootCause, MAX_ROOT_CAUSE_CHARS);
  if (rootCause) {
    sections.push(`## Root cause\n\n${rootCause}`);
  }

  // --- Changes ---------------------------------------------------------------
  const files = data.changes.slice(0, MAX_FILES);
  const moreFiles = data.changes.length - files.length;
  const changeLines = files.map((change) => {
    const path = safeInlineCode(
      sanitizeInlineCodeField(change.path, MAX_FILE_PATH_CHARS) ?? "File unavailable",
    );
    const explanation = inlineField(change.explanation, MAX_EXPLANATION_CHARS);
    return explanation ? `- ${path} — ${explanation}` : `- ${path}`;
  });
  if (moreFiles > 0) {
    changeLines.push(`- …and ${moreFiles} more file${moreFiles === 1 ? "" : "s"}`);
  }
  sections.push(`## Changes\n\n${changeLines.join("\n")}`);

  // --- Validation ------------------------------------------------------------
  const validationLines: string[] = ["| Check | Result |", "| --- | --- |"];
  if (data.validation.postPatchOutcome === "not_reproduced") {
    validationLines.push("| Exact reproduction replay | Passed — failure no longer observed |");
  } else if (data.validation.postPatchOutcome) {
    validationLines.push("| Exact reproduction replay | Inconclusive |");
  }
  for (const check of data.validation.checks.slice(0, MAX_CHECKS)) {
    if (
      (check.name === "exact_plan_replayed" && data.validation.postPatchOutcome) ||
      (check.name === "regression_test" && data.validation.regression)
    ) continue;
    validationLines.push(`| ${checkLabel(check.name)} | ${resultLabel(check.status)} |`);
  }
  if (data.validation.repository && data.validation.repository.length > 0) {
    for (const item of data.validation.repository) {
      validationLines.push(`| ${VALIDATION_CATEGORY_LABELS[item.category] ?? "Repository check"} | ${VALIDATION_STATUS_LABELS[item.status] ?? "Not available"} |`);
    }
  }
  const regression = data.validation.regression;
  if (regression) {
    if (regression.status === "proven") {
      const name = regression.testName
        ? ` (${safeInlineCode(sanitizeInlineCodeField(regression.testName, 80) ?? "generated test")})`
        : "";
      validationLines.push(
        `| Generated regression test${name} | Proven — failed before and passed after${regression.hashMatched === false ? " — test source changed between runs" : ""} |`,
      );
    } else {
      const before = regression.prePatch
        ? REGRESSION_RUN_LABELS[regression.prePatch] ?? "Not available"
        : null;
      const after = regression.postPatch
        ? REGRESSION_RUN_LABELS[regression.postPatch] ?? "Not available"
        : null;
      const detail = [
        before ? `before: ${before}` : null,
        after ? `after: ${after}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      validationLines.push(
        `| Generated regression test | ${regression.status === "blocked" ? "Inconclusive" : "Not available"}${detail ? ` — ${detail}` : ""} |`,
      );
    }
  }
  if (data.validation.testRuns.length > 0) {
    for (const run of data.validation.testRuns.slice(0, MAX_TEST_RUNS)) {
      const command = sanitizeCommandField(run.command, MAX_COMMAND_CHARS) ?? "Command unavailable";
      const result = run.timedOut ? "Timed out" : run.exitCode === 0 ? "Passed" : "Failed";
      validationLines.push(
        `| ${run.targeted ? "Targeted check" : "Full repository check"}: ${safeInlineCode(command)} | ${result} |`,
      );
    }
  } else {
    validationLines.push("| Project test command | Not configured |");
  }
  sections.push(`## Validation\n\n${validationLines.join("\n")}`);

  if (
    regression?.status === "blocked" &&
    data.validation.postPatchOutcome === "not_reproduced"
  ) {
    sections.push(
      "> [!NOTE]\n> The generated regression test was inconclusive. The fix was verified by successfully replaying the exact recorded reproduction.",
    );
  }

  const gifUrl = canonicalEvidenceUrl(data.replayEvidence?.gifUrl);
  const videoUrl = canonicalEvidenceUrl(data.replayEvidence?.videoUrl);
  if (gifUrl || videoUrl) {
    const evidenceLines = [
      "## Replay evidence",
      "",
      "Sherlock recorded both runs. Left: the reproduction failing before the fix. Right: the identical reproduction plan passing after the fix.",
    ];
    if (gifUrl) evidenceLines.push("", `![Sherlock replay evidence](${gifUrl})`);
    if (videoUrl) evidenceLines.push("", `[Watch the full comparison video](${videoUrl})`);
    sections.push(evidenceLines.join("\n"));
  }

  // --- Limitations -----------------------------------------------------------
  const limitations = data.limitations
    .slice(0, MAX_LIMITATIONS)
    .map((item) => inlineField(item, MAX_LIMITATION_CHARS))
    .filter((item): item is string => item !== null);
  if (limitations.length > 0) {
    sections.push(
      `## Limitations\n\n${limitations.map((item) => `- ${item}`).join("\n")}`,
    );
  }

  // --- Review focus ----------------------------------------------------------
  const reviewFocus = data.reviewFocus
    .slice(0, MAX_REVIEW_FOCUS_ITEMS)
    .map((item) => inlineField(item, MAX_REVIEW_FOCUS_CHARS))
    .filter((item): item is string => item !== null);
  if (reviewFocus.length > 0) {
    sections.push(
      `## Review focus\n\n${reviewFocus.map((item) => `- ${item}`).join("\n")}`,
    );
  }

  // --- Native diff link --------------------------------------------------------
  const compareUrl = canonicalGitHubCompareUrl(data.compareUrl);
  if (compareUrl) {
    sections.push(`[View the full diff on GitHub](${compareUrl})`);
  }

  return `${sections.join("\n\n")}\n`;
}
