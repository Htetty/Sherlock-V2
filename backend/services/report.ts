// Builds the concise GitHub result comment for an investigation.
// Everything that leaves the backend for GitHub must pass through redactSecrets.

export type InvestigationOutcome =
  | "reproduced"
  | "not_reproduced"
  | "plan_failed"
  | "environment_failed"
  | "execution_failed";

export type InvestigationSummary = {
  investigationId: string;
  outcome: InvestigationOutcome;
  observed?: string | null;
  expected?: string | null;
  stage?: string | null;
  error?: string | null;
  planErrors?: string[];
  evidence?: {
    screenshots: number;
    consoleErrors: number;
    networkFailures: number;
    failedAssertions: number;
  } | null;
};

const MAX_ERROR_CHARS = 300;
const MAX_COMMENT_CHARS = 3_000;

const OUTCOME_HEADLINES: Record<InvestigationOutcome, string> = {
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
    lines.push(`Error: ${truncate(summary.error, MAX_ERROR_CHARS)}`);
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
      .replace(/\b([A-Z][A-Z0-9_]{2,})=(\S+)/g, "$1=[REDACTED]")
      // credentials embedded in URLs
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s]+@/gi, "$1:[REDACTED]@")
      // well-known token prefixes
      .replace(/\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[a-z]-)[A-Za-z0-9_-]+/g, "[REDACTED]")
  );
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}…`;
}
