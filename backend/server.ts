import express from "express";
import cors from "cors";
import { analyzeIssue, generateReproductionPlan } from "./services/claude.js";
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

    log(`Repository cloned to ${repoContext.repoPath}`);

    sandboxSession = await runSandboxInvestigation({
      repoPath: repoContext.repoPath,
    });

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

    return await finishInvestigation(
      res,
      store,
      investigationRecord,
      buildExecutionSummary(investigationId, plan.expectedBehavior, result),
      { result, claudeAnalysis },
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
) {
  const githubComment = formatResultComment(summary);

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
