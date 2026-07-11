import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendMemory,
  boundFixDiff,
  loadMemory,
  matchMemory,
  mergeEntriesByTitle,
  renderPastInvestigations,
  repoKey,
  MAX_FAILED_ATTEMPTS_PER_MEMORY_ENTRY,
  MAX_FIX_DIFF_CHARS,
  MAX_RENDERED_PAST_INVESTIGATIONS_BYTES,
  type FailedMemoryAttempt,
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

describe("failed-attempt memory", () => {
  const failedAttempt = (n: number, diff: string | null = "diff --git a/x b/x"): FailedMemoryAttempt => ({
    approach: `Approach ${n}`,
    proposalHash: `hash-${n}`,
    diff,
    failureReason: "The exact replay still reproduced the issue.",
    failureSignature: 'reproduced | assertion observed "500"',
  });

  test("old entries without failedAttempts still render", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const rendered = await renderPastInvestigations([entry(1)], repoPath);
    expect(rendered).toContain('PAST: "Issue 1" -> verified');
    expect(rendered).not.toContain("ALREADY TRIED AND FAILED");
  });

  test("renders at most two failed attempts with hash, signature, and reason", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const withFailures: MemoryEntry = {
      ...entry(1),
      outcome: "failed",
      failedAttempts: [failedAttempt(1), failedAttempt(2), failedAttempt(3)],
    };

    const rendered = await renderPastInvestigations([withFailures], repoPath);
    const warnings = rendered.match(/ALREADY TRIED AND FAILED/g) ?? [];
    expect(warnings).toHaveLength(MAX_FAILED_ATTEMPTS_PER_MEMORY_ENTRY);
    expect(rendered).toContain("proposal hash: hash-1");
    expect(rendered).toContain('failure signature: reproduced | assertion observed "500"');
    expect(rendered).toContain("why it failed: The exact replay still reproduced the issue.");
    expect(rendered).toContain("diff --git a/x b/x");
  });

  test("a missing diff renders truthfully", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const withFailures: MemoryEntry = {
      ...entry(1),
      outcome: "failed",
      failedAttempts: [failedAttempt(1, null)],
    };

    const rendered = await renderPastInvestigations([withFailures], repoPath);
    expect(rendered).toContain("(diff unavailable; patch did not reach application)");
  });

  test("aggregate rendering obeys the byte cap, dropping diff bodies first", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const bigDiff = `diff --git a/big b/big\n${"+x".repeat(10_000)}`;
    const entries: MemoryEntry[] = [1, 2, 3].map((n) => ({
      ...entry(n),
      fixDiff: bigDiff,
      failedAttempts: [
        { ...failedAttempt(n), diff: bigDiff },
        { ...failedAttempt(n + 10), diff: bigDiff },
      ],
    }));

    const rendered = await renderPastInvestigations(entries, repoPath);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
      MAX_RENDERED_PAST_INVESTIGATIONS_BYTES,
    );
    expect(rendered).toContain("[MEMORY RENDER TRUNCATED");
    // Headers and signatures survive.
    expect(rendered).toContain('PAST: "Issue 1"');
    expect(rendered).toContain('PAST: "Issue 3"');
    expect(rendered).toContain("failure signature:");
  });

  test("redacts secrets in failed-attempt reasons and signatures", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const withFailures: MemoryEntry = {
      ...entry(1),
      outcome: "failed",
      failedAttempts: [
        {
          ...failedAttempt(1),
          failureReason: "Authorization: Bearer sk-super-secret-token",
          failureSignature: "GET /api -> Bearer sk-super-secret-token",
        },
      ],
    };

    const rendered = await renderPastInvestigations([withFailures], repoPath);
    expect(rendered).toContain("[REDACTED]");
    expect(rendered).not.toContain("sk-super-secret-token");
  });

  test("a newer failed run does not hide an older verified fix for the same title", () => {
    const verified: MemoryEntry = {
      ...entry(1),
      issueTitle: "Archive crashes",
      outcome: "verified",
      fixDiff: "diff --git a/server.js b/server.js\n+fixed",
      fileHashes: { "server.js": "verified-hash" },
      createdAt: new Date(1000).toISOString(),
    };
    const laterFailed: MemoryEntry = {
      ...entry(2),
      issueTitle: "Archive crashes",
      outcome: "failed",
      fileHashes: {},
      failedAttempts: [failedAttempt(9)],
      createdAt: new Date(2000).toISOString(),
    };

    const merged = mergeEntriesByTitle([verified, laterFailed]).get("Archive crashes");
    expect(merged?.outcome).toBe("verified");
    expect(merged?.fixDiff).toContain("+fixed");
    // Staleness hashes stay with the verified fix.
    expect(merged?.fileHashes).toEqual({ "server.js": "verified-hash" });
    // Newer failed attempts are attached.
    expect(merged?.failedAttempts?.[0]?.proposalHash).toBe("hash-9");

    // And matchMemory surfaces the merged entry.
    const matches = matchMemory([verified, laterFailed], ["archive", "crashes"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].outcome).toBe("verified");
  });

  test("no verified entry means the newest entry wins unchanged", () => {
    const older: MemoryEntry = { ...entry(1), issueTitle: "X", outcome: "failed" };
    const newer: MemoryEntry = {
      ...entry(2),
      issueTitle: "X",
      outcome: "blocked",
      failedAttempts: [failedAttempt(5)],
    };

    const merged = mergeEntriesByTitle([older, newer]).get("X");
    expect(merged?.outcome).toBe("blocked");
    expect(merged?.failedAttempts?.[0]?.proposalHash).toBe("hash-5");
  });
});
