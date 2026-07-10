import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendMemory,
  boundFixDiff,
  loadMemory,
  renderPastInvestigations,
  repoKey,
  MAX_FIX_DIFF_CHARS,
  type MemoryEntry,
} from "../backend/services/memory.js";

const previousDataDir = process.env.SHERLOCK_DATA_DIR;
const previousMaxEntries = process.env.SHERLOCK_MAX_MEMORY_ENTRIES;

afterEach(() => {
  process.env.SHERLOCK_DATA_DIR = previousDataDir;
  process.env.SHERLOCK_MAX_MEMORY_ENTRIES = previousMaxEntries;
});

function entry(index: number): MemoryEntry {
  return {
    issueTitle: `Issue ${index}`,
    issueTerms: [`issue-${index}`],
    commitSha: `commit-${index}`,
    outcome: "verified",
    rootCause: "root cause",
    patchedFiles: ["server.js"],
    fileHashes: {},
    whatWorked: "worked",
    whatFailed: "",
    createdAt: new Date(index).toISOString(),
  };
}

describe("appendMemory", () => {
  test("serializes concurrent appends and caps the newest entries", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "sherlock-memory-"));
    const repoUrl = "https://github.com/acme/app";
    process.env.SHERLOCK_DATA_DIR = dataDir;
    process.env.SHERLOCK_MAX_MEMORY_ENTRIES = "5";

    await Promise.all(Array.from({ length: 12 }, (_, index) => appendMemory(repoUrl, entry(index))));

    const entries = await loadMemory(repoUrl);
    expect(entries).toHaveLength(5);
    expect(entries.map((item) => item.issueTitle)).toEqual([
      "Issue 7",
      "Issue 8",
      "Issue 9",
      "Issue 10",
      "Issue 11",
    ]);

    const raw = await readFile(
      path.join(dataDir, "memory", `${repoKey(repoUrl)}.json`),
      "utf8",
    );
    expect(JSON.parse(raw)).toHaveLength(5);
  });
});

describe("renderPastInvestigations fix diffs", () => {
  const DIFF = "diff --git a/server.js b/server.js\n-  bad\n+  good";

  test("renders the verified fix diff as reapplyable when patched files are unchanged", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const contents = "const x = 1;";
    await writeFile(path.join(repoPath, "server.js"), contents);

    const withDiff: MemoryEntry = {
      ...entry(1),
      fileHashes: {
        "server.js": createHash("sha256").update(contents).digest("hex"),
      },
      fixDiff: DIFF,
    };

    const rendered = await renderPastInvestigations([withDiff], repoPath);
    expect(rendered).toContain("verified fix diff (patched files are UNCHANGED");
    expect(rendered).toContain("+  good");
    expect(rendered).not.toContain("[STALE:");
  });

  test("marks the diff stale when the patched file changed", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    await writeFile(path.join(repoPath, "server.js"), "changed since the fix");

    const withDiff: MemoryEntry = {
      ...entry(1),
      fileHashes: { "server.js": "not-the-current-hash" },
      fixDiff: DIFF,
    };

    const rendered = await renderPastInvestigations([withDiff], repoPath);
    expect(rendered).toContain("[STALE: server.js changed since this fix");
    expect(rendered).toContain("verified fix diff (STALE");
  });

  test("entries without a diff render as before", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const rendered = await renderPastInvestigations([entry(1)], repoPath);
    expect(rendered).not.toContain("verified fix diff");
  });

  test("boundFixDiff truncates oversized diffs", () => {
    const bounded = boundFixDiff("x".repeat(MAX_FIX_DIFF_CHARS + 500));
    expect(bounded).toContain("[FIX DIFF TRUNCATED]");
    expect(bounded.length).toBeLessThan(MAX_FIX_DIFF_CHARS + 100);
  });
});
