// Applies fixer patches to the cloned repo. Deterministic by design:
// every "find" must match the target file exactly once, or the whole patch
// is rejected before any file is written.
// Contract: docs/fable/09-graphify-fixer-prompt.md

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FixPatchEdit } from "./claude.js";

const execFileAsync = promisify(execFile);

export type AppliedPatch = {
  patchedFiles: string[];
  diff: string;
};

export async function applyPatch(
  repoPath: string,
  edits: FixPatchEdit[],
): Promise<AppliedPatch> {
  const resolvedRepo = path.resolve(repoPath);

  // Validate every edit before writing anything.
  const planned: { resolved: string; relative: string; edit: FixPatchEdit }[] =
    [];

  for (const edit of edits) {
    const relative = edit.path.replace(/^\.\//, "");
    const resolved = path.resolve(resolvedRepo, relative);

    if (!resolved.startsWith(resolvedRepo + path.sep)) {
      throw new Error(`Patch rejected: path escapes repo: ${edit.path}`);
    }

    const contents = await readFile(resolved, "utf8").catch(() => null);

    if (contents === null) {
      throw new Error(`Patch rejected: file not found: ${relative}`);
    }

    const matches = contents.split(edit.find).length - 1;

    if (matches === 0) {
      throw new Error(
        `Patch rejected: "find" not present in ${relative} (must match exactly once).`,
      );
    }

    if (matches > 1) {
      throw new Error(
        `Patch rejected: "find" matches ${matches} times in ${relative} (must match exactly once).`,
      );
    }

    planned.push({ resolved, relative, edit });
  }

  // All edits validated - apply them.
  for (const { resolved, edit } of planned) {
    const contents = await readFile(resolved, "utf8");
    await writeFile(resolved, contents.replace(edit.find, edit.replace));
  }

  const diff = await gitDiff(resolvedRepo);

  return {
    patchedFiles: [...new Set(planned.map(({ relative }) => relative))],
    diff,
  };
}

async function gitDiff(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff"], {
      cwd: repoPath,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    return stdout;
  } catch {
    return "(git diff unavailable)";
  }
}
