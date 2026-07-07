// Runtime workspace copies for untrusted target code.
//
// The investigation clone is the trusted Git workspace used for Graphify,
// patching, diffing, committing, and PR creation. Target install/start/test
// commands run against short-lived copies that deliberately exclude .git, so
// target code cannot mutate Git metadata that Sherlock later trusts.

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const EXCLUDED_RUNTIME_DIRS = new Set([".git"]);

export type RuntimeWorkspace = {
  path: string;
  cleanup: () => Promise<void>;
};

export async function createRuntimeWorkspace(
  trustedRepoPath: string,
): Promise<RuntimeWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "sherlock-runtime-"));
  const runtimePath = path.join(root, "repo");

  await cp(trustedRepoPath, runtimePath, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !isExcludedRuntimePath(trustedRepoPath, source),
  });

  return {
    path: runtimePath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function isExcludedRuntimePath(repoPath: string, sourcePath: string): boolean {
  const relative = path.relative(repoPath, sourcePath);

  if (!relative) {
    return false;
  }

  return relative
    .split(path.sep)
    .some((segment) => EXCLUDED_RUNTIME_DIRS.has(segment));
}
