// The investigation pipeline: clone -> memory recall -> sandbox -> graph
// context -> memory-plan replay -> one-shot reproduction plan -> reproducer
// agent fallback -> deterministic execution -> verified fix loop (with graph
// refinement) -> pull request -> memory reflection.
// Extracted from the HTTP route so the queue worker can run it directly;
// both the Express route and the BullMQ worker call this single
// implementation.
//
// Cheap-first ordering (cost): deterministic memory replay first, one-shot
// generation second, agentic exploration only when necessary.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  analyzeIssue,
  generateMemoryReflection,
  generateRegressionTestProposal,
  generateReproductionPlan,
} from "./claude.js";
import {
  runFixerAgent,
  type FixerAgentAttempt,
  type FixerAgentStatus,
} from "../agents/fixer.js";
import {
  getBudgetProfileName,
  runReproducerAgent,
  type ReproducerFinding,
} from "../agents/reproducer.js";
import { createCostShapeTracker } from "./cost-shape.js";
import type { FixAttemptResult, FixOutcome } from "./fix.js";
import { getSandboxNetworkPolicy } from "./container.js";
import { formatValidationLine } from "./repo-validation.js";
import {
  formatRegressionCommentLines,
  type AppNetworkTarget,
} from "./regression-test.js";
import { buildGraphContext, tokenize } from "./graphContext.js";
import {
  appendMemory,
  boundFixDiff,
  findStaleFile,
  hashRepoFiles,
  loadMemory,
  matchMemory,
  renderPastInvestigations,
  writeMemorySelectionArtifacts,
  MAX_FAILED_ATTEMPTS_PER_MEMORY_ENTRY,
  MAX_FAILED_DIFF_BYTES,
  MAX_FAILED_REASON_BYTES,
  type FailedMemoryAttempt,
  type MemoryOutcome,
} from "./memory.js";
import { truncateUtf8Bytes } from "./reproduction-evidence.js";
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
import { RepositoryError } from "./repo-auth.js";
import {
  runSandboxInvestigation,
  type SandboxResult,
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
  formatAnalysisComment,
  formatPullRequestComment,
  formatResultComment,
  redactSecrets,
  type InvestigationSummary,
} from "./report.js";
import {
  createNoopInvestigationStateStore,
  safeRepoUrl,
  type InvestigationStateEvent,
  type InvestigationStateEventInput,
  type InvestigationStateStore,
} from "./investigation-state-store.js";

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
  // Permission metadata from the installation access-token response.
  installationPermissions?: Record<string, string> | null;
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
  // Injectable for tests; production always uses the real authenticated
  // clone flow.
  cloneRepo?: typeof cloneRepoForInvestigation;
  // Investigation lifecycle state store (dashboard-friendly summary records).
  // Defaults to the no-op store, so leaving this unset preserves behavior.
  // Writes are best-effort: a failing store never fails the investigation.
  stateStore?: InvestigationStateStore;
};

export type ReproducerFallbackCase =
  | "memory_reproduced"
  | "plan_failed"
  | "reproduced"
  | "not_reproduced"
  | "environment_failed"
  | "execution_failed";

export function shouldRunReproducerFallback(
  fallbackCase: ReproducerFallbackCase,
  escalateNotReproduced: boolean,
): boolean {
  return (
    fallbackCase === "plan_failed" ||
    fallbackCase === "execution_failed" ||
    (fallbackCase === "not_reproduced" && escalateNotReproduced)
  );
}

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

  const stateStore = options.stateStore ?? createNoopInvestigationStateStore();

  // State-store writes are best-effort telemetry: a failing store must never
  // break an investigation. Every lifecycle write goes through here so the
  // non-fatal guarantee lives in exactly one place.
  const recordState = async (event: InvestigationStateEventInput) => {
    try {
      await stateStore.record({
        ...event,
        investigationId,
        at: new Date().toISOString(),
      } as InvestigationStateEvent);
    } catch (error) {
      log(`State store write failed ("${event.type}"); continuing: ${formatError(error)}`);
    }
  };

  // Stage reporting is best-effort telemetry; a broken reporter (e.g. a
  // Redis blip during updateProgress) must never fail the investigation.
  const reportStage = async (stage: InvestigationStage) => {
    await recordState({ type: "stage_changed", stage });

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

  // Wraps finishInvestigation so every terminal path — success or early
  // failure return — records the final outcome (and any error) into the state
  // store exactly once, alongside the existing artifact write.
  const finish = async (
    summary: InvestigationSummary,
    extra: Partial<InvestigationPipelineResult> = {},
    extraComment: string | null = null,
  ): Promise<InvestigationPipelineResult> => {
    const finished = await finishInvestigation(
      store as ArtifactStore,
      investigationRecord,
      summary,
      extra,
      extraComment,
    );

    await recordState({
      type: "final_outcome",
      outcome: summary.outcome,
      originalOutcome: summary.originalOutcome ?? null,
      pullRequestStatus: summary.pullRequestStatus ?? null,
      error: summary.error ?? null,
    });

    return finished;
  };

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

    await recordState({
      type: "created",
      repoOwner: payload.repoOwner,
      repoName: payload.repoName,
      // Derived from the validated owner/name, never the webhook-supplied URL,
      // so a credential can never ride in via a crafted repoUrl.
      repoUrl: safeRepoUrl(payload.repoOwner, payload.repoName),
      issueNumber: payload.issueNumber,
      issueTitle: payload.issueTitle,
      issueUrl: payload.issueUrl,
      triggeredBy: payload.triggeredBy,
    });

    try {
      // Clone target is derived from the validated owner/name, never the
      // webhook-supplied URL; the short-lived installation token (minted by
      // the worker for this installation) authenticates private clones.
      repoContext = await (options.cloneRepo ?? cloneRepoForInvestigation)({
        repoOwner: payload.repoOwner,
        repoName: payload.repoName,
        defaultBranch: payload.defaultBranch,
        installationToken: payload.installationToken ?? null,
        installationPermissions: payload.installationPermissions ?? null,
      });
    } catch (error) {
      // Transient repository failures (GitHub 5xx/rate limits, network or
      // transport blips) must reach the worker so BullMQ retries with
      // backoff — they are never converted into a completed
      // environment_failed result.
      if (error instanceof RepositoryError && error.retryable) {
        throw error;
      }

      return await finish({
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
    await writeMemorySelectionArtifacts({
      investigationDir: store.dir,
      queryTerms: issueTerms,
      storedEntryCount: memoryEntries.length,
      selectedEntries: pastEntries,
      renderedMemory: pastInvestigations,
    });

    log(
      `Memory: ${memoryEntries.length} stored entr${memoryEntries.length === 1 ? "y" : "ies"} for this repo; using top ${pastEntries.length} match(es).`,
    );

    try {
      sandboxSession = await runSandboxInvestigation({
        repoPath: repoContext.repoPath,
      });
    } catch (error) {
      return await finish({
        investigationId,
        outcome: "environment_failed",
        stage: "application startup",
        error: formatError(error),
      });
    }

    log(
      `Sandbox started at ${sandboxSession.result.baseUrl} (network policy: ${getSandboxNetworkPolicy()})`,
    );

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
        // Identity of the restarted app container so strict-network
        // regression containers can join its network namespace.
        appNetwork: appNetworkTarget(sandboxSession.result),
        log: [sandboxSession.result.stdout, sandboxSession.result.stderr]
          .filter(Boolean)
          .join("\n"),
      };
    };

    // Reproduction ordering (cost, cheap-first):
    //   1. memory-plan replay (deterministic, no model call)
    //   2. one-shot generateReproductionPlan()
    //   3. reproducer agent (docs/fable/11) as FALLBACK
    // Only executeReproductionPlan() can mark reproduced — memory is never
    // trusted without replay.
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
    // Structured live-exploration findings, retained ONLY when reproduction
    // succeeded through the reproducer agent (Change 4). Memory-replay and
    // one-shot paths never fabricate findings.
    let reproducerFindings: ReproducerFinding[] = [];

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
          return await finish({
            investigationId,
            outcome: "plan_failed",
            planErrors: [reproResult.reason],
          });
        }

        if (reproResult.status === "environment_failed") {
          return await finish({
            investigationId,
            outcome: "environment_failed",
            stage: "reproduction replay",
            error: reproResult.reason,
          });
        }

        if (reproResult.status === "failed" || !reproResult.plan || !reproResult.result) {
          return await finish({
            investigationId,
            outcome: "execution_failed",
            error: reproResult.reason,
          });
        }

        plan = reproResult.plan;
        result = reproResult.result;
        reproductionMode = getPlanMode(plan);
        reproductionPath = "reproducer_agent";
        reproducerFindings = reproResult.findings;
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
        if (shouldRunReproducerFallback("plan_failed", escalateNotReproduced)) {
          log("One-shot reproduction plan failed; falling back to reproducer agent.");
          const terminal = await runReproducerAgentFallback();

          if (terminal) {
            return terminal;
          }
        } else {
          return await finish({
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
          shouldRunReproducerFallback(oneShotResult.outcome, escalateNotReproduced)
        ) {
          if (oneShotResult.outcome === "not_reproduced") {
            log(
              "One-shot reproduction not_reproduced; escalating to reproducer agent (SHERLOCK_ESCALATE_NOT_REPRODUCED=true).",
            );
          } else {
            log(
              "One-shot reproduction execution failed; falling back to reproducer agent.",
            );
          }
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
      return await finish({
        investigationId,
        outcome: "execution_failed",
        error: "No reproduction path produced a plan and result.",
      });
    }

    investigationRecord.reproductionPath = reproductionPath;
    log(`Accepted reproduction path: ${reproductionPath}`);

    await recordState({
      type: "reproduction",
      path: reproductionPath,
      mode: reproductionMode,
      outcome: result.outcome,
      commit: repoContext.commit,
    });

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
    let fixerFailureCode: string | null = null;
    let fixerAttemptCount = 0;
    // Retained outside the fixer try block so the memory-recording stage can
    // persist ALL non-verified attempts, not only the last one (Change 2).
    let fixerAttempts: FixerAgentAttempt[] = [];

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

        const knownFailedProposals = pastEntries
          .flatMap((entry) => entry.failedAttempts ?? [])
          .filter(
            (attempt) =>
              typeof attempt?.proposalHash === "string" && attempt.proposalHash,
          )
          .map((attempt) => ({
            proposalHash: attempt.proposalHash,
            failureReason: attempt.failureReason ?? "(no reason recorded)",
          }));

        // One regression test per fix attempt (dev): Claude-backed generator
        // with bounded refinement handled inside runFixAttempt(). The fixer
        // agent binds each patch proposal into the generator per attempt.
        const regressionSourceFiles = (
          refinedContext.available ? refinedContext.relevantFiles : contextSourceFiles
        ).map((file) => ({ path: file.path, contents: file.contents }));
        const acceptedPlan = plan;
        const acceptedResult = result;

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
          // Memory: how similar bugs in this repo were fixed before,
          // re-rendered against the CURRENT clone so staleness markers and
          // verified fix diffs are accurate at fix time.
          pastInvestigations: await renderPastInvestigations(
            pastEntries,
            repoContext.repoPath,
          ),
          // Cross-run duplicate guard seed (Change 3): canonical hashes of
          // patches that already failed for this issue. Omitted when empty.
          ...(knownFailedProposals.length > 0 ? { knownFailedProposals } : {}),
          // Live-exploration hints (Change 4): reproducerFindings is only
          // ever assigned on the reproducer-agent path, so a non-empty array
          // implies that path; memory-replay/one-shot stay empty.
          ...(reproducerFindings.length > 0 ? { reproducerFindings } : {}),
          initialSourceFiles: refinedContext.available
            ? refinedContext.relevantFiles
            : contextSourceFiles,
          restart,
          repositoryLabel: `${payload.repoOwner}/${payload.repoName}`,
          appNetwork: appNetworkTarget(sandboxSession.result),
          buildRegressionTestGenerator: (proposal) => (feedback) =>
            generateRegressionTestProposal(
              {
                issueTitle: payload.issueTitle,
                issueBody: payload.issueBody ?? "",
                plan: acceptedPlan,
                reproductionResult: acceptedResult,
                fixProposal: proposal,
                sourceFiles: regressionSourceFiles,
              },
              feedback,
            ),
        });

        fixAttempt = agentResult.fixAttempt;
        fixerStatus = agentResult.status;
        fixerFailureCode = agentResult.failureCode;
        fixerAttemptCount = agentResult.attempts.length;
        fixerAttempts = agentResult.attempts;
        await costShape.update({
          fixerTurns: agentResult.turns,
          fixerPatchAttempts: agentResult.attempts.length,
          fixerFailureCode: agentResult.failureCode,
          compactionEvents:
            costShape.shape.compactionEvents + agentResult.compactionEvents,
        });
        log(`Fixer agent finished: ${agentResult.status} — ${agentResult.reason}`);
        if (agentResult.failureCode) {
          log(`Fixer failure code: ${agentResult.failureCode}`);
        }
        for (const attempt of agentResult.attempts) {
          log(
            `  attempt ${attempt.index} (${attempt.fixAttemptId ?? "?"}): ${attempt.outcome ?? "?"}${attempt.reason ? ` - ${firstLine(attempt.reason)}` : ""}`,
          );
        }

        if (fixAttempt) {
          log(`Fix attempt ${fixAttempt.fixAttemptId} finished: ${fixAttempt.outcome}`);
          if (fixAttempt.reason) {
            log(`  reason: ${fixAttempt.reason}`);
          }
          if (fixAttempt.changedFiles.length > 0) {
            log(`  changed files: ${fixAttempt.changedFiles.join(", ")}`);
          }
          if (fixAttempt.postPatchOutcome) {
            log(`Post-patch replay outcome: ${fixAttempt.postPatchOutcome}`);
          }
          if (fixAttempt.regressionTest) {
            const regression = fixAttempt.regressionTest;
            const regressionCheck = fixAttempt.checks.find(
              (item) => item.name === "regression_test",
            );

            if (regressionCheck) {
              log(`Regression evidence: ${regressionCheck.status}`);
            }

            if (regression.testName) {
              log(`Regression test generated: ${regression.testName}`);
            }
            if (regression.prePatch) {
              log(`Pre-patch regression result: ${regression.prePatch}`);
            }
            if (regression.postPatch) {
              log(`Post-patch regression result: ${regression.postPatch}`);
            }
            if (regression.hashMatched !== null) {
              log(`Regression test hash matched: ${regression.hashMatched}`);
            }
            if (regression.status === "unavailable") {
              log(`Regression test unavailable: ${regression.reason ?? "(no reason recorded)"}`);
            }

            if (fixAttempt.outcome === "verified") {
              log(
                regression.status === "blocked"
                  ? "Verification decision: accepted from the exact saved replay; generated regression evidence was blocked"
                  : regression.status === "unavailable"
                    ? "Verification decision: accepted from the exact saved replay; generated regression evidence was unavailable"
                    : "Verification decision: accepted from the exact saved replay and proven generated regression test",
              );
            } else {
              log(`Verification decision: rejected (${fixAttempt.outcome})`);
            }
          }
          for (const item of fixAttempt.checks) {
            log(
              `  [${item.status === "passed" ? "pass" : item.status === "failed" ? "FAIL" : "advisory"}] ${item.name}: ${firstLine(item.detail)}`,
            );
          }
          for (const run of fixAttempt.testRuns) {
            log(`  test: ${run.command} -> exit ${run.exitCode} (${run.durationMs}ms)`);
          }
        }
      } catch (error) {
        log(`Fix attempt failed unexpectedly: ${formatError(error)}`);
        await recordState({
          type: "error",
          stage: "fixing",
          message: formatError(error),
        });
      }

      // Fixer attempts summary + repository validation and regression proof
      // results (dashboard-friendly; derived from the returned fix attempt).
      await recordState({
        type: "fixer_attempts",
        status: fixerStatus,
        attempts: fixerAttemptCount,
        outcome: fixAttempt?.outcome ?? null,
        changedFiles: fixAttempt?.changedFiles ?? [],
        verifiedFixAttemptId:
          fixAttempt?.outcome === "verified" ? fixAttempt.fixAttemptId : null,
      });

      if (fixAttempt?.repositoryValidation) {
        await recordState({
          type: "repository_validation",
          aggregate: fixAttempt.repositoryValidation.aggregate,
          categories: fixAttempt.repositoryValidation.categories.map((item) => ({
            category: item.category,
            status: item.status,
          })),
        });
      }

      if (fixAttempt?.regressionTest) {
        await recordState({
          type: "regression_proof",
          status: fixAttempt.regressionTest.status,
          testName: fixAttempt.regressionTest.testName,
          prePatch: fixAttempt.regressionTest.prePatch,
          postPatch: fixAttempt.regressionTest.postPatch,
          hashMatched: fixAttempt.regressionTest.hashMatched,
        });
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

        await recordState({
          type: "pull_request",
          status: pullRequest.status,
          number: pullRequest.pullRequestNumber,
          url: pullRequest.pullRequestUrl,
          branch: pullRequest.branch,
        });
      } catch (error) {
        log(`Pull request flow failed unexpectedly: ${formatError(error)}`);
        await recordState({
          type: "error",
          stage: "opening_pull_request",
          message: formatError(error),
        });
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
              .filter((item) => item.status === "failed")
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

        if (fixerFailureCode === "fixer_no_patch_attempt") {
          memoryFields.whatFailed =
            "The failure was reproduced, but the fixer did not attempt a patch before exhausting or ending its budget.";
        }
      }

      // Truthful memory for rejected regression proofs: when the exact
      // replay DID pass after the patch, the record must say so — the
      // failure was the generated-test proof, not the reproduction.
      if (
        fixAttempt?.outcome === "rejected_regression_test_failed" &&
        fixAttempt.postPatchOutcome === "not_reproduced"
      ) {
        memoryFields.whatWorked = [
          "The exact reproduction replay passed after the patch.",
          memoryFields.whatWorked,
        ]
          .filter(Boolean)
          .join(" ");
        memoryFields.whatFailed = `The generated regression test did not prove the fix (${
          fixAttempt.regressionTest?.reason ?? "regression proof failed"
        }), so the patch was rejected despite the passing replay.`;
      }

      // Failed-attempt memory (Change 2): the last two non-verified attempts,
      // bounded, with diffs read only through the fixer-returned attemptDir.
      const failedAttempts: FailedMemoryAttempt[] = [];

      for (const attempt of fixerAttempts
        .filter((item) => item.outcome !== "verified" && item.proposalHash)
        .slice(-MAX_FAILED_ATTEMPTS_PER_MEMORY_ENTRY)) {
        let failedDiff: string | null = null;

        if (attempt.attemptDir) {
          try {
            const raw = await readFile(
              path.join(attempt.attemptDir, "git-diff.patch"),
              "utf8",
            );
            failedDiff = raw.trim()
              ? truncateUtf8Bytes(raw, MAX_FAILED_DIFF_BYTES)
              : null;
          } catch {
            failedDiff = null; // Patch never reached application.
          }
        }

        failedAttempts.push({
          approach: attempt.proposalSummary ?? "(no summary recorded)",
          proposalHash: attempt.proposalHash as string,
          diff: failedDiff,
          failureReason: truncateUtf8Bytes(
            redactSecrets(
              [attempt.reason ?? "", attempt.failureSignature ?? ""]
                .filter(Boolean)
                .join(" | ") || "(no reason recorded)",
            ),
            MAX_FAILED_REASON_BYTES,
          ),
          failureSignature: attempt.failureSignature ?? null,
        });
      }

      // Verified fixes: store the exact winning diff so a future fixer run on
      // the same bug can reapply HOW it was fixed instead of re-deriving it.
      let fixDiff: string | null = null;

      if (fixVerified && fixAttempt) {
        try {
          fixDiff = boundFixDiff(
            await readFile(path.join(fixAttempt.attemptDir, "git-diff.patch"), "utf8"),
          );
        } catch {
          fixDiff = null; // Diff artifact missing; record memory without it.
        }
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
        ...(fixDiff ? { fixDiff } : {}),
        ...(failedAttempts.length > 0 ? { failedAttempts } : {}),
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
            .filter((item) => item.status === "passed")
            .map((item) => item.detail),
          repositoryValidation: fixAttempt.repositoryValidation
            ? fixAttempt.repositoryValidation.categories.map((item) =>
                formatValidationLine(item),
              )
            : undefined,
          regressionTest: fixAttempt.regressionTest
            ? formatRegressionCommentLines(fixAttempt.regressionTest)
            : undefined,
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

    const analysisComment = !fixAttempt || fixAttempt.outcome !== "verified"
      ? formatAnalysisComment(claudeAnalysis)
      : null;
    const extraComment =
      [analysisComment, fixComment, pullRequestComment].filter(Boolean).join("\n\n---\n\n") || null;

    // Final outcome semantics: a reproduced bug whose patch was verified
    // finishes as verified_fix. The original reproduction outcome is
    // preserved in summary.originalOutcome and in the untouched
    // reproduction-result.json artifact.
    const summary = buildExecutionSummary(investigationId, plan.expectedBehavior, result);
    const finalOutcome = resolveFinalOutcome(result.outcome, fixAttempt?.outcome ?? null);

    if (finalOutcome === "verified_fix") {
      summary.outcome = "verified_fix";
      summary.originalOutcome = result.outcome;
      summary.verification = "verified";
      summary.pullRequestStatus = pullRequest?.status ?? "not_attempted";
      log(
        `Final outcome: verified_fix (original reproduction: ${result.outcome}, pull request: ${summary.pullRequestStatus})`,
      );
    }

    return await finish(
      {
        ...summary,
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
    // Typed transient repository errors propagate to the worker retry
    // classifier instead of becoming a completed execution_failed result.
    if (error instanceof RepositoryError && error.retryable) {
      throw error;
    }

    console.error(`[${investigationId}] Investigation failed:`, error);

    await recordState({
      type: "error",
      stage: "pipeline",
      message: formatError(error),
    });

    const summary: InvestigationSummary = {
      investigationId,
      outcome: "execution_failed",
      error: formatError(error),
    };

    if (store) {
      return await finish(summary);
    }

    // No artifact store was created yet, so finish() (which requires a store)
    // cannot run; record the final outcome directly to keep the state record
    // complete.
    await recordState({
      type: "final_outcome",
      outcome: summary.outcome,
      error: summary.error ?? null,
    });

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

// Final investigation outcome semantics:
// - environment/plan/execution failures and not_reproduced pass through
// - reproduced with no verified patch stays "reproduced"
// - reproduced AND a verified patch becomes "verified_fix"
// PR creation status is a separate field, never part of the outcome.
export function resolveFinalOutcome(
  reproductionOutcome: ReproductionResult["outcome"],
  fixOutcome: FixOutcome | null,
): ReproductionResult["outcome"] | "verified_fix" {
  return reproductionOutcome === "reproduced" && fixOutcome === "verified"
    ? "verified_fix"
    : reproductionOutcome;
}

// The running app container's identity for strict-network regression
// execution; null when the sandbox did not report one.
function appNetworkTarget(result: SandboxResult): AppNetworkTarget | null {
  if (result.containerName && result.internalPort) {
    return {
      containerName: result.containerName,
      internalPort: result.internalPort,
    };
  }

  return null;
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
