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
// - the cloned target workspace is mounted read-write at /app because
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
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOCKER_CHECK_TIMEOUT_MS = 5_000;

export const CONTAINER_WORKDIR = "/app";

export const CONTAINER_DEFAULTS = {
  image: process.env.SHERLOCK_TARGET_IMAGE ?? "node:20-slim",
  cpus: "1",
  memory: "1g",
  pidsLimit: "256",
  user: "node",
};

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
  env: Record<string, string>;
  command: string[]; // argv executed in the container, e.g. ["npm", "install"]
  portMapping?: { hostPort: number; containerPort: number };
  image?: string;
  // Adds the Docker host-gateway alias so a verification container can reach
  // the sandbox application published on the host's localhost. Adds a DNS
  // name only — no host networking, and the restriction set is unchanged.
  addHostGateway?: boolean;
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
    `--user=${CONTAINER_DEFAULTS.user}`,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=512m",
    "-v",
    `${spec.workspacePath}:${CONTAINER_WORKDIR}`,
    "-w",
    CONTAINER_WORKDIR,
  ];

  if (spec.portMapping) {
    args.push(
      "-p",
      `127.0.0.1:${spec.portMapping.hostPort}:${spec.portMapping.containerPort}`,
    );
  }

  if (spec.addHostGateway) {
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
  },
): Promise<ContainerCommandResult> {
  const containerName = createContainerName(spec.purpose);
  const args = buildContainerRunArgs({ ...spec, containerName });
  const sanitizedCommand = sanitizeDockerCommand(args, spec.workspacePath);
  const startedAt = Date.now();

  trackContainer(containerName, docker);

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = docker.spawnContainer(args);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
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
