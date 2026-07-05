// creates a temp clone of repo, extracting important files that claude can analyze

import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_TREE_ENTRIES = 120;
const MAX_SOURCE_FILE_CHARS = 8_000;

const IMPORTANT_SOURCE_FILES = [
  "server.js",
  "server.ts",
  "app.js",
  "app.ts",
  "index.js",
  "index.ts",
  "src/App.tsx",
  "src/App.jsx",
  "src/App.ts",
  "src/App.js",
  "src/main.tsx",
  "src/main.jsx",
  "src/index.tsx",
  "src/index.jsx",
  "src/index.ts",
  "src/index.js",
  "app/page.tsx",
  "app/layout.tsx",
  "pages/index.tsx",
  "pages/index.jsx",
  "pages/index.ts",
  "pages/index.js",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.js",
  "tsconfig.json",
];

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

export type RepoContext = {
  workspacePath: string;
  repoPath: string;
  commit: string;
  fileTree: string[];
  packageJson: string | null;
  readme: string | null;
  sourceFiles: SourceFile[];
};

export type SourceFile = {
  path: string;
  contents: string;
  truncated: boolean;
};

// combine all functions and actually clone repo
export async function cloneRepoForInvestigation(input: {
  repoUrl: string;
  defaultBranch?: string;
}): Promise<RepoContext> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "handoff-"));
  const repoPath = path.join(workspacePath, "repo");

  try {
    await cloneRepo(input.repoUrl, repoPath, input.defaultBranch);
    await writeRepoExcludes(repoPath);

    return {
      workspacePath,
      repoPath,
      commit: await getHeadCommit(repoPath),
      fileTree: await collectFileTree(repoPath),
      packageJson: await safeRead(path.join(repoPath, "package.json")),
      readme: await readFirstExisting(repoPath, [
        "README.md",
        "readme.md",
        "README.txt",
      ]),
      sourceFiles: await collectSourceFiles(repoPath),
    };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

// cleanup function to remove cloned repo after investigation is done
export async function cleanupRepoContext(context: RepoContext) {
  await rm(context.workspacePath, { recursive: true, force: true });
}

// start collecting file paths but stop if too many
async function collectFileTree(repoPath: string) {
  const entries: string[] = [];

  async function walk(currentPath: string, relativePath = "") {
    if (entries.length >= MAX_TREE_ENTRIES) {
      return;
    }

    const dirEntries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of dirEntries) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        return;
      }

      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      const nextRelativePath = relativePath
        ? path.join(relativePath, entry.name)
        : entry.name;

      entries.push(nextRelativePath);

      if (entry.isDirectory()) {
        await walk(path.join(currentPath, entry.name), nextRelativePath);
      }
    }
  }

  await walk(repoPath);
  return entries;
}

async function collectSourceFiles(repoPath: string) {
  const files: SourceFile[] = [];

  for (const relativePath of IMPORTANT_SOURCE_FILES) {
    const contents = await safeRead(path.join(repoPath, relativePath));

    if (contents === null) {
      continue;
    }

    files.push({
      path: relativePath,
      contents: contents.slice(0, MAX_SOURCE_FILE_CHARS),
      truncated: contents.length > MAX_SOURCE_FILE_CHARS,
    });
  }

  return files;
}

async function cloneRepo(
  repoUrl: string,
  repoPath: string,
  defaultBranch?: string,
) {
  if (defaultBranch) {
    try {
      await runGitClone([
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        defaultBranch,
        repoUrl,
        repoPath,
      ]);
      return;
    } catch {
      console.warn(
        `Could not clone branch "${defaultBranch}". Falling back to repository default branch.`,
      );
    }
  }

  await runGitClone(["clone", "--depth", "1", repoUrl, repoPath]);
}

// Sherlock's own tooling (graphify extract, npm install in the sandbox)
// creates untracked directories inside the clone. Target repos without a
// .gitignore would then fail the fix loop's workspace_clean precondition.
// .git/info/exclude is repo-local ignoring that never touches the working
// tree, so the cleanliness check stays strict for anything unexpected.
const INVESTIGATION_EXCLUDES = [
  "node_modules/",
  "graphify-out/",
  "dist/",
  "build/",
  ".next/",
  ".cache/",
  ".turbo/",
  "coverage/",
];

async function writeRepoExcludes(repoPath: string) {
  const excludePath = path.join(repoPath, ".git", "info", "exclude");

  try {
    await mkdir(path.dirname(excludePath), { recursive: true });
    await appendFile(
      excludePath,
      `\n# Added by Sherlock (investigation tooling artifacts)\n${INVESTIGATION_EXCLUDES.join("\n")}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn(
      `Could not write .git/info/exclude for ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getHeadCommit(repoPath: string) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    timeout: 10_000,
  });

  return stdout.trim();
}

async function runGitClone(args: string[]) {
  await execFileAsync("git", args, {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

// read files that claude will analyze, returning null if they don't exist or cant be read
async function readFirstExisting(repoPath: string, fileNames: string[]) {
  for (const fileName of fileNames) {
    const contents = await safeRead(path.join(repoPath, fileName));

    if (contents !== null) {
      return contents;
    }
  }

  return null;
}

async function safeRead(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
