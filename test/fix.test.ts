// Verified fix loop tests against a small git-backed fixture app with the
// login bug seeded in code (POST /api/login returns 500 instead of 401).
//
// ANTHROPIC_API_KEY is removed: proposals are injected, and the fix loop's
// imports never load the Claude client, proving verification runs without
// calling Claude.
delete process.env.ANTHROPIC_API_KEY;

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { createArtifactStore, createInvestigationId } from "../backend/services/artifacts.js";
import {
  FIX_PROPOSAL_VERSION,
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

async function createFixtureRepo() {
  const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-fix-repo-"));

  await writeFile(path.join(repoPath, "server.mjs"), BUGGY_SERVER, "utf8");
  await writeFile(path.join(repoPath, "check-login.mjs"), CHECK_LOGIN_TEST, "utf8");
  await writeFile(path.join(repoPath, "failing-test.mjs"), "process.exit(1);\n", "utf8");
  await writeFile(path.join(repoPath, ".env"), "SECRET_TOKEN=super-secret-value\n", "utf8");

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
async function setupReproducedInvestigation() {
  const { repoPath, commit } = await createFixtureRepo();
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
      const setup = await setupReproducedInvestigation();
      const before = await readOriginalArtifacts(setup.store.dir);

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal(),
        restart: setup.restart,
      });

      expect(attempt.outcome).toBe("verified");
      expect(attempt.postPatchOutcome).toBe("not_reproduced");
      expect(attempt.changedFiles).toEqual(["server.mjs"]);
      expect(attempt.fixAttemptId).toMatch(/^fix_[0-9A-Z]{10,}$/);
      expect(attempt.testRuns).toHaveLength(1);
      expect(attempt.testRuns[0].exitCode).toBe(0);

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
    "a patch that fixes the bug but breaks relevant tests is rejected_tests_failed",
    { timeout: 120_000 },
    async () => {
      const setup = await setupReproducedInvestigation();

      const attempt = await runFixAttempt({
        investigationId: setup.investigationId,
        investigationDir: setup.store.dir,
        repoPath: setup.repoPath,
        sourceCommit: setup.commit,
        plan: setup.plan,
        originalOutcome: setup.original.outcome,
        proposal: correctProposal({ relevantTests: ["node failing-test.mjs"] }),
        restart: setup.restart,
      });

      expect(attempt.outcome).toBe("rejected_tests_failed");
      // The reproduction itself did pass post-patch.
      expect(attempt.postPatchOutcome).toBe("not_reproduced");
      expect(attempt.testRuns[0].exitCode).not.toBe(0);
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
