// Deterministic full-output and privacy tests for the public issue-report
// renderer. The renderer is a pure function of structured data, so these
// tests pin the exact Markdown for the flagship success and failure reports
// and assert the privacy contract on every variant.
import { describe, expect, test } from "vitest";
import {
  buildInvestigationReportData,
  canonicalGitHubPullRequestUrl,
  extractAnalysisText,
  normalizeInvestigationReportData,
  QUEUED_INVESTIGATION_ASCII_ART,
  renderIssueReport,
  renderQueuedIssueReport,
  renderIssueStatusComment,
  renderWorkerFailureIssueReport,
  type InvestigationReportData,
  type ReportPullRequest,
} from "../backend/services/issue-report-renderer.js";
import { deliveryCommentMarker } from "../backend/services/delivery.js";
import type { InvestigationSummary } from "../backend/services/report.js";

const INV = "inv_0RENDER12345";
const FIX = "fix_0RENDER12345";
const INTERNAL_OUTPUT_NAMES = [
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

function verifiedSummary(overrides: Partial<InvestigationSummary> = {}): InvestigationSummary {
  return {
    investigationId: INV,
    outcome: "verified_fix",
    originalOutcome: "reproduced",
    verification: "verified",
    reproductionMode: "browser",
    observed: "POST /api/login returned HTTP 500",
    expected: "Login with unknown credentials returns HTTP 401",
    evidence: {
      screenshots: 2,
      consoleErrors: 1,
      networkFailures: 1,
      failedAssertions: 1,
    },
    ...overrides,
  };
}

function verifiedFixAttempt() {
  return {
    outcome: "verified" as const,
    reason: "All verification checks passed.",
    rootCause: "The login handler always responds with HTTP 500 for unknown users.",
    summary: "Return 401 for unknown users instead of a server error.",
    changedFiles: ["src/auth/login.ts"],
    checks: [],
    postPatchOutcome: "not_reproduced",
    repositoryValidation: {
      aggregate: "passed" as const,
      categories: [
        { category: "test" as const, status: "passed" as const },
        { category: "typecheck" as const, status: "not_available" as const },
      ],
    },
    regressionTest: {
      status: "proven" as const,
      testName: "login-does-not-return-500",
      relativePath: "sherlock-regression.test.mjs",
      runner: "node" as const,
      sha256: "a".repeat(64),
      prePatch: "failed_as_expected" as const,
      postPatch: "passed" as const,
      hashMatched: true,
      generationAttempts: 1,
      reason: null,
    },
  };
}

function verifiedReport() {
  return buildInvestigationReportData({
    summary: verifiedSummary(),
    fixAttempt: verifiedFixAttempt(),
  });
}

// Assertions shared by every rendered variant: internal identifiers and
// unsafe URLs never appear in the visible report.
function expectPrivateReport(rendered: string) {
  expect(rendered).not.toContain(INV);
  expect(rendered).not.toContain(FIX);
  expect(rendered).not.toMatch(/inv_[0-9A-Z]{6,}/);
  expect(rendered).not.toMatch(/fix_[0-9A-Z]{6,}/);
  expect(rendered).not.toContain("localhost");
  expect(rendered).not.toContain("127.0.0.1");
  expect(rendered).not.toMatch(/https?:\/\/[^\s]*:\d{4,5}/);
  expect(rendered).not.toContain("sherlock-target-");
  expect(rendered).not.toContain("/artifacts/");
}

describe("queued report", () => {
  test("contains the queued status, artwork, and unchanged delivery marker", () => {
    const rendered = renderQueuedIssueReport();
    expect(rendered).toBe(
      [
        "## Sherlock Investigation",
        "",
        "> [!NOTE]",
        "> **Investigation queued** — Sherlock will update this comment when the investigation is complete.",
        "",
        "```text",
        QUEUED_INVESTIGATION_ASCII_ART,
        "```",
      ].join("\n"),
    );
    expect(rendered).toContain(`\`\`\`text\n${QUEUED_INVESTIGATION_ASCII_ART}\n\`\`\``);

    const marker = deliveryCommentMarker(INV);
    expect(marker).toBe(`<!-- sherlock-delivery-comment:${INV} -->`);
    const queuedComment = [rendered, marker].join("\n\n");
    expect(queuedComment).toContain(
      `\n\n<!-- sherlock-delivery-comment:${INV} -->`,
    );
    expect(queuedComment).toContain(marker);
    expectPrivateReport(rendered);
  });

  test("queued status does not appear in completed, failed, or reproduced-without-fix reports", () => {
    const completed = renderIssueReport(verifiedReport(), {
      status: "created",
      url: "https://github.com/acme/app/pull/7",
    });
    const failed = renderWorkerFailureIssueReport({ error: "worker stopped" });
    const reproducedWithoutFix = renderIssueReport(
      buildInvestigationReportData({
        summary: verifiedSummary({
          outcome: "reproduced",
          originalOutcome: null,
          verification: null,
          pullRequestStatus: null,
        }),
      }),
      null,
    );

    for (const rendered of [completed, failed, reproducedWithoutFix]) {
      expect(rendered).not.toContain("**Investigation queued**");
    }
  });
});

describe("public status comment", () => {
  test("reports completion and links the PR without duplicating investigation details", () => {
    const rendered = renderIssueStatusComment(verifiedReport(), {
      status: "created",
      url: "https://github.com/acme/app/pull/7",
    });

    expect(rendered).toContain("**Fix verified**");
    expect(rendered).toContain("https://github.com/acme/app/pull/7");
    expect(rendered).not.toContain("### Root cause");
    expect(rendered).not.toContain("### Fix");
    expect(rendered).not.toContain("### Validation");
    expect(rendered).not.toContain("Replay evidence");
  });
});

describe("verified fix report", () => {
  test("full output for a verified fix with a created pull request", () => {
    const rendered = renderIssueReport(verifiedReport(), {
      status: "created",
      url: "https://github.com/acme/app/pull/7",
    });

    expect(rendered).toBe(
      `## Sherlock Investigation

> [!TIP]
> **Fix verified** — Sherlock reproduced the reported failure and verified a fix.

### Root cause

The login handler always responds with HTTP 500 for unknown users.

### Fix

Return 401 for unknown users instead of a server error.

Changed files: \`src/auth/login.ts\`

### Validation

| Check | Result |
| --- | --- |
| Original failure reproduced | Passed |
| Exact reproduction replay | Passed — failure no longer observed |
| Repository tests | Passed |
| Typecheck | Not configured |
| Generated regression test (\`login-does-not-return-500\`) | Proven — failed before and passed after |

### Limitations

- The fix was verified in an isolated Sherlock workspace by replaying the recorded reproduction; adjacent behavior was not separately verified.

### Pull request

Sherlock opened the verified fix: [View pull request #7](https://github.com/acme/app/pull/7).

<details>
<summary><strong>Technical evidence</strong></summary>

- Evidence source: Browser
- Expected: Login with unknown credentials returns HTTP 401
- Observed: POST /api/login returned HTTP 500
- Evidence collected: 2 screenshots, 1 console error, 1 failed network request, 1 failed assertion

</details>`,
    );
    expectPrivateReport(rendered);
  });

  test.each([
    ["reused", "An existing Sherlock pull request contains this fix"],
    ["merged", "was already merged"],
  ] as const)("a %s pull request is reported truthfully with its link", (status, phrase) => {
    const rendered = renderIssueReport(verifiedReport(), {
      status,
      url: "https://github.com/acme/app/pull/12",
    });
    expect(rendered).toContain(phrase);
    expect(rendered).toContain("https://github.com/acme/app/pull/12");
    expect(rendered).not.toContain("opened a pull request with the verified fix:");
    expectPrivateReport(rendered);
  });

  test("blocked PR delivery never claims a pull request", () => {
    const rendered = renderIssueReport(verifiedReport(), {
      status: "blocked",
      url: "https://github.com/acme/app/pull/12",
    });
    expect(rendered).toContain("closed without being merged");
    expect(rendered).toContain("did not open a replacement");
    expect(rendered).not.toContain("opened a pull request with the verified fix");
    expectPrivateReport(rendered);
  });

  test("fix verified but PR delivery failed says so plainly", () => {
    const rendered = renderIssueReport(verifiedReport(), {
      status: "failed",
      url: null,
    });
    expect(rendered).toContain("verified a fix");
    expect(rendered).toContain(
      "did not open a pull request because GitHub delivery failed",
    );
    expect(rendered).not.toContain("https://github.com/acme/app/pull/");
    expectPrivateReport(rendered);
  });
});

describe("failure and no-fix reports", () => {
  test("full output for an environment failure before reproduction", () => {
    const report = buildInvestigationReportData({
      summary: {
        investigationId: INV,
        outcome: "environment_failed",
        stage: "application startup",
        error:
          "Attempted command: PORT=59743 npm start\nError: connect ECONNREFUSED http://localhost:59743/health",
      },
    });
    const rendered = renderIssueReport(report, null);

    expect(rendered).toContain("> [!WARNING]");
    expect(rendered).toContain("**Environment unavailable**");
    expect(rendered).toContain("Failure stage: Investigation processing");
    expect(rendered).toContain("PORT=&lt;dynamic&gt;");
    expect(rendered).not.toContain("59743");
    expect(rendered).toContain("<pre><code>");
    expect(rendered).toContain("</code></pre>");
    expectPrivateReport(rendered);
  });

  test("reproduced without a verified fix reports the attempt and keeps analysis in evidence", () => {
    const report = buildInvestigationReportData({
      summary: verifiedSummary({
        outcome: "reproduced",
        originalOutcome: null,
        verification: null,
        pullRequestStatus: null,
      }),
      fixAttempt: {
        ...verifiedFixAttempt(),
        outcome: "rejected_regression_test_failed",
        reason: "The generated regression test did not prove the fix.",
        postPatchOutcome: "not_reproduced",
      },
      analysis: {
        type: "text",
        text: "The handler at http://localhost:53211/api/login drops the user lookup result.",
      },
    });
    const rendered = renderIssueReport(report, null);

    expect(rendered).toContain(
      "Failure reproduced; no verified fix",
    );
    // Unverified root cause is not promoted.
    expect(rendered).toContain("Not established");
    expect(rendered).not.toContain(
      "### Root cause\n\nThe login handler always responds",
    );
    expect(rendered).toContain(
      "the generated regression test did not prove it",
    );
    expect(rendered).toContain("No pull request was opened for it.");
    // Analysis is present, sanitized, and only inside collapsed evidence.
    expect(rendered).toContain("Diagnostic analysis (unverified)");
    expect(rendered).toContain("drops the user lookup result");
    expect(rendered.indexOf("<details>")).toBeLessThan(
      rendered.indexOf("Diagnostic analysis"),
    );
    expectPrivateReport(rendered);
  });

  test("plan failure lists bounded plan problems", () => {
    const report = buildInvestigationReportData({
      summary: {
        investigationId: INV,
        outcome: "plan_failed",
        planErrors: ["Step 2 has no selector.", "x".repeat(600)],
      },
    });
    const rendered = renderIssueReport(report, null);
    expect(rendered).toContain(
      "could not produce a valid reproduction plan",
    );
    expect(rendered).toContain("- Plan problem: Step 2 has no selector.");
    expect(rendered).toContain("…");
    expectPrivateReport(rendered);
  });

  test("not_reproduced reports plainly without fix or PR sections", () => {
    const report = buildInvestigationReportData({
      summary: verifiedSummary({
        outcome: "not_reproduced",
        originalOutcome: null,
        verification: null,
      }),
    });
    const rendered = renderIssueReport(report, null);
    expect(rendered).toContain("without observing the reported failure");
    expect(rendered).not.toContain("### Fix");
    expect(rendered).not.toContain("### Pull request");
    expectPrivateReport(rendered);
  });
});

describe("validation and limitation variants", () => {
  test("repository validation unavailable becomes a truthful limitation", () => {
    const attempt = verifiedFixAttempt();
    attempt.repositoryValidation = {
      aggregate: "not_available" as never,
      categories: [
        { category: "test", status: "not_available" as never },
      ] as never,
    };
    const report = buildInvestigationReportData({
      summary: verifiedSummary(),
      fixAttempt: attempt,
    });
    const rendered = renderIssueReport(report, { status: "created", url: null });
    expect(rendered).toContain("| Repository tests | Not configured |");
    expect(rendered).toContain(
      "declares no runnable validation scripts",
    );
    expectPrivateReport(rendered);
  });

  test("blocked and unavailable regression evidence become limitations", () => {
    const blocked = verifiedFixAttempt();
    blocked.regressionTest = {
      ...blocked.regressionTest,
      status: "blocked" as never,
      postPatch: "failed" as never,
      reason: "The regression test did not pass on the patched source.",
    };
    const blockedRendered = renderIssueReport(
      buildInvestigationReportData({
        summary: verifiedSummary(),
        fixAttempt: blocked,
      }),
      { status: "created", url: null },
    );
    expect(blockedRendered).toContain("| Generated regression test | Inconclusive");
    expect(blockedRendered).toContain(
      "verification relied on the exact reproduction replay",
    );

    const unavailable = verifiedFixAttempt();
    unavailable.regressionTest = {
      status: "unavailable" as never,
      testName: null,
      relativePath: null,
      runner: null,
      sha256: null,
      prePatch: null,
      postPatch: null,
      hashMatched: null,
      generationAttempts: 0,
      reason: "No regression-test generator was available.",
    } as never;
    const unavailableRendered = renderIssueReport(
      buildInvestigationReportData({
        summary: verifiedSummary(),
        fixAttempt: unavailable,
      }),
      { status: "created", url: null },
    );
    expect(unavailableRendered).toContain(
      "| Generated regression test | Not available — No regression-test generator was available. |",
    );
    expect(unavailableRendered).toContain(
      "No generated regression test was available for this fix.",
    );
  });

  test("failed checks appear only inside collapsed technical evidence, bounded and sanitized", () => {
    const attempt = verifiedFixAttempt();
    attempt.outcome = "rejected_tests_failed" as never;
    attempt.checks = [
      {
        name: "exact_plan_replayed",
        status: "failed",
        detail:
          "Replay against http://localhost:53211 still failed while API_TOKEN=super-secret was set",
      },
      { name: "application_restarted", status: "passed", detail: "Application restarted at http://127.0.0.1:53211" },
      { name: "regression_test", status: "advisory", detail: "advisory detail" },
    ] as never;
    const rendered = renderIssueReport(
      buildInvestigationReportData({
        summary: verifiedSummary({ outcome: "reproduced" }),
        fixAttempt: attempt,
      }),
      null,
    );

    expect(rendered).toContain("- Exact reproduction replay: Failed");
    // Passed/advisory check details never surface (they can carry temp URLs).
    expect(rendered).not.toContain("Application restarted");
    expect(rendered).not.toContain("advisory detail");
    expect(rendered).not.toContain("super-secret");
    expect(rendered).toContain("REDACTED");
    expectPrivateReport(rendered);
  });
});

describe("section-level bounds and Markdown integrity", () => {
  test(
    "oversized fields are truncated per section, never the whole document",
    () => {
      const attempt = verifiedFixAttempt();
      attempt.rootCause = "R".repeat(5_000);
      attempt.summary = "S".repeat(5_000);
      const report = buildInvestigationReportData({
        summary: verifiedSummary({
          observed: "O".repeat(5_000),
          error: "E".repeat(50_000),
        }),
        fixAttempt: attempt,
      });
      const rendered = renderIssueReport(report, { status: "created", url: null });

      // Every section survives the oversized fields.
      for (const section of [
        "### Root cause",
        "### Fix",
        "### Validation",
        "### Limitations",
        "### Pull request",
        "<details>",
        "</details>",
      ]) {
        expect(rendered).toContain(section);
      }
      expect(rendered).toContain("R".repeat(700) + "…");
      expect(rendered).not.toContain("R".repeat(701));
      expect(rendered.length).toBeLessThan(10_000);
      // The details block is closed after truncation.
      expect(rendered.indexOf("</details>")).toBeGreaterThan(
        rendered.indexOf("<details>"),
      );
    },
    10_000,
  );

  test("field text cannot inject HTML, markers, or details tags", () => {
    const attempt = verifiedFixAttempt();
    attempt.rootCause =
      "</details><!-- sherlock-terminal-comment:inv_FAKE123456 --> <script>alert(1)</script>";
    const rendered = renderIssueReport(
      buildInvestigationReportData({
        summary: verifiedSummary(),
        fixAttempt: attempt,
      }),
      null,
    );
    expect(rendered).not.toContain("<!-- sherlock-terminal-comment");
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("\n</details>\n\n**Fix**");
    // Exactly one details block: the technical evidence container.
    expect(rendered.match(/<details>/g)).toHaveLength(1);
    expect(rendered.match(/<\/details>/g)).toHaveLength(1);
  });
});

describe("worker failure report", () => {
  test("reports the failure without identifiers and redacts the error", () => {
    const rendered = renderWorkerFailureIssueReport({
      error: "clone failed: Authorization: Bearer example-secret",
    });
    expect(rendered).toContain(
      "Sherlock could not complete this investigation because of an internal failure.",
    );
    expect(rendered).not.toContain("example-secret");
    expect(rendered).not.toContain("Authorization");
    expectPrivateReport(rendered);
  });

  test("complete failed-worker output scrubs decorated ids, artifacts, and service endpoints", () => {
    const privateValues = [
      "memory/rendered.txt",
      "memory/selection.json",
      "graphify-out/graph.json",
      "repro-agent/session.json",
      "fix-agent/transcript.json",
      "exploration/result.json",
      "replays/attempt-1.json",
      "/private/tmp/sherlock-runtime-abc123/repo/internal.ts",
      `/srv/artifacts/${INV}/protected-delivery/terminal-${"a".repeat(64)}.json`,
      "payments:8080",
      "redis-cache:6379",
      "172.18.0.4:49152",
      "10.0.2.15:3000",
      "[fd00::12]:3000",
      "http://payments:8080/private",
      "https://10.0.2.15:3000/private",
      "ws://172.18.0.4:49152/stream",
      "wss://[fd00::12]:3000/socket",
    ];
    const rendered = renderWorkerFailureIssueReport({
      error: [
        "src/config/settings.json backend/services/delivery.ts test/fixtures/investigation.json server.ts:42 HTTP 401 3000ms",
        "inv_ABCDEF_suffix fix_ABCDEF_suffix",
        INTERNAL_OUTPUT_NAMES.join(" "),
        "db:5432 redis:6379 postgres:5432 mysql:3306 mongo:27017 app:3000 api:8080",
        "http://db:5432/private ws://redis:6379/stream",
        ...privateValues,
      ].join("\n"),
    });
    expect(rendered).toContain("internal failure");
    expect(rendered).not.toMatch(/(?:inv|fix)_ABCDEF_suffix/);
    for (const outputName of INTERNAL_OUTPUT_NAMES) {
      if (outputName === "investigation.json") continue;
      expect(rendered).not.toContain(outputName);
    }
    expect(
      rendered.replaceAll("test/fixtures/investigation.json", ""),
    ).not.toContain("investigation.json");
    expect(rendered).not.toMatch(/(?:db|redis|postgres|mysql|mongo|app|api):\d+/i);
    for (const value of privateValues) expect(rendered).not.toContain(value);
    expect(rendered).not.toContain("src/config/settings.json");
    expect(rendered).not.toContain("backend/services/delivery.ts");
    expect(rendered).not.toContain("test/fixtures/investigation.json");
    expect(rendered).not.toContain("server.ts:42");
    expect(rendered).not.toContain("HTTP 401");
    expect(rendered).not.toContain("3000ms");
    expectPrivateReport(rendered);
  });
});

describe("normalizeInvestigationReportData", () => {
  test("round-trips built report data", () => {
    const report = verifiedReport();
    const normalized = normalizeInvestigationReportData(
      JSON.parse(JSON.stringify(report)) as unknown,
    );
    expect(normalized).toEqual(report);
  });

  test("rejects non-objects and reports without an outcome", () => {
    expect(() => normalizeInvestigationReportData(null)).toThrow(/not an object/i);
    expect(() => normalizeInvestigationReportData({})).toThrow(/outcome/i);
  });

  test("rejects malformed nested fields instead of rendering them", () => {
    expect(() => normalizeInvestigationReportData({
      outcome: "reproduced",
      changedFiles: [42, "src/ok.ts"],
      limitations: "not-an-array",
      verification: { exactReplay: "bogus", repository: "nope", regression: null },
      technicalEvidence: { failedChecks: [{ name: 1 }], planErrors: null },
    } as unknown)).toThrow();
  });

  test("requires explicitly present nullable v2 keys", () => {
    for (const key of ["originalOutcome", "rootCause", "fixReason"] as const) {
      const report = structuredClone(verifiedReport()) as Record<string, unknown>;
      delete report[key];
      expect(() => normalizeInvestigationReportData(report)).toThrow(
        /missing required fields/i,
      );
    }

    const missingEvidenceError = structuredClone(verifiedReport()) as Record<string, unknown>;
    delete (missingEvidenceError.technicalEvidence as Record<string, unknown>).error;
    expect(() => normalizeInvestigationReportData(missingEvidenceError)).toThrow(
      /missing required fields/i,
    );

    const missingRegressionReason = structuredClone(verifiedReport()) as Record<string, unknown>;
    const verification = missingRegressionReason.verification as Record<string, unknown>;
    delete (verification.regression as Record<string, unknown>).reason;
    expect(() => normalizeInvestigationReportData(missingRegressionReason)).toThrow(
      /missing required fields/i,
    );
  });

  test("rejects unknown enums, oversized arrays, and contradictory claims", () => {
    const base = JSON.parse(JSON.stringify(verifiedReport())) as Record<string, unknown>;
    expect(() => normalizeInvestigationReportData({ ...base, outcome: "mystery" })).toThrow(/outcome/i);
    expect(() => normalizeInvestigationReportData({ ...base, changedFiles: Array(21).fill("x.ts") })).toThrow(/size/i);
    expect(() => normalizeInvestigationReportData({ ...base, rootCause: null })).toThrow(/inconsistent/i);

    const failed = {
      ...JSON.parse(JSON.stringify(base)),
      outcome: "failed",
      originalOutcome: null,
      rootCause: null,
      fixSummary: null,
      changedFiles: [],
      fixOutcome: null,
      verification: { exactReplay: null, repository: null, regression: null },
      technicalEvidence: {
        ...(base.technicalEvidence as object),
        error: "worker stopped",
      },
    };
    expect(() => normalizeInvestigationReportData(failed)).not.toThrow();
    expect(() => normalizeInvestigationReportData({
      ...failed,
      verification: { exactReplay: "passed", repository: null, regression: null },
    })).toThrow(/inconsistent/i);
    expect(() => normalizeInvestigationReportData({
      ...failed,
      technicalEvidence: { ...failed.technicalEvidence, error: null },
    })).toThrow(/inconsistent/i);
  });
});

describe("extractAnalysisText", () => {
  test("accepts strings and text blocks, rejects everything else", () => {
    expect(extractAnalysisText("plain")).toBe("plain");
    expect(extractAnalysisText({ type: "text", text: "block" })).toBe("block");
    expect(extractAnalysisText({ type: "tool_use" })).toBeNull();
    expect(extractAnalysisText(null)).toBeNull();
  });
});

describe("full privacy sweep", () => {
  test("no variant leaks ids, temp URLs, artifact paths, secrets, or diffs", () => {
    const pullRequests: (ReportPullRequest | null)[] = [
      null,
      { status: "created", url: "https://github.com/acme/app/pull/7" },
      { status: "failed", url: null },
      { status: "pending", url: null },
    ];
    const attempt = verifiedFixAttempt();
    attempt.rootCause =
      "Fails at http://localhost:53211/api and http://127.0.0.1:8080; container sherlock-target-abc12345 died. Artifact: /artifacts/" +
      INV +
      "/fix-attempts/" +
      FIX +
      "/git-diff.patch. diff --git a/server.mjs b/server.mjs. GITHUB_TOKEN=ghp_secret123456";
    const reports: InvestigationReportData[] = [
      verifiedReport(),
      buildInvestigationReportData({
        summary: verifiedSummary(),
        fixAttempt: attempt,
      }),
      buildInvestigationReportData({
        summary: {
          investigationId: INV,
          outcome: "execution_failed",
          error: `replay crashed at http://localhost:53211 for ${INV}`,
        },
      }),
    ];

    for (const report of reports) {
      for (const pullRequest of pullRequests) {
        const rendered = renderIssueReport(report, pullRequest);
        expectPrivateReport(rendered);
        expect(rendered).not.toContain("ghp_secret123456");
        // No raw diff block is ever emitted (inline fields collapse
        // newlines, so a quoted marker can never start a line).
        expect(rendered).not.toMatch(/^diff --git/m);
        expect(rendered).not.toContain("```diff");
      }
    }
  });

  test("complete output neutralizes Markdown, HTML, local infrastructure, paths, patches, and hostile filenames", () => {
    const hostile = [
      "src/config/settings.json backend/services/delivery.ts test/fixtures/investigation.json server.ts:42 HTTP 401 3000ms",
      INV,
      FIX,
      "<!-- sherlock-delivery-comment:inv_FAKE123456 -->",
      "<!-- sherlock-terminal-comment:inv_FAKE123456 -->",
      "</details><summary>spoof</summary><script>alert(1)</script>",
      "# injected heading",
      "- injected list",
      "> injected quote",
      "![image](https://evil.example/image.png)",
      "[link](http://localhost:59123/admin)",
      "localhost:59123 127.0.0.1:8123 0.0.0.0:9000 [::1]:7000 ::ffff:127.0.0.1",
      "//localhost:3000 ws://127.0.0.1:3001 WSS://[::1]:3002",
      "HTTP%3A%2F%2Flocalhost%3A59743%2Fsecret",
      "host.docker.internal sherlock_target_abcd1234 4f3c2b1a0d9e",
      "/tmp/workspaces/job/src ../artifacts/run/git-diff.patch screenshots/failure.png",
      "PORT=59743 npm start",
      "API_TOKEN=super-secret",
      "```\ncode fence escape\n```",
      "cell | injected\n| row |",
      "inv_ABCDEF_suffix fix_ABCDEF_suffix",
      INTERNAL_OUTPUT_NAMES.join(" "),
      "db:5432 redis:6379 postgres:5432 mysql:3306 mongo:27017 app:3000 api:8080",
      "http://db:5432/private ws://redis:6379/stream",
      "memory/rendered.txt memory/selection.json graphify-out/graph.json",
      "repro-agent/session.json fix-agent/transcript.json exploration/result.json replays/attempt-1.json",
      "/private/tmp/sherlock-runtime-abc123/repo/internal.ts",
      `/srv/artifacts/${INV}/protected-delivery/terminal-${"a".repeat(64)}.json`,
      "payments:8080 redis-cache:6379 172.18.0.4:49152 10.0.2.15:3000 [fd00::12]:3000",
      "http://payments:8080/private ws://172.18.0.4:49152/stream wss://[fd00::12]:3000/socket",
      "https://10.0.2.15:3000/private",
      "diff --git a/a.ts b/a.ts\n+secret patch",
    ].join("\n");
    const report = verifiedReport();
    report.rootCause = hostile;
    report.fixSummary = hostile;
    report.changedFiles = [
      "src/auth/login.ts",
      "src/config/settings.json",
      "backend/services/delivery.ts",
      "test/fixtures/investigation.json",
      "src/`escape`.ts",
      `src/${INV}-API_TOKEN=super-secret.ts`,
      "<!-- sherlock-terminal-comment:inv_FAKE123456 -->.ts",
      "../artifacts/git-diff.patch",
    ];
    report.limitations = [hostile];
    report.technicalEvidence.expected = hostile;
    report.technicalEvidence.observed = hostile;
    report.technicalEvidence.error = hostile;
    report.technicalEvidence.analysis = hostile;
    report.technicalEvidence.planErrors = [
      "diff --git a/a.ts b/a.ts\n+secret patch",
      hostile,
    ];
    report.technicalEvidence.failedChecks = [{
      name: "exact_plan_replayed",
      status: "failed",
      detail: hostile,
    }];

    const rendered = renderIssueReport(report, {
      status: "created",
      url: "https://github.com/acme/app/pull/77",
    });
    expect(rendered).toContain("`src/auth/login.ts`");
    expect(rendered).toContain("`src/config/settings.json`");
    expect(rendered).toContain("`backend/services/delivery.ts`");
    expect(rendered).toContain("`test/fixtures/investigation.json`");
    expect(rendered).toContain("server.ts:42");
    expect(rendered).toContain("HTTP 401");
    expect(rendered).toContain("3000ms");
    expect(rendered).toContain("[View pull request #77](https://github.com/acme/app/pull/77)");
    expect(rendered.match(/<details>/g)).toHaveLength(1);
    expect(rendered.match(/<summary>/g)).toHaveLength(1);
    expect(rendered).not.toMatch(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1|59743|super-secret)/i);
    expect(rendered).not.toMatch(/(?:inv_FAKE|sherlock-(?:delivery|terminal)-comment|git-diff\.patch|workspaces\/job|screenshots\/failure)/i);
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toMatch(/^diff --git/m);
    expect(rendered).not.toContain("https://evil.example");
    expect(rendered).not.toMatch(/(?:inv|fix)_ABCDEF_suffix/);
    expect(rendered).not.toMatch(/(?:db|redis|postgres|mysql|mongo|app|api):\d+/i);
    expect(rendered).not.toMatch(/(?:memory\/(?:rendered\.txt|selection\.json)|graphify-out\/graph\.json|repro-agent\/session\.json|fix-agent\/transcript\.json|exploration\/result\.json|replays\/attempt-1\.json)/i);
    expect(rendered).not.toMatch(/(?:payments:8080|redis-cache:6379|172\.18\.0\.4:49152|10\.0\.2\.15:3000|\[fd00::12\]:3000)/i);
    expect(rendered).not.toContain("http://payments:8080/private");
    expect(rendered).not.toContain("https://10.0.2.15:3000/private");
    expect(rendered).not.toContain("ws://172.18.0.4:49152/stream");
    expect(rendered).not.toContain("wss://[fd00::12]:3000/socket");
    for (const outputName of INTERNAL_OUTPUT_NAMES) {
      if (outputName === "investigation.json") continue;
      expect(rendered).not.toContain(outputName);
    }
    expect(
      rendered.replaceAll("test/fixtures/investigation.json", ""),
    ).not.toContain("investigation.json");
    expect(rendered).toContain("PORT=&lt;dynamic&gt;");
    expect(rendered).toContain("\\[patch omitted\\]");
    expectPrivateReport(rendered);
  });

  test("only canonical GitHub pull-request URLs are preserved", () => {
    expect(canonicalGitHubPullRequestUrl("https://github.com/acme/app/pull/7")).toBe(
      "https://github.com/acme/app/pull/7",
    );
    expect(canonicalGitHubPullRequestUrl("http://github.com/acme/app/pull/7")).toBeNull();
    expect(canonicalGitHubPullRequestUrl("https://evil.example/acme/app/pull/7")).toBeNull();
    expect(canonicalGitHubPullRequestUrl("https://github.com/acme/app/issues/7")).toBeNull();
    const rendered = renderIssueReport(verifiedReport(), {
      status: "created",
      url: "https://evil.example/[spoof](http://localhost:3000)",
    });
    expect(rendered).not.toContain("evil.example");
    expect(rendered).not.toContain("localhost");
  });
});
