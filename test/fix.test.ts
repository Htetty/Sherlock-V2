// Verified fix loop tests against a small git-backed fixture app with the
// login bug seeded in code (POST /api/login returns 500 instead of 401).
//
// ANTHROPIC_API_KEY is removed: proposals are injected, and the fix loop's
// imports never load the Claude client, proving verification runs without
// calling Claude.
delete process.env.ANTHROPIC_API_KEY;

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { createArtifactStore, createInvestigationId } from "../backend/services/artifacts.js";
import {
  CONTAINER_DEFAULTS,
  type DockerAdapter,
} from "../backend/services/container.js";
import {
  FIX_PROPOSAL_VERSION,
  extractFixProposalJson,
  requestValidProposal,
  validatePatchSafety,
  validateFixProposalShape,
  type FixProposal,
} from "../backend/services/fix-proposal.js";
import { hashPlanBehavior, runFixAttempt } from "../backend/services/fix.js";
import {
  REPRODUCTION_PLAN_VERSION,
  validateReproductionPlan,
  type ReproductionPlan,
} from "../backend/services/plan.js";
import { executeReproductionPlan } from "../backend/services/playwright.js";
import { formatFixComment } from "../backend/services/report.js";

const execFileAsync = promisify(execFile);

const BUGGY_RESPONSE = `      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));`;

const FIXED_RESPONSE = `      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid credentials" }));`;

// Same page as test/fixtures/fixture-app, but the bug lives in code so a
// patch can fix it.
const BUGGY_SERVER = `import http from "node:http";

const port = Number(process.env.PORT ?? 3000);

const page = \`<!doctype html>
<html>
  <head><title>Fixture Login</title></head>
  <body>
    <form id="login-form">
      <input name="email" type="email" />
      <input name="password" type="password" />
      <button type="submit">Log in</button>
    </form>
    <p id="message"></p>
    <script>
      document.getElementById("login-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: document.querySelector("[name='email']").value }),
        });
        document.getElementById("message").textContent = "Login status " + response.status;
      });
    </script>
  </body>
</html>\`;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
    return;
  }

  if (req.method === "POST" && req.url === "/api/login") {
    req.resume();
    req.on("end", () => {
      // BUG: unknown users should get 401, not a server error.
${BUGGY_RESPONSE}
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, () => {
  console.log(\`Fixture app listening on http://localhost:\${port}\`);
});
`;

const CHECK_LOGIN_TEST = `import { spawn } from "node:child_process";

const port = 42000 + Math.floor(Math.random() * 2000);
const app = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});

const deadline = Date.now() + 8000;
let status = 0;

while (Date.now() < deadline) {
  try {
    const response = await fetch(\`http://localhost:\${port}/api/login\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    status = response.status;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

app.kill("SIGKILL");
process.exit(status === 401 ? 0 : 1);
`;

// Emulates the restricted-container adapter by executing the in-container
// argv directly on the host inside the mounted workspace. This keeps the fix
// loop's verification path end-to-end (real processes, real exit codes)
// without requiring a Docker daemon, while still exercising the exact argv
// and lifecycle the real adapter would receive.
function createHostEmulatingDocker() {
  const containerNames: string[] = [];
  const removed: string[] = [];

  const adapter: DockerAdapter = {
    isAvailable: async () => true,
    spawnContainer: (args) => {
      containerNames.push(args[args.indexOf("--name") + 1]);
      const volume = args[args.indexOf("-v") + 1];
      const cwd = volume.slice(0, volume.lastIndexOf(":"));
      const imageIndex = args.indexOf(CONTAINER_DEFAULTS.image);
      const argv = args.slice(imageIndex + 1);

      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env },
      });
      runningApps.push(child);
      return child as ChildProcess & {
        stdout: NonNullable<ChildProcess["stdout"]>;
        stderr: NonNullable<ChildProcess["stderr"]>;
        stdin: NonNullable<ChildProcess["stdin"]>;
      };
    },
    removeContainer: async (name) => {
      removed.push(name);
    },
  };

  return { adapter, containerNames, removed };
}

let runningApps: ChildProcess[] = [];

afterEach(() => {
  for (const app of runningApps) {
    app.kill("SIGKILL");
  }

  runningApps = [];
});

async function git(repoPath: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout;
}

async function createFixtureRepo(scripts?: Record<string, string>) {
  const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-fix-repo-"));

  await writeFile(path.join(repoPath, "server.mjs"), BUGGY_SERVER, "utf8");
  await writeFile(path.join(repoPath, "check-login.mjs"), CHECK_LOGIN_TEST, "utf8");
  await writeFile(path.join(repoPath, "failing-test.mjs"), "process.exit(1);\n", "utf8");
  await writeFile(
    path.join(repoPath, "never-exits.mjs"),
    // Self-terminates as a leak guard; validation timeouts fire well before.
    "setTimeout(() => process.exit(0), 15000);\nsetInterval(() => {}, 1000);\n",
    "utf8",
  );
  await writeFile(path.join(repoPath, ".env"), "SECRET_TOKEN=super-secret-value\n", "utf8");

  if (scripts) {
    await writeFile(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "fixture-app", version: "1.0.0", scripts }),
      "utf8",
    );
  }

  await git(repoPath, ["init", "--quiet"]);
  await git(repoPath, ["config", "user.email", "fixture@example.com"]);
  await git(repoPath, ["config", "user.name", "Fixture"]);
  await git(repoPath, ["add", "-A", "-f"]);
  await git(repoPath, ["commit", "--quiet", "-m", "fixture"]);

  const commit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  return { repoPath, commit };
}

function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate port."));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function startApp(repoPath: string, port: number) {
  const app = spawn(process.execPath, [path.join(repoPath, "server.mjs")], {
    cwd: repoPath,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  runningApps.push(app);

  const baseUrl = `http://localhost:${port}`;

  if (!(await waitReachable(baseUrl, 10_000))) {
    throw new Error("Fixture app did not start in time.");
  }

  return app;
}

async function waitReachable(baseUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return false;
}

function buildLoginPlan(baseUrl: string): ReproductionPlan {
  const validation = validateReproductionPlan({
    version: REPRODUCTION_PLAN_VERSION,
    baseUrl,
    steps: [
      { id: "step-1", action: "goto", path: "/" },
      { id: "step-2", action: "fill", selector: "[name='email']", value: "unknown@example.com" },
      { id: "step-3", action: "click", selector: "button[type='submit']" },
      { id: "step-4", action: "screenshot" },
    ],
    expectedBehavior: "Login with unknown credentials returns HTTP 401.",
    failureCondition: "Login request returns HTTP 500.",
    assertion: {
      type: "response_status",
      pathPattern: "/api/login",
      method: "POST",
      expected: 401,
      failureValue: 500,
    },
  });

  if (!validation.ok) {
    throw new Error(validation.errors.join(", "));
  }

  return validation.plan;
}

function correctProposal(overrides: Partial<FixProposal> = {}): FixProposal {
  return {
    version: FIX_PROPOSAL_VERSION,
    summary: "Return 401 for unknown users instead of a server error.",
    rootCause: "The login handler always responds with HTTP 500.",
    confidence: 0.9,
    files: [
      {
        path: "server.mjs",
        edits: [{ oldText: BUGGY_RESPONSE, newText: FIXED_RESPONSE }],
      },
    ],
    relevantTests: ["node check-login.mjs"],
    risk: "low",
    assumptions: [],
    ...overrides,
  };
}

// Runs the seeded bug through reproduction, then a fix attempt with the given
// proposal and restart behavior. Returns everything the assertions need.
async function setupReproducedInvestigation(scripts?: Record<string, string>) {
  const { repoPath, commit } = await createFixtureRepo(scripts);
  const port = await getFreePort();
  let app = await startApp(repoPath, port);
  const baseUrl = `http://localhost:${port}`;

  const investigationId = createInvestigationId();
  const artifactsRoot = await mkdtemp(path.join(tmpdir(), "sherlock-fix-artifacts-"));
  const store = await createArtifactStore(
    investigationId,
    path.join(artifactsRoot, investigationId),
  );

  const plan = buildLoginPlan(baseUrl);
  const original = await executeReproductionPlan(plan, store);
  expect(original.outcome).toBe("reproduced");

  await store.writeJson("reproduction-plan.json", plan);
  await store.writeJson("reproduction-result.json", {
    investigationId,
    ...original,
  });

  const restart = async () => {
    app.kill("SIGKILL");
    app = await startApp(repoPath, port);
    return { ok: true, baseUrl, log: "restarted fixture app" };
  };

  return { repoPath, commit, investigationId, store, plan, original, restart, baseUrl };
}

async function readOriginalArtifacts(storeDir: string) {
  return {
    plan: await readFile(path.join(storeDir, "reproduction-plan.json"), "utf8"),
    result: await readFile(path.join(storeDir, "reproduction-result.json"), "utf8"),
  };
}

describe("verified fix loop", () => {
  test(
    "a correct patch is verified and original artifacts are preserved",
    { timeout: 120_000 },
    async () => {
      // Fixture declares a real test script; validation must discover and
      // run it in the container path (exact replay + all available checks
      // passing allows verification).
      const setup = await setupReproducedInvestigation({
        test: "node check-login.mjs",
      });
      const before = await readOriginalArtifacts(setup.store.dir);
      const docker = createHostEmulatingDocker();

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
      });

      expect(attempt.outcome).toBe("verified");
      expect(attempt.postPatchOutcome).toBe("not_reproduced");
      expect(attempt.changedFiles).toEqual(["server.mjs"]);
      expect(attempt.fixAttemptId).toMatch(/^fix_[0-9A-Z]{10,}$/);
      expect(attempt.testRuns).toHaveLength(1);
      expect(attempt.testRuns[0].command).toBe("npm run test");
      expect(attempt.testRuns[0].exitCode).toBe(0);
      expect(attempt.testRuns[0].timedOut).toBe(false);
      // No generator injected: regression testing is truthfully unavailable
      // and never a fake pass, while replay + validation still verify.
      expect(attempt.regressionTest?.status).toBe("unavailable");
      expect(attempt.regressionTest?.prePatch).toBeNull();

      expect(attempt.repositoryValidation).toEqual({
        aggregate: "passed",
        categories: [
          { category: "test", status: "passed" },
          { category: "typecheck", status: "not_available" },
          { category: "lint", status: "not_available" },
          { category: "build", status: "not_available" },
        ],
      });

      // The validation command ran in its own short-lived container (not
      // the app container) and was force-removed afterwards.
      expect(docker.containerNames).toHaveLength(1);
      expect(docker.containerNames[0]).toMatch(/^sherlock-validate-test-/);
      expect(docker.removed).toContain(docker.containerNames[0]);

      // The exact saved plan was replayed (hash recorded, steps untouched).
      const replayCheck = attempt.checks.find((c) => c.name === "exact_plan_replayed");
      expect(replayCheck?.detail).toContain(hashPlanBehavior(setup.plan));

      // All required artifacts were persisted under fix-attempts/<id>/.
      for (const fileName of [
        "fix-proposal.json",
        "proposed.patch",
        "patch-validation.json",
        "git-diff.patch",
        "build-result.json",
        "post-patch-reproduction-result.json",
        "repository-validation.json",
        "regression-test.json",
        "test-results.json",
        "verification-result.json",
      ]) {
        const info = await stat(path.join(attempt.attemptDir, fileName));
        expect(info.isFile()).toBe(true);
      }

      expect(attempt.attemptDir).toContain(
        path.join(setup.store.dir, "fix-attempts", attempt.fixAttemptId),
      );

      // Original pre-patch evidence is byte-for-byte unchanged.
      const after = await readOriginalArtifacts(setup.store.dir);
      expect(after.plan).toBe(before.plan);
      expect(after.result).toBe(before.result);
    },
  );

  test(
    "a patch that leaves the bug is rejected_reproduction_still_fails",
    { timeout: 120_000 },
    async () => {
      const setup = await setupReproducedInvestigation();

      const uselessProposal = correctProposal({
        summary: "Clarify a comment.",
        files: [
          {
            path: "server.mjs",
            edits: [
              {
                oldText: "// BUG: unknown users should get 401, not a server error.",
                newText: "// TODO: look into the login status code.",
              },
            ],
          },
        ],
      });

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: uselessProposal,
        restart: setup.restart,
      });

      expect(attempt.outcome).toBe("rejected_reproduction_still_fails");
      expect(attempt.postPatchOutcome).toBe("reproduced");
    },
  );

  test(
    "a patch that fixes the bug but fails repository validation is rejected_tests_failed",
    { timeout: 120_000 },
    async () => {
      // Discovered failing "test" script + passing "lint" script: any failed
      // category prevents verification.
      const setup = await setupReproducedInvestigation({
        test: "node failing-test.mjs",
        lint: "node check-login.mjs",
      });
      const docker = createHostEmulatingDocker();

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
      });

      expect(attempt.outcome).toBe("rejected_tests_failed");
      // The reproduction itself did pass post-patch.
      expect(attempt.postPatchOutcome).toBe("not_reproduced");
      expect(attempt.repositoryValidation?.aggregate).toBe("failed");
      expect(attempt.repositoryValidation?.categories).toContainEqual({
        category: "test",
        status: "failed",
      });
      expect(attempt.repositoryValidation?.categories).toContainEqual({
        category: "lint",
        status: "passed",
      });
      expect(attempt.testRuns[0].exitCode).not.toBe(0);
      expect(attempt.testRuns[1].exitCode).toBe(0);

      // Each validation command got its own uniquely named short-lived
      // container, and both were cleaned up.
      expect(docker.containerNames).toHaveLength(2);
      expect(new Set(docker.containerNames).size).toBe(2);

      for (const name of docker.containerNames) {
        expect(docker.removed).toContain(name);
      }
    },
  );

  test(
    "unavailable repository validation is reported truthfully and never faked as passing",
    { timeout: 120_000 },
    async () => {
      // No package.json at all: the exact reproduction replay may still
      // verify the fix, but nothing may claim tests passed.
      const setup = await setupReproducedInvestigation();
      const docker = createHostEmulatingDocker();

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
      });

      expect(attempt.outcome).toBe("verified");
      expect(attempt.repositoryValidation?.aggregate).toBe("not_available");
      expect(attempt.testRuns).toHaveLength(0);
      // Unavailable categories execute nothing.
      expect(docker.containerNames).toHaveLength(0);

      // Truthful check: no fake relevant_tests_passed, no "passed with no
      // coverage" wording anywhere.
      const names = attempt.checks.map((item) => item.name);
      expect(names).not.toContain("relevant_tests_passed");
      const validationCheck = attempt.checks.find(
        (item) => item.name === "repository_validation",
      );
      expect(validationCheck?.detail).toContain("unavailable");
      const serialized = JSON.stringify(attempt);
      expect(serialized).not.toContain("passed with no coverage");
      expect(attempt.reason).toContain("Repository validation was unavailable");
    },
  );

  test(
    "a timed-out validation command prevents verified status",
    { timeout: 120_000 },
    async () => {
      const setup = await setupReproducedInvestigation({
        test: "node never-exits.mjs",
      });
      const docker = createHostEmulatingDocker();

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
        validationTimeoutMs: 800,
      });

      expect(attempt.outcome).toBe("rejected_tests_failed");
      expect(attempt.repositoryValidation?.aggregate).toBe("failed");
      expect(attempt.repositoryValidation?.categories).toContainEqual({
        category: "test",
        status: "timed_out",
      });
      expect(attempt.testRuns[0].timedOut).toBe(true);
      expect(attempt.reason).toContain("timed out");

      // Forced cleanup ran for the timed-out container.
      expect(docker.removed).toContain(docker.containerNames[0]);
    },
  );

  test(
    "unsafe or invalid patches are rejected before application",
    { timeout: 60_000 },
    async () => {
      const { repoPath, commit } = await createFixtureRepo();
      const investigationId = createInvestigationId();
      const artifactsRoot = await mkdtemp(path.join(tmpdir(), "sherlock-fix-artifacts-"));
      const store = await createArtifactStore(
        investigationId,
        path.join(artifactsRoot, investigationId),
      );
      const plan = buildLoginPlan("http://localhost:39999");
      const envBefore = await readFile(path.join(repoPath, ".env"), "utf8");
      let restartCalled = false;

      const attempt = await runFixAttempt({
        investigationId,
        investigationDir: store.dir,
        repoPath,
        sourceCommit: commit,
        plan,
        originalOutcome: "reproduced",
        proposal: correctProposal({
          files: [
            {
              path: ".env",
              edits: [{ oldText: "SECRET_TOKEN", newText: "TOKEN" }],
            },
          ],
        }),
        restart: async () => {
          restartCalled = true;
          return { ok: true };
        },
      });

      expect(attempt.outcome).toBe("rejected_patch_invalid");
      expect(restartCalled).toBe(false);
      expect(await readFile(path.join(repoPath, ".env"), "utf8")).toBe(envBefore);

      // Direct validator coverage for the other unsafe categories.
      const traversal = await validatePatchSafety(
        correctProposal({
          files: [{ path: "../outside.txt", edits: [{ oldText: "a", newText: "b" }] }],
        }),
        repoPath,
      );
      expect(traversal.ok).toBe(false);
      expect(traversal.errors.join(" ")).toContain("escapes the repository workspace");

      const outsideDir = await mkdtemp(path.join(tmpdir(), "sherlock-outside-"));
      await writeFile(path.join(outsideDir, "escape.txt"), "original\n", "utf8");
      await symlink(outsideDir, path.join(repoPath, "linked-out"));
      const symlinkEscape = await validatePatchSafety(
        correctProposal({
          files: [
            {
              path: "linked-out/escape.txt",
              edits: [{ oldText: "original", newText: "changed" }],
            },
          ],
        }),
        repoPath,
      );
      expect(symlinkEscape.ok).toBe(false);
      expect(symlinkEscape.errors.join(" ")).toContain("via a symlink");

      const tooManyFiles = await validatePatchSafety(
        correctProposal({
          files: Array.from({ length: 6 }, (_, index) => ({
            path: `file-${index}.txt`,
            edits: [{ oldText: "a", newText: "b" }],
          })),
        }),
        repoPath,
      );
      expect(tooManyFiles.ok).toBe(false);

      const shellInjection = validateFixProposalShape(
        correctProposal({ relevantTests: ["npm test && rm -rf /"] }),
      );
      expect(shellInjection.ok).toBe(false);

      const emptyPatch = validateFixProposalShape(
        correctProposal({
          files: [{ path: "server.mjs", edits: [{ oldText: "same", newText: "same" }] }],
        }),
      );
      expect(emptyPatch.ok).toBe(false);

      const wrongVersion = validateFixProposalShape(correctProposal({ version: 99 }));
      expect(wrongVersion.ok).toBe(false);
    },
  );

  test(
    "a rebuild or restart failure is rejected_build_failed",
    { timeout: 60_000 },
    async () => {
      const { repoPath, commit } = await createFixtureRepo();
      const investigationId = createInvestigationId();
      const artifactsRoot = await mkdtemp(path.join(tmpdir(), "sherlock-fix-artifacts-"));
      const store = await createArtifactStore(
        investigationId,
        path.join(artifactsRoot, investigationId),
      );

      const attempt = await runFixAttempt({
        investigationId,
        investigationDir: store.dir,
        repoPath,
        sourceCommit: commit,
        plan: buildLoginPlan("http://localhost:39999"),
        originalOutcome: "reproduced",
        proposal: correctProposal(),
        restart: async () => ({ ok: false, log: "npm run build failed: DATABASE_URL missing" }),
      });

      expect(attempt.outcome).toBe("rejected_build_failed");

      const buildResult = JSON.parse(
        await readFile(path.join(attempt.attemptDir, "build-result.json"), "utf8"),
      );
      expect(buildResult.ok).toBe(false);
    },
  );

  test("a missing reproduction precondition fails without applying anything", async () => {
    const { repoPath, commit } = await createFixtureRepo();
    const investigationId = createInvestigationId();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), "sherlock-fix-artifacts-"));
    const store = await createArtifactStore(
      investigationId,
      path.join(artifactsRoot, investigationId),
    );
    const serverBefore = await readFile(path.join(repoPath, "server.mjs"), "utf8");

    const attempt = await runFixAttempt({
      investigationId,
      investigationDir: store.dir,
      repoPath,
      sourceCommit: commit,
      plan: buildLoginPlan("http://localhost:39999"),
      originalOutcome: "not_reproduced",
      proposal: correctProposal(),
      restart: async () => ({ ok: true }),
    });

    expect(attempt.outcome).toBe("rejected_verification_inconclusive");
    expect(attempt.reason).toContain("Precondition failed");
    expect(await readFile(path.join(repoPath, "server.mjs"), "utf8")).toBe(serverBefore);
  });
});

// Regression-test lifecycle against the real fixture workspace: generated
// tests are injected (Claude is mocked) and executed through the
// host-emulating container adapter.
describe("regression-test verification loop", () => {
  const regressionProposal = (contents: string, name = "login-does-not-return-500") => ({
    version: 1,
    testName: name,
    purpose: "Prove the login handler behavior.",
    relativePath: "sherlock-regression.test.mjs",
    runner: "node",
    contents,
    expectedPrePatchFailure: "The assertion fails on the buggy source.",
    expectedPostPatchBehavior: "The assertion passes after the fix.",
  });

  const FAILS_ON_BUGGY = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile("server.mjs", "utf8");
assert.ok(!source.includes("res.writeHead(500"), "REGRESSION_EXPECTED_FAILURE: login handler must not respond 500");
`;

  test(
    "fail-before/pass-after with identical bytes permits verification",
    { timeout: 120_000 },
    async () => {
      const setup = await setupReproducedInvestigation();
      const docker = createHostEmulatingDocker();
      let generatorCalls = 0;

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
        generateRegressionTest: async () => {
          generatorCalls += 1;
          return regressionProposal(FAILS_ON_BUGGY);
        },
      });

      expect(attempt.outcome).toBe("verified");
      expect(generatorCalls).toBe(1);
      expect(attempt.regressionTest).toMatchObject({
        status: "proven",
        testName: "login-does-not-return-500",
        prePatch: "failed_as_expected",
        postPatch: "passed",
        hashMatched: true,
        generationAttempts: 1,
      });
      expect(attempt.regressionTest?.sha256).toMatch(/^[0-9a-f]{64}$/);

      // Both runs happened in their own regression containers.
      const regressionContainers = docker.containerNames.filter((name) =>
        name.startsWith("sherlock-regression-"),
      );
      expect(regressionContainers).toHaveLength(2);

      // The generated test is evidence only: gone from the workspace, with
      // only the intended patch file changed — it can never reach the PR.
      await expect(
        stat(path.join(setup.repoPath, "sherlock-regression.test.mjs")),
      ).rejects.toThrow();
      const status = await execFileAsync("git", ["status", "--short"], {
        cwd: setup.repoPath,
      });
      expect(status.stdout.trim()).toBe("M server.mjs");

      // The intended production patch is intact.
      const patched = await readFile(path.join(setup.repoPath, "server.mjs"), "utf8");
      expect(patched).toContain("res.writeHead(401");

      // Structured artifacts exist, with the exact source bytes preserved.
      for (const fileName of [
        "regression-test.json",
        "regression-test-source.mjs",
        "regression-prepatch-result.json",
        "regression-postpatch-result.json",
      ]) {
        const info = await stat(path.join(attempt.attemptDir, fileName));
        expect(info.isFile()).toBe(true);
      }
      expect(
        await readFile(path.join(attempt.attemptDir, "regression-test-source.mjs"), "utf8"),
      ).toBe(FAILS_ON_BUGGY);
      const artifact = JSON.parse(
        await readFile(path.join(attempt.attemptDir, "regression-test.json"), "utf8"),
      );
      expect(artifact.status).toBe("proven");
      expect(JSON.stringify(artifact)).not.toContain("SECRET_TOKEN");
    },
  );

  test(
    "a test that unexpectedly passes on the original source rejects the fix before patching",
    { timeout: 120_000 },
    async () => {
      const setup = await setupReproducedInvestigation();
      const docker = createHostEmulatingDocker();

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
        generateRegressionTest: async () =>
          regressionProposal(
            `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile("server.mjs", "utf8");
assert.ok(source.includes("http"), "REGRESSION_EXPECTED_FAILURE: trivially true on the buggy source");
`,
            "trivially-passing-test",
          ),
      });

      expect(attempt.outcome).toBe("rejected_regression_test_failed");
      expect(attempt.regressionTest?.status).toBe("blocked");
      expect(attempt.regressionTest?.prePatch).toBe("unexpectedly_passed");

      // The patch was never applied: the buggy source is untouched.
      const source = await readFile(path.join(setup.repoPath, "server.mjs"), "utf8");
      expect(source).toContain("res.writeHead(500");
    },
  );

  test(
    "one invalid proposal permits exactly one refinement, and invalid twice is truthfully unavailable",
    { timeout: 120_000 },
    async () => {
      // Invalid (syntax error) then valid: refinement succeeds.
      const setup = await setupReproducedInvestigation();
      const docker = createHostEmulatingDocker();
      const feedbackSeen: (string | null)[] = [];

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
        generateRegressionTest: async (feedback) => {
          feedbackSeen.push(feedback);
          return feedbackSeen.length === 1
            ? regressionProposal(
                'const assert = ; // REGRESSION_EXPECTED_FAILURE: broken\n',
                "broken-syntax-test",
              )
            : regressionProposal(FAILS_ON_BUGGY);
        },
      });

      expect(attempt.outcome).toBe("verified");
      expect(attempt.regressionTest?.status).toBe("proven");
      expect(attempt.regressionTest?.generationAttempts).toBe(2);
      expect(feedbackSeen).toHaveLength(2);
      expect(feedbackSeen[0]).toBeNull();
      expect(feedbackSeen[1]).toContain("invalid_test");

      // Invalid twice: bounded at two attempts, no third call, neutral and
      // truthful — verification still succeeds via replay, never a fake pass.
      const setup2 = await setupReproducedInvestigation();
      const docker2 = createHostEmulatingDocker();
      let calls = 0;

      const attempt2 = await runFixAttempt({
        investigationId: setup2.investigationId,
        investigationDir: setup2.store.dir,
        repoPath: setup2.repoPath,
        sourceCommit: setup2.commit,
        plan: setup2.plan,
        originalOutcome: setup2.original.outcome,
        proposal: correctProposal(),
        restart: setup2.restart,
        docker: docker2.adapter,
        generateRegressionTest: async () => {
          calls += 1;
          return regressionProposal(
            'const assert = ; // REGRESSION_EXPECTED_FAILURE: still broken\n',
            "still-broken-test",
          );
        },
      });

      expect(calls).toBe(2);
      expect(attempt2.outcome).toBe("verified");
      expect(attempt2.regressionTest?.status).toBe("unavailable");
      expect(attempt2.regressionTest?.prePatch).toBe("invalid_test");
      const regressionCheck = attempt2.checks.find((c) => c.name === "regression_test");
      expect(regressionCheck?.passed).toBe(true);
      expect(regressionCheck?.detail).toContain("No generated regression test was available");
    },
  );

  test(
    "a wrong-route setup failure is never accepted as behavioral proof and does not block a replay-verified patch",
    { timeout: 120_000 },
    async () => {
      // Reproduces live inv_1JSR0AM8Q8T19Z3: the generated test hit an
      // invented endpoint, its SETUP assertion failed (404-style), and that
      // must classify as invalid_test — not failed_as_expected — leaving
      // the replay-verified patch verifiable once generation is exhausted.
      const WRONG_ROUTE_TEST = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
let body = null;
try {
  body = await readFile("this-route-does-not-exist.json", "utf8");
} catch {
  assert.fail("Archive request should succeed, got 404");
}
assert.ok(!body.includes("nope"), "REGRESSION_EXPECTED_FAILURE: archived task reappeared");
`;

      const setup = await setupReproducedInvestigation();
      const docker = createHostEmulatingDocker();
      const feedbackSeen: (string | null)[] = [];

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
        generateRegressionTest: async (feedback) => {
          feedbackSeen.push(feedback);
          return regressionProposal(WRONG_ROUTE_TEST, "wrong-route-test");
        },
      });

      // Setup failure without the marker: invalid, refined once, then
      // truthfully unavailable — never blocking the replay-verified patch.
      expect(attempt.regressionTest?.prePatch).toBe("invalid_test");
      expect(attempt.regressionTest?.status).toBe("unavailable");
      expect(attempt.regressionTest?.generationAttempts).toBe(2);
      expect(attempt.outcome).toBe("verified");

      // The refinement feedback teaches the model what went wrong.
      expect(feedbackSeen).toHaveLength(2);
      expect(feedbackSeen[1]).toContain("invalid_test");
      expect(feedbackSeen[1]).toContain("REGRESSION_EXPECTED_FAILURE");
      expect(feedbackSeen[1]).toContain("not behavioral proof");
    },
  );

  test(
    "a regression test that still fails after the patch blocks verification",
    { timeout: 120_000 },
    async () => {
      const setup = await setupReproducedInvestigation();
      const docker = createHostEmulatingDocker();

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
        docker: docker.adapter,
        generateRegressionTest: async () =>
          regressionProposal(
            `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile("server.mjs", "utf8");
assert.ok(source.includes("unicorn"), "REGRESSION_EXPECTED_FAILURE: fails before AND after the patch");
`,
            "fails-both-sides-test",
          ),
      });

      expect(attempt.outcome).toBe("rejected_regression_test_failed");
      expect(attempt.regressionTest?.status).toBe("blocked");
      expect(attempt.regressionTest?.prePatch).toBe("failed_as_expected");
      expect(attempt.regressionTest?.postPatch).toBe("failed");
      expect(attempt.regressionTest?.hashMatched).toBe(true);

      // The generated test never remains in the workspace, even on rejection.
      await expect(
        stat(path.join(setup.repoPath, "sherlock-regression.test.mjs")),
      ).rejects.toThrow();
    },
  );
});

describe("fix proposal extraction and retry", () => {
  const validProposalJson = JSON.stringify(correctProposal());

  test("a valid direct JSON object succeeds on the first attempt", async () => {
    const direct = extractFixProposalJson(validProposalJson);
    expect(direct.ok).toBe(true);

    let calls = 0;
    const result = await requestValidProposal(async () => {
      calls += 1;
      return validProposalJson;
    });

    expect(calls).toBe(1);
    expect(result.parseError).toBeNull();
    expect(result.proposal).toMatchObject({ version: FIX_PROPOSAL_VERSION });
    expect(result.attempts).toHaveLength(1);
  });

  test("a fenced JSON object is extracted", () => {
    const fencedWithTag = extractFixProposalJson(
      `Looking at the bug, here is the fix:\n\n\`\`\`json\n${validProposalJson}\n\`\`\`\n`,
    );
    expect(fencedWithTag.ok).toBe(true);

    if (fencedWithTag.ok) {
      expect(fencedWithTag.value.version).toBe(FIX_PROPOSAL_VERSION);
    }

    const fencedPlain = extractFixProposalJson(`\`\`\`\n${validProposalJson}\n\`\`\``);
    expect(fencedPlain.ok).toBe(true);
  });

  test("prose, arrays, and JSON-encoded strings trigger exactly one retry", async () => {
    // Prose, a JSON array, and a double-encoded object are all rejected.
    for (const invalid of [
      "I suggest changing the login handler to return 401.",
      `[${validProposalJson}]`,
      JSON.stringify(validProposalJson),
    ]) {
      expect(extractFixProposalJson(invalid).ok).toBe(false);
    }

    const retryFeedback: (string | null)[] = [];
    const result = await requestValidProposal(async (retryError) => {
      retryFeedback.push(retryError);
      return retryFeedback.length === 1
        ? "Looking at the bug: the archive job has a circular reference."
        : validProposalJson;
    });

    expect(retryFeedback).toHaveLength(2);
    expect(retryFeedback[0]).toBeNull();
    expect(retryFeedback[1]).toContain("JSON object");
    expect(result.proposal).toMatchObject({ version: FIX_PROPOSAL_VERSION });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].error).not.toBeNull();
    expect(result.attempts[1].error).toBeNull();
  });

  test(
    "an invalid retry stays rejected and no patch is applied",
    { timeout: 60_000 },
    async () => {
      let calls = 0;
      const result = await requestValidProposal(async () => {
        calls += 1;
        return "Still prose, not JSON.";
      });

      expect(calls).toBe(2);
      expect(result.proposal).toBeNull();
      expect(result.parseError).not.toBeNull();
      expect(result.attempts).toHaveLength(2);

      // Feeding the failed result into the fix loop rejects before any
      // patch or restart happens and leaves the workspace untouched.
      const { repoPath, commit } = await createFixtureRepo();
      const investigationId = createInvestigationId();
      const artifactsRoot = await mkdtemp(path.join(tmpdir(), "sherlock-fix-artifacts-"));
      const store = await createArtifactStore(
        investigationId,
        path.join(artifactsRoot, investigationId),
      );
      const serverBefore = await readFile(path.join(repoPath, "server.mjs"), "utf8");
      let restartCalled = false;

      const attempt = await runFixAttempt({
        investigationId,
        investigationDir: store.dir,
        repoPath,
        sourceCommit: commit,
        plan: buildLoginPlan("http://localhost:39999"),
        originalOutcome: "reproduced",
        proposal: result.proposal,
        restart: async () => {
          restartCalled = true;
          return { ok: true };
        },
      });

      expect(attempt.outcome).toBe("rejected_patch_invalid");
      expect(restartCalled).toBe(false);
      expect(await readFile(path.join(repoPath, "server.mjs"), "utf8")).toBe(serverBefore);
    },
  );
});

describe("fix GitHub comments", () => {
  test("a verified fix produces a concise accurate comment", () => {
    const comment = formatFixComment({
      investigationId: "inv_123ABC456DEF",
      fixAttemptId: "fix_456DEF789GHJ",
      outcome: "verified",
      rootCause: "Missing user records were dereferenced in the login handler.",
      changedFiles: ["src/auth/login.ts"],
      verification: [
        "Original reproduction no longer fails",
        "Authentication tests passed",
        "1 file changed",
      ],
    });

    expect(comment).toContain("Sherlock verified a local fix.");
    expect(comment).toContain("Investigation: inv_123ABC456DEF");
    expect(comment).toContain("Fix attempt: fix_456DEF789GHJ");
    expect(comment).toContain("Outcome: verified");
    expect(comment).toContain("Changed: src/auth/login.ts");
    expect(comment).toContain("- Original reproduction no longer fails");
    expect(comment).not.toContain("No pull request was opened.");
  });

  test("a rejected fix comment explains the reason and redacts secrets", () => {
    const comment = formatFixComment({
      investigationId: "inv_123ABC456DEF",
      fixAttemptId: "fix_456DEF789GHJ",
      outcome: "rejected_tests_failed",
      reason:
        "2 authentication tests failed while DATABASE_URL=postgres://admin:hunter2@db/app was set",
    });

    expect(comment).toContain("Sherlock generated a fix, but verification failed.");
    expect(comment).toContain("Outcome: rejected_tests_failed");
    expect(comment).toContain("No pull request was opened.");
    expect(comment).not.toContain("hunter2");
    expect(comment).toContain("[REDACTED]");
  });
});
