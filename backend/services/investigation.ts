// The investigation pipeline: clone -> memory recall -> sandbox -> graph
// context -> reproduction plan -> deterministic execution -> verified fix
// loop (with graph refinement) -> pull request -> memory reflection.
// Extracted from the HTTP route so the queue worker can run it directly;
// both the Express route and the BullMQ worker call this single
// implementation.

import {
  analyzeIssue,
  generateFixProposal,
  generateMemoryReflection,
  generateReproductionPlan,
} from "./claude.js";
import { runFixAttempt, type FixAttemptResult, type FixOutcome } from "./fix.js";
import { formatValidationLine } from "./repo-validation.js";
import { buildGraphContext, tokenize } from "./graphContext.js";
import {
  appendMemory,
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
import { RepositoryError } from "./repo-auth.js";
import {
  runSandboxInvestigation,
  type SandboxSession,
} from "./sandbox.js";
import {
  executeReproductionPlan,
  type ReproductionResult,
} from "./playwright.js";
import { validateReproductionPlan, type ReproductionPlan } from "./plan.js";
import {
  createArtifactStore,
  createInvestigationId,
  isInvestigationId,
  writeExecutionArtifacts,
  type ArtifactStore,
} from "./artifacts.js";
import {
  formatFixComment,
  formatPullRequestComment,
  formatResultComment,
  redactSecrets,
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
      attempts: generated.attempts ?? [],
    });

    for (const [index, attempt] of (generated.attempts ?? []).entries()) {
      log(
        `Plan generation attempt ${index + 1}: ${attempt.error ? `rejected - ${attempt.error}` : "ok"}`,
      );
    }

    if (generated.parseError !== null) {
      log(`Plan generation failed after all attempts: ${generated.parseError}`);
      log(`Raw model response (first 600 chars):\n${generated.rawText.slice(0, 600)}`);

      return await finishInvestigation(store, investigationRecord, {
        investigationId,
        outcome: "plan_failed",
        planErrors: [generated.parseError],
      });
    }

    const validation = validateReproductionPlan(generated.parsed);

    if (!validation.ok) {
      log(`Plan rejected by validator:`);
      for (const validationError of validation.errors) {
        log(`  - ${validationError}`);
      }
      log(`Raw model response (first 600 chars):\n${generated.rawText.slice(0, 600)}`);

      return await finishInvestigation(store, investigationRecord, {
        investigationId,
        outcome: "plan_failed",
        planErrors: validation.errors,
      });
    }

    const plan = validation.plan;
    await store.writeJson("reproduction-plan.json", plan);
    log(`Validated plan: ${plan.steps.length} step(s), assertion ${plan.assertion.type}`);
    for (const step of plan.steps) {
      log(`  ${step.id}: ${describePlanStep(step)}`);
    }
    log(`  expectedBehavior: ${plan.expectedBehavior}`);
    log(`  failureCondition: ${plan.failureCondition}`);
    log(`  assertion: ${JSON.stringify(plan.assertion)}`);

    const result = await executeReproductionPlan(plan, store);
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
        await reportStage("fixing");

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

        for (const [index, attempt] of (generatedFix.attempts ?? []).entries()) {
          log(
            `Fix proposal attempt ${index + 1}: ${attempt.error ? `rejected - ${attempt.error}` : "ok"}`,
          );
        }

        if (generatedFix.parseError !== null) {
          log(`Fix proposal failed after all attempts: ${generatedFix.parseError}`);
          log(
            `Raw model response (first 600 chars):\n${redactSecrets(generatedFix.rawText.slice(0, 600))}`,
          );
        } else {
          const proposal = generatedFix.parsed as Record<string, unknown>;
          log(`Fix proposal parsed:`);
          log(`  summary: ${String(proposal.summary ?? "(none)")}`);
          log(`  rootCause: ${String(proposal.rootCause ?? "(none)")}`);
          log(
            `  confidence: ${String(proposal.confidence ?? "?")} | risk: ${String(proposal.risk ?? "?")}`,
          );
          if (Array.isArray(proposal.files)) {
            for (const file of proposal.files as { path?: string; edits?: unknown[] }[]) {
              log(`  file: ${file.path ?? "?"} (${file.edits?.length ?? 0} edit(s))`);
            }
          }
        }

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

        await reportStage("verifying");

        fixAttempt = await runFixAttempt({
          investigationId,
          investigationDir: store.dir,
          repoPath,
          sourceCommit: repoContext.commit,
          plan,
          originalOutcome: result.outcome,
          proposal: generatedFix.parsed,
          restart,
          repositoryLabel: `${payload.repoOwner}/${payload.repoName}`,
        });

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
      } catch (error) {
        log(`Fix attempt failed unexpectedly: ${formatError(error)}`);
      }
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
      log(`  terms: ${reflection.issueTerms.join(", ")}`);
      log(`  rootCause: ${fixAttempt?.rootCause ?? reflection.rootCause}`);
      if (reflection.whatWorked) {
        log(`  whatWorked: ${reflection.whatWorked}`);
      }
      if (reflection.whatFailed) {
        log(`  whatFailed: ${reflection.whatFailed}`);
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
          repositoryValidation: fixAttempt.repositoryValidation
            ? fixAttempt.repositoryValidation.categories.map((item) =>
                formatValidationLine(item),
              )
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

    const extraComment =
      [fixComment, pullRequestComment].filter(Boolean).join("\n\n---\n\n") || null;

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

    return await finishInvestigation(
      store,
      investigationRecord,
      summary,
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
