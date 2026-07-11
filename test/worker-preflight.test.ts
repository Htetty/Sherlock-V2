// Worker preflight: mandatory/warning classification, safe output, and
// startup enforcement. Every external boundary (git, Docker, Redis,
// Playwright, filesystem, Graphify) is injected — nothing real is touched.
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  describeWorkerError,
  enforceStartupChecks,
  formatPreflightReport,
  runWorkerPreflight,
  type PreflightDeps,
  type PreflightReport,
} from "../backend/worker-preflight.js";

const SECRET_KEY = "sk-ant-veryverysecretvalue";
const SECRET_PEM = "secretpemmaterial";

const fullEnv = {
  APP_ID: "123456",
  ANTHROPIC_API_KEY: SECRET_KEY,
  PRIVATE_KEY: `-----BEGIN RSA PRIVATE KEY-----${SECRET_PEM}`,
  REDIS_URL: "redis://localhost:6379",
  // Matches the production compose wiring; the default fileExists (() =>
  // true) makes /.dockerenv look present, i.e. a containerized worker.
  SHERLOCK_SANDBOX_NETWORK: "sherlock-sandbox",
} as NodeJS.ProcessEnv;

// Docker sets a container's hostname to its short (12-hex) container id; the
// fake worker's full 64-hex id starts with it, as on a real daemon. Both full
// ids are constructed (not literal 64-hex strings) so secret scanners do not
// flag them.
const SELF_HOSTNAME = "0f3c9a1b2d4e";
const SELF_CONTAINER_ID = (SELF_HOSTNAME + "0123456789abcdef".repeat(4)).slice(0, 64);
const OTHER_CONTAINER_ID = "abcd0123".repeat(8);
const ATTACHED_CONTAINERS_JSON = JSON.stringify({
  [SELF_CONTAINER_ID]: { Name: "sherlock-worker-1" },
});
const OTHER_ONLY_CONTAINERS_JSON = JSON.stringify({
  [OTHER_CONTAINER_ID]: { Name: "some-other-container" },
});

// All commands succeed by default; individual tests break specific ones.
// `docker network inspect` reports the worker attached to the sandbox
// network, and identity comes from the short-id hostname (no cgroup file, as
// on macOS) — matching a healthy compose deployment.
function passingDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    env: fullEnv,
    runCommand: async (command, args) => {
      if (command === "docker" && args[0] === "network") {
        return { stdout: ATTACHED_CONTAINERS_JSON, stderr: "" };
      }
      return { stdout: "ok", stderr: "" };
    },
    pingRedis: async () => {},
    launchChromium: async () => {},
    checkWritableDir: async () => {},
    fileExists: () => true,
    hostname: () => SELF_HOSTNAME,
    readTextFile: () => {
      throw new Error("ENOENT: no such file or directory");
    },
    ...overrides,
  };
}

function statusOf(report: PreflightReport, name: string) {
  return report.checks.find((check) => check.name === name)?.status;
}

describe("worker preflight", () => {
  test("all mandatory checks pass and no secret values are printed", async () => {
    const report = await runWorkerPreflight(passingDeps());

    expect(report.ok).toBe(true);

    for (const name of [
      "env:APP_ID",
      "env:ANTHROPIC_API_KEY",
      "env:PRIVATE_KEY",
      "env:REDIS_URL",
      "git",
      "docker:cli",
      "docker:daemon",
      "docker:target-image",
      "sandbox:addressing",
      "redis",
      "playwright:chromium",
      "writable:artifacts-dir",
      "writable:data-dir",
      "writable:temp-dir",
      "graphify",
    ]) {
      expect(statusOf(report, name), name).toBe("PASS");
    }

    const rendered = formatPreflightReport(report);
    expect(rendered).toContain("PASS worker preflight");
    expect(rendered).not.toContain(SECRET_KEY);
    expect(rendered).not.toContain(SECRET_PEM);
  });

  test("missing env vars fail by name; PRIVATE_KEY_PATH is an accepted alternative", async () => {
    const missing = await runWorkerPreflight(
      passingDeps({
        env: { APP_ID: "123456", PRIVATE_KEY: "x" } as NodeJS.ProcessEnv,
      }),
    );

    expect(missing.ok).toBe(false);
    expect(statusOf(missing, "env:ANTHROPIC_API_KEY")).toBe("FAIL");
    // The default Redis behavior is clearly reported, not failed.
    const redisEnv = missing.checks.find((c) => c.name === "env:REDIS_URL");
    expect(redisEnv?.status).toBe("PASS");
    expect(redisEnv?.detail).toContain("default");

    // PRIVATE_KEY_PATH instead of PRIVATE_KEY: accepted when the file exists.
    const viaPath = await runWorkerPreflight(
      passingDeps({
        env: {
          ...fullEnv,
          PRIVATE_KEY: undefined,
          PRIVATE_KEY_PATH: "/etc/sherlock/key.pem",
        } as NodeJS.ProcessEnv,
        fileExists: (filePath) => filePath === "/etc/sherlock/key.pem",
      }),
    );
    expect(statusOf(viaPath, "env:PRIVATE_KEY")).toBe("PASS");

    const viaMissingPath = await runWorkerPreflight(
      passingDeps({
        env: {
          ...fullEnv,
          PRIVATE_KEY: undefined,
          PRIVATE_KEY_PATH: "/nope.pem",
        } as NodeJS.ProcessEnv,
        fileExists: () => false,
      }),
    );
    expect(statusOf(viaMissingPath, "env:PRIVATE_KEY")).toBe("FAIL");
    expect(viaMissingPath.ok).toBe(false);
  });

  test("Supabase state-store env is validated only when that mode is selected", async () => {
    // Not selected: no state-store check appears at all.
    const noStore = await runWorkerPreflight(passingDeps());
    expect(statusOf(noStore, "state-store:supabase")).toBeUndefined();

    // Selected but missing credentials: mandatory FAIL, names only.
    const missing = await runWorkerPreflight(
      passingDeps({
        env: { ...fullEnv, SHERLOCK_STATE_STORE: "supabase" } as NodeJS.ProcessEnv,
      }),
    );
    expect(statusOf(missing, "state-store:supabase")).toBe("FAIL");
    expect(missing.ok).toBe(false);
    const detail = missing.checks.find(
      (c) => c.name === "state-store:supabase",
    )?.detail;
    expect(detail).toContain("SUPABASE_URL");
    expect(detail).toContain("SUPABASE_SERVICE_ROLE_KEY");

    // Selected + configured: PASS. Placeholder credentials only.
    const configured = await runWorkerPreflight(
      passingDeps({
        env: {
          ...fullEnv,
          SHERLOCK_STATE_STORE: "supabase",
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "redact-me",
        } as NodeJS.ProcessEnv,
      }),
    );
    expect(statusOf(configured, "state-store:supabase")).toBe("PASS");
    expect(configured.ok).toBe(true);
  });

  test("git, Docker CLI, daemon, and target-image failures are mandatory failures", async () => {
    const gitMissing = await runWorkerPreflight(
      passingDeps({
        runCommand: async (command) => {
          if (command === "git") throw new Error("git: command not found");
          return { stdout: "ok", stderr: "" };
        },
      }),
    );
    expect(statusOf(gitMissing, "git")).toBe("FAIL");
    expect(gitMissing.ok).toBe(false);

    const cliMissing = await runWorkerPreflight(
      passingDeps({
        runCommand: async (command) => {
          if (command === "docker") throw new Error("docker: command not found");
          return { stdout: "ok", stderr: "" };
        },
      }),
    );
    expect(statusOf(cliMissing, "docker:cli")).toBe("FAIL");
    expect(statusOf(cliMissing, "docker:daemon")).toBe("FAIL");
    expect(statusOf(cliMissing, "docker:target-image")).toBe("FAIL");

    const daemonDown = await runWorkerPreflight(
      passingDeps({
        runCommand: async (command, args) => {
          if (command === "docker" && args[0] === "info") {
            throw new Error("Cannot connect to the Docker daemon");
          }
          return { stdout: "ok", stderr: "" };
        },
      }),
    );
    expect(statusOf(daemonDown, "docker:cli")).toBe("PASS");
    expect(statusOf(daemonDown, "docker:daemon")).toBe("FAIL");

    const imageUnavailable = await runWorkerPreflight(
      passingDeps({
        runCommand: async (command, args) => {
          if (command === "docker" && (args[0] === "image" || args[0] === "pull")) {
            throw new Error("pull access denied");
          }
          return { stdout: "ok", stderr: "" };
        },
      }),
    );
    expect(statusOf(imageUnavailable, "docker:target-image")).toBe("FAIL");
    expect(imageUnavailable.ok).toBe(false);
  });

  test("sandbox addressing: a containerized worker requires an existing shared sandbox network", async () => {
    // Containerized (default fileExists sees /.dockerenv) without the shared
    // network: mandatory failure naming the missing variable — this is the
    // exact misconfiguration that otherwise surfaces as probe timeouts.
    const containerizedNoNetwork = await runWorkerPreflight(
      passingDeps({
        env: { ...fullEnv, SHERLOCK_SANDBOX_NETWORK: undefined } as NodeJS.ProcessEnv,
      }),
    );
    expect(statusOf(containerizedNoNetwork, "sandbox:addressing")).toBe("FAIL");
    expect(containerizedNoNetwork.ok).toBe(false);
    expect(
      containerizedNoNetwork.checks.find((c) => c.name === "sandbox:addressing")?.detail,
    ).toContain("SHERLOCK_SANDBOX_NETWORK");

    // Network configured but missing on the daemon: mandatory failure.
    const networkMissing = await runWorkerPreflight(
      passingDeps({
        runCommand: async (command, args) => {
          if (command === "docker" && args[0] === "network") {
            throw new Error("network sherlock-sandbox not found");
          }
          return { stdout: "ok", stderr: "" };
        },
      }),
    );
    expect(statusOf(networkMissing, "sandbox:addressing")).toBe("FAIL");
    expect(networkMissing.ok).toBe(false);

    // Host-run worker (no /.dockerenv) without the variable: loopback
    // publishing is the correct mode, so this passes.
    const hostRun = await runWorkerPreflight(
      passingDeps({
        env: { ...fullEnv, SHERLOCK_SANDBOX_NETWORK: undefined } as NodeJS.ProcessEnv,
        fileExists: () => false,
      }),
    );
    expect(statusOf(hostRun, "sandbox:addressing")).toBe("PASS");
  });

  test("sandbox addressing: the network existing is not enough — the containerized worker must be attached to it", async () => {
    const inspectReturns = (stdout: string) =>
      async (command: string, args: string[]) => {
        if (command === "docker" && args[0] === "network") {
          return { stdout, stderr: "" };
        }
        return { stdout: "ok", stderr: "" };
      };

    // Network exists, other containers are attached, but not THIS worker:
    // mandatory failure telling the operator how to attach.
    const unattached = await runWorkerPreflight(
      passingDeps({ runCommand: inspectReturns(OTHER_ONLY_CONTAINERS_JSON) }),
    );
    expect(statusOf(unattached, "sandbox:addressing")).toBe("FAIL");
    expect(unattached.ok).toBe(false);
    const detail = unattached.checks.find((c) => c.name === "sandbox:addressing")?.detail;
    expect(detail).toContain("NOT attached");
    expect(detail).toContain("--network sherlock-sandbox");

    // Attached, identity from the 12-hex short-id hostname: PASS.
    // passingDeps models exactly this healthy deployment.
    const attached = await runWorkerPreflight(passingDeps());
    expect(statusOf(attached, "sandbox:addressing")).toBe("PASS");

    // Attached, identity from the full 64-hex id in /proc/self/cgroup: PASS
    // even under a custom (non-id) hostname.
    const viaCgroup = await runWorkerPreflight(
      passingDeps({
        hostname: () => "sherlock-worker-custom",
        readTextFile: () => `0::/system.slice/docker-${SELF_CONTAINER_ID}.scope\n`,
      }),
    );
    expect(statusOf(viaCgroup, "sandbox:addressing")).toBe("PASS");

    // Unreadable inspect output must never pass a containerized worker.
    const unreadable = await runWorkerPreflight(
      passingDeps({ runCommand: inspectReturns("not-json") }),
    );
    expect(statusOf(unreadable, "sandbox:addressing")).toBe("FAIL");

    // Host-run worker (not containerized) with the variable set: there is no
    // worker container to attach, so existence alone still passes.
    const hostRunWithNetwork = await runWorkerPreflight(
      passingDeps({
        fileExists: () => false,
        runCommand: async () => ({ stdout: "ok", stderr: "" }),
      }),
    );
    expect(statusOf(hostRunWithNetwork, "sandbox:addressing")).toBe("PASS");
  });

  test("sandbox addressing: identity must be proven by container id — names and short prefixes never pass", async () => {
    const inspectReturns = (stdout: string) =>
      async (command: string, args: string[]) => {
        if (command === "docker" && args[0] === "network") {
          return { stdout, stderr: "" };
        }
        return { stdout: "ok", stderr: "" };
      };

    // An unattached worker claiming another ATTACHED container's name via
    // SHERLOCK_CONTAINER_NAME must FAIL: a configurable name is not proof of
    // identity, so it is ignored and the check fails closed on the custom
    // hostname instead.
    const claimedName = await runWorkerPreflight(
      passingDeps({
        env: {
          ...fullEnv,
          SHERLOCK_CONTAINER_NAME: "some-other-container",
        } as NodeJS.ProcessEnv,
        hostname: () => "sherlock-worker-custom",
        runCommand: inspectReturns(OTHER_ONLY_CONTAINERS_JSON),
      }),
    );
    expect(statusOf(claimedName, "sandbox:addressing")).toBe("FAIL");
    expect(claimedName.ok).toBe(false);

    // A short hostname prefix (< 12 hex chars) is never accepted as a
    // container id, even when an attached container's id happens to start
    // with it.
    const shortPrefix = await runWorkerPreflight(
      passingDeps({ hostname: () => SELF_HOSTNAME.slice(0, 4) }),
    );
    expect(statusOf(shortPrefix, "sandbox:addressing")).toBe("FAIL");

    // Custom hostname with no readable cgroup id: fail closed with guidance
    // to use Docker's default hostname — never guess.
    const customHostname = await runWorkerPreflight(
      passingDeps({ hostname: () => "sherlock-worker-custom" }),
    );
    expect(statusOf(customHostname, "sandbox:addressing")).toBe("FAIL");
    const customDetail = customHostname.checks.find(
      (c) => c.name === "sandbox:addressing",
    )?.detail;
    expect(customDetail).toContain("Could not determine");
    expect(customDetail).toContain("default hostname");
  });

  test("manual docker run commands in the production-worker doc attach the sandbox network", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile(
      new URL("../docs/production-worker.md", import.meta.url),
      "utf8",
    );

    // Every documented docker run of the worker image must attach the
    // sandbox network, or the attachment preflight above fails at runtime.
    const workerRuns = doc
      .split(/```/)
      .filter((block) => block.includes("docker run") && block.includes("sherlock-worker"));
    expect(workerRuns.length).toBeGreaterThan(0);
    for (const block of workerRuns) {
      const runCommands = block
        .split(/\n(?=docker run)/)
        .filter((cmd) => cmd.startsWith("docker run"));
      expect(runCommands.length).toBeGreaterThan(0);
      for (const cmd of runCommands) {
        expect(cmd).toContain("--network sherlock-sandbox");
      }
    }
  });

  test("Redis, Playwright, and writable-directory failures are mandatory failures", async () => {
    const redisDown = await runWorkerPreflight(
      passingDeps({
        pingRedis: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
        },
      }),
    );
    expect(statusOf(redisDown, "redis")).toBe("FAIL");
    expect(redisDown.ok).toBe(false);

    const chromiumBroken = await runWorkerPreflight(
      passingDeps({
        launchChromium: async () => {
          throw new Error("browserType.launch: missing libraries");
        },
      }),
    );
    expect(statusOf(chromiumBroken, "playwright:chromium")).toBe("FAIL");

    // Each writable directory is independently mandatory.
    for (const [failDir, checkName] of [
      ["artifacts", "writable:artifacts-dir"],
      [".sherlock", "writable:data-dir"],
      [tmpdir(), "writable:temp-dir"],
    ] as const) {
      const report = await runWorkerPreflight(
        passingDeps({
          checkWritableDir: async (dir) => {
            if (dir.includes(failDir)) throw new Error("EACCES: permission denied");
          },
        }),
      );
      expect(statusOf(report, checkName), checkName).toBe("FAIL");
      expect(report.ok).toBe(false);
    }
  });

  test("missing graphify warns without failing the preflight", async () => {
    const report = await runWorkerPreflight(
      passingDeps({
        runCommand: async (command, args) => {
          if (command === "graphify") throw new Error("graphify: command not found");
          if (command === "docker" && args[0] === "network") {
            return { stdout: ATTACHED_CONTAINERS_JSON, stderr: "" };
          }
          return { stdout: "ok", stderr: "" };
        },
      }),
    );

    const graphify = report.checks.find((check) => check.name === "graphify");
    expect(graphify?.status).toBe("WARN");
    expect(graphify?.mandatory).toBe(false);
    expect(graphify?.detail).toContain("fall back");
    expect(report.ok).toBe(true);
    expect(formatPreflightReport(report)).toContain("WARN");
  });

  test("diagnostic details are redacted", async () => {
    const report = await runWorkerPreflight(
      passingDeps({
        pingRedis: async () => {
          throw new Error("connect failed for redis://admin:hunter2@redis-host:6379");
        },
      }),
    );

    const redis = report.checks.find((check) => check.name === "redis");
    expect(redis?.status).toBe("FAIL");
    expect(redis?.detail).not.toContain("hunter2");
    expect(redis?.detail).toContain("[REDACTED]");

    expect(describeWorkerError(new Error("auth failed: api_key=sk-livekey"))).not.toContain(
      "sk-livekey",
    );
  });

  test("startup enforcement: disabled preserves behavior, enabled exits before consuming jobs on failure", async () => {
    // Flag disabled: preflight never runs, worker proceeds as before.
    let preflightRuns = 0;
    let failures = 0;
    const failingPreflight = async (): Promise<PreflightReport> => {
      preflightRuns += 1;
      return {
        ok: false,
        checks: [
          { name: "redis", status: "FAIL", detail: "unreachable", mandatory: true },
        ],
      };
    };

    expect(
      await enforceStartupChecks({}, failingPreflight, () => {
        failures += 1;
      }),
    ).toBe(true);
    expect(preflightRuns).toBe(0);
    expect(failures).toBe(0);

    // Flag enabled + failing preflight: onFailure fires, worker must not start.
    const logs: string[] = [];
    expect(
      await enforceStartupChecks(
        { SHERLOCK_RUN_STARTUP_CHECKS: "true" },
        failingPreflight,
        () => {
          failures += 1;
        },
        (line) => logs.push(line),
      ),
    ).toBe(false);
    expect(preflightRuns).toBe(1);
    expect(failures).toBe(1);
    expect(logs.join("\n")).toContain("FAIL worker preflight");

    // Flag enabled + passing preflight: proceeds.
    expect(
      await enforceStartupChecks(
        { SHERLOCK_RUN_STARTUP_CHECKS: "true" },
        async () => ({ ok: true, checks: [] }),
        () => {
          failures += 1;
        },
      ),
    ).toBe(true);
    expect(failures).toBe(1);
  });
});
