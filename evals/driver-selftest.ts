// Synthetic driver used ONLY to validate harness plumbing (smoke gate) on
// machines without Docker/Playwright/API keys. Runs no model, spends nothing.
// Reports produced with this driver are labelled self-test and are not
// evaluations of any model or policy.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineDriver } from "./run.js";

// Deterministic pseudo-outcomes derived from the task id so repeated
// self-tests are stable.
function hashCode(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function createSelfTestDriver(): PipelineDriver {
  return async (task) => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-selftest-"));
    const reproduced = task.expected.reproduced;
    const fixVerified = task.expected.fixVerified && !task.adversarial;
    const calls = 2 + (hashCode(task.taskId) % 3);

    const records = Array.from({ length: calls }, (_v, index) => ({
      schemaVersion: 1,
      logicalCallId: `selftest_${task.taskId}_${index}`,
      investigationId: `inv_selftest`,
      phase: index === 0 ? "plan" : "fix",
      model: "selftest-model",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      latencyMs: 5,
      attemptCount: 1,
      inputTokens: 1000 + index,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      thinkingTokens: null,
      stopReason: "end_turn",
      estimatedCostUsd: null, // unknown pricing by design => report warning path
    }));

    await writeFile(
      path.join(dir, "inference-records.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    return {
      finalOutcome: fixVerified ? "fix_verified" : reproduced ? "fix_failed" : "not_reproduced",
      reproduced,
      fixVerified,
      failureCode: fixVerified ? null : "selftest_static",
      reproductionPath: reproduced ? "one_shot" : null,
      changedFiles: fixVerified ? ["src/app.js"] : [],
      diffText: fixVerified
        ? "--- a/src/app.js\n+++ b/src/app.js\n-  const ok = false;\n+  const ok = true;\n"
        : null,
      observedFailureEvidence: task.expected.expectedFailureEvidence ?? [],
      artifactDir: dir,
    };
  };
}
