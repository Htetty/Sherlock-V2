// Builds the concise GitHub result comment for an investigation.
// Everything that leaves the backend for GitHub must pass through redactSecrets.

export type InvestigationOutcome =
  | "reproduced"
  | "not_reproduced"
  | "plan_failed"
  | "environment_failed"
  | "execution_failed"
  // Bug reproduced AND the patch was verified (replay + repository
  // validation). The original reproduction outcome is preserved separately
  // in originalOutcome.
  | "verified_fix";

export type InvestigationSummary = {
  investigationId: string;
  outcome: InvestigationOutcome;
  observed?: string | null;
  expected?: string | null;
  stage?: string | null;
  error?: string | null;
  planErrors?: string[];
  originalOutcome?: string | null;
  verification?: string | null;
  pullRequestStatus?: string | null;
  evidence?: {
    screenshots: number;
    consoleErrors: number;
    networkFailures: number;
    failedAssertions: number;
  } | null;
};

const MAX_ERROR_CHARS = 300;
// Environment/startup errors carry multi-line diagnostics (attempted command,
// stdout/stderr tails); clipping them at MAX_ERROR_CHARS hid exactly the part
// needed to debug a failed startup.
const MAX_DIAGNOSTIC_ERROR_CHARS = 1_600;
const MAX_COMMENT_CHARS = 3_000;

const OUTCOME_HEADLINES: Record<InvestigationOutcome, string> = {
  verified_fix:
    "Sherlock reproduced the reported failure and verified a fix for it.",
  reproduced: "Sherlock reproduced the reported failure.",
  not_reproduced:
    "Sherlock executed the reproduction plan but did not observe the reported failure.",
  plan_failed:
    "Sherlock could not produce a valid reproduction plan for this report.",
  environment_failed:
    "Sherlock could not reproduce the report because the application environment failed to start.",
  execution_failed:
    "Sherlock could not complete the reproduction plan because of an execution problem.",
};

export function formatResultComment(summary: InvestigationSummary): string {
  const lines = [
    OUTCOME_HEADLINES[summary.outcome],
    "",
    `Investigation: ${summary.investigationId}`,
    `Outcome: ${summary.outcome}`,
  ];

  if (summary.originalOutcome) {
    lines.push(`Original reproduction: ${summary.originalOutcome}`);
  }

  if (summary.verification) {
    lines.push(`Verification: ${summary.verification}`);
  }

  if (summary.pullRequestStatus) {
    lines.push(`Pull request: ${summary.pullRequestStatus}`);
  }

  if (summary.observed) {
    lines.push(`Observed: ${truncate(summary.observed, MAX_ERROR_CHARS)}`);
  }

  if (summary.expected) {
    lines.push(`Expected: ${truncate(summary.expected, MAX_ERROR_CHARS)}`);
  }

  if (summary.stage) {
    lines.push(`Stage: ${summary.stage}`);
  }

  if (summary.error) {
    lines.push(`Error: ${truncate(summary.error, MAX_DIAGNOSTIC_ERROR_CHARS)}`);
  }

  if (summary.planErrors && summary.planErrors.length > 0) {
    lines.push(
      `Plan problems: ${truncate(summary.planErrors.slice(0, 3).join(" | "), MAX_ERROR_CHARS)}`,
    );
  }

  if (summary.evidence) {
    const parts = [
      `${summary.evidence.screenshots} screenshot${summary.evidence.screenshots === 1 ? "" : "s"}`,
      `${summary.evidence.consoleErrors} console error${summary.evidence.consoleErrors === 1 ? "" : "s"}`,
      `${summary.evidence.networkFailures} failed network request${summary.evidence.networkFailures === 1 ? "" : "s"}`,
      `${summary.evidence.failedAssertions} failed assertion${summary.evidence.failedAssertions === 1 ? "" : "s"}`,
    ];
    lines.push(`Evidence: ${parts.join(", ")}`);
  }

  return truncate(redactSecrets(lines.join("\n")), MAX_COMMENT_CHARS);
}

// Env vars whose values are inherently non-sensitive; everything else in
// NAME=value form is redacted. Keep this list small and obviously safe.
const BENIGN_ENV_VARS = new Set(["PORT", "HOST", "HOSTNAME", "NODE_ENV"]);

// Best-effort scrubbing of secret-shaped content from text that will be
// posted publicly or saved into shareable summaries.
export function redactSecrets(text: string): string {
  return (
    text
      // bearer tokens (before key:value so "Authorization: Bearer x" loses the token)
      .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
      // key=value / key: value pairs for sensitive-sounding keys
      .replace(
        /\b((?:[A-Za-z0-9_-]*(?:key|token|secret|password|passwd|credential|authorization|auth)[A-Za-z0-9_-]*))(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
        "$1$2[REDACTED]",
      )
      // SCREAMING_SNAKE env-style assignments (e.g. DATABASE_URL=postgres://...)
      // except a short allowlist of values that are never secrets and are
      // needed for diagnostics (e.g. "Attempted command: PORT=59743 npm start")
      .replace(/\b([A-Z][A-Z0-9_]{2,})=(\S+)/g, (match, name: string) =>
        BENIGN_ENV_VARS.has(name) ? match : `${name}=[REDACTED]`,
      )
      // credentials embedded in URLs
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s]+@/gi, "$1:[REDACTED]@")
      // well-known token prefixes
      .replace(/\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[a-z]-)[A-Za-z0-9_-]+/g, "[REDACTED]")
  );
}

export type FixCommentSummary = {
  investigationId: string;
  fixAttemptId: string;
  outcome: string;
  rootCause?: string | null;
  changedFiles?: string[];
  reason?: string | null;
  verification?: string[];
  // Truthful per-category repository validation lines, e.g. "Tests: passed".
  repositoryValidation?: string[];
  // Truthful regression-test lines, e.g. "Before patch: failed as expected".
  regressionTest?: string[];
};

const FIX_OUTCOME_HEADLINES: Record<string, string> = {
  verified: "Sherlock verified a local fix.",
  rejected_reproduction_still_fails:
    "Sherlock generated a fix, but the original failure still occurs.",
  rejected_build_failed:
    "Sherlock generated a fix, but the application failed to rebuild or restart with it.",
  rejected_tests_failed: "Sherlock generated a fix, but verification failed.",
  rejected_patch_invalid:
    "Sherlock generated a fix, but it was rejected before being applied.",
  rejected_environment_failed:
    "Sherlock generated a fix, but the application environment failed during verification.",
  rejected_verification_inconclusive:
    "Sherlock generated a fix, but could not conclusively verify it.",
  rejected_regression_test_failed:
    "Sherlock generated a fix, but the generated regression test did not prove it.",
};

export function formatFixComment(summary: FixCommentSummary): string {
  const lines = [
    FIX_OUTCOME_HEADLINES[summary.outcome] ??
      "Sherlock completed a fix attempt.",
    "",
    `Investigation: ${summary.investigationId}`,
    `Fix attempt: ${summary.fixAttemptId}`,
    `Outcome: ${summary.outcome}`,
  ];

  if (summary.rootCause) {
    lines.push(`Root cause: ${truncate(summary.rootCause, MAX_ERROR_CHARS)}`);
  }

  if (summary.changedFiles && summary.changedFiles.length > 0) {
    lines.push(`Changed: ${summary.changedFiles.join(", ")}`);
  }

  if (summary.reason) {
    lines.push(`Reason: ${truncate(summary.reason, MAX_ERROR_CHARS)}`);
  }

  if (summary.verification && summary.verification.length > 0) {
    lines.push("Verification:");

    for (const item of summary.verification) {
      lines.push(`- ${truncate(item, MAX_ERROR_CHARS)}`);
    }
  }

  if (summary.repositoryValidation && summary.repositoryValidation.length > 0) {
    lines.push("Repository validation:");

    for (const item of summary.repositoryValidation) {
      lines.push(`- ${truncate(item, MAX_ERROR_CHARS)}`);
    }
  }

  if (summary.regressionTest && summary.regressionTest.length > 0) {
    lines.push("Regression test:");

    for (const item of summary.regressionTest) {
      lines.push(`- ${truncate(item, MAX_ERROR_CHARS)}`);
    }
  }

  if (summary.outcome !== "verified") {
    lines.push("No pull request was opened.");
  }

  return truncate(redactSecrets(lines.join("\n")), MAX_COMMENT_CHARS);
}

export type PullRequestCommentSummary = {
  investigationId: string;
  fixAttemptId: string;
  status: string;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  branch?: string | null;
  reason?: string | null;
};

export function formatPullRequestComment(summary: PullRequestCommentSummary): string {
  const lines: string[] = [];

  if (summary.status === "created" || summary.status === "already_exists") {
    lines.push(
      "Sherlock reproduced the issue, verified a local fix, and opened a pull request.",
      "",
      `Investigation: ${summary.investigationId}`,
      `Fix attempt: ${summary.fixAttemptId}`,
      `Pull request: ${summary.pullRequestUrl ?? `#${summary.pullRequestNumber}`}`,
      "Outcome: verified",
    );
  } else if (summary.status === "pull_request_failed" && summary.branch) {
    lines.push(
      "Sherlock verified a local fix and pushed a branch, but pull request creation failed.",
      "",
      `Investigation: ${summary.investigationId}`,
      `Fix attempt: ${summary.fixAttemptId}`,
      `Branch: ${summary.branch}`,
      `Reason: ${truncate(summary.reason ?? "unknown", MAX_ERROR_CHARS)}`,
    );
  } else {
    lines.push(
      "Sherlock verified a local fix but did not open a pull request.",
      "",
      `Investigation: ${summary.investigationId}`,
      `Fix attempt: ${summary.fixAttemptId}`,
      `Status: ${summary.status}`,
      `Reason: ${truncate(summary.reason ?? "unknown", MAX_ERROR_CHARS)}`,
    );
  }

  return truncate(redactSecrets(lines.join("\n")), MAX_COMMENT_CHARS);
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}…`;
}
