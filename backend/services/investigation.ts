// The investigation pipeline: clone -> memory recall -> sandbox -> graph
// context -> memory-plan replay -> one-shot reproduction plan -> reproducer
// agent fallback -> deterministic execution -> verified fix loop (with graph
// refinement) -> pull request -> memory reflection.
// Extracted from the HTTP route so the queue worker can run it directly;
// both the Express route and the BullMQ worker call this single
// implementation.
//
// Cheap-first ordering (cost): deterministic memory replay first, one-shot
// generation second, agentic exploration only when necessary. Note that
// REPRODUCER_AGENT_ENABLED=true now means "the reproducer agent is AVAILABLE
// AS FALLBACK", not "always use the reproducer agent first".

import path from "node:path";
import {
  analyzeIssue,
  generateMemoryReflection,
  generateReproductionPlan,
} from "./claude.js";
import { runFixerAgent, type FixerAgentStatus } from "../agents/fixer.js";
import { getBudgetProfileName, runReproducerAgent } from "../agents/reproducer.js";
import { createCostShapeTracker } from "./cost-shape.js";
import type { FixAttemptResult } from "./fix.js";
import { buildGraphContext, tokenize } from "./graphContext.js";
import {
  appendMemory,
  findStaleFile,
  hashRepoFiles,
  loadMemory,
  matchMemory,
  renderPastInvestigations,
  type MemoryOutcome,
} from "./memory.js";
import {
  createFixPullRequest,
  createGitHubRestClient,
  type PullRequestResult,
} from "./pull-request.js";
import {
  cleanupRepoContext,
  cloneRepoForInvestigation,
  type RepoContext,
} from "./repo.js";
import {
  runSandboxInvestigation,
  type SandboxSession,
} from "./sandbox.js";
import {
  executeReproductionPlan,
  type ReproductionResult,
} from "./playwright.js";
import {
  getPlanMode,
  validateReproductionPlan,
  type ReproductionPlan,
} from "./plan.js";
import {
  createArtifactStore,
  createInvestigationId,
  isInvestigationId,
  rebaseExecutionArtifactPaths,
  writeExecutionArtifacts,
  type ArtifactStore,
} from "./artifacts.js";
import {
  formatFixComment,
  formatPullRequestComment,
  formatResultComment,
  type InvestigationSummary,
} from "./report.js";

export type InvestigationStage =
  | "queued"
  | "running"
  | "reproducing"
  | "fixing"
  | "verifying"
  | "opening_pull_request"
  | "completed"
  | "failed";

const ONE_SHOT_SOURCE_FILE_LIMIT = 3;

export type InvestigationPipelineInput = {
  investigationId?: string;
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  defaultBranch: string;
  issueNumber: number;
  issueTitle: string;
  issueBody?: string;
  issueUrl?: string;
  triggerComment?: string;
  triggeredBy?: string;
  installationToken?: string | null;
};

export type InvestigationPipelineResult = {
  investigationId: string;
  outcome: string;
  summary: InvestigationSummary;
  githubComment: string;
  artifactsDir?: string;
  result?: ReproductionResult;
  claudeAnalysis?: unknown;
  fixAttempt?: FixAttemptResult | null;
  pullRequest?: PullRequestResult | null;
  graphContextNotes?: string;
  memoryMatches?: number;
};

export type PipelineOptions = {
  onStage?: (stage: InvestigationStage) => void | Promise<void>;
};

export async function runInvestigationPipeline(
  payload: InvestigationPipelineInput,
  options: PipelineOptions = {},
): Promise<InvestigationPipelineResult> {
  const investigationId = isInvestigationId(payload?.investigationId)
    ? payload.investigationId
    : createInvestigationId();
  const log = (message: string) => {
    console.log(`[${investigationId}] ${message}`);
  };

  // Stage reporting is best-effort telemetry; a broken reporter (e.g. a
  // Redis blip during updateProgress) must never fail the investigation.
  const reportStage = async (stage: InvestigationStage) => {
    try {
      await options.onStage?.(stage);
    } catch (error) {
      log(`Could not report stage "${stage}": ${formatError(error)}`);
    }
  };

  let repoContext: RepoContext | null = null;
  let sandboxSession: SandboxSession | null = null;
  let store: ArtifactStore | null = null;
  let investigationRecord: Record<string, unknown> = { investigationId };

  try {
    log("Investigation started.");
    await reportStage("reproducing");

    store = await createArtifactStore(investigationId);

    // Cost-shape summary (artifacts/<inv_id>/cost-shape.json): populated
    // incrementally so a crash still leaves a partial record.
    const costShape = createCostShapeTracker(store, getBudgetProfileName());
    await costShape.update({});

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
      return await finishInvestigation(store, investigationRecord, {
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
      return await finishInvestigation(store, investigationRecord, {
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
    const oneShotSourceFiles = contextSourceFiles.slice(0, ONE_SHOT_SOURCE_FILE_LIMIT);

    // Sandbox restart used by both the reproducer agent (pristine official
    // replays) and the fix loop (post-patch verification).
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

    // Reproduction ordering (cost, cheap-first):
    //   1. memory-plan replay (deterministic, no model call)
    //   2. one-shot generateReproductionPlan()
    //   3. reproducer agent (docs/fable/11) as FALLBACK when enabled
    // REPRODUCER_AGENT_ENABLED=true means the agent is available as fallback,
    // not that it runs first. Only executeReproductionPlan() can mark
    // reproduced — memory is never trusted without replay.
    const reproducerAgentEnabled = process.env.REPRODUCER_AGENT_ENABLED === "true";
    const escalateNotReproduced =
      process.env.SHERLOCK_ESCALATE_NOT_REPRODUCED === "true";

    let plan: ReproductionPlan | null = null;
    let result: ReproductionResult | null = null;
    // Mode of the accepted plan (agent path only): surfaces in the summary
    // and result comment so a reader can tell what evidence drove the fixer.
    let reproductionMode: string | null = null;
    let reproductionPath:
      | "memory_replay"
      | "one_shot"
      | "reproducer_agent"
      | null = null;

    // Runs the reproducer agent fallback. Returns a finished pipeline result
    // on a terminal failure, or null when a plan/result was accepted (stored
    // into the outer plan/result variables).
    const runReproducerAgentFallback =
      async (): Promise<InvestigationPipelineResult | null> => {
        await costShape.update({ reproducerAgentUsed: true });

        const reproResult = await runReproducerAgent({
          investigationId,
          investigationDir: store!.dir,
          repoPath,
          sourceCommit: repoContext!.commit,
          issueTitle: payload.issueTitle,
          issueBody: payload.issueBody ?? "",
          repoUrl: payload.repoUrl,
          defaultBranch: payload.defaultBranch,
          fileTree: repoContext!.fileTree,
          packageJson: repoContext!.packageJson,
          readme: repoContext!.readme,
          sandboxResult: sandboxSession!.result,
          graphContext,
          initialSourceFiles: contextSourceFiles,
          pastInvestigations,
          restart,
        });

        await costShape.update({
          reproducerTurns: reproResult.turns,
          compactionEvents:
            costShape.shape.compactionEvents + reproResult.compactionEvents,
        });

        log(`Reproducer agent finished: ${reproResult.status} — ${reproResult.reason}`);
        for (const submission of reproResult.submissions) {
          log(
            `  submission ${submission.index}: ${submission.valid ? (submission.replayOutcome ?? "valid") : `invalid - ${(submission.validationErrors ?? []).join(" | ")}`}`,
          );
        }

        if (reproResult.status === "plan_failed" || reproResult.status === "exhausted") {
          return await finishInvestigation(store!, investigationRecord, {
            investigationId,
            outcome: "plan_failed",
            planErrors: [reproResult.reason],
          });
        }

        if (reproResult.status === "environment_failed") {
          return await finishInvestigation(store!, investigationRecord, {
            investigationId,
            outcome: "environment_failed",
            stage: "reproduction replay",
            error: reproResult.reason,
          });
        }

        if (reproResult.status === "failed" || !reproResult.plan || !reproResult.result) {
          return await finishInvestigation(store!, investigationRecord, {
            investigationId,
            outcome: "execution_failed",
            error: reproResult.reason,
          });
        }

        plan = reproResult.plan;
        result = reproResult.result;
        reproductionMode = getPlanMode(plan);
        reproductionPath = "reproducer_agent";
        investigationRecord.reproduction = {
          explorationMode: reproResult.explorationMode,
          planMode: reproductionMode,
        };

        // Exploration can be broader than the frozen proof (e.g. mixed
        // exploration, api-only plan) - make the split explicit.
        log(`Exploration mode: ${reproResult.explorationMode}`);
        log(`Submitted plan mode: ${reproductionMode}`);
        log(`Fixer evidence mode: ${reproductionMode} official replay result`);

        await store!.writeJson("reproduction-plan.json", plan);

        return null;
      };

    // --- 1. Memory-plan replay -------------------------------------------
    // A stored plan from a past verified/reproduced investigation is replayed
    // from scratch. A stale-but-attempted replay is safe (it just fails and
    // falls through); the hash check only skips obviously wasteful attempts.
    const replayCandidate = pastEntries.find((entry) => entry.reproductionPlan);

    if (replayCandidate?.reproductionPlan) {
      log("Memory replay candidate found.");

      const staleFile = await findStaleFile(replayCandidate, repoContext.repoPath);

      if (staleFile) {
        log(
          `Memory replay skipped: ${staleFile} changed since the stored plan; falling through to one-shot reproduction.`,
        );
      } else {
        await costShape.update({ memoryReplayTried: true });

        // Rewrite the stored plan's baseUrl to the current sandbox.
        const replayValidation = validateReproductionPlan({
          ...replayCandidate.reproductionPlan,
          baseUrl: sandboxSession.result.baseUrl,
        });

        if (!replayValidation.ok) {
          log(
            `Memory replay plan failed validation (schema drift?); falling through to one-shot reproduction.`,
          );
        } else {
          const replayStore = await createArtifactStore(
            investigationId,
            `${store.dir}/memory-replay`,
          );
          const replayResult = await executeReproductionPlan(
            replayValidation.plan,
            replayStore,
          );

          await replayStore.writeJson("reproduction-result.json", {
            investigationId,
            ...replayResult,
          });

          if (replayResult.outcome === "reproduced") {
            log("Memory replay reproduced issue; skipping one-shot and reproducer agent.");
            plan = replayValidation.plan;
            result = rebaseExecutionArtifactPaths(
              replayResult,
              path.relative(store.dir, replayStore.dir),
            );
            reproductionPath = "memory_replay";
            await costShape.update({ memoryReplaySucceeded: true });
            await store.writeJson("reproduction-plan.json", plan);
          } else {
            log("Memory replay did not reproduce; falling through to one-shot reproduction.");
          }
        }
      }
    }

    // --- 2. One-shot reproduction plan ------------------------------------
    if (!result) {
      await costShape.update({ oneShotPlanTried: true });

      const generated = await generateReproductionPlan({
        issueTitle: payload.issueTitle,
        issueBody: payload.issueBody ?? "",
        repoUrl: payload.repoUrl,
        defaultBranch: payload.defaultBranch,
        fileTree: repoContext.fileTree,
        packageJson: repoContext.packageJson,
        readme: repoContext.readme,
        sourceFiles: oneShotSourceFiles,
        sandboxResult: sandboxSession.result,
        graphContext,
        pastInvestigations,
      });

      await store.writeJson("reproduction-plan-raw.json", {
        rawText: generated.rawText,
        parseError: generated.parseError,
        attempts: generated.attempts ?? [],
      });

      for (const [index, attempt] of (generated.attempts ?? []).entries()) {
        log(
          `Plan generation attempt ${index + 1}: ${attempt.error ? `rejected - ${attempt.error}` : "ok"}`,
        );
      }

      // Generation/validation failure falls through to the agent when it is
      // enabled; it only terminates the run when the agent is unavailable.
      let planErrors: string[] | null = null;
      let oneShotPlan: ReproductionPlan | null = null;

      if (generated.parseError !== null) {
        log(`Plan generation failed after all attempts: ${generated.parseError}`);
        log(`Raw model response (first 600 chars):\n${generated.rawText.slice(0, 600)}`);
        planErrors = [generated.parseError];
      } else {
        const validation = validateReproductionPlan(generated.parsed);

        if (!validation.ok) {
          log(`Plan rejected by validator:`);
          for (const validationError of validation.errors) {
            log(`  - ${validationError}`);
          }
          log(`Raw model response (first 600 chars):\n${generated.rawText.slice(0, 600)}`);
          planErrors = validation.errors;
        } else {
          oneShotPlan = validation.plan;
        }
      }

      if (planErrors !== null) {
        if (reproducerAgentEnabled) {
          log("One-shot reproduction plan failed; falling back to reproducer agent.");
          const terminal = await runReproducerAgentFallback();

          if (terminal) {
            return terminal;
          }
        } else {
          return await finishInvestigation(store, investigationRecord, {
            investigationId,
            outcome: "plan_failed",
            planErrors,
          });
        }
      } else if (oneShotPlan) {
        await store.writeJson("reproduction-plan.json", oneShotPlan);

        const oneShotResult = await executeReproductionPlan(oneShotPlan, store);

        if (oneShotResult.outcome === "reproduced") {
          log("One-shot reproduction succeeded; skipping reproducer agent.");
          plan = oneShotPlan;
          result = oneShotResult;
          reproductionPath = "one_shot";
          await costShape.update({ oneShotPlanSucceeded: true });
        } else if (
          oneShotResult.outcome === "execution_failed" &&
          reproducerAgentEnabled
        ) {
          log("One-shot reproduction execution failed; falling back to reproducer agent.");
          const terminal = await runReproducerAgentFallback();

          if (terminal) {
            return terminal;
          }
        } else if (
          oneShotResult.outcome === "not_reproduced" &&
          escalateNotReproduced &&
          reproducerAgentEnabled
        ) {
          log(
            "One-shot reproduction not_reproduced; escalating to reproducer agent (SHERLOCK_ESCALATE_NOT_REPRODUCED=true).",
          );
          const terminal = await runReproducerAgentFallback();

          if (terminal) {
            return terminal;
          }
        } else {
          if (oneShotResult.outcome === "not_reproduced") {
            log("One-shot reproduction not_reproduced; accepting result.");
          }

          plan = oneShotPlan;
          result = oneShotResult;
          reproductionPath = "one_shot";
        }
      }
    }

    if (!plan || !result) {
      // Defensive: every path above either accepts a plan/result or returns.
      return await finishInvestigation(store, investigationRecord, {
        investigationId,
        outcome: "execution_failed",
        error: "No reproduction path produced a plan and result.",
      });
    }

    investigationRecord.reproductionPath = reproductionPath;
    log(`Accepted reproduction path: ${reproductionPath}`);

    log(`Validated plan: ${plan.steps.length} step(s), assertion ${plan.assertion.type}`);
    for (const step of plan.steps) {
      log(`  ${step.id}: ${describePlanStep(step)}`);
    }
    log(`  expectedBehavior: ${plan.expectedBehavior}`);
    log(`  failureCondition: ${plan.failureCondition}`);
    log(`  assertion: ${JSON.stringify(plan.assertion)}`);

    await writeExecutionArtifacts(store, result);

    log(`Plan executed with outcome: ${result.outcome} (${durationMs(result.startedAt, result.finishedAt)}ms)`);
    for (const step of result.steps) {
      const timing =
        step.startedAt && step.finishedAt
          ? ` ${durationMs(step.startedAt, step.finishedAt)}ms`
          : "";
      const detail = step.error
        ? ` - ${step.ambiguous ? "AMBIGUOUS: " : ""}${firstLine(step.error)}`
        : "";
      log(`  ${step.id} [${step.outcome}${timing}]${detail}`);
    }
    if (result.assertion) {
      log(
        `  assertion: matchedFailure=${result.assertion.matchedFailure} matchedExpected=${result.assertion.matchedExpected}`,
      );
      log(`  assertion detail: ${result.assertion.detail}`);
      log(`  observed: ${firstLine(result.assertion.observed ?? "(nothing)")}`);
    }
    log(
      `  evidence: ${result.consoleErrors.length} console error(s), ${result.pageErrors.length} page error(s), ${result.networkFailures.length} network failure(s), ${result.apiResponses.length} api response(s), ${result.screenshots.length} screenshot(s)`,
    );

    // Verified fix loop: only for a confirmed reproduction. The bounded
    // fixer agent may make several verifier-judged attempts internally.
    // analyzeIssue() moved AFTER the fix decision (cost): a verified fix
    // attempt already carries root cause, summary, changed files, and
    // verification checks, so the diagnostic call is skipped entirely.
    let fixAttempt: FixAttemptResult | null = null;
    let fixerStatus: FixerAgentStatus | null = null;

    if (result.outcome === "reproduced") {
      try {
        await reportStage("fixing");
        await costShape.update({ fixerAgentUsed: true });

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

        await reportStage("verifying");

        // Bounded fixer agent (docs/fable/10): explores the repo, proposes
        // patches, and revises using deterministic verification evidence.
        // Only runFixAttempt() inside the agent can mark an attempt verified.
        const agentResult = await runFixerAgent({
          investigationId,
          investigationDir: store.dir,
          repoPath,
          sourceCommit: repoContext.commit,
          issueTitle: payload.issueTitle,
          issueBody: payload.issueBody ?? "",
          repoUrl: payload.repoUrl,
          defaultBranch: payload.defaultBranch,
          fileTree: repoContext.fileTree,
          packageJson: repoContext.packageJson,
          readme: repoContext.readme,
          sandboxResult: sandboxSession.result,
          plan,
          reproductionResult: result,
          graphContext: refinedContext,
          initialSourceFiles: refinedContext.available
            ? refinedContext.relevantFiles
            : contextSourceFiles,
          restart,
        });

        fixAttempt = agentResult.fixAttempt;
        fixerStatus = agentResult.status;
        await costShape.update({
          fixerTurns: agentResult.turns,
          fixerPatchAttempts: agentResult.attempts.length,
          compactionEvents:
            costShape.shape.compactionEvents + agentResult.compactionEvents,
        });
        log(`Fixer agent finished: ${agentResult.status} — ${agentResult.reason}`);
        for (const attempt of agentResult.attempts) {
          log(
            `  attempt ${attempt.index} (${attempt.fixAttemptId ?? "?"}): ${attempt.outcome ?? "?"}${attempt.reason ? ` - ${firstLine(attempt.reason)}` : ""}`,
          );
        }

        if (fixAttempt) {
          log(`Fix attempt ${fixAttempt.fixAttemptId} finished: ${fixAttempt.outcome}`);
          for (const item of fixAttempt.checks) {
            log(`  [${item.passed ? "pass" : "FAIL"}] ${item.name}: ${firstLine(item.detail)}`);
          }
          if (fixAttempt.reason) {
            log(`  reason: ${fixAttempt.reason}`);
          }
          if (fixAttempt.changedFiles.length > 0) {
            log(`  changed files: ${fixAttempt.changedFiles.join(", ")}`);
          }
          if (fixAttempt.postPatchOutcome) {
            log(`  post-patch replay outcome: ${fixAttempt.postPatchOutcome}`);
          }
          for (const run of fixAttempt.testRuns) {
            log(`  test: ${run.command} -> exit ${run.exitCode} (${run.durationMs}ms)`);
          }
        }
      } catch (error) {
        log(`Fix attempt failed unexpectedly: ${formatError(error)}`);
      }
    }

    // Diagnostic analysis (reporting only; the fixer never consumes it).
    // Called ONLY when the investigation ends without a verified fix:
    // reproduced-but-unfixed, or not_reproduced needing an explanatory
    // report. A verified fix already carries root cause + verification
    // detail, so the call is skipped entirely (claudeAnalysis stays null).
    let claudeAnalysis: unknown = null;
    const fixVerified = fixAttempt?.outcome === "verified";

    if (
      !fixVerified &&
      (result.outcome === "reproduced" || result.outcome === "not_reproduced")
    ) {
      await costShape.update({ analyzeIssueCalled: true });

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
    } else if (fixVerified) {
      log("Fix verified; skipping analyzeIssue (fix attempt carries root cause and verification detail).");
    }

    // Verified fix -> GitHub pull request. Only verified fixes may push.
    let pullRequest: PullRequestResult | null = null;

    if (fixAttempt?.outcome === "verified") {
      try {
        await reportStage("opening_pull_request");

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
    // Cost: the reflection input is compact structured fields (plan summary,
    // bounded evidence), never full plan JSON / logs / analysis text. On a
    // verified fix all fields derive directly from the fix attempt and the
    // Claude reflection call is skipped entirely.
    try {
      const outcome = mapMemoryOutcome(result, fixAttempt, fixerStatus);
      const patchedFiles = fixAttempt?.changedFiles ?? [];
      const planSummary = `${plan.steps.length} step(s), assertion ${plan.assertion.type} — intent: ${firstLine(plan.failureCondition)}`;
      const failedChecks =
        fixAttempt && fixAttempt.outcome !== "verified"
          ? fixAttempt.checks
              .filter((item) => !item.passed)
              .map((item) => `${item.name}: ${item.detail}`)
          : [];

      let memoryFields: {
        issueTerms: string[];
        rootCause: string;
        whatWorked: string;
        whatFailed: string;
      };

      if (fixVerified && fixAttempt) {
        // Derive directly from the verified fix attempt; no model call.
        memoryFields = {
          issueTerms: issueTerms.slice(0, 8),
          rootCause: fixAttempt.rootCause ?? "",
          whatWorked:
            fixAttempt.summary ??
            `Verified fix touching ${patchedFiles.join(", ") || "(no files recorded)"}`,
          whatFailed: "",
        };
      } else {
        await costShape.update({ memoryReflectionCalled: true });

        const reflection = await generateMemoryReflection({
          issueTitle: payload.issueTitle,
          outcome,
          planSummary,
          assertionDetail: result.assertion?.detail ?? "",
          browserErrors: [
            result.outcomeReason,
            ...(result.assertion ? [result.assertion.detail] : []),
          ],
          fixRootCause: fixAttempt?.rootCause ?? "",
          fixSummary: fixAttempt?.summary ?? "",
          changedFiles: patchedFiles,
          failedChecks,
        });
        memoryFields = {
          issueTerms: reflection.issueTerms,
          rootCause: fixAttempt?.rootCause ?? reflection.rootCause,
          whatWorked: reflection.whatWorked,
          whatFailed: reflection.whatFailed,
        };
      }

      await appendMemory(payload.repoUrl, {
        issueTitle: payload.issueTitle,
        issueTerms: memoryFields.issueTerms,
        commitSha: repoContext.commit,
        outcome,
        rootCause: memoryFields.rootCause,
        patchedFiles,
        fileHashes: await hashRepoFiles(repoContext.repoPath, patchedFiles),
        whatWorked: memoryFields.whatWorked,
        whatFailed: memoryFields.whatFailed,
        createdAt: new Date().toISOString(),
        // Memory-plan replay: store the deterministically proven plan so
        // repeat issues can replay it instead of regenerating. Only plans
        // that actually reproduced are stored; replay (never trust) decides.
        ...(result.outcome === "reproduced" ? { reproductionPlan: plan } : {}),
      });

      log(`Memory entry recorded (outcome: ${outcome}).`);
      log(`  terms: ${memoryFields.issueTerms.join(", ")}`);
      log(`  rootCause: ${memoryFields.rootCause}`);
      if (result.outcome === "reproduced") {
        log("  reproductionPlan: stored for future memory replay");
      }
      if (memoryFields.whatWorked) {
        log(`  whatWorked: ${memoryFields.whatWorked}`);
      }
      if (memoryFields.whatFailed) {
        log(`  whatFailed: ${memoryFields.whatFailed}`);
      }
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
      store,
      investigationRecord,
      {
        ...buildExecutionSummary(investigationId, plan.expectedBehavior, result),
        ...(reproductionMode ? { reproductionMode } : {}),
      },
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
      return await finishInvestigation(store, investigationRecord, summary);
    }

    return {
      investigationId,
      outcome: "execution_failed",
      summary,
      githubComment: formatResultComment(summary),
    };
  } finally {
    if (sandboxSession) {
      await sandboxSession.stop();
    }

    if (repoContext) {
      await cleanupRepoContext(repoContext);
    }
  }
}

// --- Terminal logging helpers ---------------------------------------------

function describePlanStep(step: ReproductionPlan["steps"][number]): string {
  switch (step.action) {
    case "goto":
      return `goto ${step.path}`;
    case "click":
    case "waitForSelector":
      return `${step.action} ${"selector" in step ? step.selector : JSON.stringify(step.target)}`;
    case "fill":
      return `fill ${"selector" in step ? step.selector : JSON.stringify(step.target)} = "${step.value}"`;
    case "screenshot":
      return "screenshot";
    case "wait":
      return `wait ${step.ms}ms`;
    case "request":
      return `${step.method} ${step.path}${step.body ? ` body=${JSON.stringify(step.body)}` : ""}`;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";

  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function durationMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}

// Memory outcome mapping (docs/fable/10):
// agent status verified -> verified, blocked -> blocked, exhausted/failed ->
// failed. Without an agent run: reproduced but no usable fix attempt ->
// blocked; otherwise analysis only.
function mapMemoryOutcome(
  result: ReproductionResult,
  fixAttempt: FixAttemptResult | null,
  fixerStatus: FixerAgentStatus | null,
): MemoryOutcome {
  if (fixerStatus === "verified" || fixAttempt?.outcome === "verified") {
    return "verified";
  }

  if (fixerStatus === "blocked") {
    return "blocked";
  }

  if (fixerStatus === "exhausted" || fixerStatus === "failed") {
    return "failed";
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
  store: ArtifactStore,
  record: Record<string, unknown>,
  summary: InvestigationSummary,
  extra: Partial<InvestigationPipelineResult> = {},
  extraComment: string | null = null,
): Promise<InvestigationPipelineResult> {
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

  return {
    investigationId: summary.investigationId,
    outcome: summary.outcome,
    summary,
    githubComment,
    artifactsDir: store.dir,
    ...extra,
  };
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
