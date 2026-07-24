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
import {
  buildGitHubCloneUrl,
  createGitAuthContext,
  preflightRepositoryAccess,
  redactGitFailure,
  RepositoryError,
  type GitHubApiClient,
  type InstallationTokenPermissions,
} from "./repo-auth.js";

const execFileAsync = promisify(execFile);

// Injectable Git-process boundary (argument arrays only — never a shell).
export type GitRunner = (
  args: string[],
  options: { env?: Record<string, string>; cwd?: string },
) => Promise<{ stdout: string }>;

const defaultGitRunner: GitRunner = async (args, options) => {
  const { stdout } = await execFileAsync("git", args, {
    env: options.env,
    cwd: options.cwd,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  return { stdout };
};

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

// Clones the repository identified by the VALIDATED owner/name (never a
// webhook-supplied URL) and extracts bounded context. When an installation
// token is provided, access is preflighted against the GitHub API first and
// the clone authenticates through a temporary GIT_ASKPASS helper; the token
// never appears in URLs, argv, configuration, metadata, or errors.
export async function cloneRepoForInvestigation(input: {
  repoOwner: string;
  repoName: string;
  defaultBranch?: string;
  targetCommitSha?: string;
  installationToken?: string | null;
  // Permission metadata from the token-minting response (authoritative for
  // the token's Contents access).
  installationPermissions?: InstallationTokenPermissions;
  github?: GitHubApiClient;
  runGit?: GitRunner;
}): Promise<RepoContext> {
  // Throws a typed invalid_identity error for anything that is not a plain
  // GitHub owner/repository pair (traversal, slashes, queries, schemes, ...).
  const cloneUrl = buildGitHubCloneUrl(input.repoOwner, input.repoName);
  const token = input.installationToken ?? null;

  // Access preflight happens before any credential-helper file exists and
  // before Git starts.
  if (token) {
    await preflightRepositoryAccess(
      input.repoOwner,
      input.repoName,
      token,
      input.github,
      input.installationPermissions ?? null,
    );
  }

  const runGit = input.runGit ?? defaultGitRunner;
  const workspacePath = await mkdtemp(path.join(tmpdir(), "handoff-"));
  const repoPath = path.join(workspacePath, "repo");

  try {
    await cloneRepo(cloneUrl, repoPath, input.defaultBranch, token, runGit);

    // The origin remote must contain only the clean unauthenticated GitHub
    // URL; the askpass mechanism never touches the URL, and this pins it.
    await runGit(["remote", "set-url", "origin", cloneUrl], { cwd: repoPath });
    const origin = (
      await runGit(["remote", "get-url", "origin"], { cwd: repoPath })
    ).stdout.trim();

    if (origin !== cloneUrl) {
      throw new RepositoryError(
        "transient_clone",
        "The cloned repository's origin URL did not match the expected GitHub URL.",
        true,
      );
    }

    const commit = await getHeadCommit(repoPath);
    if (input.targetCommitSha) {
      if (!/^[0-9a-f]{40}$/i.test(input.targetCommitSha)) {
        throw new RepositoryError(
          "invalid_identity",
          "The requested target commit must be a full 40-character Git SHA.",
          false,
        );
      }
      if (commit.toLowerCase() !== input.targetCommitSha.toLowerCase()) {
        throw new RepositoryError(
          "invalid_identity",
          `The cloned branch resolved to ${commit}, not the pinned eval commit ${input.targetCommitSha}. Refusing to evaluate a different revision.`,
          false,
        );
      }
    }

    await writeRepoExcludes(repoPath);

    return {
      workspacePath,
      repoPath,
      commit,
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

// Base flags for every clone: no credential forwarding across redirects and
// no configured credential helpers, passed per-process (never persisted).
const CLONE_CONFIG_ARGS = [
  "-c",
  "http.followRedirects=false",
  "-c",
  "credential.helper=",
];

async function cloneRepo(
  cloneUrl: string,
  repoPath: string,
  defaultBranch: string | undefined,
  token: string | null,
  runGit: GitRunner,
) {
  // Authentication lives ONLY in the Git child-process environment: an
  // askpass helper (containing no token) plus the token variable. The URL
  // and argv stay credential-free.
  const auth = token ? await createGitAuthContext(token) : null;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_TERMINAL_PROMPT: "0",
    // Host git configuration is fully disabled for the clone child process:
    // no global/system config means no host credential helpers, rewrites,
    // or redirect settings can participate in an authenticated clone.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...(auth?.env ?? {}),
  };

  try {
    if (defaultBranch) {
      try {
        await runGit(
          [
            ...CLONE_CONFIG_ARGS,
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            defaultBranch,
            cloneUrl,
            repoPath,
          ],
          { env },
        );
        return;
      } catch {
        console.warn(
          `Could not clone branch "${defaultBranch}". Falling back to repository default branch.`,
        );
      }
    }

    try {
      await runGit(
        [...CLONE_CONFIG_ARGS, "clone", "--depth", "1", cloneUrl, repoPath],
        { env },
      );
    } catch (error) {
      throw classifyCloneFailure(error, token);
    }
  } finally {
    // Credential-helper directory is removed on success and failure alike;
    // after this, no reference to the auth environment remains.
    await auth?.cleanup();
  }
}

// Post-preflight clone failures are treated as transient transport failures
// (retryable via BullMQ): identity, access, permission, and credential
// problems were already ruled out by the typed preflight. Diagnostics are
// scrubbed of anything credential-adjacent before leaving this module.
function classifyCloneFailure(error: unknown, token: string | null): RepositoryError {
  if (error instanceof RepositoryError) {
    return error;
  }

  const raw = error as Error & { stderr?: string | Buffer };
  const detail = [raw?.message ?? String(error), raw?.stderr?.toString() ?? ""]
    .filter(Boolean)
    .join("\n");

  return new RepositoryError(
    "transient_clone",
    `git clone failed: ${redactGitFailure(detail, token).slice(0, 600)}`,
    true,
  );
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
