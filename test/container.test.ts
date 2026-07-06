// Restricted-container execution: environment filtering, Docker argument
// construction, and short-lived command containers with guaranteed cleanup.
// All Docker interaction is faked through the adapter — no daemon required.
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  CONTAINER_DEFAULTS,
  buildContainerRunArgs,
  buildTargetEnv,
  getSandboxNetworkPolicy,
  isProtectedEnvName,
  runContainerCommand,
  sanitizeDockerCommand,
  type DockerAdapter,
} from "../backend/services/container.js";

type FakeProcess = ChildProcessWithoutNullStreams & {
  emitAndClose: (stdout: string, stderr: string, code: number) => void;
};

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  proc.emitAndClose = (stdout: string, stderr: string, code: number) => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.exitCode = code;
    proc.emit("close", code);
  };

  return proc as FakeProcess;
}

describe("target container environment", () => {
  test("worker secrets and protected names are excluded even when allowlisted", () => {
    const hostEnv = {
      ANTHROPIC_API_KEY: "sk-secret",
      REDIS_URL: "redis://internal:6379",
      GITHUB_TOKEN: "ghp_abc",
      WEBHOOK_SECRET: "hook-secret",
      PRIVATE_KEY: "-----BEGIN RSA-----",
      SMEE_URL: "https://smee.io/secret-channel",
      MY_DB_PASSWORD: "hunter2",
      CUSTOM_ACCESS_TOKEN: "tok",
      // Attempting to allowlist protected names must not work.
      SHERLOCK_TARGET_ENV_ALLOWLIST:
        "ANTHROPIC_API_KEY,REDIS_URL,GITHUB_TOKEN,MY_DB_PASSWORD,CUSTOM_ACCESS_TOKEN,FEATURE_FLAG",
      FEATURE_FLAG: "on",
      UNRELATED_HOST_VAR: "should-not-leak",
    } as NodeJS.ProcessEnv;

    const env = buildTargetEnv({ port: 51234 }, hostEnv);

    // Required safe variables are always present.
    expect(env.PORT).toBe("51234");
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.NODE_ENV).toBe("development");

    // Explicitly allowed safe variable passes through.
    expect(env.FEATURE_FLAG).toBe("on");

    // Protected names never pass, allowlisted or not.
    for (const name of [
      "ANTHROPIC_API_KEY",
      "REDIS_URL",
      "GITHUB_TOKEN",
      "WEBHOOK_SECRET",
      "PRIVATE_KEY",
      "SMEE_URL",
      "MY_DB_PASSWORD",
      "CUSTOM_ACCESS_TOKEN",
    ]) {
      expect(env).not.toHaveProperty(name);
    }

    // The rest of process.env never leaks: only the constructed keys exist.
    expect(env).not.toHaveProperty("UNRELATED_HOST_VAR");
    expect(Object.keys(env).sort()).toEqual(
      ["FEATURE_FLAG", "HOME", "HOST", "NODE_ENV", "PORT"].sort(),
    );

    // Category matcher covers name variants.
    expect(isProtectedEnvName("SOME_API_KEY")).toBe(true);
    expect(isProtectedEnvName("app_secret")).toBe(true);
    expect(isProtectedEnvName("USER_PASSWORD")).toBe(true);
    expect(isProtectedEnvName("SSH_PRIVATE_KEY")).toBe(true);
    expect(isProtectedEnvName("FEATURE_FLAG")).toBe(false);
  });

  test("docker arguments enforce resource, privilege, user, mount, and network restrictions", () => {
    const args = buildContainerRunArgs({
      containerName: "sherlock-test-abc",
      workspacePath: "/Users/someone/workspaces/repo",
      env: { PORT: "51234" },
      command: ["npm", "test"],
      portMapping: { hostPort: 51234, containerPort: 3000 },
    });

    for (const required of [
      "--rm",
      "--cpus=1",
      "--memory=1g",
      "--pids-limit=256",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--user=${CONTAINER_DEFAULTS.user}`,
      "--read-only",
    ]) {
      expect(args).toContain(required);
    }

    // Only the workspace is mounted, read-write, at /app.
    const volumeFlags = args.filter((arg) => arg === "-v");
    expect(volumeFlags).toHaveLength(1);
    expect(args[args.indexOf("-v") + 1]).toBe("/Users/someone/workspaces/repo:/app");

    // Port mapping binds localhost only; host networking is never used.
    expect(args[args.indexOf("-p") + 1]).toBe("127.0.0.1:51234:3000");
    expect(args.join(" ")).not.toContain("--network=host");
    expect(args.join(" ")).not.toContain("docker.sock");

    // Command argv comes after the image — never a shell string.
    expect(args.slice(-2)).toEqual(["npm", "test"]);

    // Sanitized rendering elides the local absolute workspace path.
    const sanitized = sanitizeDockerCommand(args, "/Users/someone/workspaces/repo");
    expect(sanitized).toContain("<workspace>:/app");
    expect(sanitized).not.toContain("/Users/someone");
  });
});

describe("short-lived command containers", () => {
  function createAdapter(process: FakeProcess) {
    const removed: string[] = [];
    const spawned: string[][] = [];

    const adapter: DockerAdapter = {
      isAvailable: async () => true,
      spawnContainer: (args) => {
        spawned.push(args);
        return process;
      },
      removeContainer: async (name) => {
        removed.push(name);
      },
    };

    return { adapter, removed, spawned };
  }

  test("preserves exit code, stdout, stderr, and duration, and cleans up on completion", async () => {
    const proc = createFakeProcess();
    const { adapter, removed, spawned } = createAdapter(proc);

    const pending = runContainerCommand(adapter, {
      purpose: "test",
      workspacePath: "/tmp/ws",
      env: buildTargetEnv(),
      command: ["npm", "test"],
      timeoutMs: 5_000,
    });

    proc.emitAndClose("test output", "warnings", 3);
    const result = await pending;

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("test output");
    expect(result.stderr).toBe("warnings");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.sanitizedCommand).toContain("docker run");
    expect(result.sanitizedCommand).not.toContain("/tmp/ws");

    // Explicit rm -f backstop even on normal completion.
    const containerName = spawned[0][spawned[0].indexOf("--name") + 1];
    expect(containerName).toMatch(/^sherlock-test-/);
    expect(removed).toContain(containerName);
  });

  test("timeout forces container removal and reports timed-out state", async () => {
    const proc = createFakeProcess();
    const { adapter, removed, spawned } = createAdapter(proc);

    // Never emits "close": only the timeout path can resolve it.
    const result = await runContainerCommand(adapter, {
      purpose: "install",
      workspacePath: "/tmp/ws",
      env: buildTargetEnv(),
      command: ["npm", "install"],
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect((proc as any).killed).toBe(true);

    const containerName = spawned[0][spawned[0].indexOf("--name") + 1];
    expect(removed).toContain(containerName);
  });
});

describe("sandbox network policy", () => {
  test("strict is the default; invalid values fall back to strict with a warning", () => {
    expect(getSandboxNetworkPolicy({})).toBe("strict");
    expect(getSandboxNetworkPolicy({ SHERLOCK_SANDBOX_NETWORK_POLICY: "strict" })).toBe(
      "strict",
    );
    expect(
      getSandboxNetworkPolicy({ SHERLOCK_SANDBOX_NETWORK_POLICY: "permissive" }),
    ).toBe("permissive");

    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

    try {
      expect(
        getSandboxNetworkPolicy({ SHERLOCK_SANDBOX_NETWORK_POLICY: "wide-open" }),
      ).toBe("strict");
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.join("\n")).toContain("wide-open");
    expect(warnings.join("\n")).toContain("strict");
  });

  test("network argument construction: none, app-netns join, and add-host suppression", () => {
    const base = {
      containerName: "sherlock-test-x",
      workspacePath: "/tmp/ws",
      env: { CI: "true" },
      command: ["node", "t.mjs"],
    };

    // No network option: no --network flag (Docker default bridge — install
    // containers and the app container rely on this).
    expect(buildContainerRunArgs(base).join(" ")).not.toContain("--network");

    // Isolated command container.
    const none = buildContainerRunArgs({ ...base, network: "none" });
    expect(none).toContain("--network=none");

    // Regression container joining the app's network namespace: single
    // argv token, no shell, and --add-host must be suppressed (it conflicts
    // with a container-mode netns).
    const joined = buildContainerRunArgs({
      ...base,
      network: { joinContainer: "sherlock-app-abc" },
      addHostGateway: true,
    });
    expect(joined).toContain("--network=container:sherlock-app-abc");
    expect(joined.join(" ")).not.toContain("--add-host");

    // The restriction set is independent of the network mode.
    for (const args of [none, joined]) {
      expect(args).toContain("--cap-drop=ALL");
      expect(args).toContain("--read-only");
      expect(args).toContain(`--user=${CONTAINER_DEFAULTS.user}`);
    }
  });
});
