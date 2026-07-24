import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendMemory,
  boundFixDiff,
  findStaleFile,
  findReplayCandidate,
  hashRepoFilesAtCommit,
  loadMemory,
  matchMemory,
  mergeEntriesByTitle,
  renderPastInvestigations,
  selectBlockingFailedAttempts,
  repoKey,
  writeMemorySelectionArtifacts,
  MAX_FAILED_ATTEMPTS_PER_MEMORY_ENTRY,
  MAX_FIX_DIFF_CHARS,
  MAX_RENDERED_PAST_INVESTIGATIONS_BYTES,
  type FailedMemoryAttempt,
  type MemoryEntry,
} from "../backend/services/memory.js";

const execFileAsync = promisify(execFile);

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

describe("direct memory replay eligibility", () => {
  const addNotePlan = {
    version: 1,
    baseUrl: "http://localhost:3000",
    steps: [{ id: "step-1", action: "goto", path: "/" }],
    expectedBehavior: "The added note appears immediately.",
    failureCondition: "The added note stays hidden.",
    assertion: {
      type: "page_text",
      contains: "Buy milk",
      failureWhen: "absent",
    },
  } as MemoryEntry["reproductionPlan"];

  test("does not directly replay a plan from a different issue with overlapping terms", () => {
    const prior: MemoryEntry = {
      ...entry(1),
      issueNumber: 6,
      issueTitle: "New note does not appear after Add",
      issueTerms: ["note", "add", "appear"],
      reproductionPlan: addNotePlan,
    };

    expect(
      findReplayCandidate([prior], 8, "Delete removes the wrong note"),
    ).toBeNull();
    expect(matchMemory([prior], ["delete", "removes", "wrong", "note"])).toContain(prior);
  });

  test("allows replay for the same normalized issue title", () => {
    const prior: MemoryEntry = {
      ...entry(1),
      issueNumber: 8,
      issueTitle: "  New note DOES not appear after Add  ",
      reproductionPlan: addNotePlan,
    };

    expect(
      findReplayCandidate([prior], 8, "new note does not appear after add"),
    ).toBe(prior);
  });

  test("keeps legacy entries without an issue number as context only", () => {
    const prior: MemoryEntry = {
      ...entry(1),
      issueTitle: "New note does not appear after Add",
      reproductionPlan: addNotePlan,
    };

    expect(
      findReplayCandidate([prior], 8, "New note does not appear after Add"),
    ).toBeNull();
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

  test("the exact source commit overrides legacy post-patch hashes", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const original = "const state = 'buggy';\n";
    await writeFile(path.join(repoPath, "server.js"), original);
    await execFileAsync("git", ["init", "--quiet"], { cwd: repoPath });
    await execFileAsync("git", ["add", "server.js"], { cwd: repoPath });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=test@sherlock.dev",
        "-c",
        "user.name=Sherlock Test",
        "commit",
        "--quiet",
        "-m",
        "source",
      ],
      { cwd: repoPath },
    );
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
    });
    const sourceCommit = stdout.trim();
    await writeFile(path.join(repoPath, "server.js"), "const state = 'fixed';\n");

    const legacyEntry: MemoryEntry = {
      ...entry(1),
      commitSha: sourceCommit,
      fileHashes: {
        "server.js": createHash("sha256").update("const state = 'fixed';\n").digest("hex"),
      },
      fixDiff: DIFF,
    };

    expect(await findStaleFile(legacyEntry, repoPath, sourceCommit)).toBeNull();
    const rendered = await renderPastInvestigations(
      [legacyEntry],
      repoPath,
      sourceCommit,
    );
    expect(rendered).not.toContain("[STALE:");

    const sourceHashes = await hashRepoFilesAtCommit(repoPath, sourceCommit, ["server.js"]);
    expect(sourceHashes["server.js"]).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
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

describe("memory selection artifacts", () => {
  test("writes the chosen worked and failed memories into a dedicated folder", async () => {
    const investigationDir = await mkdtemp(path.join(tmpdir(), "sherlock-investigation-"));
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const worked: MemoryEntry = {
      ...entry(1),
      issueTitle: "Archive cache fix",
      issueTerms: ["archive", "cache"],
      outcome: "verified",
      whatWorked: "Invalidating the all cache fixed the replay.",
    };
    const failed: MemoryEntry = {
      ...entry(2),
      issueTitle: "Archive UI-only attempt",
      issueTerms: ["archive"],
      outcome: "failed",
      whatWorked: "",
      whatFailed: "Changing only the UI left the API stale.",
    };
    const rendered = await renderPastInvestigations([worked, failed], repoPath);

    await writeMemorySelectionArtifacts({
      investigationDir,
      queryTerms: ["archive", "cache"],
      storedEntryCount: 8,
      selectedEntries: [worked, failed],
      renderedMemory: rendered,
    });

    const manifest = JSON.parse(
      await readFile(path.join(investigationDir, "memory", "selection.json"), "utf8"),
    ) as {
      selectedEntryCount: number;
      selectionAppliedTo: string[];
      selected: Array<{
        memoryRole: string;
        issueTitle: string;
        outcome: string;
        selectionReason: string;
      }>;
    };
    const renderedArtifact = await readFile(
      path.join(investigationDir, "memory", "rendered.txt"),
      "utf8",
    );

    expect(manifest.selectedEntryCount).toBe(2);
    expect(manifest.selectionAppliedTo).toEqual(["reproducer", "fixer"]);
    expect(manifest.selected).toMatchObject([
      {
        memoryRole: "worked",
        issueTitle: "Archive cache fix",
        outcome: "verified",
        selectionReason: "strongest_match",
      },
      {
        memoryRole: "failed",
        issueTitle: "Archive UI-only attempt",
        outcome: "failed",
        selectionReason: "failed_example",
      },
    ]);
    expect(renderedArtifact).toContain("memory role: WORKED EXAMPLE");
    expect(renderedArtifact).toContain("memory role: FAILED EXAMPLE");
    expect(renderedArtifact.trim()).toBe(rendered);
  });

  test("redacts secrets from both selection artifacts", async () => {
    const investigationDir = await mkdtemp(path.join(tmpdir(), "sherlock-investigation-"));
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const secretEntry: MemoryEntry = {
      ...entry(1),
      rootCause: "Authorization: Bearer sk-super-secret-token",
      whatFailed: "Bearer sk-super-secret-token was logged",
    };
    const rendered = await renderPastInvestigations([secretEntry], repoPath);

    await writeMemorySelectionArtifacts({
      investigationDir,
      queryTerms: ["secret"],
      storedEntryCount: 1,
      selectedEntries: [secretEntry],
      renderedMemory: rendered,
    });

    const artifacts = `${await readFile(
      path.join(investigationDir, "memory", "selection.json"),
      "utf8",
    )}\n${await readFile(path.join(investigationDir, "memory", "rendered.txt"), "utf8")}`;

    expect(artifacts).toContain("[REDACTED]");
    expect(artifacts).not.toContain("sk-super-secret-token");
  });
});

describe("failed-attempt memory", () => {
  test("only the same normalized issue title and source commit can block a patch", () => {
    const matching: MemoryEntry = {
      ...entry(1),
      issueTitle: "  Archive   crashes ",
      commitSha: "source-a",
      failedAttempts: [failedAttempt(1)],
    };
    const differentIssue: MemoryEntry = {
      ...entry(2),
      issueTitle: "Archive cache is stale",
      commitSha: "source-a",
      failedAttempts: [failedAttempt(2)],
    };
    const differentCommit: MemoryEntry = {
      ...entry(3),
      issueTitle: "Archive crashes",
      commitSha: "source-b",
      failedAttempts: [failedAttempt(3)],
    };

    expect(
      selectBlockingFailedAttempts(
        [matching, differentIssue, differentCommit],
        "archive crashes",
        "source-a",
      ).map((attempt) => attempt.proposalHash),
    ).toEqual(["hash-1"]);
  });

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

  test("renders worked and failed lessons separately", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const rendered = await renderPastInvestigations(
      [
        {
          ...entry(1),
          whatWorked: "Invalidating the all-tasks cache fixed the replay.",
          whatFailed: "Invalidating only the completed cache left stale data.",
        },
      ],
      repoPath,
    );

    expect(rendered).toContain("memory role: WORKED EXAMPLE");
    expect(rendered).toContain(
      "what worked: Invalidating the all-tasks cache fixed the replay.",
    );
    expect(rendered).toContain(
      "what failed: Invalidating only the completed cache left stale data.",
    );
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

    // Balanced matching surfaces both investigations: the failure no longer
    // hides the verified fix, and the verified fix no longer hides the
    // failure example.
    const matches = matchMemory([verified, laterFailed], ["archive", "crashes"]);
    expect(matches).toHaveLength(2);
    expect(matches.map((item) => item.outcome)).toEqual(["failed", "verified"]);
  });

  test("reserves a failed example even when verified matches score higher", () => {
    const strongestVerified: MemoryEntry = {
      ...entry(1),
      issueTitle: "Archive task cache stale",
      issueTerms: ["archive", "task", "cache", "stale"],
      outcome: "verified",
    };
    const secondVerified: MemoryEntry = {
      ...entry(2),
      issueTitle: "Archive cache invalidation",
      issueTerms: ["archive", "cache", "invalidation"],
      outcome: "verified",
    };
    const failed: MemoryEntry = {
      ...entry(3),
      issueTitle: "Archive attempt failed",
      issueTerms: ["archive"],
      outcome: "failed",
      whatWorked: "",
      whatFailed: "Changing only the UI did not alter the API response.",
      failedAttempts: [failedAttempt(7)],
    };

    const matches = matchMemory(
      [strongestVerified, secondVerified, failed],
      ["archive", "task", "cache", "stale"],
    );

    expect(matches).toHaveLength(3);
    expect(matches[0]).toBe(strongestVerified);
    expect(matches).toContain(failed);
    expect(matches.some((item) => item.outcome === "verified")).toBe(true);
    expect(matches.some((item) => item.outcome === "failed")).toBe(true);
  });

  test("reserves a verified example when the strongest match is a failure", () => {
    const failed: MemoryEntry = {
      ...entry(1),
      issueTitle: "Login request returns five hundred",
      issueTerms: ["login", "request", "returns", "five", "hundred"],
      outcome: "failed",
      whatWorked: "",
      whatFailed: "Changing the client error message did not fix the handler.",
    };
    const verified: MemoryEntry = {
      ...entry(2),
      issueTitle: "Login handler status",
      issueTerms: ["login", "handler"],
      outcome: "verified",
      whatWorked: "Return 401 from the server handler.",
    };

    const matches = matchMemory(
      [failed, verified],
      ["login", "request", "returns", "five", "hundred"],
    );

    expect(matches.map((item) => item.outcome)).toEqual(["failed", "verified"]);
  });

  test("failedPlans render with hash, commit, and signature; entries without them are unchanged", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-repo-"));
    const withPlans: MemoryEntry = {
      ...entry(1),
      outcome: "failed",
      failedPlans: [
        {
          planHash: "abcd1234efgh5678",
          commitSha: "a1b2c3d4e5f6a7b8",
          replaySignature: "not_reproduced | assertion Expected behavior observed.",
          failureReason: "x".repeat(1_000),
        },
        {
          planHash: "second-hash",
          commitSha: "a1b2c3d4e5f6a7b8",
          replaySignature: null,
          failureReason: "invalid submission",
        },
        {
          planHash: "third-hash-dropped",
          commitSha: "a1b2c3d4e5f6a7b8",
          replaySignature: null,
          failureReason: "over the cap",
        },
      ],
    };

    const rendered = await renderPastInvestigations([withPlans], repoPath);
    const warnings = rendered.match(/REPRODUCTION PLANS ALREADY TRIED/g) ?? [];
    expect(warnings).toHaveLength(2);
    expect(rendered).toContain("plan hash: abcd1234efgh5678 (commit a1b2c3d4)");
    expect(rendered).toContain("replay signature: not_reproduced | assertion Expected behavior observed.");
    expect(rendered).toContain("replay signature: (never replayed: invalid)");
    expect(rendered).not.toContain("third-hash-dropped");
    // Reason byte-bounded.
    expect(rendered).not.toContain("x".repeat(600));

    const plain = await renderPastInvestigations([entry(2)], repoPath);
    expect(plain).not.toContain("REPRODUCTION PLANS ALREADY TRIED");
  });

  test("a newer failed reproduction attaches failedPlans without displacing a verified fix", () => {
    const verified: MemoryEntry = {
      ...entry(1),
      issueTitle: "Archive crashes",
      outcome: "verified",
      fixDiff: "+fixed",
      fileHashes: { "server.js": "vh" },
    };
    const laterFailedRepro: MemoryEntry = {
      ...entry(2),
      issueTitle: "Archive crashes",
      outcome: "failed",
      fileHashes: {},
      failedPlans: [
        {
          planHash: "plan-hash-9",
          commitSha: "commit-9",
          replaySignature: "execution_failed | step step-1",
          failureReason: "replay failed",
        },
      ],
    };

    const merged = mergeEntriesByTitle([verified, laterFailedRepro]).get("Archive crashes");
    expect(merged?.outcome).toBe("verified");
    expect(merged?.fixDiff).toBe("+fixed");
    expect(merged?.fileHashes).toEqual({ "server.js": "vh" });
    expect(merged?.failedPlans?.[0]?.planHash).toBe("plan-hash-9");
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
