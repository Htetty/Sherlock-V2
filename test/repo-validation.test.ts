// Repository validation: package-manager detection, script discovery from
// package.json (never executed), container-only command execution with
// bounded output and timeouts, aggregate semantics, and the verified_fix
// final-outcome transition. Command execution is mocked through the Docker
// adapter — no network, no real repository scripts.
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { DockerAdapter } from "../backend/services/container.js";
import {
  aggregateValidation,
  detectPackageManager,
  discoverRepositoryValidation,
  formatValidationLine,
  runRepositoryValidation,
} from "../backend/services/repo-validation.js";
import { resolveFinalOutcome } from "../backend/services/investigation.js";
import { formatResultComment } from "../backend/services/report.js";

async function createRepo(files: Record<string, string>) {
  const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-validation-"));

  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(repoPath, name), contents, "utf8");
  }

  return repoPath;
}

const pkg = (scripts: Record<string, string>) =>
  JSON.stringify({ name: "target", version: "1.0.0", scripts });

// Fake docker daemon: behavior scripted per script name found in the argv.
function createFakeDocker(
  behavior: Record<string, { exitCode?: number; stdout?: string; hang?: boolean; launchError?: boolean }>,
) {
  const spawned: string[][] = [];
  const removed: string[] = [];

  const adapter: DockerAdapter = {
    isAvailable: async () => true,
    spawnContainer: (args) => {
      spawned.push(args);
      const scriptName = args[args.length - 1];
      const spec = behavior[scriptName] ?? {};
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.exitCode = null;
      proc.kill = () => true;

      setImmediate(() => {
        if (spec.launchError) {
          proc.emit("error", new Error("spawn failed"));
          return;
        }

        if (spec.stdout) {
          proc.stdout.emit("data", Buffer.from(spec.stdout));
        }

        if (!spec.hang) {
          proc.emit("close", spec.exitCode ?? 0);
        }
      });

      return proc as ChildProcessWithoutNullStreams;
    },
    removeContainer: async (name) => {
      removed.push(name);
    },
  };

  return { adapter, spawned, removed };
}

describe("repository command discovery", () => {
  test("detects the package manager from lockfiles in priority order", async () => {
    expect(await detectPackageManager(await createRepo({ "pnpm-lock.yaml": "" }))).toBe("pnpm");
    expect(await detectPackageManager(await createRepo({ "yarn.lock": "" }))).toBe("yarn");
    expect(await detectPackageManager(await createRepo({ "bun.lockb": "" }))).toBe("bun");
    expect(
      await detectPackageManager(await createRepo({ "package-lock.json": "{}" })),
    ).toBe("npm");
    // pnpm lockfile wins over npm lockfile.
    expect(
      await detectPackageManager(
        await createRepo({ "pnpm-lock.yaml": "", "package-lock.json": "{}" }),
      ),
    ).toBe("pnpm");
    // No lockfile: npm.
    expect(await detectPackageManager(await createRepo({}))).toBe("npm");
  });

  test("selects at most one declared script per category by priority", async () => {
    const repoPath = await createRepo({
      "yarn.lock": "",
      "package.json": pkg({
        "test:ci": "vitest run",
        test: "vitest",
        "type-check": "tsc --noEmit",
        lint: "eslint .",
        build: "vite build",
        deploy: "never-considered",
      }),
    });

    const plan = await discoverRepositoryValidation(repoPath);

    expect(plan.packageManager).toBe("yarn");
    expect(plan.commands).toEqual([
      { category: "test", scriptName: "test:ci", argv: ["yarn", "run", "test:ci"], reason: null },
      {
        category: "typecheck",
        scriptName: "type-check",
        argv: ["yarn", "run", "type-check"],
        reason: null,
      },
      { category: "lint", scriptName: "lint", argv: ["yarn", "run", "lint"], reason: null },
      { category: "build", scriptName: "build", argv: ["yarn", "run", "build"], reason: null },
    ]);
  });

  test("a repository without package.json has every category not available", async () => {
    const repoPath = await createRepo({});
    const plan = await discoverRepositoryValidation(repoPath);

    for (const command of plan.commands) {
      expect(command.argv).toBeNull();
      expect(command.reason).toContain("no package.json");
    }
  });

  test("undeclared scripts and the npm placeholder are not available; dependencies are never used for inference", async () => {
    const repoPath = await createRepo({
      "package.json": JSON.stringify({
        name: "target",
        // jest in dependencies must NOT produce a test command.
        dependencies: { jest: "^29.0.0", typescript: "^5.0.0" },
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
          build: "tsc",
        },
      }),
    });

    const plan = await discoverRepositoryValidation(repoPath);
    const byCategory = Object.fromEntries(plan.commands.map((c) => [c.category, c]));

    expect(byCategory.test.argv).toBeNull();
    expect(byCategory.test.reason).toContain("placeholder");
    expect(byCategory.typecheck.argv).toBeNull();
    expect(byCategory.lint.argv).toBeNull();
    expect(byCategory.build.argv).toEqual(["npm", "run", "build"]);
  });
});

describe("repository validation execution", () => {
  test("runs discovered commands as argv arrays in containers with CI=true, in category order, skipping unavailable ones", async () => {
    const repoPath = await createRepo({
      "package.json": pkg({ test: "vitest run", lint: "eslint ." }),
    });
    const docker = createFakeDocker({ test: { exitCode: 0 }, lint: { exitCode: 0 } });

    const validation = await runRepositoryValidation(docker.adapter, {
      repoPath,
      timeoutMs: 5_000,
    });

    expect(validation.aggregate).toBe("passed");
    expect(validation.results.map((r) => [r.category, r.status])).toEqual([
      ["test", "passed"],
      ["typecheck", "not_available"],
      ["lint", "passed"],
      ["build", "not_available"],
    ]);

    // Exactly two containers: unavailable categories execute nothing.
    expect(docker.spawned).toHaveLength(2);

    for (const args of docker.spawned) {
      // argv array through the container runner — no shell anywhere.
      expect(args.slice(-3)).toEqual(["npm", "run", args[args.length - 1]]);
      expect(args.join(" ")).not.toContain("sh -");
      expect(args.join(" ")).toContain("-e CI=true");
      // Restricted-container path (same runner as everything else).
      expect(args).toContain("--cap-drop=ALL");
      expect(args[args.indexOf("--name") + 1]).toMatch(/^sherlock-validate-/);
    }

    // Order: test before lint.
    expect(docker.spawned[0][docker.spawned[0].length - 1]).toBe("test");
    expect(docker.spawned[1][docker.spawned[1].length - 1]).toBe("lint");
  });

  test("failed, timed-out, and launch-failure commands are classified truthfully", async () => {
    const repoPath = await createRepo({
      "package.json": pkg({
        test: "vitest run",
        lint: "eslint .",
        build: "vite build",
      }),
    });
    const docker = createFakeDocker({
      test: { exitCode: 1 },
      lint: { hang: true },
      build: { launchError: true },
    });

    const validation = await runRepositoryValidation(docker.adapter, {
      repoPath,
      timeoutMs: 100,
    });

    const byCategory = Object.fromEntries(
      validation.results.map((r) => [r.category, r]),
    );

    expect(byCategory.test.status).toBe("failed");
    expect(byCategory.test.exitCode).toBe(1);
    expect(byCategory.lint.status).toBe("timed_out");
    expect(byCategory.lint.reason).toContain("timeout");
    // A declared command that cannot launch is failed, never not_available.
    expect(byCategory.build.status).toBe("failed");
    expect(byCategory.build.reason).toContain("could not be launched");
    expect(validation.aggregate).toBe("failed");

    // Timed-out container was force-removed.
    expect(docker.removed.length).toBeGreaterThan(0);
  });

  test("stdout and stderr are bounded so repositories cannot flood artifacts", async () => {
    const repoPath = await createRepo({ "package.json": pkg({ test: "vitest run" }) });
    const docker = createFakeDocker({
      test: { exitCode: 0, stdout: "x".repeat(60_000) },
    });

    const validation = await runRepositoryValidation(docker.adapter, {
      repoPath,
      timeoutMs: 5_000,
    });

    const testResult = validation.results[0];
    expect(testResult.stdout.length).toBeLessThan(11_000);
    expect(testResult.stdout).toContain("[truncated");
  });

  test("all-unavailable validation aggregates to not_available, never a fake pass", async () => {
    const repoPath = await createRepo({});
    const docker = createFakeDocker({});

    const validation = await runRepositoryValidation(docker.adapter, {
      repoPath,
      timeoutMs: 5_000,
    });

    expect(validation.aggregate).toBe("not_available");
    expect(docker.spawned).toHaveLength(0);
    expect(
      aggregateValidation(validation.results),
    ).toBe("not_available");
    expect(formatValidationLine(validation.results[0])).toBe("Tests: not available");
  });
});

describe("final investigation outcome semantics", () => {
  test("verified patch produces verified_fix; anything else preserves the reproduction outcome", () => {
    expect(resolveFinalOutcome("reproduced", "verified")).toBe("verified_fix");

    // Reproduced without a verified patch stays reproduced.
    expect(resolveFinalOutcome("reproduced", null)).toBe("reproduced");
    expect(resolveFinalOutcome("reproduced", "rejected_tests_failed")).toBe("reproduced");
    expect(resolveFinalOutcome("reproduced", "rejected_patch_invalid")).toBe("reproduced");

    // Existing outcomes are unchanged regardless of fix state.
    expect(resolveFinalOutcome("not_reproduced", null)).toBe("not_reproduced");
    expect(resolveFinalOutcome("environment_failed", null)).toBe("environment_failed");
    expect(resolveFinalOutcome("execution_failed", null)).toBe("execution_failed");
  });

  test("the GitHub comment reports verified_fix while preserving the original reproduction", () => {
    const comment = formatResultComment({
      investigationId: "inv_0TEST123ABC",
      outcome: "verified_fix",
      originalOutcome: "reproduced",
      verification: "verified",
      pullRequestStatus: "created",
      observed: "Login returned HTTP 500",
      expected: "Login should return HTTP 401",
    });

    expect(comment).toContain("Sherlock reproduced the reported failure and verified a fix");
    expect(comment).toContain("Outcome: verified_fix");
    expect(comment).toContain("Original reproduction: reproduced");
    expect(comment).toContain("Verification: verified");
    expect(comment).toContain("Pull request: created");

    // Existing outcomes keep their existing comment shape.
    const envFailed = formatResultComment({
      investigationId: "inv_0TEST123ABC",
      outcome: "environment_failed",
      stage: "application startup",
      error: "Docker is not available",
    });
    expect(envFailed).toContain("Outcome: environment_failed");
    expect(envFailed).not.toContain("Original reproduction:");
  });
});
