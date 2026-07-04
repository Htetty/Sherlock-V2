import express from "express";
import cors from "cors";
import {
  analyzeIssue,
  generateFix,
  generateIntentPlan,
  generateMemoryReflection,
  type BrowserResult,
  type FixResult,
  type IntentStep,
} from "./services/claude.js";
import { buildGraphContext, tokenize } from "./services/graphContext.js";
import {
  appendMemory,
  hashRepoFiles,
  loadMemory,
  matchMemory,
  renderPastInvestigations,
  type MemoryOutcome,
} from "./services/memory.js";
import { applyPatch } from "./services/patch.js";
import {
  cleanupRepoContext,
  cloneRepoForInvestigation,
  type RepoContext,
} from "./services/repo.js";

import {
  runSandboxInvestigation,
  type SandboxSession,
} from "./services/sandbox.js";
import { runIntentInvestigation } from "./services/playwright.js";

const app = express();
const PORT = Number(process.env.BACKEND_PORT ?? 4000);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/investigations", async (req, res) => {
  let repoContext: RepoContext | null = null;
  let sandboxSession: SandboxSession | null = null;

  try {
    const payload = req.body;

    console.log("Investigation payload received:");
    console.log(payload);

    repoContext = await cloneRepoForInvestigation({
      repoUrl: payload.repoUrl,
      defaultBranch: payload.defaultBranch,
    });

    console.log(`Repository cloned to ${repoContext.repoPath}`);

    sandboxSession = await runSandboxInvestigation({
      repoPath: repoContext.repoPath,
    });

    console.log("Sandbox result:");
    console.log(sandboxSession.result);

    const issueTerms = tokenize(
      `${payload.issueTitle} ${payload.issueBody ?? ""}`,
    );
    const pastEntries = matchMemory(await loadMemory(payload.repoUrl), issueTerms);
    const pastInvestigations = await renderPastInvestigations(
      pastEntries,
      repoContext.repoPath,
    );

    console.log(`Memory: ${pastEntries.length} matching past investigation(s).`);

    const graphContext = await buildGraphContext({
      repoPath: repoContext.repoPath,
      repoUrl: payload.repoUrl,
      issueTitle: payload.issueTitle,
      issueBody: payload.issueBody ?? "",
      boostFiles: pastEntries.flatMap((entry) => entry.patchedFiles),
    });

    console.log(`Graph context: ${graphContext.notes}`);

    const intentPlan = await generateIntentPlan({
      issueTitle: payload.issueTitle,
      issueBody: payload.issueBody ?? "",
      graphContext,
      fallbackSourceFiles: repoContext.sourceFiles,
      sandboxResult: sandboxSession.result,
      pastInvestigations,
    });

    console.log("Intent plan:");
    console.log(JSON.stringify(intentPlan, null, 2));

    const browserResult = await runIntentInvestigation(intentPlan);

    console.log("Browser result:");
    console.log(browserResult);

    const claudeResult = await analyzeIssue({
      issueTitle: payload.issueTitle,
      issueBody: payload.issueBody ?? "",
      repoUrl: payload.repoUrl,
      defaultBranch: payload.defaultBranch,
      fileTree: repoContext.fileTree,
      packageJson: repoContext.packageJson,
      readme: repoContext.readme,
      sourceFiles: repoContext.sourceFiles,
      sandboxResult: sandboxSession.result,
      browserResult,
    });

    console.log("Claude result:");
    console.log(claudeResult);

    // Reproduction gate (doc 09): fix only when the plan's actions all ran
    // AND the expected failure was observed as a REAL failing assert.
    // Ambiguous asserts (strict-mode violations) are plan defects, not bug
    // evidence - they fail regardless of whether the bug exists.
    const beforeSteps = browserResult.stepResults ?? [];
    const actionFailed = beforeSteps.some(
      (step) => step.action !== "assert" && step.status === "failed",
    );
    const ambiguousAsserts = beforeSteps.filter(
      (step) =>
        step.action === "assert" && step.status === "failed" && step.ambiguous,
    );
    const realAssertFailures = beforeSteps.filter(
      (step) =>
        step.action === "assert" && step.status === "failed" && !step.ambiguous,
    );
    const reproduced = realAssertFailures.length > 0 && !actionFailed;

    if (ambiguousAsserts.length > 0) {
      console.warn(
        `Plan defect: ${ambiguousAsserts.length} assert step(s) had ambiguous targets (counted as warnings, not bug evidence): steps ${ambiguousAsserts
          .map((step) => step.index + 1)
          .join(", ")}`,
      );
    }

    console.log(
      `Reproduction gate: actions ${actionFailed ? "FAILED" : "ok"}, real assert failures: ${realAssertFailures
        .map((step) => step.index + 1)
        .join(", ") || "none"} -> reproduced=${reproduced}`,
    );

    let fixResult: FixResult | null = null;
    let patchDiff = "";
    let patchedFiles: string[] = [];
    let afterBrowserResult: BrowserResult | null = null;
    let verification = reproduced ? "not_attempted" : "not_reproduced";

    if (reproduced) {
      const refineTerms = collectRefineTerms(
        intentPlan.steps,
        intentPlan.expectedFailure,
        browserResult,
      );

      console.log(
        `Refine inputs (${refineTerms.length}): ${refineTerms.slice(0, 10).join(" | ").slice(0, 400)}`,
      );

      const refinedContext = await buildGraphContext({
        repoPath: repoContext.repoPath,
        repoUrl: payload.repoUrl,
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody ?? "",
        boostFiles: pastEntries.flatMap((entry) => entry.patchedFiles),
        extraTerms: refineTerms,
      });

      console.log(`Refined graph context: ${refinedContext.notes}`);

      fixResult = await generateFix({
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody ?? "",
        graphContext: refinedContext,
        intentPlanJson: JSON.stringify(intentPlan),
        expectedFailure: intentPlan.expectedFailure,
        browserErrors: browserResult.errors,
        consoleLogs: browserResult.consoleLogs,
        failedResponses: browserResult.failedNetworkResponses.map(
          (response) => `${response.status} ${response.statusText} ${response.url}`,
        ),
        relevantFiles: refinedContext.available
          ? refinedContext.relevantFiles
          : repoContext.sourceFiles,
      });

      console.log("Fix result:");
      console.log(fixResult);

      if (fixResult.status === "patch") {
        try {
          const applied = await applyPatch(repoContext.repoPath, fixResult.patch);
          patchDiff = applied.diff;
          patchedFiles = applied.patchedFiles;

          // Restart the sandbox on the patched code and rerun the SAME intent.
          await sandboxSession.stop();
          sandboxSession = await runSandboxInvestigation({
            repoPath: repoContext.repoPath,
          });

          afterBrowserResult = await runIntentInvestigation({
            ...intentPlan,
            baseUrl: sandboxSession.result.baseUrl,
          });

          // Per-step semantic comparison (doc 09):
          // - every action step must pass after the patch
          // - every REAL assert failure from before must now pass
          // - no step that passed before may fail after
          // - asserts that were ambiguous before and are still ambiguous are
          //   tolerated (pre-existing plan defect, unrelated to the patch)
          const afterSteps = afterBrowserResult.stepResults ?? [];
          const failedBefore = new Set(
            realAssertFailures.map((step) => step.index),
          );
          const problems: string[] = [];

          console.log("Verification step comparison (before -> after):");

          for (const after of afterSteps) {
            const before = beforeSteps[after.index];
            const beforeLabel = describeStepStatus(before);
            const afterLabel = describeStepStatus(after);

            console.log(
              `  Step ${after.index + 1} [${after.action}]: ${beforeLabel} -> ${afterLabel}`,
            );

            if (after.status === "skipped") {
              problems.push(`step ${after.index + 1} did not run after patch`);
            } else if (after.action !== "assert" && after.status === "failed") {
              problems.push(
                `action step ${after.index + 1} failed after patch: ${after.error ?? ""}`,
              );
            } else if (after.action === "assert" && after.status === "failed") {
              if (failedBefore.has(after.index)) {
                problems.push(
                  `previously-failing assert step ${after.index + 1} still fails: ${after.error ?? ""}`,
                );
              } else if (after.ambiguous && before?.ambiguous) {
                console.warn(
                  `  Step ${after.index + 1}: still ambiguous (pre-existing plan defect, tolerated)`,
                );
              } else if (before?.status === "passed") {
                problems.push(
                  `assert step ${after.index + 1} passed before but fails after patch (regression)`,
                );
              } else {
                problems.push(
                  `assert step ${after.index + 1} fails after patch: ${after.error ?? ""}`,
                );
              }
            }
          }

          verification = problems.length === 0 ? "verified" : "failed";

          if (problems.length > 0) {
            console.warn("Verification problems:");
            for (const problem of problems) {
              console.warn(`  - ${problem}`);
            }
          }
        } catch (error) {
          verification = "failed";
          console.warn("Patch/verification failed:", error);
        }
      } else {
        verification = "fix_blocked";
      }

      console.log(`Verification: ${verification}`);
    } else {
      console.log(
        `Reproduction gate not passed (actionFailed=${actionFailed}, realAssertFailures=${realAssertFailures.length}, ambiguousAsserts=${ambiguousAsserts.length}); skipping fixer.`,
      );
    }

    const outcome: MemoryOutcome =
      verification === "verified"
        ? "verified"
        : verification === "failed"
          ? "failed"
          : actionFailed || verification === "fix_blocked"
            ? "blocked"
            : "analysis_complete";

    try {
      const reflection = await generateMemoryReflection({
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody ?? "",
        outcome,
        intentPlanJson: JSON.stringify(intentPlan),
        browserErrors: browserResult.errors,
        analysisText:
          claudeResult && claudeResult.type === "text" ? claudeResult.text : "",
        patchedFiles,
      });

      await appendMemory(payload.repoUrl, {
        issueTitle: payload.issueTitle,
        issueTerms: reflection.issueTerms,
        commitSha: graphContext.commitSha,
        outcome,
        rootCause: fixResult?.rootCause
          ? `${fixResult.rootCause.explanation} (${fixResult.rootCause.file}, ${fixResult.rootCause.location})`
          : reflection.rootCause,
        patchedFiles,
        fileHashes: await hashRepoFiles(repoContext.repoPath, patchedFiles),
        whatWorked: reflection.whatWorked,
        whatFailed: reflection.whatFailed,
        createdAt: new Date().toISOString(),
      });

      console.log("Memory entry recorded.");
    } catch (error) {
      console.warn("Could not record memory entry:", error);
    }

    res.json({
      investigationId: `inv_${Date.now()}`,
      status: outcome,
      reproduced,
      verification,
      graphContextNotes: graphContext.notes,
      intentPlan,
      browserResult,
      fixResult,
      patchDiff,
      patchedFiles,
      afterBrowserResult,
      sandboxResult: sandboxSession.result,
      claudeResult,
    });
  } catch (error) {
    console.error("Investigation failed:", error);

    res.status(500).json({
      status: "error",
      message: "Investigation failed.",
    });
  } finally {
    if (sandboxSession) {
      await sandboxSession.stop();
    }

    if (repoContext) {
      await cleanupRepoContext(repoContext);
    }
  }
});

function describeStepStatus(
  step: { status: string; ambiguous?: boolean } | undefined,
): string {
  if (!step) {
    return "n/a";
  }

  if (step.status === "failed" && step.ambiguous) {
    return "failed(ambiguous)";
  }

  return step.status;
}

// Refine terms for the fixer's graph re-selection (doc 09): intent target
// strings, the expected failure text, step errors, and failed request paths.
function collectRefineTerms(
  steps: IntentStep[],
  expectedFailure: string,
  browserResult: BrowserResult,
): string[] {
  const targetStrings = steps
    .flatMap((step) => ("target" in step ? Object.values(step.target) : []))
    .filter((value): value is string => typeof value === "string");

  return [
    ...targetStrings,
    expectedFailure,
    ...browserResult.errors,
    ...browserResult.failedNetworkResponses.map((response) => response.url),
  ];
}

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
