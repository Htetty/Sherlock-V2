// Runtime workspace ownership: a root worker (containerized production) must
// hand the runtime copy to the unprivileged target-container user, because on
// a Linux daemon bind mounts preserve host ownership and a root-owned /app
// gives the `node` user EACCES on npm install. All chown behavior is
// exercised through the injected chown so the tests run unprivileged.
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createRuntimeWorkspace,
  resolveWorkspaceOwner,
} from "../backend/services/runtime-workspace.js";

async function createFixtureRepo() {
  const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-rw-"));

  await writeFile(path.join(repoPath, "package.json"), "{}", "utf8");
  await mkdir(path.join(repoPath, "src"));
  await writeFile(path.join(repoPath, "src", "index.js"), "// fixture", "utf8");
  await mkdir(path.join(repoPath, ".git"));
  await writeFile(path.join(repoPath, ".git", "config"), "[core]\n", "utf8");

  return repoPath;
}

describe("workspace owner resolution", () => {
  test("only a root worker chowns; the target uid/gid default to the node user and are overridable", () => {
    // Non-root worker (local dev): cannot chown to another uid, and Docker
    // Desktop's file sharing already makes the mount writable.
    expect(resolveWorkspaceOwner({}, 1000 as number)).toBeNull();
    expect(resolveWorkspaceOwner({}, null)).toBeNull();

    // Root worker: defaults to the node image's unprivileged user.
    expect(resolveWorkspaceOwner({}, 0)).toEqual({ uid: 1000, gid: 1000 });

    // Custom target image with a different unprivileged user.
    expect(
      resolveWorkspaceOwner(
        { SHERLOCK_TARGET_UID: "1234", SHERLOCK_TARGET_GID: "4321" },
        0,
      ),
    ).toEqual({ uid: 1234, gid: 4321 });

    // Garbage overrides fall back to the defaults instead of chowning to NaN.
    expect(
      resolveWorkspaceOwner(
        { SHERLOCK_TARGET_UID: "not-a-uid", SHERLOCK_TARGET_GID: "-5" },
        0,
      ),
    ).toEqual({ uid: 1000, gid: 1000 });
  });
});

describe("runtime workspace ownership", () => {
  test("chowns every copied file and directory to the target owner without following symlinks", async () => {
    const repoPath = await createFixtureRepo();
    const outsideTarget = path.join(
      await mkdtemp(path.join(tmpdir(), "sherlock-outside-")),
      "host-file",
    );
    await writeFile(outsideTarget, "host content", "utf8");
    // A target repo could ship a symlink at any host file; ownership must be
    // applied to the link itself, never through it.
    await symlink(outsideTarget, path.join(repoPath, "escape-link"));

    const chowned: { target: string; uid: number; gid: number }[] = [];
    const runtime = await createRuntimeWorkspace(repoPath, {
      owner: { uid: 1000, gid: 1000 },
      chown: async (target, uid, gid) => {
        chowned.push({ target, uid, gid });
      },
    });

    const chownedPaths = chowned.map((entry) => entry.target);

    // The workspace root and everything inside it (files, dirs, the link).
    for (const expected of [
      runtime.path,
      path.join(runtime.path, "package.json"),
      path.join(runtime.path, "src"),
      path.join(runtime.path, "src", "index.js"),
      path.join(runtime.path, "escape-link"),
    ]) {
      expect(chownedPaths).toContain(expected);
    }

    // Everything targets the container user, nothing outside the workspace
    // is touched, and the symlink target is never resolved.
    for (const entry of chowned) {
      expect(entry.uid).toBe(1000);
      expect(entry.gid).toBe(1000);
      expect(entry.target.startsWith(runtime.path)).toBe(true);
    }
    expect(chownedPaths).not.toContain(outsideTarget);

    // .git is still excluded from the runtime copy.
    await expect(access(path.join(runtime.path, ".git"))).rejects.toThrow();

    await runtime.cleanup();
  });

  test("owner null (non-root worker) copies without any chown", async () => {
    const repoPath = await createFixtureRepo();

    let chownCalls = 0;
    const runtime = await createRuntimeWorkspace(repoPath, {
      owner: null,
      chown: async () => {
        chownCalls += 1;
      },
    });

    expect(chownCalls).toBe(0);
    expect(await readFile(path.join(runtime.path, "package.json"), "utf8")).toBe("{}");

    await runtime.cleanup();
  });

  test("a chown failure removes the partial workspace and propagates", async () => {
    const repoPath = await createFixtureRepo();
    let workspaceRoot: string | null = null;

    await expect(
      createRuntimeWorkspace(repoPath, {
        owner: { uid: 1000, gid: 1000 },
        chown: async (target) => {
          workspaceRoot = target;
          throw new Error("EPERM: chown not permitted");
        },
      }),
    ).rejects.toThrow("EPERM");

    // The temp copy did not leak.
    expect(workspaceRoot).not.toBeNull();
    await expect(access(workspaceRoot!)).rejects.toThrow();
  });
});
