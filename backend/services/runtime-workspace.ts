// Runtime workspace copies for untrusted target code.
//
// The investigation clone is the trusted Git workspace used for Graphify,
// patching, diffing, committing, and PR creation. Target install/start/test
// commands run against short-lived copies that deliberately exclude .git, so
// target code cannot mutate Git metadata that Sherlock later trusts.
//
// Ownership: target containers run as the unprivileged `node` user (see
// CONTAINER_DEFAULTS in container.ts) and must be able to write the mounted
// workspace (npm install, builds, patch verification). A containerized
// production worker runs as root, so on a Linux daemon the copied files
// arrive root-owned and the target user gets EACCES — macOS Docker Desktop
// masks this with its permissive file sharing. The fix is ownership, not
// permissions: when the worker runs as root the copy is chowned to the
// target container uid/gid (never a broad chmod), using lchown so symlinks
// shipped by the target repository are never followed onto host files.

import { cp, lchown, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const EXCLUDED_RUNTIME_DIRS = new Set([".git"]);

// uid/gid of the `node` user in the official node images used for target
// containers. Overridable for custom SHERLOCK_TARGET_IMAGE values whose
// unprivileged user differs.
const DEFAULT_TARGET_UID = 1000;
const DEFAULT_TARGET_GID = 1000;

export type WorkspaceOwner = { uid: number; gid: number };

// The owner the runtime copy must have so the target container user can
// write it, or null when no chown is needed or possible: a non-root worker
// cannot chown to another uid, and in that mode (local development, host-run
// worker) Docker Desktop's file sharing already maps ownership.
export function resolveWorkspaceOwner(
  env: NodeJS.ProcessEnv = process.env,
  currentUid: number | null = typeof process.getuid === "function"
    ? process.getuid()
    : null,
): WorkspaceOwner | null {
  if (currentUid !== 0) {
    return null;
  }

  return {
    uid: parsePosixId(env.SHERLOCK_TARGET_UID) ?? DEFAULT_TARGET_UID,
    gid: parsePosixId(env.SHERLOCK_TARGET_GID) ?? DEFAULT_TARGET_GID,
  };
}

function parsePosixId(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }

  const id = Number(value);

  return Number.isInteger(id) && id >= 0 ? id : null;
}

export type RuntimeWorkspace = {
  path: string;
  cleanup: () => Promise<void>;
};

export async function createRuntimeWorkspace(
  trustedRepoPath: string,
  options: {
    owner?: WorkspaceOwner | null;
    chown?: (target: string, uid: number, gid: number) => Promise<void>;
  } = {},
): Promise<RuntimeWorkspace> {
  const owner = options.owner === undefined ? resolveWorkspaceOwner() : options.owner;
  const chown = options.chown ?? ((target, uid, gid) => lchown(target, uid, gid));
  const root = await mkdtemp(path.join(process.env.SHERLOCK_HOST_TMP ?? tmpdir(), "sherlock-runtime-"));
  const runtimePath = path.join(root, "repo");
  const cleanup = () => rm(root, { recursive: true, force: true });

  try {
    await cp(trustedRepoPath, runtimePath, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => !isExcludedRuntimePath(trustedRepoPath, source),
    });

    if (owner) {
      await chownTree(runtimePath, owner, chown);
    }
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }

  return { path: runtimePath, cleanup };
}

// Depth-first lchown of the runtime copy. Directory entries come from
// readdir with lstat semantics, so a symlink to a directory is chowned as a
// link and never traversed — target repos must not be able to point a
// symlink at host files and have Sherlock chown them.
async function chownTree(
  rootPath: string,
  owner: WorkspaceOwner,
  chown: (target: string, uid: number, gid: number) => Promise<void>,
): Promise<void> {
  await chown(rootPath, owner.uid, owner.gid);

  const entries = await readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      await chownTree(entryPath, owner, chown);
    } else {
      await chown(entryPath, owner.uid, owner.gid);
    }
  }
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
