// Restricted Docker execution for target-repository commands.
//
// Security rule: no command originating from a target repository (installs,
// app startup, builds, tests, package scripts) may run directly on the
// Sherlock host. Everything goes through `docker run` with argument arrays
// (never shell strings), resource limits, dropped capabilities, a non-root
// user, and a read-only root filesystem.
//
// Filesystem model:
// - `--read-only` protects the container's root filesystem.
// - a short-lived .git-less runtime copy is mounted read-write at /app because
//   dependency installation, builds, and patch verification must write there.
// - /tmp is a tmpfs so npm has a writable HOME/cache.
// - nothing else is mounted: no Sherlock repo, worker home, Docker socket,
//   SSH/git credentials, or host env files.
//
// Known remaining risks (documented, accepted for the MVP):
// - outbound networking stays enabled so `npm install` works; a malicious
//   package can exfiltrate whatever is inside the container (the mounted
//   workspace and the filtered env).
// - containers talk to the host's Docker daemon via the CLI; the daemon
//   itself is trusted infrastructure.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { appendBoundedText } from "./bounded-text.js";

const execFileAsync = promisify(execFile);

const DOCKER_CHECK_TIMEOUT_MS = 5_000;
const MAX_CONTAINER_OUTPUT_CHARS = 256 * 1024;

export const CONTAINER_WORKDIR = "/app";

export const CONTAINER_DEFAULTS = {
  image: process.env.SHERLOCK_TARGET_IMAGE ?? "node:20-slim",
  cpus: "1",
  memory: "1g",
  pidsLimit: "256",
  user: "node",
};

// --- Sandbox outbound network policy -----------------------------------------
//
// Phases differ in what network they legitimately need:
// - dependency install: outbound network (package registries) — always.
// - app runtime: default bridge under host addressing (localhost-only port
//   publishing, -p 127.0.0.1:..., does not work without it), or the shared
//   sandbox bridge network under network addressing (see SandboxAddressing).
//   Either way its outbound access is a DOCUMENTED LIMITATION of the strict
//   policy.
// - repository-validation commands: no network at all under strict.
// - generated regression tests: under strict they either get no network
//   (no app access needed) or join the app container's network namespace
//   (--network=container:<app>), which lets them reach the target app at
//   localhost:<internal port> without a network path of their own.
//
// permissive preserves the previous behavior everywhere for local debugging
// or environments where these Docker options are unsupported.

export type SandboxNetworkPolicy = "strict" | "permissive";

export function getSandboxNetworkPolicy(
  env: NodeJS.ProcessEnv = process.env,
): SandboxNetworkPolicy {
  const value = env.SHERLOCK_SANDBOX_NETWORK_POLICY ?? "strict";

  if (value === "strict" || value === "permissive") {
    return value;
  }

  // Fail safe: an unknown value falls back to the SECURE default.
  console.warn(
    `Unknown SHERLOCK_SANDBOX_NETWORK_POLICY "${value}"; falling back to "strict".`,
  );
  return "strict";
}

// Explicit network configuration for a container. Absent means the Docker
// default (bridge) — required for installs and the published app port.
export type ContainerNetwork =
  | "none"
  | { joinContainer: string }
  | { attachNetwork: string };

// --- Sandbox addressing -------------------------------------------------------
//
// How the worker reaches the target application:
// - "host" (default): the app container publishes its port on the host
//   loopback and the worker probes http://localhost:<hostPort>. Correct only
//   when the worker process runs directly on the Docker host (local dev).
// - "network": SHERLOCK_SANDBOX_NETWORK names a Docker bridge network shared
//   by the worker container and every target app container. The app publishes
//   NO host port; the worker probes http://<containerName>:<port> over that
//   network via Docker DNS. Required when the worker itself runs in a
//   container (docker-compose.prod.yml): its localhost is the worker
//   container, not the Docker host, so host mode can never reach a sibling.
//   Only the worker and short-lived target containers attach to this network;
//   Sherlock's api/redis must stay off it so target code cannot reach them.

export type SandboxAddressing =
  | { mode: "host" }
  | { mode: "network"; network: string };

export function getSandboxAddressing(
  env: NodeJS.ProcessEnv = process.env,
): SandboxAddressing {
  const network = (env.SHERLOCK_SANDBOX_NETWORK ?? "").trim();

  return network === "" ? { mode: "host" } : { mode: "network", network };
}

// A containerized worker left in host mode fails every probe with an opaque
// timeout; detecting the situation lets the sandbox fail with the real cause.
// SHERLOCK_WORKER_CONTAINERIZED overrides in either direction; otherwise the
// Docker-created /.dockerenv marker decides.
export function isContainerizedWorker(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): boolean {
  if (env.SHERLOCK_WORKER_CONTAINERIZED === "true") {
    return true;
  }

  if (env.SHERLOCK_WORKER_CONTAINERIZED === "false") {
    return false;
  }

  return fileExists("/.dockerenv");
}

// --- Target environment construction ----------------------------------------
//
// The worker's process.env is NEVER passed through. Only the variables built
// here reach the target container: required safe variables plus names the
// operator explicitly allowlisted via SHERLOCK_TARGET_ENV_ALLOWLIST — and
// even allowlisted names are refused when they look secret-bearing or belong
// to Sherlock's own configuration.

const PROTECTED_ENV_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "REDIS_URL",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "INSTALLATION_TOKEN",
  "PRIVATE_KEY",
  "PRIVATE_KEY_PATH",
  "WEBHOOK_SECRET",
  "WEBHOOK_PROXY_URL",
  "SMEE_URL",
  "APP_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
]);

const PROTECTED_ENV_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|APIKEY|CREDENTIAL|AUTH)/i;

export function isProtectedEnvName(name: string): boolean {
  const upper = name.toUpperCase();

  return PROTECTED_ENV_NAMES.has(upper) || PROTECTED_ENV_PATTERN.test(upper);
}

export type TargetEnvOptions = {
  // Omitted for command containers (installs/tests) that serve no traffic.
  port?: number;
  nodeEnv?: string;
  extra?: Record<string, string>;
};

export function buildTargetEnv(
  options: TargetEnvOptions = {},
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    // Inside a container the app must bind all interfaces for the port
    // mapping to reach it; the mapping itself only exposes localhost:<port>.
    HOST: "0.0.0.0",
    NODE_ENV: options.nodeEnv ?? "development",
    // Writable HOME on the tmpfs so npm can use its cache under --read-only.
    HOME: "/tmp",
  };

  if (options.port !== undefined) {
    env.PORT = String(options.port);
  }

  const allowlist = (hostEnv.SHERLOCK_TARGET_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  for (const name of allowlist) {
    if (isProtectedEnvName(name)) {
      console.warn(
        `Refusing to pass protected variable "${name}" to the target container despite the allowlist.`,
      );
      continue;
    }

    const value = hostEnv[name];

    if (value !== undefined) {
      env[name] = value;
    }
  }

  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (!isProtectedEnvName(name)) {
      env[name] = value;
    }
  }

  return env;
}

// --- Docker argument construction --------------------------------------------

export type ContainerRunSpec = {
  containerName: string;
  workspacePath: string;
  // Mount the workspace read-only at /app (fable/16 run_code explorer). The
  // Docker :ro mount is the security boundary for generated exploration code
  // — never a post-hoc git rollback.
  workspaceReadOnly?: boolean;
  env: Record<string, string>;
  command: string[]; // argv executed in the container, e.g. ["npm", "install"]
  portMapping?: { hostPort: number; containerPort: number };
  image?: string;
  // Container user override (default CONTAINER_DEFAULTS.user). The explorer
  // image may not define the "node" user; non-root is still required.
  user?: string;
  // Adds the Docker host-gateway alias so a verification container can reach
  // the sandbox application published on the host's localhost. Adds a DNS
  // name only — no host networking, and the restriction set is unchanged.
  // Mutually exclusive with `network` (a container-mode netns rejects
  // --add-host, and none needs no gateway).
  addHostGateway?: boolean;
  // Outbound network restriction; absent = Docker default bridge.
  network?: ContainerNetwork;
};

export function buildContainerRunArgs(spec: ContainerRunSpec): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    spec.containerName,
    `--cpus=${CONTAINER_DEFAULTS.cpus}`,
    `--memory=${CONTAINER_DEFAULTS.memory}`,
    `--pids-limit=${CONTAINER_DEFAULTS.pidsLimit}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${spec.user ?? CONTAINER_DEFAULTS.user}`,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=512m",
    "-v",
    `${spec.workspacePath}:${CONTAINER_WORKDIR}${spec.workspaceReadOnly ? ":ro" : ""}`,
    "-w",
    CONTAINER_WORKDIR,
  ];

  if (spec.portMapping) {
    args.push(
      "-p",
      `127.0.0.1:${spec.portMapping.hostPort}:${spec.portMapping.containerPort}`,
    );
  }

  if (spec.network === "none") {
    args.push("--network=none");
  } else if (spec.network && "joinContainer" in spec.network) {
    args.push(`--network=container:${spec.network.joinContainer}`);
  } else if (spec.network) {
    args.push(`--network=${spec.network.attachNetwork}`);
  }

  // --add-host is invalid with a container-mode netns and pointless with
  // none; only emit it on the default bridge.
  if (spec.addHostGateway && !spec.network) {
    args.push("--add-host=host.docker.internal:host-gateway");
  }

  for (const [name, value] of Object.entries(spec.env)) {
    args.push("-e", `${name}=${value}`);
  }

  args.push(spec.image ?? CONTAINER_DEFAULTS.image, ...spec.command);
  return args;
}

// Safe-to-log/persist rendering: local absolute workspace paths are elided
// (env values here are already secret-filtered by buildTargetEnv).
export function sanitizeDockerCommand(args: string[], workspacePath: string): string {
  return ["docker", ...args]
    .join(" ")
    .split(workspacePath)
    .join("<workspace>");
}

// --- Docker adapter -----------------------------------------------------------
//
// All Docker interaction goes through this adapter so tests can simulate
// container behavior without a daemon. The real adapter uses argv APIs
// exclusively — no shell strings anywhere.

export type DockerAdapter = {
  isAvailable: () => Promise<boolean>;
  spawnContainer: (args: string[]) => ChildProcessWithoutNullStreams;
  removeContainer: (containerName: string) => Promise<void>;
};

export const realDockerAdapter: DockerAdapter = {
  isAvailable: async () => {
    try {
      await execFileAsync("docker", ["info"], { timeout: DOCKER_CHECK_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  },
  spawnContainer: (args) => spawn("docker", args),
  removeContainer: async (containerName) => {
    await execFileAsync("docker", ["rm", "-f", containerName], {
      timeout: 30_000,
    });
  },
};

// --- Live-container registry ---------------------------------------------------
//
// Every started container registers here so SIGINT/SIGTERM (worker shutdown)
// can force-remove anything still running, even mid-investigation.

const liveContainers = new Map<string, DockerAdapter>();

export function trackContainer(name: string, docker: DockerAdapter) {
  liveContainers.set(name, docker);
}

export function untrackContainer(name: string) {
  liveContainers.delete(name);
}

export async function cleanupAllContainers(): Promise<string[]> {
  const cleaned: string[] = [];

  for (const [name, docker] of [...liveContainers.entries()]) {
    await docker.removeContainer(name).catch(() => {});
    liveContainers.delete(name);
    cleaned.push(name);
  }

  return cleaned;
}

export function createContainerName(purpose: string) {
  return `sherlock-${purpose}-${randomUUID()}`;
}

// --- Short-lived command containers ---------------------------------------------
//
// Installs, builds, and verification test commands each run in their own
// fresh container (same image, mount, env policy, restrictions) so they
// never contaminate the running application container.

export type ContainerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  sanitizedCommand: string;
};

export async function runContainerCommand(
  docker: DockerAdapter,
  spec: Omit<ContainerRunSpec, "containerName"> & {
    purpose: string;
    timeoutMs: number;
    // Sent to the container's stdin, then stdin is closed. Used by run_code
    // to transport a generated script without interpolating it into any
    // shell/Docker command string or filename (fable/16).
    stdinData?: string;
  },
): Promise<ContainerCommandResult> {
  const containerName = createContainerName(spec.purpose);
  const needsStdin = spec.stdinData !== undefined;
  const args = buildContainerRunArgs({ ...spec, containerName });

  if (needsStdin) {
    // docker run -i keeps stdin open so the piped script reaches the shell.
    args.splice(1, 0, "-i");
  }

  const sanitizedCommand = sanitizeDockerCommand(args, spec.workspacePath);
  const startedAt = Date.now();

  trackContainer(containerName, docker);

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = docker.spawnContainer(args);

  if (needsStdin) {
    child.stdin.on("error", () => {
      // A container that exits before consuming stdin must not crash the
      // worker with an unhandled EPIPE.
    });
    child.stdin.write(spec.stdinData);
    child.stdin.end();
  }
  child.stdout.on("data", (chunk) => {
    stdout = appendBoundedText(
      stdout,
      chunk.toString(),
      MAX_CONTAINER_OUTPUT_CHARS,
      "STDOUT TRUNCATED",
    );
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBoundedText(
      stderr,
      chunk.toString(),
      MAX_CONTAINER_OUTPUT_CHARS,
      "STDERR TRUNCATED",
    );
  });

  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      // Forced cleanup on timeout: never leave the container running.
      void docker.removeContainer(containerName).catch(() => {});
      child.kill("SIGKILL");
      resolve(124);
    }, spec.timeoutMs);

    child.once("error", () => {
      clearTimeout(timer);
      resolve(127);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  // Guaranteed cleanup on every path (success, failure, timeout). `--rm`
  // usually already removed it; rm -f is the explicit backstop.
  await docker.removeContainer(containerName).catch(() => {});
  untrackContainer(containerName);

  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    timedOut,
    sanitizedCommand,
  };
}

// --- Long-running application container ------------------------------------------

export type AppContainer = {
  containerName: string;
  sanitizedCommand: string;
  process: ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
};

export function startAppContainer(
  docker: DockerAdapter,
  spec: Omit<ContainerRunSpec, "containerName">,
): AppContainer {
  const containerName = createContainerName("app");
  const args = buildContainerRunArgs({ ...spec, containerName });
  const sanitizedCommand = sanitizeDockerCommand(args, spec.workspacePath);
  const child = docker.spawnContainer(args);

  trackContainer(containerName, docker);

  return {
    containerName,
    sanitizedCommand,
    process: child,
    stop: async () => {
      await docker.removeContainer(containerName).catch(() => {});
      untrackContainer(containerName);

      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
    },
  };
}
