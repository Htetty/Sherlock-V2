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
} as NodeJS.ProcessEnv;

// All commands succeed by default; individual tests break specific ones.
function passingDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    env: fullEnv,
    runCommand: async () => ({ stdout: "ok", stderr: "" }),
    pingRedis: async () => {},
    launchChromium: async () => {},
    checkWritableDir: async () => {},
    fileExists: () => true,
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
        runCommand: async (command) => {
          if (command === "graphify") throw new Error("graphify: command not found");
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
