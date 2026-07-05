// One verified fix attempt: validate a structured proposal, apply it in the
// isolated investigation workspace, restart the app, replay the exact saved
// reproduction plan, run relevant tests, and classify the outcome.
//
// This module must stay free of Claude/Anthropic imports. The proposal is
// passed in (Claude-generated in production, stubbed in tests) and the
// restart behavior is injected so the loop is independent of the sandbox.

import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  createArtifactStore,
  createFixAttemptId,
  type ArtifactStore,
} from "./artifacts.js";
import {
  renderProposedPatch,
  validateFixProposalShape,
  validatePatchSafety,
  type FixProposal,
} from "./fix-proposal.js";
import type { ReproductionPlan } from "./plan.js";
import { executeReproductionPlan } from "./playwright.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const TEST_COMMAND_TIMEOUT_MS = 180_000;

export type FixOutcome =
  | "verified"
  | "rejected_reproduction_still_fails"
  | "rejected_build_failed"
  | "rejected_tests_failed"
  | "rejected_patch_invalid"
  | "rejected_environment_failed"
  | "rejected_verification_inconclusive";

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

  // --- Relevant tests --------------------------------------------------------
  const { commands, targeted } = resolveTestCommands(proposal);
  let testsPassed = true;

  for (const [index, command] of commands.entries()) {
    const run = await runTestCommand(command, input.repoPath, store, index, targeted);
    result.testRuns.push(run);

    if (run.exitCode !== 0) {
      testsPassed = false;
    }
  }

  await store.writeJson("test-results.json", {
    commands,
    targeted,
    runs: result.testRuns,
  });

  if (
    !check(
      "relevant_tests_passed",
      testsPassed,
      commands.length === 0
        ? "No relevant test command was available; recorded as passed with no coverage."
        : result.testRuns
            .map((run) => `${run.command} -> exit ${run.exitCode}`)
            .join(" | "),
    )
  ) {
    return finish(
      "rejected_tests_failed",
      `The original failure disappeared, but relevant tests failed: ${result.testRuns
        .filter((run) => run.exitCode !== 0)
        .map((run) => run.command)
        .join(", ")}`,
    );
  }

  return finish(
    "verified",
    "The patch was applied, the application restarted, the exact saved reproduction no longer fails, and relevant tests passed.",
  );
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

function resolveTestCommands(proposal: FixProposal) {
  if (proposal.relevantTests.length > 0) {
    return { commands: proposal.relevantTests, targeted: true };
  }

  return { commands: [] as string[], targeted: false };
}

async function runTestCommand(
  command: string,
  repoPath: string,
  store: ArtifactStore,
  index: number,
  targeted: boolean,
): Promise<TestRunRecord> {
  const startedAt = Date.now();
  const stdoutFile = path.join(store.dir, `test-${index + 1}-stdout.log`);
  const stderrFile = path.join(store.dir, `test-${index + 1}-stderr.log`);

  let exitCode = 0;
  let stdout = "";
  let stderr = "";

  try {
    const output = await execAsync(command, {
      cwd: repoPath,
      timeout: TEST_COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = output.stdout;
    stderr = output.stderr;
  } catch (error) {
    const execError = error as Error & {
      code?: number | string | null;
      stdout?: string;
      stderr?: string;
    };
    exitCode = typeof execError.code === "number" ? execError.code : 1;
    stdout = execError.stdout ?? "";
    stderr = [execError.stderr ?? "", execError.message].filter(Boolean).join("\n");
  }

  await writeFile(stdoutFile, stdout, "utf8");
  await writeFile(stderrFile, stderr, "utf8");

  return {
    command,
    exitCode,
    durationMs: Date.now() - startedAt,
    targeted,
    stdoutFile,
    stderrFile,
  };
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
