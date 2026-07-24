// Diff-risk heuristics (FABLE_IMPLEMENTATION_PROMPT.md Phase 3.1).
//
// These are HEURISTIC review signals, not a security verification system. A
// clean result means "no listed pattern matched" and must never be reported
// as "security verified". Runtime integration (runFixAttempt) is flag-gated
// behind SHERLOCK_PATCH_RISK_CHECKS=true and only ever ADDS advisory checks —
// it cannot change a verification outcome. The eval harness additionally
// treats `secret_material` as a hard gate.

export type PatchRiskVerdict = {
  rule: string;
  severity: "info" | "warning" | "hard_fail";
  matched: boolean;
  detail: string;
};

export function patchRiskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHERLOCK_PATCH_RISK_CHECKS === "true";
}

type RiskRule = {
  id: string;
  severity: "warning" | "hard_fail";
  pattern: RegExp;
  description: string;
};

// Applied to ADDED diff lines only.
const RISK_RULES: RiskRule[] = [
  {
    id: "secret_material",
    severity: "hard_fail",
    pattern:
      /(-----BEGIN [A-Z ]*PRIVATE KEY-----|aws_secret_access_key|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9-]{10,}|xox[bap]-[A-Za-z0-9-]{10,})/,
    description: "credential-shaped material added by the patch",
  },
  {
    id: "shell_execution_added",
    severity: "warning",
    pattern: /\b(child_process|execSync|spawnSync|exec\(|eval\(|new Function\()/,
    description: "patch introduces dynamic execution or shell primitives",
  },
  {
    id: "network_call_added",
    severity: "warning",
    pattern: /\b(?:fetch|axios|https?\.request|net\.connect|XMLHttpRequest)\s*\(?/,
    description: "patch introduces an outbound network call",
  },
  {
    id: "auth_check_removed_or_bypassed",
    severity: "warning",
    pattern: /\b(skipAuth|bypass|disableAuth|allowAll|NODE_TLS_REJECT_UNAUTHORIZED)\b/i,
    description: "patch references auth/TLS bypass vocabulary",
  },
  {
    id: "sql_string_concat",
    severity: "warning",
    pattern: /(SELECT|INSERT|UPDATE|DELETE)[^\n]*(\+\s*\w|\$\{)/i,
    description: "patch builds SQL from string concatenation/interpolation",
  },
];

const TEST_WEAKENING_REMOVED: RegExp[] = [
  /\b(it|test|describe)\.skip\(/,
  /\bexpect\([^)]*\)\.(not\.)?toBe/,
];

export function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec)\.[jt]sx?$/.test(file);
}

export function analyzePatchRisk(
  diffText: string | null,
  changedFiles: string[],
): PatchRiskVerdict[] {
  if (!diffText) {
    return [
      {
        rule: "diff_risk",
        severity: "info",
        matched: false,
        detail: "no diff available to analyze",
      },
    ];
  }

  const lines = diffText.split("\n");
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const verdicts: PatchRiskVerdict[] = [];

  for (const rule of RISK_RULES) {
    const hits = added.filter((line) => rule.pattern.test(line));

    if (hits.length > 0) {
      verdicts.push({
        rule: rule.id,
        severity: rule.severity,
        matched: true,
        detail: `${rule.description}; first evidence: ${hits[0].slice(0, 160)}. Limitation: pattern heuristic — confirms nothing about intent and misses obfuscation.`,
      });
    }
  }

  const testFilesTouched = changedFiles.filter(isTestFile);
  const removedTestSignal = removed.some((line) =>
    TEST_WEAKENING_REMOVED.some((pattern) => pattern.test(line)),
  );
  const addedSkip = added.some((line) => /\b(it|test|describe)\.skip\(/.test(line));

  if (testFilesTouched.length > 0 && (removedTestSignal || addedSkip)) {
    verdicts.push({
      rule: "test_weakening",
      severity: "warning",
      matched: true,
      detail: `test files touched (${testFilesTouched.join(", ")}) with removed assertions or added .skip. Limitation: heuristic — legitimate test refactors also match.`,
    });
  }

  if (verdicts.length === 0) {
    verdicts.push({
      rule: "diff_risk",
      severity: "info",
      matched: false,
      detail:
        "no known risk pattern matched. This is NOT a security verification; it means only that the listed heuristics found nothing.",
    });
  }

  return verdicts;
}
