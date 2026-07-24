// Real-pipeline eval driver. Runs runInvestigationPipeline() with the eval
// policy mapped into pipeline options. Requires the dev host: Docker,
// Playwright browsers, and ANTHROPIC_API_KEY. Delivery side effects cannot
// occur — the execution pipeline never calls GitHub delivery APIs, this
// driver never invokes the delivery stage, and no installation token is
// provided, so pushes/PRs are impossible by construction.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DriverResult, PipelineDriver } from "./run.js";
import type { EvalPolicyConfig, EvalTask } from "./types.js";

export function createRealDriver(): PipelineDriver {
  return async (task: EvalTask, policy: EvalPolicyConfig, context): Promise<DriverResult> => {
    if (task.source.kind !== "authorized_remote") {
      throw new Error(
        `driver "real" currently supports authorized_remote tasks; got "${task.source.kind}" (wire a fixture cloneRepo before using local_fixture tasks)`,
      );
    }
    if (task.environment.network !== "allowlisted") {
      throw new Error(
        'driver "real" requires environment.network="allowlisted"; remote cloning cannot satisfy a disabled-network contract',
      );
    }
    if (
      (task.environment.setupCommands?.length ?? 0) > 0 ||
      (task.environment.requiredServices?.length ?? 0) > 0 ||
      (task.environment.fixtures?.length ?? 0) > 0
    ) {
      throw new Error(
        'driver "real" does not yet provision setupCommands, requiredServices, or fixtures; refusing to silently ignore the task contract',
      );
    }

    // Lazy import: keeps the CLI usable (selftest, --help) on machines
    // without the pipeline's runtime dependencies.
    const { runInvestigationPipeline } = await import("../backend/services/investigation.js");

    const result = await runInvestigationPipeline(
      {
        repoOwner: task.source.repoOwner,
        repoName: task.source.repoName,
        repoUrl:
          task.source.repoUrl ??
          `https://github.com/${task.source.repoOwner}/${task.source.repoName}`,
        defaultBranch: task.source.defaultBranch,
        targetCommitSha: task.source.commitSha,
        issueNumber: task.issue.number ?? 0,
        issueTitle: task.issue.title,
        issueBody: task.issue.body,
        triggeredBy: "eval-harness",
        // No installation token: eval targets must be public. Delivery
        // credentials are never provided to eval runs.
        installationToken: null,
        installationPermissions: null,
      },
      {
        signal: AbortSignal.timeout(context.timeoutMs),
        policy: {
          budgetProfile: policy.budgetProfile,
          compaction: policy.compaction,
          parallelReads: policy.parallelReads,
          inference: policy.inference,
          inferenceBudgetGuard: context.budgetGuard,
        },
      },
    );

    // Outcome semantics (investigation.ts resolveFinalOutcome): terminal
    // outcome is "verified_fix" | "reproduced" | "not_reproduced" |
    // "plan_failed" | "execution_failed" | "environment_failed".
    const outcome = result.outcome;
    const fixVerified = outcome === "verified_fix" || result.fixAttempt?.outcome === "verified";
    const reproduced = fixVerified || outcome === "reproduced";
    const artifactDir = result.artifactsDir ?? null;

    if (fixVerified && task.environment.testCommands.length > 0) {
      const executed = new Set(result.fixAttempt?.testRuns.map((run) => run.command) ?? []);
      const missing = task.environment.testCommands.filter((command) => !executed.has(command));
      if (missing.length > 0) {
        throw new Error(
          `task validation contract was not executed: ${missing.join(", ")}`,
        );
      }
    }

    let diffText: string | null = null;

    if (result.fixAttempt?.attemptDir) {
      diffText = await readFile(
        path.join(result.fixAttempt.attemptDir, "git-diff.patch"),
        "utf8",
      ).catch(() => null);
    }

    return {
      finalOutcome: outcome,
      reproduced,
      fixVerified,
      failureCode: null, // per-agent failure codes live in artifacts; see cost-shape.json
      reproductionPath: null,
      changedFiles: result.fixAttempt?.changedFiles ?? [],
      diffText,
      observedFailureEvidence: [
        result.summary.error ?? "",
        result.result?.outcomeReason ?? "",
        result.result?.assertion?.detail ?? "",
      ].filter(Boolean),
      artifactDir,
    };
  };
}
