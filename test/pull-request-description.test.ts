// Deterministic full-output and privacy tests for the pull-request
// description renderer. The renderer is a pure function of structured fix
// data; it never consumes issue-report Markdown or raw check details.
import { describe, expect, test } from "vitest";
import {
  buildCompareUrl,
  buildPullRequestDescriptionData,
  canonicalGitHubCompareUrl,
  renderPullRequestDescription,
  renderPullRequestTitle,
  type PullRequestDescriptionInput,
} from "../backend/services/pull-request-description-renderer.js";

const INV = "inv_0PRDESC12345";
const FIX = "fix_0PRDESC12345";
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

function baseInput(
  overrides: Partial<PullRequestDescriptionInput> = {},
): PullRequestDescriptionInput {
  return {
    owner: "acme",
    repo: "app",
    baseBranch: "main",
    branch: "sherlock/fix-42-login-abc123",
    issueNumber: 42,
    issueTitle: "Login returns 500 for unknown users!",
    plan: {
      stepCount: 3,
      mode: "browser",
      expectedBehavior: "Login with unknown credentials returns HTTP 401.",
      failureCondition: "Login request returns HTTP 500.",
    },
    fixAttempt: {
      summary: "Return 401 for unknown users instead of a server error.",
      rootCause: "The login handler always responds with HTTP 500.",
      changedFiles: ["src/auth/login.ts"],
      postPatchOutcome: "not_reproduced",
      checks: [
        { name: "original_reproduced", status: "passed" },
        { name: "exact_plan_replayed", status: "passed" },
        {
          // Its detail contains a temporary URL in production; only the
          // structured name and status may be rendered.
          name: "application_restarted",
          status: "passed",
        },
        { name: "regression_test", status: "passed" },
      ],
      repositoryValidation: {
        aggregate: "passed",
        categories: [{ category: "test", status: "passed" }],
      },
      regressionTest: {
        status: "proven",
        testName: "login-does-not-return-500",
        prePatch: "failed_as_expected",
        postPatch: "passed",
        hashMatched: true,
        reason: null,
      },
      testRuns: [
        {
          command: "node check-login.mjs",
          exitCode: 0,
          targeted: true,
          durationMs: 1200,
          timedOut: false,
        },
      ],
    },
    proposal: null,
    ...overrides,
  };
}

function expectPrivateDescription(rendered: string) {
  expect(rendered).not.toContain(INV);
  expect(rendered).not.toContain(FIX);
  expect(rendered).not.toMatch(/inv_[0-9A-Z]{6,}/);
  expect(rendered).not.toMatch(/fix_[0-9A-Z]{6,}/);
  expect(rendered).not.toContain("localhost");
  expect(rendered).not.toContain("127.0.0.1");
  expect(rendered).not.toContain("/artifacts/");
  expect(rendered).not.toContain("git-diff.patch");
  expect(rendered).not.toContain("fix-proposal.json");
  expect(rendered).not.toMatch(/^diff --git/m);
}

describe("pull request title", () => {
  test("is deterministic, redacted, and bounded", () => {
    expect(renderPullRequestTitle("Return 401 for unknown users")).toBe(
      "Sherlock: Return 401 for unknown users",
    );
    expect(renderPullRequestTitle(null)).toBe(
      "Sherlock: Fix verified by reproduction replay",
    );
    expect(
      renderPullRequestTitle("uses API_TOKEN=super-secret"),
    ).not.toContain("super-secret");
    const longWordTitle = renderPullRequestTitle("x".repeat(500));
    expect(longWordTitle.length).toBeLessThanOrEqual(72);
    expect(longWordTitle).toMatch(/…$/);
  });

  test("shortens long summaries at a readable word boundary", () => {
    const title = renderPullRequestTitle(
      "Prevent duplicate billing notifications when retrying failed webhook deliveries",
    );

    expect(title).toBe(
      "Sherlock: Prevent duplicate billing notifications when retrying…",
    );
    expect(title.length).toBeLessThanOrEqual(72);
  });

  test("neutralizes every public title injection and infrastructure form", () => {
    const title = renderPullRequestTitle(
      `# ${INV} inv_ABCDEF_suffix fix_ABCDEF_suffix db:5432 reproduction-result.json\n<!-- sherlock-terminal-comment:inv_FAKE123456 --> ` +
      "http://localhost:59743 /tmp/workspaces/run/git-diff.patch " +
      "API_TOKEN=super-secret [spoof](https://evil.example)",
    );
    expect(title).toMatch(/^Sherlock: /);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).not.toMatch(/(?:inv_|localhost|59743|workspaces|git-diff|super-secret|<!--|\n|\[|\]|#)/i);
    expect(title).not.toMatch(/(?:fix_ABCDEF_suffix|db:5432|reproduction-result\.json)/i);

    const privateValues = [
      "memory/rendered.txt",
      "memory/selection.json",
      "graphify-out/graph.json",
      "repro-agent/session.json",
      "fix-agent/transcript.json",
      "exploration/result.json",
      "replays/attempt-1.json",
      "/private/tmp/sherlock-runtime-abc123/repo/internal.ts",
      "protected-delivery/terminal-aaaaaaaa.json",
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
    for (const value of privateValues) {
      expect(renderPullRequestTitle(`Fix ${value}`)).not.toContain(value);
    }
    for (const value of [
      "src/config/settings.json",
      "backend/services/delivery.ts",
      "server.ts:42",
      "HTTP 401",
      "3000ms",
    ]) {
      expect(renderPullRequestTitle(`Keep ${value}`)).toContain(value);
    }
  });
});

describe("pull request description", () => {
  test("keeps the detailed investigation and comparison media in the PR", () => {
    const rendered = renderPullRequestDescription(
      buildPullRequestDescriptionData(baseInput({
        replayEvidence: {
          gifUrl: "https://example.supabase.co/evidence.gif",
          videoUrl: "https://example.supabase.co/evidence.mp4",
        },
      })),
    );

    expect(rendered).toContain("## Summary");
    expect(rendered).toContain("## Root cause");
    expect(rendered).toContain("Expected:");
    expect(rendered).toContain("Observed before the fix:");
    expect(rendered).toContain("## Limitations");
    expect(rendered).not.toContain("## Review focus");
    expect(rendered).toContain("- `src/auth/login.ts`");
    expect(rendered).toContain("| Check | Result |");
    expect(rendered).toContain("| Original failure reproduced | Passed |");
    expect(rendered).toContain("| Exact reproduction replay | Passed — failure no longer observed |");
    expect(rendered).toContain("| Application restart | Passed |");
    expect(rendered).toContain("| Repository tests | Passed |");
    expect(rendered).toContain("| Generated regression test (`login-does-not-return-500`) | Proven");
    expect(rendered).toContain("| Targeted check: `node check-login.mjs` | Passed |");
    expect(rendered).toContain("## Replay evidence");
    expect(rendered).toContain("![Sherlock replay evidence](https://example.supabase.co/evidence.gif)");
    expect(rendered).toContain("[Watch the full comparison video](https://example.supabase.co/evidence.mp4)");
    expect(rendered).toContain("[View the full diff on GitHub](https://github.com/acme/app/compare/main...sherlock%2Ffix-42-login-abc123)");
    expect(rendered).not.toMatch(/\b(?:PASS|FAIL|ADVISORY)\b/);
    expect(rendered).not.toContain("-> exit");
    // No trustworthy review-focus signals -> the section is omitted entirely.
    expect(rendered).not.toContain("## Review focus");
    expectPrivateDescription(rendered);
  });

  test("explains why an API-only reproduction has no visual comparison", () => {
    const rendered = renderPullRequestDescription(
      buildPullRequestDescriptionData(baseInput({
        plan: {
          ...baseInput().plan,
          mode: "api-only",
        },
        replayEvidence: null,
      })),
    );

    expect(rendered).toContain(
      "No visual comparison is available because the accepted reproduction was API-only",
    );
    expect(rendered).toContain("recorded API reproduction");
    expect(rendered).toContain("no browser session was recorded");
  });

  test("review focus derives only from explicit structured signals", () => {
    const rendered = renderPullRequestDescription(
      buildPullRequestDescriptionData(
        baseInput({
          proposal: {
            risk: "medium",
            assumptions: ["Only the login route returns this error."],
            relevantTests: ["npm test"],
          },
          fixAttempt: {
            ...baseInput().fixAttempt,
            checks: [
              { name: "exact_plan_replayed", status: "passed" },
              { name: "regression_test", status: "advisory" },
            ],
            repositoryValidation: {
              aggregate: "passed",
              categories: [
                { category: "test", status: "passed" },
                { category: "lint", status: "not_available" },
              ],
            },
            regressionTest: {
              status: "blocked",
              testName: "login-regression",
              prePatch: "failed_as_expected",
              postPatch: "failed",
              hashMatched: true,
              reason: "The regression test did not pass on the patched source.",
            },
          },
        }),
      ),
    );

    expect(rendered).toContain("## Review focus");
    expect(rendered).toContain("The fixer assessed this change as medium risk");
    expect(rendered).toContain("Assumption: Only the login route returns this error");
    expect(rendered).toContain("## Limitations");
    expect(rendered).toContain(
      "| Generated regression test | Inconclusive — before: Failed as expected, after: Failed |",
    );
    expectPrivateDescription(rendered);
  });

  test("renders a clean file list without invented per-file explanations", () => {
    const rendered = renderPullRequestDescription(
      buildPullRequestDescriptionData(
        baseInput({
          fixAttempt: {
            ...baseInput().fixAttempt,
            changedFiles: ["src/auth/login.ts", "src/auth/session.ts"],
          },
        }),
      ),
    );
    expect(rendered).toContain("- `src/auth/login.ts`\n- `src/auth/session.ts`");
    // No fabricated " — explanation" suffix on any file line.
    expect(rendered).not.toMatch(/- `src\/auth\/[a-z.]+` — /);
  });

  test("bounded fields keep every section and the markdown structure intact", () => {
    const input = baseInput();
    input.fixAttempt = {
      ...input.fixAttempt,
      summary: "S".repeat(5_000),
      rootCause: "R".repeat(5_000),
      changedFiles: Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts`),
      testRuns: Array.from({ length: 20 }, (_, i) => ({
        command: `npm test -- case-${i}`,
        exitCode: 0,
        targeted: true,
        durationMs: 10,
        timedOut: false,
      })),
    };
    const rendered = renderPullRequestDescription(
      buildPullRequestDescriptionData(input),
    );

    for (const section of ["## Summary", "## Root cause", "## Changes", "## Validation", "## Limitations", "[View the full diff on GitHub]"]) {
      expect(rendered).toContain(section);
    }
    expect(rendered).toContain("R".repeat(1_000) + "…");
    expect(rendered).toContain("- …and 20 more files");
    expect(rendered.length).toBeLessThan(20_000);
    expectPrivateDescription(rendered);
  });

  test("temporary URLs, ids, and secrets in field text are scrubbed", () => {
    const input = baseInput();
    input.fixAttempt = {
      ...input.fixAttempt,
      summary: `Fixes ${INV} at http://localhost:53211/login`,
      rootCause:
        `Handler crashed (fix attempt ${FIX}) against http://127.0.0.1:8080 in container sherlock-target-ab12cd34; ` +
        "DATABASE_URL=postgres://admin:hunter2@db/app leaked into /artifacts/" +
        INV +
        "/repro.log",
    };
    const rendered = renderPullRequestDescription(
      buildPullRequestDescriptionData(input),
    );
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("sherlock-target-ab12cd34");
    expectPrivateDescription(rendered);
  });

  test("the native diff link is the repository compare URL", () => {
    expect(
      buildCompareUrl({
        owner: "acme",
        repo: "app",
        baseBranch: "main",
        branch: "sherlock/fix-7-crash-9f9f9f",
      }),
    ).toBe("https://github.com/acme/app/compare/main...sherlock%2Ffix-7-crash-9f9f9f");
    expect(
      buildCompareUrl({
        owner: "acme org",
        repo: "app#1",
        baseBranch: "release/v1",
        branch: "sherlock/fix 7",
      }),
    ).toBe("https://github.com/acme%20org/app%231/compare/release%2Fv1...sherlock%2Ffix%207");
    expect(canonicalGitHubCompareUrl(
      "https://github.com/acme/app/compare/main...sherlock%2Ffix-7-crash-9f9f9f",
    )).toBe("https://github.com/acme/app/compare/main...sherlock%2Ffix-7-crash-9f9f9f");
    expect(canonicalGitHubCompareUrl("https://evil.example/acme/app/compare/main...head")).toBeNull();
  });

  test("missing structured data degrades to truthful fallbacks", () => {
    const input = baseInput();
    input.plan = {
      stepCount: 1,
      mode: null,
      expectedBehavior: "",
      failureCondition: "",
    };
    input.fixAttempt = {
      ...input.fixAttempt,
      summary: null,
      rootCause: null,
      postPatchOutcome: null,
      repositoryValidation: null,
      regressionTest: null,
      testRuns: [],
    };
    const rendered = renderPullRequestDescription(
      buildPullRequestDescriptionData(input),
    );
    expect(rendered).toContain(
      "Sherlock verified a minimal fix by replaying the saved reproduction.",
    );
    expect(rendered).not.toContain("## Root cause");
    expect(rendered).toContain("| Project test command | Not configured |");
    expectPrivateDescription(rendered);
  });

  test("complete PR output sanitizes every prose, filename, command, and review-focus field", () => {
    const hostile = [
      "src/config/settings.json backend/services/delivery.ts test/fixtures/investigation.json server.ts:42 HTTP 401 3000ms",
      `${INV} ${FIX}`,
      "<!-- sherlock-delivery-comment:inv_FAKE123456 -->",
      "</details><summary>spoof</summary><script>alert(1)</script>",
      "# heading | extra row",
      "![image](https://evil.example/x.png) [link](http://localhost:59743/x)",
      "localhost:5000 127.0.0.1:5001 0.0.0.0:5002 [::1]:5003",
      "//localhost:5004 ws://127.0.0.1:5005 WSS://[::1]:5006",
      "HTTP%3A%2F%2Flocalhost%3A59743%2Fsecret host.docker.internal",
      "/tmp/workspaces/run ../artifacts/run/git-diff.patch screenshots/failure.png",
      "PORT=59743 npm start API_TOKEN=super-secret",
      "``` escape ```",
      "inv_ABCDEF_suffix fix_ABCDEF_suffix",
      INTERNAL_OUTPUT_NAMES.join(" "),
      "db:5432 redis:6379 postgres:5432 mysql:3306 mongo:27017 app:3000 api:8080",
      "http://db:5432/private ws://redis:6379/stream",
      "memory/rendered.txt memory/selection.json graphify-out/graph.json",
      "repro-agent/session.json fix-agent/transcript.json exploration/result.json replays/attempt-1.json",
      "/private/tmp/sherlock-runtime-abc123/repo/internal.ts protected-delivery/terminal-aaaaaaaa.json",
      "payments:8080 redis-cache:6379 172.18.0.4:49152 10.0.2.15:3000 [fd00::12]:3000",
      "http://payments:8080/private ws://172.18.0.4:49152/stream wss://[fd00::12]:3000/socket",
      "https://10.0.2.15:3000/private",
      "diff --git a/a.ts b/a.ts\n+patch",
    ].join("\n");
    const input = baseInput({
      issueTitle: hostile,
      plan: {
        stepCount: 2,
        mode: "unknown_internal_mode",
        expectedBehavior: hostile,
        failureCondition: hostile,
      },
      proposal: {
        risk: "high",
        assumptions: [hostile],
        relevantTests: [hostile],
      },
    });
    input.fixAttempt = {
      ...input.fixAttempt,
      summary: hostile,
      rootCause: hostile,
      changedFiles: [
        "src/auth/login.ts",
        "src/config/settings.json",
        "backend/services/delivery.ts",
        "test/fixtures/investigation.json",
        "src/`escape`.ts",
        `src/${INV}-API_TOKEN=super-secret.ts`,
        "<!-- sherlock-terminal-comment:inv_FAKE123456 -->.ts",
        "../artifacts/git-diff.patch",
      ],
      checks: [
        { name: "unknown_internal_check", status: "advisory" },
        { name: "exact_plan_replayed", status: "passed" },
      ],
      repositoryValidation: {
        aggregate: "passed",
        categories: [{ category: "unknown_internal_category", status: "passed" }],
      },
      regressionTest: {
        status: "blocked",
        testName: hostile,
        prePatch: "unknown_internal_run",
        postPatch: "failed",
        hashMatched: true,
        reason: hostile,
      },
      testRuns: [{
        command: hostile,
        exitCode: 1,
        targeted: true,
        durationMs: 59743,
        timedOut: false,
      }],
    };

    const rendered = renderPullRequestDescription(buildPullRequestDescriptionData(input));
    expect(rendered).toContain("`src/auth/login.ts`");
    expect(rendered).toContain("`src/config/settings.json`");
    expect(rendered).toContain("`backend/services/delivery.ts`");
    expect(rendered).toContain("`test/fixtures/investigation.json`");
    expect(rendered).toContain("server.ts:42");
    expect(rendered).toContain("HTTP 401");
    expect(rendered).toContain("3000ms");
    expect(rendered).toContain("| Verification check | Advisory |");
    expect(rendered).toContain("| Repository check | Passed |");
    expect(rendered).toContain("[View the full diff on GitHub](https://github.com/acme/app/compare/main...sherlock%2Ffix-42-login-abc123)");
    expect(rendered).not.toMatch(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1|59743|super-secret)/i);
    expect(rendered).not.toMatch(/(?:inv_|fix_|sherlock-(?:delivery|terminal)-comment|git-diff\.patch|workspaces\/run|screenshots\/failure)/i);
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("unknown_internal");
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
    expect(rendered).not.toMatch(/\b(?:PASS|FAIL|ADVISORY)\b/);
    expect(rendered).not.toContain("-> exit");
    expect(rendered).toContain("PORT=&lt;dynamic&gt;");
    expectPrivateDescription(rendered);
  });
});
