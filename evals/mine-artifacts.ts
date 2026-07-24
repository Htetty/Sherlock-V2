// Artifact mining — CANDIDATE MANIFEST ONLY (Phase 0.2, data-governance gate).
//
// This tool reads historical investigation artifacts and emits a REDACTED
// candidate manifest of metadata + short summaries. It deliberately does NOT:
//   - emit raw issue bodies, source excerpts, diffs, logs, or prompts;
//   - produce eval tasks or gold labels;
//   - write anything into evals/tasks/.
//
// A human must review the manifest, confirm per-repository authorization, and
// author reviewed task files separately. Historical pipeline "success" means
// an old assertion passed — it is NOT evidence the fix was correct.

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { redactSecrets } from "../backend/services/report.js";

export type CandidateManifestEntry = {
  investigationId: string;
  repositoryFingerprint: string | null;
  commit: string | null;
  outcome: string | null;
  // Short, redacted, length-bounded — enough for a reviewer to triage, never
  // the full content.
  issueTitleRedacted: string | null;
  createdAt: string | null;
  hasReproductionPlan: boolean;
  hasVerifiedFix: boolean;
  // Reviewer must fill these before the entry can become a task.
  authorizationStatus: "unknown";
  redactionStatus: "pending";
  humanReviewed: false;
};

const MAX_TITLE_CHARS = 120;

function boundedRedact(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return redactSecrets(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/(^|\s)@[A-Za-z0-9_-]+/g, "$1[REDACTED_HANDLE]")
    .slice(0, MAX_TITLE_CHARS);
}

export async function buildCandidateManifest(
  artifactsDir: string,
  options: { allowedRepositories: ReadonlySet<string> },
): Promise<CandidateManifestEntry[]> {
  const entries: CandidateManifestEntry[] = [];

  let ids: string[];
  try {
    ids = (await readdir(artifactsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("inv_"))
      .map((entry) => entry.name);
  } catch {
    return entries;
  }

  for (const id of ids) {
    const dir = path.join(artifactsDir, id);
    let investigation: Record<string, unknown> = {};
    try {
      investigation = JSON.parse(await readFile(path.join(dir, "investigation.json"), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // No investigation.json: still record the id so the reviewer sees it.
    }

    const files = await readdir(dir).catch(() => [] as string[]);
    const repoUrl = typeof investigation.repoUrl === "string" ? investigation.repoUrl : null;
    if (!repoUrl || !options.allowedRepositories.has(repoUrl)) {
      continue;
    }

    entries.push({
      investigationId: id,
      repositoryFingerprint: createHash("sha256").update(repoUrl).digest("hex"),
      commit: typeof investigation.commit === "string" ? investigation.commit : null,
      outcome: typeof investigation.outcome === "string" ? investigation.outcome : null,
      issueTitleRedacted: boundedRedact(investigation.issueTitle),
      createdAt: typeof investigation.createdAt === "string" ? investigation.createdAt : null,
      hasReproductionPlan: files.includes("reproduction-plan.json"),
      hasVerifiedFix: investigation.outcome === "verified_fix",
      authorizationStatus: "unknown",
      redactionStatus: "pending",
      humanReviewed: false,
    });
  }

  return entries.sort((a, b) => a.investigationId.localeCompare(b.investigationId));
}
