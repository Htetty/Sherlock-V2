// Container-only sandbox: target installation and startup always go through
// the Docker adapter (never the host), the base URL always stays on the
// allocated dynamic host port, and hardcoded-port apps are exposed through a
// second restricted container mapping. All container behavior is simulated
// through the injected adapter — no Docker daemon required.
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CONTAINER_DEFAULTS } from "../backend/services/container.js";
import {
  runSandboxInvestigation,
  SandboxUnreachableError,
  type DockerAdapter,
} from "../backend/services/sandbox.js";

async function createFixtureRepo() {
  const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-sandbox-"));

  await writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "sandbox-fixture",
      version: "1.0.0",
      scripts: { start: "node server.js" },
    }),
    "utf8",
  );
  await writeFile(path.join(repoPath, "server.js"), "// fixture", "utf8");
  await mkdir(path.join(repoPath, ".git"), { recursive: true });
  await writeFile(path.join(repoPath, ".git", "config"), "[core]\n", "utf8");

  return repoPath;
}

function createFakeProcess(stdout = "") {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.kill = () => true;

  if (stdout) {
    setImmediate(() => proc.stdout.emit("data", Buffer.from(stdout)));
  }

  return proc as ChildProcessWithoutNullStreams;
}

// Fake daemon: command containers (install/test) exit successfully right
// away; app containers stay "running" and emit the scripted log output.
function createFakeDocker(appLogsByAttempt: string[] = []) {
  const spawned: string[][] = [];
  const removed: string[] = [];
  let appAttempt = 0;

  const adapter: DockerAdapter = {
    isAvailable: async () => true,
    spawnContainer: (args) => {
      spawned.push(args);
      const name = args[args.indexOf("--name") + 1];

      if (name.startsWith("sherlock-app-")) {
        const logs = appLogsByAttempt[appAttempt] ?? "";
        appAttempt += 1;
        return createFakeProcess(logs);
      }

      // Short-lived command container (e.g. npm install): succeed.
      const proc = createFakeProcess();
      setImmediate(() => proc.emit("close", 0));
      return proc;
    },
    removeContainer: async (name) => {
      removed.push(name);
    },
  };

  return { adapter, spawned, removed };
}

function appContainers(spawned: string[][]) {
  return spawned.filter(
    (args) => args[args.indexOf("--name") + 1].startsWith("sherlock-app-"),
  );
}

function mountedWorkspace(args: string[]) {
  const volume = args[args.indexOf("-v") + 1];
  return volume.slice(0, volume.lastIndexOf(":"));
}

describe("container-only sandbox", () => {
  test("Docker unavailable returns an environment failure and never executes anything", async () => {
    const repoPath = await createFixtureRepo();
    let spawnCalls = 0;

    const unavailable: DockerAdapter = {
      isAvailable: async () => false,
      spawnContainer: () => {
        spawnCalls += 1;
        throw new Error("must not spawn when Docker is unavailable");
      },
      removeContainer: async () => {},
    };

    let caught: Error | null = null;

    try {
      await runSandboxInvestigation({ repoPath, docker: unavailable });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(SandboxUnreachableError);
    expect(caught?.message).toContain("Docker is not available");
    expect(caught?.message).toContain("only ever run inside isolated containers");
    expect(spawnCalls).toBe(0);
  });

  test("installation and startup run in restricted containers on the allocated dynamic port", async () => {
    const repoPath = await createFixtureRepo();
    const { adapter, spawned } = createFakeDocker([""]);
    const probedUrls: string[] = [];

    const session = await runSandboxInvestigation({
      repoPath,
      docker: adapter,
      probe: async (url) => {
        probedUrls.push(url);
        return true;
      },
    });

    // npm install ran in its own short-lived container.
    const install = spawned[0];
    expect(install[install.indexOf("--name") + 1]).toMatch(/^sherlock-install-/);
    expect(install.slice(-2)).toEqual(["npm", "install"]);
    const installWorkspace = mountedWorkspace(install);
    expect(installWorkspace).not.toBe(repoPath);
    await expect(access(path.join(installWorkspace, ".git"))).rejects.toThrow();

    // The app container maps <allocated>:<allocated> with PORT injected.
    const app = appContainers(spawned)[0];
    expect(mountedWorkspace(app)).toBe(installWorkspace);
    const hostPort = session.result.hostPort!;
    expect(hostPort).not.toBe(3000);
    expect(hostPort).not.toBe(4000);
    expect(app[app.indexOf("-p") + 1]).toBe(`127.0.0.1:${hostPort}:${hostPort}`);
    expect(app.join(" ")).toContain(`-e PORT=${hostPort}`);

    // Both containers carry the full restriction set.
    for (const args of [install, app]) {
      for (const flag of [
        "--rm",
        "--cpus=1",
        "--memory=1g",
        "--pids-limit=256",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        `--user=${CONTAINER_DEFAULTS.user}`,
        "--read-only",
      ]) {
        expect(args).toContain(flag);
      }
    }

    // Network policy: the dependency install MUST keep outbound network
    // (package registries), and the app container stays on the default
    // bridge because the localhost-only published port requires it.
    expect(install.join(" ")).not.toContain("--network");
    expect(app.join(" ")).not.toContain("--network");
    expect(app[app.indexOf("-p") + 1]).toMatch(/^127\.0\.0\.1:/);

    // The app container's identity is exposed for strict-network regression
    // containers to join.
    expect(session.result.containerName).toMatch(/^sherlock-app-/);

    // Probing and the base URL use the allocated host port only.
    expect(probedUrls[0]).toBe(`http://localhost:${hostPort}`);
    expect(session.result.baseUrl).toBe(`http://localhost:${hostPort}`);
    expect(session.result.strategy).toBe("container-dynamic-port");

    // Persisted command info stays sanitized.
    expect(session.result.command).toContain("<workspace>");
    expect(session.result.command).not.toContain(repoPath);

    await session.stop();
  });

  test("hardcoded-port apps are remapped: first container removed, same host port mapped to the detected internal port", async () => {
    const repoPath = await createFixtureRepo();
    const { adapter, spawned, removed } = createFakeDocker([
      "Taskboard running on http://localhost:3000",
      "Taskboard running on http://localhost:3000",
    ]);

    let probeCount = 0;
    const session = await runSandboxInvestigation({
      repoPath,
      startupTimeoutMs: 1_000,
      docker: adapter,
      // First attempt unreachable (app ignored PORT), second reachable. The
      // yield lets the fake container flush its scripted log output first,
      // like a real container streaming logs during the probe window.
      probe: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        probeCount += 1;
        return probeCount > 1;
      },
    });

    const apps = appContainers(spawned);
    expect(apps).toHaveLength(2);

    const hostPort = session.result.hostPort!;
    const firstName = apps[0][apps[0].indexOf("--name") + 1];

    // First (failed) container was stopped and force-removed before retry.
    expect(removed).toContain(firstName);

    // Second container maps the SAME allocated host port to detected 3000.
    expect(apps[1][apps[1].indexOf("-p") + 1]).toBe(`127.0.0.1:${hostPort}:3000`);
    expect(apps[1].join(" ")).toContain("PORT=3000");

    // The logged fixed port never becomes the public base URL.
    expect(session.result.baseUrl).toBe(`http://localhost:${hostPort}`);
    expect(hostPort).not.toBe(3000);
    expect(session.result.strategy).toBe("container-fixed-port");
    expect(session.result.internalPort).toBe(3000);

    await session.stop();
  });

  test("returns environment failure when no internal port can be detected from the failed container", async () => {
    const repoPath = await createFixtureRepo();
    const { adapter } = createFakeDocker(["app started, no port in logs"]);

    let caught: Error | null = null;

    try {
      await runSandboxInvestigation({
        repoPath,
        startupTimeoutMs: 500,
        docker: adapter,
        probe: async () => false,
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(SandboxUnreachableError);
    expect(caught?.message).toContain("no fixed internal port could be detected");
    expect(caught?.message).toContain("Attempted command: docker run");
    expect(caught?.message).not.toContain(repoPath);
  });

  test("does not treat database/cache ports as app listener ports", async () => {
    const repoPath = await createFixtureRepo();
    const { adapter } = createFakeDocker([
      "Postgres connection failed at postgres://localhost:5432\nRedis unavailable on port 6379",
    ]);

    let caught: Error | null = null;

    try {
      await runSandboxInvestigation({
        repoPath,
        startupTimeoutMs: 500,
        docker: adapter,
        probe: async () => false,
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(SandboxUnreachableError);
    expect(caught?.message).toContain("no fixed internal port could be detected");
  });

  test("network addressing: the app joins the shared sandbox network and the base URL targets the container name, with no host port published", async () => {
    const repoPath = await createFixtureRepo();
    const { adapter, spawned } = createFakeDocker([""]);
    const probedUrls: string[] = [];

    const session = await runSandboxInvestigation({
      repoPath,
      docker: adapter,
      // The containerized production worker: sibling containers are only
      // reachable over the shared sandbox network, never via localhost.
      containerized: true,
      addressing: { mode: "network", network: "sherlock-sandbox" },
      probe: async (url) => {
        probedUrls.push(url);
        return true;
      },
    });

    // Install containers keep the default bridge (they need registries, not
    // the worker), while the app container attaches to the sandbox network.
    const install = spawned[0];
    expect(install.join(" ")).not.toContain("--network");

    const app = appContainers(spawned)[0];
    expect(app).toContain("--network=sherlock-sandbox");

    // Nothing is published on the Docker host.
    expect(app).not.toContain("-p");

    // The worker probes the app container by name over the shared network.
    const containerName = app[app.indexOf("--name") + 1];
    const hostPort = session.result.hostPort!;
    expect(session.result.baseUrl).toBe(`http://${containerName}:${hostPort}`);
    expect(probedUrls[0]).toBe(`http://${containerName}:${hostPort}`);
    expect(app.join(" ")).toContain(`-e PORT=${hostPort}`);

    // The restriction set is unchanged by the addressing mode.
    for (const flag of ["--cap-drop=ALL", "--read-only", `--user=${CONTAINER_DEFAULTS.user}`]) {
      expect(app).toContain(flag);
    }

    await session.stop();
  });

  test("network addressing: hardcoded-port apps are reached at the detected internal port on the container name", async () => {
    const repoPath = await createFixtureRepo();
    const { adapter, spawned, removed } = createFakeDocker([
      "Taskboard running on http://localhost:3000",
      "Taskboard running on http://localhost:3000",
    ]);

    let probeCount = 0;
    const session = await runSandboxInvestigation({
      repoPath,
      startupTimeoutMs: 1_000,
      docker: adapter,
      containerized: true,
      addressing: { mode: "network", network: "sherlock-sandbox" },
      probe: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        probeCount += 1;
        return probeCount > 1;
      },
    });

    const apps = appContainers(spawned);
    expect(apps).toHaveLength(2);
    expect(removed).toContain(apps[0][apps[0].indexOf("--name") + 1]);

    // Second attempt: same sandbox network, PORT is the detected fixed port,
    // and the base URL targets it directly on the new container's name.
    const secondName = apps[1][apps[1].indexOf("--name") + 1];
    expect(apps[1]).toContain("--network=sherlock-sandbox");
    expect(apps[1]).not.toContain("-p");
    expect(apps[1].join(" ")).toContain("PORT=3000");
    expect(session.result.baseUrl).toBe(`http://${secondName}:3000`);
    expect(session.result.strategy).toBe("container-fixed-port");

    await session.stop();
  });

  test("a containerized worker without a sandbox network fails fast with the misconfiguration, not a probe timeout", async () => {
    const repoPath = await createFixtureRepo();
    const { adapter, spawned } = createFakeDocker([""]);

    let caught: Error | null = null;

    try {
      await runSandboxInvestigation({
        repoPath,
        docker: adapter,
        containerized: true,
        addressing: { mode: "host" },
        probe: async () => true,
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(SandboxUnreachableError);
    expect(caught?.message).toContain("SHERLOCK_SANDBOX_NETWORK");
    expect(caught?.message).toContain("cannot reach sibling target-app containers");
    // Nothing was executed against the misconfigured environment.
    expect(spawned).toHaveLength(0);
  });

  test("retries with a new runtime workspace when Docker reports a host-port bind conflict", async () => {
    const repoPath = await createFixtureRepo();
    const { adapter, spawned } = createFakeDocker([
      "docker: Error response from daemon: Bind for 127.0.0.1 failed: port is already allocated",
      "",
    ]);
    let probeCount = 0;

    const session = await runSandboxInvestigation({
      repoPath,
      startupTimeoutMs: 500,
      docker: adapter,
      probe: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        probeCount += 1;
        return probeCount > 1;
      },
    });

    const installs = spawned.filter((args) =>
      args[args.indexOf("--name") + 1].startsWith("sherlock-install-"),
    );
    expect(installs).toHaveLength(2);
    expect(mountedWorkspace(installs[0])).not.toBe(mountedWorkspace(installs[1]));

    await session.stop();
  });
});
