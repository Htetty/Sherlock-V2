// One verified fix attempt: validate a structured proposal, apply it in the
// isolated investigation workspace, restart the app, replay the exact saved
// reproduction plan, run relevant tests, and classify the outcome.
//
// This module must stay free of Claude/Anthropic imports. The proposal is
// passed in (Claude-generated in production, stubbed in tests) and the
// restart behavior is injected so the loop is independent of the sandbox.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createArtifactStore, createFixAttemptId } from "./artifacts.js";
import { realDockerAdapter, type DockerAdapter } from "./container.js";
import {
  renderProposedPatch,
  validateFixProposalShape,
  validatePatchSafety,
  type FixProposal,
} from "./fix-proposal.js";
import type { ReproductionPlan } from "./plan.js";
import { executeReproductionPlan } from "./playwright.js";
import {
  formatValidationLine,
  runRepositoryValidation,
  type RepositoryValidation,
  type ValidationCategory,
  type ValidationStatus,
} from "./repo-validation.js";
import {
  classifyPostPatchRun,
  classifyPrePatchRun,
  extractRegressionFailureMarker,
  hashTestContents,
  materializeTest,
  runRegressionTest,
  validateRegressionProposalSafety,
  validateRegressionProposalShape,
  type PostPatchClassification,
  type RegressionTestProposal,
  type RegressionTestSummary,
} from "./regression-test.js";

const execFileAsync = promisify(execFile);

export type FixOutcome =
  | "verified"
  | "rejected_reproduction_still_fails"
  | "rejected_build_failed"
  | "rejected_tests_failed"
  | "rejected_patch_invalid"
  | "rejected_environment_failed"
  | "rejected_verification_inconclusive"
  // A generated regression test existed but its fail-before/pass-after
  // contract was not satisfied (unexpectedly passed, failed post-patch,
  // hash mismatch, or workspace residue).
  | "rejected_regression_test_failed";

export type RestartResult = {
  ok: boolean;
  baseUrl?: string;
  log?: string;
};

export type TestRunRecord = {
  command: string;
  exitCode: number;
  durationMs: number;
  targeted: boolean;
  timedOut: boolean;
  stdoutFile: string;
  stderrFile: string;
};

export type VerificationCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type FixAttemptInput = {
  investigationId: string;
  investigationDir: string;
  repoPath: string;
  sourceCommit: string;
  plan: ReproductionPlan;
  originalOutcome: string;
  proposal: unknown;
  restart: () => Promise<RestartResult>;
  probeTimeoutMs?: number;
  // Verification commands run in restricted containers through this
  // adapter; injectable so tests run without a Docker daemon.
  docker?: DockerAdapter;
  // "owner/name" used in the validation artifact; never a URL or secret.
  repositoryLabel?: string;
  validationTimeoutMs?: number;
  // Produces a structured regression-test proposal (Claude-backed in
  // production, stubbed in tests). Called at most twice: initial proposal,
  // then one refinement with feedback. Absent means regression testing is
  // unavailable for this investigation — reported truthfully, never faked.
  generateRegressionTest?: ((feedback: string | null) => Promise<unknown>) | null;
  regressionTimeoutMs?: number;
};

export type RepositoryValidationSummary = {
  aggregate: RepositoryValidation["aggregate"];
  categories: { category: ValidationCategory; status: ValidationStatus }[];
};

export type FixAttemptResult = {
  investigationId: string;
  fixAttemptId: string;
  attemptDir: string;
  outcome: FixOutcome;
  reason: string;
  checks: VerificationCheck[];
  sourceCommit: string;
  changedFiles: string[];
  summary: string | null;
  rootCause: string | null;
  postPatchOutcome: string | null;
  testRuns: TestRunRecord[];
  // Truthful repository validation summary (null until validation runs).
  repositoryValidation: RepositoryValidationSummary | null;
  // Generated regression test contract (null until the stage runs).
  regressionTest: RegressionTestSummary | null;
  startedAt: string;
  finishedAt: string;
};

export async function runFixAttempt(input: FixAttemptInput): Promise<FixAttemptResult> {
  const fixAttemptId = createFixAttemptId();
  const store = await createArtifactStore(
    input.investigationId,
    path.join(input.investigationDir, "fix-attempts", fixAttemptId),
  );

  const result: FixAttemptResult = {
    investigationId: input.investigationId,
    fixAttemptId,
    attemptDir: store.dir,
    outcome: "rejected_verification_inconclusive",
    reason: "",
    checks: [],
    sourceCommit: input.sourceCommit,
    changedFiles: [],
    summary: null,
    rootCause: null,
    postPatchOutcome: null,
    testRuns: [],
    repositoryValidation: null,
    regressionTest: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };

  const check = (name: string, passed: boolean, detail: string) => {
    result.checks.push({ name, passed, detail });
    return passed;
  };

  const finish = async (outcome: FixOutcome, reason: string) => {
    result.outcome = outcome;
    result.reason = reason;
    result.finishedAt = new Date().toISOString();
    await store.writeJson("verification-result.json", result);
    return result;
  };

  await store.writeJson("fix-proposal.json", {
    investigationId: input.investigationId,
    fixAttemptId,
    proposal: input.proposal,
  });

  // --- Preconditions -------------------------------------------------------
  if (
    !check(
      "original_reproduced",
      input.originalOutcome === "reproduced",
      `Original reproduction outcome was "${input.originalOutcome}".`,
    )
  ) {
    return finish(
      "rejected_verification_inconclusive",
      "Precondition failed: the original investigation did not reproduce the bug.",
    );
  }

  const headCommit = await getHeadCommit(input.repoPath);

  if (
    !check(
      "workspace_at_source_commit",
      headCommit === input.sourceCommit,
      `Workspace HEAD is ${headCommit ?? "(unavailable)"}, reproduction ran at ${input.sourceCommit}.`,
    )
  ) {
    return finish(
      "rejected_verification_inconclusive",
      "Precondition failed: the workspace is missing or not at the reproduced commit.",
    );
  }

  const statusBefore = await gitStatusShort(input.repoPath);
  await store.writeJson("workspace-before.json", {
    commit: headCommit,
    gitStatus: statusBefore,
  });

  if (
    !check(
      "workspace_clean",
      statusBefore.trim() === "",
      statusBefore.trim() === ""
        ? "Working tree is clean."
        : `Working tree has unexpected changes:\n${statusBefore}`,
    )
  ) {
    return finish(
      "rejected_verification_inconclusive",
      "Precondition failed: the workspace working tree is not clean.",
    );
  }

  // --- Proposal validation -------------------------------------------------
  const shapeValidation = validateFixProposalShape(input.proposal);

  if (!shapeValidation.ok) {
    await store.writeJson("patch-validation.json", shapeValidation);
    check("patch_valid", false, shapeValidation.errors.join(" | "));
    return finish(
      "rejected_patch_invalid",
      `The fix proposal is invalid: ${shapeValidation.errors.join(" | ")}`,
    );
  }

  const proposal = shapeValidation.proposal;
  result.summary = proposal.summary;
  result.rootCause = proposal.rootCause;

  const safety = await validatePatchSafety(proposal, input.repoPath);
  await store.writeJson("patch-validation.json", safety);

  if (!check("patch_valid", safety.ok, safety.ok ? "Patch passed safety validation." : safety.errors.join(" | "))) {
    return finish(
      "rejected_patch_invalid",
      `The patch failed safety validation: ${safety.errors.join(" | ")}`,
    );
  }

  await writeFile(
    path.join(store.dir, "proposed.patch"),
    renderProposedPatch(proposal),
    "utf8",
  );

  // --- Regression test: generation + pre-patch proof ------------------------
  // Runs BEFORE the patch is applied: the generated test must fail on the
  // original source for the intended behavioral assertion. Bounded to two
  // generation attempts (initial + one refinement) — never a model loop.
  const regressionSummary: RegressionTestSummary = {
    status: "unavailable",
    testName: null,
    relativePath: null,
    runner: null,
    sha256: null,
    prePatch: null,
    postPatch: null,
    hashMatched: null,
    generationAttempts: 0,
    reason: null,
  };
  result.regressionTest = regressionSummary;

  const persistRegressionArtifact = () =>
    store.writeJson("regression-test.json", {
      investigationId: input.investigationId,
      fixAttemptId,
      repository: input.repositoryLabel ?? null,
      sourceCommit: input.sourceCommit,
      ...regressionSummary,
    });

  let provenRegressionTest: RegressionTestProposal | null = null;

  if (!input.generateRegressionTest) {
    regressionSummary.reason =
      "No regression-test generator is available for this investigation.";
  } else {
    let feedback: string | null = null;

    for (let attempt = 1; attempt <= 2 && provenRegressionTest === null; attempt += 1) {
      regressionSummary.generationAttempts = attempt;

      let raw: unknown;

      try {
        raw = await input.generateRegressionTest(feedback);
      } catch (error) {
        regressionSummary.reason = `Regression-test generation failed: ${formatError(error)}`;
        break;
      }

      const shape = validateRegressionProposalShape(raw);

      if (!shape.ok) {
        feedback = shape.errors.join(" | ");
        regressionSummary.reason = `The proposed test was structurally invalid: ${feedback}`;
        continue;
      }

      const safety = await validateRegressionProposalSafety(shape.proposal, input.repoPath);

      if (!safety.ok) {
        feedback = safety.errors.join(" | ");
        regressionSummary.reason = `The proposed test was unsafe: ${feedback}`;
        continue;
      }

      const testProposal = shape.proposal;
      const sha256 = hashTestContents(testProposal.contents);
      regressionSummary.testName = testProposal.testName;
      regressionSummary.relativePath = testProposal.relativePath;
      regressionSummary.runner = testProposal.runner;
      regressionSummary.sha256 = sha256;

      // Exact generated bytes preserved as an artifact.
      await writeFile(
        path.join(store.dir, "regression-test-source.mjs"),
        testProposal.contents,
        "utf8",
      );

      const materialized = await materializeTest(input.repoPath, testProposal, sha256);

      if (!materialized.ok) {
        await materialized.remove();
        feedback = "The materialized test bytes did not match the proposal hash.";
        regressionSummary.reason = feedback;
        continue;
      }

      const preRun = await runRegressionTest(input.docker ?? realDockerAdapter, {
        repoPath: input.repoPath,
        relativePath: testProposal.relativePath,
        targetUrl: input.plan.baseUrl,
        timeoutMs: input.regressionTimeoutMs,
      });

      await materialized.remove();
      // Restore the pristine pre-patch workspace (a test could have written
      // residue) and prove it: generation must never contaminate the source.
      await runGit(input.repoPath, ["checkout", "--", "."]);
      await runGit(input.repoPath, ["clean", "-fd"]);

      // Guaranteed non-null by shape validation: exactly one marker exists.
      const failureMarker = extractRegressionFailureMarker(testProposal.contents)!;
      const classification = classifyPrePatchRun(preRun, failureMarker);
      regressionSummary.prePatch = classification;

      await store.writeJson("regression-prepatch-result.json", {
        investigationId: input.investigationId,
        fixAttemptId,
        attempt,
        classification,
        exitCode: preRun.exitCode,
        timedOut: preRun.timedOut,
        durationMs: preRun.durationMs,
        stdout: boundOutput(preRun.stdout),
        stderr: boundOutput(preRun.stderr),
      });

      if (classification === "failed_as_expected") {
        provenRegressionTest = testProposal;
        regressionSummary.reason = null;
        break;
      }

      if (classification === "unexpectedly_passed") {
        regressionSummary.status = "blocked";
        regressionSummary.reason =
          "The generated test unexpectedly passed on the original, unpatched source, so it does not demonstrate the bug.";
        await persistRegressionArtifact();
        check("regression_test", false, regressionSummary.reason);
        return finish(
          "rejected_regression_test_failed",
          `The generated regression test "${testProposal.testName}" unexpectedly passed on the original source; it cannot prove the fix.`,
        );
      }

      // invalid_test / timed_out / execution_failed: not regression proof.
      // One refinement attempt with the diagnostic output as feedback.
      feedback = `The previous test was classified as ${classification}. It must fail on the buggy source specifically at the final behavioral assertion carrying the "${failureMarker}" message — a setup failure (wrong route, 404, missing fixture) is not behavioral proof. Use only routes from the verified reproduction plan. Bounded output: ${boundOutput(
        preRun.stderr || preRun.stdout,
      ).slice(0, 800)}`;
      regressionSummary.reason = `The generated test did not produce a diagnostic pre-patch failure (${classification}).`;
    }
  }

  await persistRegressionArtifact();

  // --- Apply patch in the isolated workspace -------------------------------
  await applyProposal(proposal, input.repoPath);

  const diff = await runGit(input.repoPath, ["diff"]);
  const diffStat = await runGit(input.repoPath, ["diff", "--stat"]);
  const changedFiles = (await runGit(input.repoPath, ["diff", "--name-only"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  result.changedFiles = changedFiles;
  await writeFile(path.join(store.dir, "git-diff.patch"), diff, "utf8");
  await store.writeJson("workspace-after.json", { changedFiles, diffStat });

  const approvedPaths = new Set(proposal.files.map((file) => path.normalize(file.path)));
  const unexpectedFiles = changedFiles.filter(
    (file) => !approvedPaths.has(path.normalize(file)),
  );

  if (
    !check(
      "changes_within_scope",
      unexpectedFiles.length === 0 && changedFiles.length > 0,
      unexpectedFiles.length > 0
        ? `Unexpected files modified: ${unexpectedFiles.join(", ")}`
        : changedFiles.length === 0
          ? "The patch produced no changes."
          : `Changed files: ${changedFiles.join(", ")}`,
    )
  ) {
    await runGit(input.repoPath, ["checkout", "--", "."]);
    return finish(
      "rejected_patch_invalid",
      unexpectedFiles.length > 0
        ? `The patch modified files outside the approved scope: ${unexpectedFiles.join(", ")}`
        : "The patch produced no changes.",
    );
  }

  // --- Restart / rebuild ----------------------------------------------------
  const restart = await input.restart();
  await store.writeJson("build-result.json", {
    ok: restart.ok,
    baseUrl: restart.baseUrl ?? null,
    log: restart.log ?? "",
  });

  if (
    !check(
      "application_restarted",
      restart.ok,
      restart.ok
        ? `Application restarted at ${restart.baseUrl ?? "(same base URL)"}.`
        : "Application rebuild/restart failed after applying the patch.",
    )
  ) {
    return finish(
      "rejected_build_failed",
      "The application failed to rebuild or restart after the patch was applied.",
    );
  }

  // --- Exact reproduction replay --------------------------------------------
  // Steps and assertion are byte-identical to the saved plan; only the base
  // URL may change because the restarted sandbox can bind a new port.
  const replayPlan: ReproductionPlan = {
    ...input.plan,
    baseUrl: restart.baseUrl ?? input.plan.baseUrl,
  };

  check(
    "exact_plan_replayed",
    true,
    `Replayed saved plan (steps+assertion sha256 ${hashPlanBehavior(input.plan)}).`,
  );

  const postResult = await executeReproductionPlan(replayPlan, store, {
    probeTimeoutMs: input.probeTimeoutMs,
  });
  result.postPatchOutcome = postResult.outcome;
  await store.writeJson("post-patch-reproduction-result.json", {
    investigationId: input.investigationId,
    fixAttemptId,
    planBehaviorHash: hashPlanBehavior(input.plan),
    ...postResult,
  });

  if (postResult.outcome === "reproduced") {
    check("failure_no_longer_observed", false, postResult.outcomeReason);
    return finish(
      "rejected_reproduction_still_fails",
      `The original failure still occurs after the patch: ${postResult.outcomeReason}`,
    );
  }

  if (postResult.outcome === "environment_failed") {
    check("failure_no_longer_observed", false, postResult.outcomeReason);
    return finish(
      "rejected_environment_failed",
      `The application was not reachable after the patch: ${postResult.outcomeReason}`,
    );
  }

  if (postResult.outcome === "execution_failed") {
    check("failure_no_longer_observed", false, postResult.outcomeReason);
    return finish(
      "rejected_verification_inconclusive",
      `The reproduction plan could not be completed after the patch, so the fix cannot be verified: ${postResult.outcomeReason}`,
    );
  }

  const healthy =
    postResult.assertion?.matchedExpected === true &&
    postResult.steps.every((step) => step.outcome === "passed") &&
    postResult.pageErrors.length === 0;

  if (
    !check(
      "failure_no_longer_observed",
      healthy,
      healthy
        ? `Expected behavior observed: ${postResult.assertion?.detail}`
        : `Post-patch replay finished but was not clearly healthy: ${postResult.outcomeReason}${postResult.pageErrors.length > 0 ? ` | page errors: ${postResult.pageErrors.join("; ")}` : ""}`,
    )
  ) {
    return finish(
      "rejected_verification_inconclusive",
      "The failure was not observed, but the replay did not clearly show the expected behavior.",
    );
  }

  // --- Repository validation --------------------------------------------------
  // Discovered from package.json (test/typecheck/lint/build), executed in
  // restricted containers. Unavailable categories run nothing and are
  // reported truthfully — never as a fake pass.
  const validation = await runRepositoryValidation(input.docker ?? realDockerAdapter, {
    repoPath: input.repoPath,
    timeoutMs: input.validationTimeoutMs,
  });

  result.repositoryValidation = {
    aggregate: validation.aggregate,
    categories: validation.results.map((item) => ({
      category: item.category,
      status: item.status,
    })),
  };

  for (const item of validation.results) {
    if (item.argv === null) {
      continue;
    }

    const stdoutFile = path.join(store.dir, `validation-${item.category}-stdout.log`);
    const stderrFile = path.join(store.dir, `validation-${item.category}-stderr.log`);
    await writeFile(stdoutFile, item.stdout, "utf8");
    await writeFile(stderrFile, item.stderr, "utf8");

    result.testRuns.push({
      command: item.argv.join(" "),
      exitCode: item.exitCode ?? 1,
      durationMs: item.durationMs ?? 0,
      targeted: false,
      timedOut: item.status === "timed_out",
      stdoutFile,
      stderrFile,
    });
  }

  // Structured artifact; the large bounded logs live in the per-category
  // files above, not duplicated here.
  await store.writeJson("repository-validation.json", {
    investigationId: input.investigationId,
    fixAttemptId,
    repository: input.repositoryLabel ?? null,
    sourceCommit: input.sourceCommit,
    workspaceState: { patched: true, changedFiles: result.changedFiles },
    packageManager: validation.packageManager,
    aggregate: validation.aggregate,
    results: validation.results.map(({ stdout, stderr, ...rest }) => ({
      ...rest,
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
    })),
    startedAt: validation.startedAt,
    finishedAt: validation.finishedAt,
  });

  await store.writeJson("test-results.json", {
    source: "repository-validation",
    runs: result.testRuns,
  });

  const validationLines = validation.results
    .map((item) => formatValidationLine(item))
    .join(" | ");

  if (validation.aggregate === "failed") {
    check("repository_validation", false, validationLines);

    const failures = validation.results
      .filter((item) => item.status === "failed" || item.status === "timed_out")
      .map((item) => `${item.argv?.join(" ")} (${item.status === "timed_out" ? "timed out" : `exit ${item.exitCode}`})`)
      .join(", ");

    return finish(
      "rejected_tests_failed",
      `The original failure disappeared, but repository validation failed: ${failures}`,
    );
  }

  if (validation.aggregate === "not_available") {
    check(
      "repository_validation",
      true,
      "Repository validation was unavailable: package.json declares no test, typecheck, lint, or build scripts. Verification relies on the exact reproduction replay.",
    );
  } else {
    check("repository_validation", true, validationLines);
  }

  // --- Regression test: post-patch run (identical bytes, identical hash) -----
  if (provenRegressionTest !== null) {
    const expectedSha = regressionSummary.sha256!;
    const materialized = await materializeTest(
      input.repoPath,
      provenRegressionTest,
      expectedSha,
    );
    regressionSummary.hashMatched = materialized.ok;

    let postClassification: PostPatchClassification | null = null;

    if (materialized.ok) {
      const postRun = await runRegressionTest(input.docker ?? realDockerAdapter, {
        repoPath: input.repoPath,
        relativePath: provenRegressionTest.relativePath,
        targetUrl: restart.baseUrl ?? input.plan.baseUrl,
        timeoutMs: input.regressionTimeoutMs,
      });

      postClassification = classifyPostPatchRun(postRun);

      await store.writeJson("regression-postpatch-result.json", {
        investigationId: input.investigationId,
        fixAttemptId,
        classification: postClassification,
        exitCode: postRun.exitCode,
        timedOut: postRun.timedOut,
        durationMs: postRun.durationMs,
        stdout: boundOutput(postRun.stdout),
        stderr: boundOutput(postRun.stderr),
      });
    }

    // The generated test is verification evidence only: it must be gone
    // before the final diff, and only the intended patch files may remain.
    await materialized.remove();

    const residue = (await runGit(input.repoPath, ["status", "--short"]))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3).split(" -> ").pop()!.trim());
    const unexpectedResidue = residue.filter(
      (file) => !result.changedFiles.includes(file),
    );

    regressionSummary.postPatch = postClassification;

    const proven =
      materialized.ok &&
      postClassification === "passed" &&
      unexpectedResidue.length === 0;

    regressionSummary.status = proven ? "proven" : "blocked";

    if (!proven) {
      regressionSummary.reason = !materialized.ok
        ? "The post-patch test bytes did not hash to the recorded pre-patch value; the runs are not comparable."
        : unexpectedResidue.length > 0
          ? `Unexpected files remained in the workspace after the regression run: ${unexpectedResidue.join(", ")}`
          : `The regression test did not pass on the patched source (${postClassification}).`;

      await persistRegressionArtifact();
      check("regression_test", false, regressionSummary.reason);

      return finish(
        "rejected_regression_test_failed",
        `The exact reproduction replay PASSED after the patch, but the generated regression test "${provenRegressionTest.testName}" did not cleanly pass, so the fix was rejected: ${regressionSummary.reason}`,
      );
    }

    await persistRegressionArtifact();
    check(
      "regression_test",
      true,
      `Generated test "${provenRegressionTest.testName}" failed as expected before the patch and passed after it (identical sha256 ${expectedSha.slice(0, 12)}…).`,
    );
  } else {
    // Neutral, truthful: no generated test exists, so nothing may claim one
    // passed. Exact replay (and repository validation when available)
    // carries verification.
    check(
      "regression_test",
      true,
      `No generated regression test was available: ${regressionSummary.reason ?? "generation is unsupported for this repository"}. Verification relies on the exact reproduction replay${validation.aggregate === "passed" ? " and repository validation" : ""}.`,
    );
  }

  return finish(
    "verified",
    validation.aggregate === "not_available"
      ? "The patch was applied, the application restarted, and the exact saved reproduction no longer fails. Repository validation was unavailable (no declared scripts), so verification relies on the reproduction replay."
      : "The patch was applied, the application restarted, the exact saved reproduction no longer fails, and all available repository validation commands passed.",
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_BOUNDED_OUTPUT_CHARS = 10_000;

function boundOutput(text: string): string {
  return text.length > MAX_BOUNDED_OUTPUT_CHARS
    ? `${text.slice(0, MAX_BOUNDED_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_BOUNDED_OUTPUT_CHARS} chars]`
    : text;
}

async function applyProposal(proposal: FixProposal, repoPath: string) {
  for (const file of proposal.files) {
    const absolutePath = path.resolve(repoPath, file.path);
    let contents = await readFile(absolutePath, "utf8");

    for (const edit of file.edits) {
      contents = contents.replace(edit.oldText, edit.newText);
    }

    await writeFile(absolutePath, contents, "utf8");
  }
}

// Hash of the plan's behavior (steps + assertion, excluding baseUrl) proving
// the replay used the saved reproduction unchanged.
export function hashPlanBehavior(plan: ReproductionPlan) {
  return createHash("sha256")
    .update(JSON.stringify({ steps: plan.steps, assertion: plan.assertion }))
    .digest("hex")
    .slice(0, 16);
}

async function getHeadCommit(repoPath: string): Promise<string | null> {
  try {
    return (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

async function gitStatusShort(repoPath: string) {
  try {
    return await runGit(repoPath, ["status", "--short"]);
  } catch {
    return "(git status unavailable)";
  }
}

async function runGit(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  return stdout;
}
