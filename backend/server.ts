import express from "express";
import cors from "cors";
import {
  analyzeIssue,
  generateIntentPlan,
  generateMemoryReflection,
} from "./services/claude.js";
import { buildGraphContext, tokenize } from "./services/graphContext.js";
import {
  appendMemory,
  loadMemory,
  matchMemory,
  renderPastInvestigations,
  type MemoryOutcome,
} from "./services/memory.js";
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
    console.log(intentPlan);

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

    // Record memory. No fixer yet, so outcome is analysis_complete unless an
    // action step (not an assert) failed, which means reproduction was blocked.
    const actionFailed = browserResult.errors.some((error) =>
      /^Step \d+ \((?:goto|click|fill)/.test(error),
    );
    const outcome: MemoryOutcome = actionFailed ? "blocked" : "analysis_complete";

    try {
      const reflection = await generateMemoryReflection({
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody ?? "",
        outcome,
        intentPlanJson: JSON.stringify(intentPlan),
        browserErrors: browserResult.errors,
        analysisText:
          claudeResult && claudeResult.type === "text" ? claudeResult.text : "",
        patchedFiles: [],
      });

      await appendMemory(payload.repoUrl, {
        issueTitle: payload.issueTitle,
        issueTerms: reflection.issueTerms,
        commitSha: graphContext.commitSha,
        outcome,
        rootCause: reflection.rootCause,
        patchedFiles: [],
        fileHashes: {},
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
      status: "analysis_complete",
      graphContextNotes: graphContext.notes,
      intentPlan,
      browserResult,
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

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
