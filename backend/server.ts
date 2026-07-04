import express from "express";
import cors from "cors";
import {
  analyzeIssue,
  generateFixProposal,
  generateReproductionPlan,
} from "./services/claude.js";
import { runFixAttempt, type FixAttemptResult } from "./services/fix.js";
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
import { validateReproductionPlan } from "./services/plan.js";
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

    const generated = await generateReproductionPlan({
      issueTitle: payload.issueTitle,
      issueBody: payload.issueBody ?? "",
      repoUrl: payload.repoUrl,
      defaultBranch: payload.defaultBranch,
      fileTree: repoContext.fileTree,
      packageJson: repoContext.packageJson,
      readme: repoContext.readme,
      sourceFiles: repoContext.sourceFiles,
      sandboxResult: sandboxSession.result,
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
        sourceFiles: repoContext.sourceFiles,
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
        const generatedFix = await generateFixProposal({
          issueTitle: payload.issueTitle,
          issueBody: payload.issueBody ?? "",
          repoUrl: payload.repoUrl,
          defaultBranch: payload.defaultBranch,
          fileTree: repoContext.fileTree,
          packageJson: repoContext.packageJson,
          readme: repoContext.readme,
          sourceFiles: repoContext.sourceFiles,
          sandboxResult: sandboxSession.result,
          commit: repoContext.commit,
          plan,
          reproductionResult: result,
        });

        await store.writeJson("fix-proposal-raw.json", {
          rawText: generatedFix.rawText,
          parseError: generatedFix.parseError,
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
      { result, claudeAnalysis, fixAttempt, pullRequest },
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
