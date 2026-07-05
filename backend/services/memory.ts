// Per-repo investigation memory. Append-only memory.json stored OUTSIDE the
// cloned repo (the graph is regenerated per commit; memory must survive).
// Contract: docs/fable/08-memory-prompt.md

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const MAX_MATCHES = 3;

export type MemoryOutcome =
  | "verified"
  | "blocked"
  | "failed"
  | "analysis_complete";

export type MemoryEntry = {
  issueTitle: string;
  issueTerms: string[];
  commitSha: string;
  outcome: MemoryOutcome;
  rootCause: string;
  patchedFiles: string[];
  // Content hashes of patchedFiles at record time, used for staleness checks
  // (shallow clones cannot diff against old commits).
  fileHashes: Record<string, string>;
  whatWorked: string;
  whatFailed: string;
  createdAt: string;
};

export function dataDir(): string {
  return process.env.SHERLOCK_DATA_DIR ?? path.join(homedir(), ".sherlock");
}

export function repoKey(repoUrl: string): string {
  return createHash("sha1").update(repoUrl).digest("hex").slice(0, 16);
}

function memoryPath(repoUrl: string): string {
  return path.join(dataDir(), "memory", `${repoKey(repoUrl)}.json`);
}

export async function loadMemory(repoUrl: string): Promise<MemoryEntry[]> {
  try {
    const raw = await readFile(memoryPath(repoUrl), "utf8");
    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed) ? (parsed as MemoryEntry[]) : [];
  } catch {
    return [];
  }
}

export async function appendMemory(repoUrl: string, entry: MemoryEntry) {
  const entries = await loadMemory(repoUrl);
  entries.push(entry);

  await mkdir(path.dirname(memoryPath(repoUrl)), { recursive: true });
  await writeFile(memoryPath(repoUrl), JSON.stringify(entries, null, 2));
}

// Top matches by issue-term overlap. Zero-overlap entries are excluded -
// an empty result means the PAST INVESTIGATIONS section is omitted entirely.
// Stored terms and the stored issue title are re-tokenized before comparison
// so multi-word terms (e.g. "active filter") still match single-word tokens.
export function matchMemory(
  entries: MemoryEntry[],
  issueTerms: string[],
): MemoryEntry[] {
  const terms = new Set(issueTerms);

  // Reruns of the same issue append near-identical entries; keep only the
  // newest per issue title so the top matches stay diverse and reflect the
  // latest outcome. Entries are appended chronologically.
  const newestByTitle = new Map<string, MemoryEntry>();

  for (const entry of entries) {
    newestByTitle.set(entry.issueTitle, entry);
  }

  return [...newestByTitle.values()]
    .map((entry) => ({
      entry,
      score: overlapScore(entry, terms),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES)
    .map(({ entry }) => entry);
}

function overlapScore(entry: MemoryEntry, terms: Set<string>): number {
  const entryTokens = new Set([
    ...entry.issueTerms.flatMap(splitTokens),
    ...splitTokens(entry.issueTitle),
  ]);

  let score = 0;

  for (const token of entryTokens) {
    if (terms.has(token)) {
      score += 1;
    }
  }

  return score;
}

function splitTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 3);
}

export async function renderPastInvestigations(
  entries: MemoryEntry[],
  repoPath: string,
): Promise<string> {
  const blocks: string[] = [];

  for (const entry of entries) {
    const lines = [
      `PAST: "${entry.issueTitle}" -> ${entry.outcome}`,
      `  root cause: ${entry.rootCause || "(not recorded)"}`,
      `  patched: ${entry.patchedFiles.join(", ") || "(none)"}`,
      `  lesson: ${entry.whatWorked || entry.whatFailed || "(none recorded)"}`,
    ];

    const staleFile = await findStaleFile(entry, repoPath);

    if (staleFile) {
      lines.push(
        `  [STALE: ${staleFile} changed since this fix - re-verify before trusting]`,
      );
    }

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}

async function findStaleFile(
  entry: MemoryEntry,
  repoPath: string,
): Promise<string | null> {
  for (const file of entry.patchedFiles) {
    const recorded = entry.fileHashes[file];
    const current = await hashFile(path.join(repoPath, file));

    if (current === null) {
      return file; // file no longer exists
    }

    if (recorded && recorded !== current) {
      return file;
    }
  }

  return null;
}

export async function hashRepoFiles(
  repoPath: string,
  files: string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};

  for (const file of files) {
    const hash = await hashFile(path.join(repoPath, file));

    if (hash !== null) {
      hashes[file] = hash;
    }
  }

  return hashes;
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    const contents = await readFile(filePath);

    return createHash("sha256").update(contents).digest("hex");
  } catch {
    return null;
  }
}
