import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendMemory, loadMemory, repoKey, type MemoryEntry } from "../backend/services/memory.js";

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
