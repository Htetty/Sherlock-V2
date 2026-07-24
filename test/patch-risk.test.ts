// Diff-risk heuristic tests (Phase 3.1). Honest labelling is under test:
// a clean scan is never a security claim.

import { describe, expect, test } from "vitest";
import { analyzePatchRisk, isTestFile, patchRiskEnabled } from "../backend/services/patch-risk.js";

describe("patchRiskEnabled", () => {
  test("off unless SHERLOCK_PATCH_RISK_CHECKS=true", () => {
    expect(patchRiskEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      patchRiskEnabled({ SHERLOCK_PATCH_RISK_CHECKS: "true" } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("analyzePatchRisk", () => {
  test("null diff => not applicable, not a pass", () => {
    const verdicts = analyzePatchRisk(null, []);
    expect(verdicts[0].matched).toBe(false);
    expect(verdicts[0].detail).toMatch(/no diff available/);
  });

  test("clean diff reports a non-match that is explicitly not a security claim", () => {
    const diff = "--- a/x.js\n+++ b/x.js\n-const a = 1;\n+const a = 2;\n";
    const verdicts = analyzePatchRisk(diff, ["x.js"]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].matched).toBe(false);
    expect(verdicts[0].detail).toMatch(/NOT a security verification/);
  });

  test("secret material is a hard_fail", () => {
    const diff =
      "--- a/config.js\n+++ b/config.js\n+const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';\n";
    const verdicts = analyzePatchRisk(diff, ["config.js"]);
    const secret = verdicts.find((v) => v.rule === "secret_material");
    expect(secret).toBeDefined();
    expect(secret!.severity).toBe("hard_fail");
    expect(secret!.matched).toBe(true);
  });

  test("added shell execution and auth bypass are warnings", () => {
    const diff =
      "--- a/s.js\n+++ b/s.js\n+const { execSync } = require('child_process');\n+const skipAuth = true;\n";
    const rules = analyzePatchRisk(diff, ["s.js"]).map((v) => v.rule);
    expect(rules).toContain("shell_execution_added");
    expect(rules).toContain("auth_check_removed_or_bypassed");
  });

  test("ordinary fetch calls are detected as network additions", () => {
    const verdicts = analyzePatchRisk(
      "--- a/a.js\n+++ b/a.js\n+await fetch('https://example.test');\n",
      ["a.js"],
    );
    expect(verdicts.some((verdict) => verdict.rule === "network_call_added")).toBe(true);
  });

  test("test weakening flagged only when a test file is touched", () => {
    const diff =
      "--- a/auth.test.js\n+++ b/auth.test.js\n-  expect(res.status).toBe(401);\n+  it.skip('checks auth', () => {});\n";
    const verdicts = analyzePatchRisk(diff, ["auth.test.js"]);
    expect(verdicts.some((v) => v.rule === "test_weakening")).toBe(true);

    const nonTest = analyzePatchRisk(
      "--- a/a.js\n+++ b/a.js\n-  expect(x).toBe(1);\n+  y;\n",
      ["a.js"],
    );
    expect(nonTest.some((v) => v.rule === "test_weakening")).toBe(false);
  });

  test("isTestFile detects common layouts", () => {
    expect(isTestFile("test/foo.js")).toBe(true);
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("src/foo.ts")).toBe(false);
  });
});
