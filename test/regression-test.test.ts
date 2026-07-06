// Regression-test module units: strict proposal validation, runtime-marker
// classification, container-only execution, the hash gate, and truthful
// comment lines. Command execution is mocked through the Docker adapter.
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { DockerAdapter } from "../backend/services/container.js";
import {
  buildRegressionTestPrompt,
  classifyPostPatchRun,
  classifyPrePatchRun,
  extractRegressionFailureMarker,
  formatRegressionCommentLines,
  hashTestContents,
  materializeTest,
  runRegressionTest,
  validateRegressionProposalSafety,
  validateRegressionProposalShape,
  type RegressionTestProposal,
} from "../backend/services/regression-test.js";
import type { ReproductionPlan } from "../backend/services/plan.js";
import type { ReproductionResult } from "../backend/services/playwright.js";

const MARKER = "REGRESSION_EXPECTED_FAILURE: login must not return 500";

const VALID_CONTENTS = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile("server.mjs", "utf8");
assert.ok(!source.includes("res.writeHead(500"), "${MARKER}");
`;

function proposal(overrides: Partial<RegressionTestProposal> = {}): RegressionTestProposal {
  return {
    version: 1,
    testName: "login-does-not-return-500",
    purpose: "Prove the login handler no longer returns HTTP 500.",
    relativePath: "sherlock-regression.test.mjs",
    runner: "node",
    contents: VALID_CONTENTS,
    expectedPrePatchFailure: "The assertion on the 500 response fails.",
    expectedPostPatchBehavior: "The assertion passes once 401 is returned.",
    ...overrides,
  };
}

describe("regression proposal validation", () => {
  test("a valid structured proposal is accepted", () => {
    const validated = validateRegressionProposalShape(proposal());
    expect(validated.ok).toBe(true);
  });

  test("unsafe paths, runners, sizes, and dangerous constructs are rejected", () => {
    const failing: [Partial<RegressionTestProposal>, string][] = [
      [{ relativePath: "../escape.mjs" }, "relativePath"],
      [{ relativePath: "/tmp/abs.mjs" }, "relativePath"],
      [{ relativePath: "nested/dir.mjs" }, "relativePath"],
      [{ relativePath: "test.sh" }, "relativePath"],
      [{ runner: "vitest" as never }, "runner"],
      [{ contents: `assert ${"x".repeat(20_001)}` }, "limit"],
      [{ contents: 'import { execSync } from "child_process"; assert(1);' }, "child-process"],
      [{ contents: "assert(eval('1'));" }, "eval"],
      [{ contents: "const f = new Function('return 1'); assert(f());" }, "Function"],
      [{ contents: "assert(JSON.stringify(process.env));" }, "environment dumping"],
      [
        { contents: 'assert(await fetch("https://evil.example.com")); // REGRESSION_EXPECTED_FAILURE: x' },
        "external network",
      ],
      [{ contents: "console.log('no assertion at all');" }, "assert"],
      // The behavioral marker is mandatory and must be unique.
      [{ contents: 'assert.ok(false, "no marker at all");' }, "REGRESSION_EXPECTED_FAILURE"],
      [
        {
          contents:
            'assert.ok(false, "REGRESSION_EXPECTED_FAILURE: a");\nassert.ok(false, "REGRESSION_EXPECTED_FAILURE: b");',
        },
        "REGRESSION_EXPECTED_FAILURE",
      ],
    ];

    for (const [override, expectedError] of failing) {
      const validated = validateRegressionProposalShape(proposal(override));
      expect(validated.ok).toBe(false);

      if (!validated.ok) {
        expect(validated.errors.join(" ")).toContain(expectedError);
      }
    }
  });

  test("a proposal targeting an existing file is rejected and never overwrites it", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-regression-"));
    await writeFile(path.join(repoPath, "sherlock-regression.test.mjs"), "original", "utf8");

    const safety = await validateRegressionProposalSafety(proposal(), repoPath);

    expect(safety.ok).toBe(false);
    expect(safety.errors.join(" ")).toContain("already exists");
    expect(
      await readFile(path.join(repoPath, "sherlock-regression.test.mjs"), "utf8"),
    ).toBe("original");
  });
});

describe("regression generation prompt", () => {
  test("requires verified reproduction routes and the exact behavioral failure marker", () => {
    // Marker extraction: exactly one required.
    expect(extractRegressionFailureMarker(VALID_CONTENTS)).toBe(MARKER);
    expect(extractRegressionFailureMarker("assert.ok(false, 'plain');")).toBeNull();

    const plan = {
      version: 1,
      baseUrl: "http://localhost:51234",
      steps: [
        {
          id: "step-1",
          action: "request",
          method: "POST",
          path: "/tasks/archive-completed",
        },
      ],
      expectedBehavior: "Archived tasks stay archived.",
      failureCondition: "Archived tasks reappear.",
      assertion: { type: "response_body", failureContains: "x" },
    } as unknown as ReproductionPlan;

    const prompt = buildRegressionTestPrompt(
      {
        issueTitle: "Archiving breaks the task list",
        issueBody: "Tasks reappear.",
        plan,
        reproductionResult: {
          outcomeReason: "reproduced",
          assertion: null,
        } as unknown as ReproductionResult,
        fixProposal: { summary: "fix" },
        sourceFiles: [{ path: "server.mjs", contents: "// src" }],
      },
      null,
    );

    // The verified plan (the only trusted route source) is embedded, and the
    // prompt forbids invented endpoints while requiring the unique marker on
    // the final behavioral assertion and captured (not fixed) IDs.
    expect(prompt).toContain("/tasks/archive-completed");
    expect(prompt).toContain("NEVER invent");
    expect(prompt).toContain("ONLY routes, paths, selectors, and actions");
    expect(prompt).toContain("REGRESSION_EXPECTED_FAILURE:");
    expect(prompt).toContain("exactly ONE assertion");
    expect(prompt).toContain("Capture IDs from the resources the test itself creates");
    expect(prompt).toContain("Test ONLY the reproduced behavioral assertion");
  });
});

describe("regression run classification", () => {
  const run = (exitCode: number, stderr = "", timedOut = false) => ({
    exitCode,
    timedOut,
    stdout: "",
    stderr,
  });

  test("pre-patch: only an assertion failure carrying the exact behavioral marker counts as failed_as_expected", () => {
    // Assertion failure WITH the exact expected marker: behavioral proof.
    expect(
      classifyPrePatchRun(
        run(1, `AssertionError [ERR_ASSERTION]: ${MARKER}`),
        MARKER,
      ),
    ).toBe("failed_as_expected");

    // The live inv_1JSR0AM8Q8T19Z3 false negative: an assertion failure from
    // a wrong-route/setup step (404) WITHOUT the marker is NOT behavioral
    // proof — it is an invalid test eligible for refinement.
    expect(
      classifyPrePatchRun(
        run(1, "AssertionError [ERR_ASSERTION]: Archive request should succeed, got 404"),
        MARKER,
      ),
    ).toBe("invalid_test");

    expect(classifyPrePatchRun(run(0), MARKER)).toBe("unexpectedly_passed");
    // Broken test code is never regression proof.
    expect(classifyPrePatchRun(run(1, "SyntaxError: Unexpected token"), MARKER)).toBe(
      "invalid_test",
    );
    expect(
      classifyPrePatchRun(
        run(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'jest'"),
        MARKER,
      ),
    ).toBe("invalid_test");
    expect(classifyPrePatchRun(run(1, "", true), MARKER)).toBe("timed_out");
    expect(classifyPrePatchRun(run(127, "spawn failed"), MARKER)).toBe("execution_failed");
    expect(classifyPrePatchRun(run(1, "segfault"), MARKER)).toBe("execution_failed");
  });

  test("post-patch classification", () => {
    expect(classifyPostPatchRun(run(0))).toBe("passed");
    expect(classifyPostPatchRun(run(1, "AssertionError [ERR_ASSERTION]"))).toBe("failed");
    expect(classifyPostPatchRun(run(1, "", true))).toBe("timed_out");
    expect(classifyPostPatchRun(run(1, "kernel panic"))).toBe("execution_failed");
  });
});

describe("regression container execution", () => {
  test("runs as argv through the restricted container with the sandbox URL only", async () => {
    const spawned: string[][] = [];
    const removed: string[] = [];
    const adapter: DockerAdapter = {
      isAvailable: async () => true,
      spawnContainer: (args) => {
        spawned.push(args);
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.exitCode = null;
        proc.kill = () => true;
        setImmediate(() => proc.emit("close", 0));
        return proc as ChildProcessWithoutNullStreams;
      },
      removeContainer: async (name) => {
        removed.push(name);
      },
    };

    const result = await runRegressionTest(adapter, {
      repoPath: "/tmp/ws",
      relativePath: "sherlock-regression.test.mjs",
      targetUrl: "http://localhost:51234",
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    const args = spawned[0];
    // argv array, no shell.
    expect(args.slice(-2)).toEqual(["node", "sherlock-regression.test.mjs"]);
    expect(args.join(" ")).not.toContain("sh -");
    // Restricted-container path with CI and ONLY the rewritten sandbox URL.
    expect(args).toContain("--cap-drop=ALL");
    expect(args.join(" ")).toContain("-e CI=true");
    expect(args.join(" ")).toContain(
      "-e SHERLOCK_TARGET_URL=http://host.docker.internal:51234",
    );
    expect(args).toContain("--add-host=host.docker.internal:host-gateway");
    expect(args[args.indexOf("--name") + 1]).toMatch(/^sherlock-regression-/);
    // Cleanup ran.
    expect(removed).toHaveLength(1);
  });

  test("timeout forces cleanup and reports timed-out state", async () => {
    const removed: string[] = [];
    const adapter: DockerAdapter = {
      isAvailable: async () => true,
      spawnContainer: () => {
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.exitCode = null;
        proc.kill = () => true;
        return proc as ChildProcessWithoutNullStreams; // never closes
      },
      removeContainer: async (name) => {
        removed.push(name);
      },
    };

    const result = await runRegressionTest(adapter, {
      repoPath: "/tmp/ws",
      relativePath: "x.mjs",
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(removed.length).toBeGreaterThan(0);
  });
});

describe("hash gate and comment lines", () => {
  test("identical bytes hash identically; tampered bytes are detected", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-regression-"));
    const testProposal = proposal();
    const sha = hashTestContents(testProposal.contents);

    expect(sha).toBe(hashTestContents(testProposal.contents));

    const good = await materializeTest(repoPath, testProposal, sha);
    expect(good.ok).toBe(true);
    await good.remove();

    // A different expected hash (e.g. the recorded pre-patch value after
    // tampering) blocks comparability.
    const bad = await materializeTest(repoPath, testProposal, "deadbeef");
    expect(bad.ok).toBe(false);
    await bad.remove();
  });

  test("comment lines are truthful for proven, blocked, and unavailable states", () => {
    expect(
      formatRegressionCommentLines({
        status: "proven",
        testName: "archive-completed-does-not-restore-task",
        relativePath: "sherlock-regression.test.mjs",
        runner: "node",
        sha256: "abc",
        prePatch: "failed_as_expected",
        postPatch: "passed",
        hashMatched: true,
        generationAttempts: 1,
        reason: null,
      }),
    ).toEqual([
      "Test: archive-completed-does-not-restore-task",
      "Before patch: failed as expected",
      "After patch: passed",
      "Identical test: yes",
    ]);

    expect(
      formatRegressionCommentLines({
        status: "unavailable",
        testName: null,
        relativePath: null,
        runner: null,
        sha256: null,
        prePatch: null,
        postPatch: null,
        hashMatched: null,
        generationAttempts: 2,
        reason: "no safe supported test form could be generated",
      }),
    ).toEqual([
      "Status: not available",
      "Reason: no safe supported test form could be generated",
    ]);

    // A hash mismatch must never be reported as identical.
    const mismatch = formatRegressionCommentLines({
      status: "blocked",
      testName: "t",
      relativePath: "t.mjs",
      runner: "node",
      sha256: "abc",
      prePatch: "failed_as_expected",
      postPatch: "passed",
      hashMatched: false,
      generationAttempts: 1,
      reason: "hash mismatch",
    });
    expect(mismatch).toContain("Identical test: no");
  });
});
