import express from "express";
import cors from "cors";
import {
  analyzeIssue,
  generateFixProposal,
  generateMemoryReflection,
  generateReproductionPlan,
} from "./services/claude.js";
import { runFixAttempt, type FixAttemptResult } from "./services/fix.js";
import { buildGraphContext, tokenize } from "./services/graphContext.js";
import {
  appendMemory,
  hashRepoFiles,
  loadMemory,
  matchMemory,
  renderPastInvestigations,
  type MemoryOutcome,
} from "./services/memory.js";
import {
  createFixPullRequest,
  createGitHubRestClient,
  type PullRequestResult,
} from "./services/pull-request.js";
import {
  cleanupRepoContext,
  cloneRepoForInvestigation,
  type RepoContext,
} from "./services/repo.js";
import {
  runSandboxInvestigation,
  type SandboxSession,
} from "./services/sandbox.js";
import {
  executeReproductionPlan,
  type ReproductionResult,
} from "./services/playwright.js";
import { validateReproductionPlan, type ReproductionPlan } from "./services/plan.js";
import {
  createArtifactStore,
  createInvestigationId,
  isInvestigationId,
  writeExecutionArtifacts,
  type ArtifactStore,
} from "./services/artifacts.js";
import {
  formatFixComment,
  formatPullRequestComment,
  formatResultComment,
  redactSecrets,
  type InvestigationSummary,
} from "./services/report.js";

const app = express();
const PORT = Number(process.env.BACKEND_PORT ?? 4000);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/investigations", async (req, res) => {
  const payload = req.body;
  const investigationId = isInvestigationId(payload?.investigationId)
    ? payload.investigationId
    : createInvestigationId();
  const log = (message: string) => {
    console.log(`[${investigationId}] ${message}`);
  };

  let repoContext: RepoContext | null = null;
  let sandboxSession: SandboxSession | null = null;
  let store: ArtifactStore | null = null;
  let investigationRecord: Record<string, unknown> = { investigationId };

  try {
    log("Investigation started.");

    store = await createArtifactStore(investigationId);
    investigationRecord = {
      investigationId,
      createdAt: new Date().toISOString(),
      status: "running",
      repoUrl: payload.repoUrl,
      issueNumber: payload.issueNumber,
      issueTitle: payload.issueTitle,
      issueUrl: payload.issueUrl,
      triggeredBy: payload.triggeredBy,
    };
    await store.writeJson("investigation.json", investigationRecord);

    try {
      repoContext = await cloneRepoForInvestigation({
        repoUrl: payload.repoUrl,
        defaultBranch: payload.defaultBranch,
      });
    } catch (error) {
      return await finishInvestigation(res, store, investigationRecord, {
        investigationId,
        outcome: "environment_failed",
        stage: "git clone",
        error: formatError(error),
      });
    }

    log(`Repository cloned to ${repoContext.repoPath} at ${repoContext.commit}`);
    investigationRecord.commit = repoContext.commit;

    // --- Memory (docs/fable/08): past investigations of this repo ---------
    const issueTerms = tokenize(
      `${payload.issueTitle} ${payload.issueBody ?? ""}`,
    );
    const memoryEntries = await loadMemory(payload.repoUrl);
    const pastEntries = matchMemory(memoryEntries, issueTerms);
    const pastInvestigations = await renderPastInvestigations(
      pastEntries,
      repoContext.repoPath,
    );

    log(
      `Memory: ${memoryEntries.length} stored entr${memoryEntries.length === 1 ? "y" : "ies"} for this repo; using top ${pastEntries.length} match(es).`,
    );

    try {
      sandboxSession = await runSandboxInvestigation({
        repoPath: repoContext.repoPath,
      });
    } catch (error) {
      return await finishInvestigation(res, store, investigationRecord, {
        investigationId,
        outcome: "environment_failed",
        stage: "application startup",
        error: formatError(error),
      });
    }

    log(`Sandbox started at ${sandboxSession.result.baseUrl}`);

    // --- Graph context (docs/fable/07): issue-specific repo context -------
    const graphContext = await buildGraphContext({
      repoPath: repoContext.repoPath,
      repoUrl: payload.repoUrl,
      commitSha: repoContext.commit,
      issueTitle: payload.issueTitle,
      issueBody: payload.issueBody ?? "",
      boostFiles: pastEntries.flatMap((entry) => entry.patchedFiles),
    });

    log(`Graph context: ${graphContext.notes}`);
    await store.writeJson("repo-context.json", {
      available: graphContext.available,
      commitSha: graphContext.commitSha,
      notes: graphContext.notes,
      nodes: graphContext.graphNodes,
      edges: graphContext.graphEdges,
      hydratedFiles: graphContext.relevantFiles.map((file) => file.path),
      pastInvestigations,
    });

    const contextSourceFiles = graphContext.available
      ? graphContext.relevantFiles
      : repoContext.sourceFiles;

    const generated = await generateReproductionPlan({
      issueTitle: payload.issueTitle,
      issueBody: payload.issueBody ?? "",
      repoUrl: payload.repoUrl,
      defaultBranch: payload.defaultBranch,
      fileTree: repoContext.fileTree,
      packageJson: repoContext.packageJson,
      readme: repoContext.readme,
      sourceFiles: contextSourceFiles,
      sandboxResult: sandboxSession.result,
      graphContext,
      pastInvestigations,
    });

    await store.writeJson("reproduction-plan-raw.json", {
      rawText: generated.rawText,
      parseError: generated.parseError,
    });

    if (generated.parseError !== null) {
      return await finishInvestigation(res, store, investigationRecord, {
        investigationId,
        outcome: "plan_failed",
        planErrors: [generated.parseError],
      });
    }

    const validation = validateReproductionPlan(generated.parsed);

    if (!validation.ok) {
      log(`Plan rejected: ${validation.errors.join(" | ")}`);

      return await finishInvestigation(res, store, investigationRecord, {
        investigationId,
        outcome: "plan_failed",
        planErrors: validation.errors,
      });
    }

    const plan = validation.plan;
    await store.writeJson("reproduction-plan.json", plan);
    log("Validated reproduction plan saved.");

    const result = await executeReproductionPlan(plan, store);
    await writeExecutionArtifacts(store, result);
    log(`Plan executed with outcome: ${result.outcome}`);

    let claudeAnalysis: unknown = null;

    if (result.outcome === "reproduced" || result.outcome === "not_reproduced") {
      claudeAnalysis = await analyzeIssue({
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody ?? "",
        repoUrl: payload.repoUrl,
        defaultBranch: payload.defaultBranch,
        fileTree: repoContext.fileTree,
        packageJson: repoContext.packageJson,
        readme: repoContext.readme,
        sourceFiles: contextSourceFiles,
        sandboxResult: sandboxSession.result,
        browserResult: result,
      }).catch((error: unknown) => {
        log(`Claude analysis failed: ${formatError(error)}`);
        return null;
      });

      await store.writeJson("claude-analysis.json", claudeAnalysis);
    }

    // Verified fix loop: only for a confirmed reproduction, one attempt.
    let fixAttempt: FixAttemptResult | null = null;

    if (result.outcome === "reproduced") {
      try {
        // Re-select the graph around reproduction evidence (docs/fable/09):
        // by now we know which elements were touched and what failed.
        const refineTerms = collectRefineTerms(plan, result);
        log(
          `Refine inputs (${refineTerms.length}): ${refineTerms.slice(0, 10).join(" | ").slice(0, 400)}`,
        );

        const refinedContext = await buildGraphContext({
          repoPath: repoContext.repoPath,
          repoUrl: payload.repoUrl,
          commitSha: repoContext.commit,
          issueTitle: payload.issueTitle,
          issueBody: payload.issueBody ?? "",
          boostFiles: pastEntries.flatMap((entry) => entry.patchedFiles),
          extraTerms: refineTerms,
        });

        log(`Refined graph context: ${refinedContext.notes}`);
        await store.writeJson("repo-context-refined.json", {
          available: refinedContext.available,
          notes: refinedContext.notes,
          nodes: refinedContext.graphNodes,
          edges: refinedContext.graphEdges,
          hydratedFiles: refinedContext.relevantFiles.map((file) => file.path),
        });

        const generatedFix = await generateFixProposal({
          issueTitle: payload.issueTitle,
          issueBody: payload.issueBody ?? "",
          repoUrl: payload.repoUrl,
          defaultBranch: payload.defaultBranch,
          fileTree: repoContext.fileTree,
          packageJson: repoContext.packageJson,
          readme: repoContext.readme,
          sourceFiles: refinedContext.available
            ? refinedContext.relevantFiles
            : contextSourceFiles,
          sandboxResult: sandboxSession.result,
          commit: repoContext.commit,
          plan,
          reproductionResult: result,
          graphContext: refinedContext,
        });

        // Sanitized raw model responses (every attempt) kept for debugging
        // rejected proposals.
        await store.writeJson("fix-proposal-raw.json", {
          rawText: redactSecrets(generatedFix.rawText),
          parseError: generatedFix.parseError,
          attempts: (generatedFix.attempts ?? []).map((attempt) => ({
            rawText: redactSecrets(attempt.rawText),
            error: attempt.error,
          })),
        });

        const repoPath = repoContext.repoPath;
        const restart = async () => {
          if (sandboxSession) {
            await sandboxSession.stop();
            sandboxSession = null;
          }

          try {
            sandboxSession = await runSandboxInvestigation({ repoPath });
          } catch (error) {
            return { ok: false, log: formatError(error) };
          }

          return {
            ok: true,
            baseUrl: sandboxSession.result.baseUrl,
            log: [sandboxSession.result.stdout, sandboxSession.result.stderr]
              .filter(Boolean)
              .join("\n"),
          };
        };

        fixAttempt = await runFixAttempt({
          investigationId,
          investigationDir: store.dir,
          repoPath,
          sourceCommit: repoContext.commit,
          plan,
          originalOutcome: result.outcome,
          proposal: generatedFix.parsed,
          restart,
        });

        log(`Fix attempt ${fixAttempt.fixAttemptId} finished: ${fixAttempt.outcome}`);
      } catch (error) {
        log(`Fix attempt failed unexpectedly: ${formatError(error)}`);
      }
    }

    // Verified fix -> GitHub pull request. Only verified fixes may push.
    let pullRequest: PullRequestResult | null = null;

    if (fixAttempt?.outcome === "verified") {
      try {
        const token =
          typeof payload.installationToken === "string" && payload.installationToken
            ? payload.installationToken
            : null;
        const attemptStore = await createArtifactStore(
          investigationId,
          fixAttempt.attemptDir,
        );

        pullRequest = await createFixPullRequest({
          investigationId,
          fixAttempt,
          store: attemptStore,
          repoPath: repoContext.repoPath,
          owner: payload.repoOwner,
          repo: payload.repoName,
          baseBranch: payload.defaultBranch,
          issueNumber: payload.issueNumber,
          issueTitle: payload.issueTitle,
          plan,
          github: token
            ? createGitHubRestClient({
                token,
                owner: payload.repoOwner,
                repo: payload.repoName,
              })
            : null,
          pushUrl: token
            ? `https://x-access-token:${token}@github.com/${payload.repoOwner}/${payload.repoName}.git`
            : null,
        });

        log(
          `Pull request flow finished: ${pullRequest.status}${pullRequest.pullRequestUrl ? ` (${pullRequest.pullRequestUrl})` : ""}`,
        );
      } catch (error) {
        log(`Pull request flow failed unexpectedly: ${formatError(error)}`);
      }
    }

    // --- Memory recording (docs/fable/08): always learn from the run ------
    try {
      const outcome = mapMemoryOutcome(result, fixAttempt);
      const patchedFiles = fixAttempt?.changedFiles ?? [];
      const reflection = await generateMemoryReflection({
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody ?? "",
        outcome,
        intentPlanJson: JSON.stringify(plan),
        browserErrors: [
          result.outcomeReason,
          ...(result.assertion ? [result.assertion.detail] : []),
          ...result.consoleErrors,
          ...result.pageErrors,
        ],
        analysisText: extractAnalysisText(claudeAnalysis),
        patchedFiles,
      });

      await appendMemory(payload.repoUrl, {
        issueTitle: payload.issueTitle,
        issueTerms: reflection.issueTerms,
        commitSha: repoContext.commit,
        outcome,
        rootCause: fixAttempt?.rootCause ?? reflection.rootCause,
        patchedFiles,
        fileHashes: await hashRepoFiles(repoContext.repoPath, patchedFiles),
        whatWorked: reflection.whatWorked,
        whatFailed: reflection.whatFailed,
        createdAt: new Date().toISOString(),
      });

      log(`Memory entry recorded (outcome: ${outcome}).`);
    } catch (error) {
      log(`Could not record memory entry: ${formatError(error)}`);
    }

    const fixComment = fixAttempt
      ? formatFixComment({
          investigationId,
          fixAttemptId: fixAttempt.fixAttemptId,
          outcome: fixAttempt.outcome,
          rootCause: fixAttempt.rootCause,
          changedFiles: fixAttempt.changedFiles,
          reason: fixAttempt.outcome === "verified" ? null : fixAttempt.reason,
          verification: fixAttempt.checks
            .filter((item) => item.passed)
            .map((item) => item.detail),
        })
      : null;

    const pullRequestComment =
      pullRequest && fixAttempt
        ? formatPullRequestComment({
            investigationId,
            fixAttemptId: fixAttempt.fixAttemptId,
            status: pullRequest.status,
            pullRequestNumber: pullRequest.pullRequestNumber,
            pullRequestUrl: pullRequest.pullRequestUrl,
            branch: pullRequest.branch,
            reason: pullRequest.reason,
          })
        : null;

    const extraComment =
      [fixComment, pullRequestComment].filter(Boolean).join("\n\n---\n\n") || null;

    return await finishInvestigation(
      res,
      store,
      investigationRecord,
      buildExecutionSummary(investigationId, plan.expectedBehavior, result),
      {
        result,
        claudeAnalysis,
        fixAttempt,
        pullRequest,
        graphContextNotes: graphContext.notes,
        memoryMatches: pastEntries.length,
      },
      extraComment,
    );
  } catch (error) {
    console.error(`[${investigationId}] Investigation failed:`, error);

    const summary: InvestigationSummary = {
      investigationId,
      outcome: "execution_failed",
      error: formatError(error),
    };

    if (store) {
      return await finishInvestigation(res, store, investigationRecord, summary);
    }

    return res.status(500).json({
      investigationId,
      status: "error",
      outcome: "execution_failed",
      githubComment: formatResultComment(summary),
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

// Memory outcome mapping (docs/fable/10):
// verified fix -> verified; failed/rejected fix attempt -> failed;
// reproduced but no usable fix attempt -> blocked; otherwise analysis only.
function mapMemoryOutcome(
  result: ReproductionResult,
  fixAttempt: FixAttemptResult | null,
): MemoryOutcome {
  if (fixAttempt?.outcome === "verified") {
    return "verified";
  }

  if (fixAttempt) {
    return "failed";
  }

  if (
    result.outcome === "reproduced" ||
    result.outcome === "execution_failed" ||
    result.outcome === "environment_failed"
  ) {
    return "blocked";
  }

  return "analysis_complete";
}

function extractAnalysisText(claudeAnalysis: unknown): string {
  if (
    claudeAnalysis &&
    typeof claudeAnalysis === "object" &&
    "type" in claudeAnalysis &&
    claudeAnalysis.type === "text" &&
    "text" in claudeAnalysis &&
    typeof claudeAnalysis.text === "string"
  ) {
    return claudeAnalysis.text;
  }

  return "";
}

// Refine terms for the fixer's graph re-selection (docs/fable/09): step
// target/selector strings, expected/failure text, assertion detail, and
// runtime error evidence.
function collectRefineTerms(
  plan: ReproductionPlan,
  result: ReproductionResult,
): string[] {
  const stepStrings = plan.steps.flatMap((step) => {
    if ("target" in step) {
      return Object.values(step.target).filter(
        (value): value is string => typeof value === "string",
      );
    }

    if ("selector" in step) {
      return [step.selector];
    }

    return [];
  });

  return [
    ...stepStrings,
    plan.expectedBehavior,
    plan.failureCondition,
    ...(result.assertion ? [result.assertion.detail] : []),
    ...result.steps
      .filter((step) => step.error)
      .map((step) => step.error as string),
    ...result.consoleErrors,
    ...result.pageErrors,
    ...result.networkFailures.map((failure) => failure.url),
  ];
}

function buildExecutionSummary(
  investigationId: string,
  expectedBehavior: string,
  result: ReproductionResult,
): InvestigationSummary {
  const base: InvestigationSummary = {
    investigationId,
    outcome: result.outcome,
    evidence: {
      screenshots: result.screenshots.length,
      consoleErrors: result.consoleErrors.length + result.pageErrors.length,
      networkFailures: result.networkFailures.length,
      failedAssertions: result.assertion?.matchedFailure ? 1 : 0,
    },
  };

  switch (result.outcome) {
    case "reproduced":
    case "not_reproduced":
      return {
        ...base,
        observed: result.assertion?.detail ?? result.outcomeReason,
        expected: expectedBehavior,
      };
    case "environment_failed":
      return {
        ...base,
        stage: "application startup",
        error: result.outcomeReason,
      };
    case "execution_failed":
      return {
        ...base,
        error: result.outcomeReason,
      };
  }
}

async function finishInvestigation(
  res: express.Response,
  store: ArtifactStore,
  record: Record<string, unknown>,
  summary: InvestigationSummary,
  extra: Record<string, unknown> = {},
  extraComment: string | null = null,
) {
  const githubComment = extraComment
    ? `${formatResultComment(summary)}\n\n---\n\n${extraComment}`
    : formatResultComment(summary);

  await store.writeJson("investigation.json", {
    ...record,
    finishedAt: new Date().toISOString(),
    status: "finished",
    outcome: summary.outcome,
    summary,
  });

  console.log(`[${summary.investigationId}] Outcome: ${summary.outcome}`);

  return res.json({
    investigationId: summary.investigationId,
    outcome: summary.outcome,
    summary,
    githubComment,
    artifactsDir: store.dir,
    ...extra,
  });
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
