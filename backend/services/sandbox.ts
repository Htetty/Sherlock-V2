// Container-only sandbox for target applications.
//
// Security rule: no command from a target repository ever executes on the
// Sherlock host. Installation and application startup always run inside
// restricted Docker containers (see container.ts for the restriction set).
// If Docker is unavailable the sandbox fails as environment_failed — there
// is no host fallback.

import { createServer } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { buildLaunchConfig, formatSanitizedCommand } from "./launch.js";
import {
  buildTargetEnv,
  realDockerAdapter,
  runContainerCommand,
  startAppContainer,
  type DockerAdapter,
} from "./container.js";

export type { DockerAdapter } from "./container.js";

const SANDBOX_STARTUP_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;

// Probot (3000) and the Sherlock backend (4000) must never be handed out as a
// target-application sandbox port: a collision makes reproduction silently
// talk to the wrong server instead of the cloned app.
const RESERVED_PORTS = new Set([3000, 4000]);
const MAX_PORT_ALLOCATION_ATTEMPTS = 10;

export type SandboxStrategy = "container-dynamic-port" | "container-fixed-port";

export type SandboxResult = {
  baseUrl: string;
  stdout: string;
  stderr: string;
  strategy?: SandboxStrategy;
  hostPort?: number;
  internalPort?: number | null;
  command?: string;
};

export type SandboxSession = {
  result: SandboxResult;
  stop: () => Promise<void>;
};

// Thrown when the target application environment cannot be started or never
// becomes reachable. Callers must classify this as an environment failure,
// never as part of the reproduction result.
export class SandboxUnreachableError extends Error {
  constructor(
    message: string,
    readonly details: {
      stdout: string;
      stderr: string;
      allocatedPort: number;
    } | null = null,
  ) {
    super(message);
  }
}

// Readiness probe is injectable so unit tests can simulate container
// reachability without a Docker daemon.
export type UrlProbe = (baseUrl: string, timeoutMs: number) => Promise<boolean>;

const defaultProbe: UrlProbe = async (baseUrl, timeoutMs) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await wait(500);
    }
  }

  return false;
};

export async function runSandboxInvestigation({
  repoPath,
  startupTimeoutMs = SANDBOX_STARTUP_TIMEOUT_MS,
  docker = realDockerAdapter,
  probe = defaultProbe,
}: {
  repoPath: string;
  startupTimeoutMs?: number;
  docker?: DockerAdapter;
  probe?: UrlProbe;
}): Promise<SandboxSession> {
  // Container-only policy: without Docker there is no safe way to run the
  // target repository's code, so the environment fails outright.
  if (!(await docker.isAvailable())) {
    throw new SandboxUnreachableError(
      [
        "Docker is not available on the Sherlock worker host.",
        "Target repositories only ever run inside isolated containers, so the application environment could not be started.",
        "Start the Docker daemon and retry the investigation.",
      ].join("\n"),
    );
  }

  const hostPort = await getAvailablePort();
  const baseUrl = `http://localhost:${hostPort}`;

  // Dependency installation runs in its own short-lived restricted
  // container, never on the host.
  const install = await runContainerCommand(docker, {
    purpose: "install",
    workspacePath: repoPath,
    env: buildTargetEnv({ port: hostPort }),
    command: ["npm", "install"],
    timeoutMs: INSTALL_TIMEOUT_MS,
  });

  if (install.exitCode !== 0) {
    throw new SandboxUnreachableError(
      [
        `Dependency installation failed in the target container (exit ${install.exitCode}${install.timedOut ? ", timed out" : ""}).`,
        `Attempted command: ${install.sanitizedCommand}`,
        `stdout (tail): ${tail(install.stdout)}`,
        `stderr (tail): ${tail(install.stderr)}`,
      ].join("\n"),
      { stdout: install.stdout, stderr: install.stderr, allocatedPort: hostPort },
    );
  }

  // First attempt: the allocated host port doubles as the container-internal
  // PORT, mapped 1:1.
  const first = await startApplicationAttempt({
    repoPath,
    docker,
    probe,
    startupTimeoutMs,
    hostPort,
    internalPort: hostPort,
    strategy: "container-dynamic-port",
    installOutput: install,
  });

  if (first.session) {
    return first.session;
  }

  // Hardcoded-port fallback: the app ignored PORT. Look for the fixed
  // internal port it logged (bounded detection rules); that port is only
  // ever used as the container-internal side of the mapping — the public
  // base URL stays on the allocated host port.
  const internalPort = detectFixedInternalPort(
    `${first.stdout}\n${first.stderr}`,
    hostPort,
  );

  if (internalPort === null) {
    throw new SandboxUnreachableError(
      [
        `Target application did not become reachable at ${baseUrl} and no fixed internal port could be detected from its startup output.`,
        `Attempted command: ${first.sanitizedCommand}`,
        `stdout (tail): ${tail(first.stdout)}`,
        `stderr (tail): ${tail(first.stderr)}`,
      ].join("\n"),
      { stdout: first.stdout, stderr: first.stderr, allocatedPort: hostPort },
    );
  }

  const second = await startApplicationAttempt({
    repoPath,
    docker,
    probe,
    startupTimeoutMs,
    hostPort,
    internalPort,
    strategy: "container-fixed-port",
    installOutput: install,
  });

  if (second.session) {
    return second.session;
  }

  throw new SandboxUnreachableError(
    [
      `Target application (fixed internal port ${internalPort}) did not become reachable at ${baseUrl} through container port mapping ${hostPort}:${internalPort}.`,
      `Attempted command: ${second.sanitizedCommand}`,
      `stdout (tail): ${tail(second.stdout)}`,
      `stderr (tail): ${tail(second.stderr)}`,
    ].join("\n"),
    { stdout: second.stdout, stderr: second.stderr, allocatedPort: hostPort },
  );
}

type AttemptResult = {
  session: SandboxSession | null;
  stdout: string;
  stderr: string;
  sanitizedCommand: string;
};

async function startApplicationAttempt(input: {
  repoPath: string;
  docker: DockerAdapter;
  probe: UrlProbe;
  startupTimeoutMs: number;
  hostPort: number;
  internalPort: number;
  strategy: SandboxStrategy;
  installOutput: { stdout: string; stderr: string };
}): Promise<AttemptResult> {
  const baseUrl = `http://localhost:${input.hostPort}`;
  // Launch flags/env are built against the container-internal port; the
  // public base URL always stays on the allocated host port.
  const launch = await buildLaunchConfig(input.repoPath, input.internalPort);

  const app = startAppContainer(input.docker, {
    workspacePath: input.repoPath,
    env: buildTargetEnv({ port: input.internalPort }),
    command: [launch.command, ...launch.args],
    portMapping: { hostPort: input.hostPort, containerPort: input.internalPort },
  });

  const output: SandboxResult = {
    baseUrl,
    stdout: input.installOutput.stdout,
    stderr:
      input.strategy === "container-fixed-port"
        ? `${input.installOutput.stderr}\nApplication ignored PORT; retried with container port mapping ${input.hostPort}:${input.internalPort}.\n`
        : input.installOutput.stderr,
    strategy: input.strategy,
    hostPort: input.hostPort,
    internalPort: input.internalPort,
    command: app.sanitizedCommand,
  };

  collectProcessOutput(app.process, output);

  const reachable = await Promise.race([
    input.probe(baseUrl, input.startupTimeoutMs),
    waitForProcessSpawnError(app.process),
  ]).catch(() => false);

  if (!reachable) {
    // The base URL is never replaced by anything the app logs; a failed
    // attempt is stopped and force-removed before any fallback.
    await app.stop();

    return {
      session: null,
      stdout: output.stdout,
      stderr: output.stderr,
      sanitizedCommand: app.sanitizedCommand,
    };
  }

  // The framework-appropriate startup command (see launch.ts) is recorded in
  // sanitized form; formatSanitizedCommand covers the in-container argv.
  output.command = `${app.sanitizedCommand} (launch: ${formatSanitizedCommand(launch)})`;

  return {
    session: { result: output, stop: app.stop },
    stdout: output.stdout,
    stderr: output.stderr,
    sanitizedCommand: app.sanitizedCommand,
  };
}

// Ports the app itself claims to be listening on in its startup output.
const LOGGED_PORT_PATTERNS = [
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})/gi,
  /\bport[:\s]+(\d{1,5})\b/gi,
];

function detectFixedInternalPort(
  output: string,
  allocatedPort: number,
): number | null {
  for (const pattern of LOGGED_PORT_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const candidate = Number(match[1]);

      if (candidate > 0 && candidate < 65_536 && candidate !== allocatedPort) {
        return candidate;
      }
    }
  }

  return null;
}

function collectProcessOutput(
  appProcess: ChildProcessWithoutNullStreams,
  output: SandboxResult,
) {
  appProcess.stdout.on("data", (chunk) => {
    output.stdout += chunk.toString();
  });

  appProcess.stderr.on("data", (chunk) => {
    output.stderr += chunk.toString();
  });
}

function waitForProcessSpawnError(appProcess: ChildProcessWithoutNullStreams) {
  return new Promise<never>((_, reject) => {
    appProcess.once("error", reject);
  });
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getAvailablePort() {
  for (let attempt = 0; attempt < MAX_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
    const port = await allocateEphemeralPort();

    if (!RESERVED_PORTS.has(port)) {
      return port;
    }
  }

  throw new Error(
    `Could not allocate a sandbox port outside of the reserved set (${[...RESERVED_PORTS].join(", ")}) after ${MAX_PORT_ALLOCATION_ATTEMPTS} attempts.`,
  );
}

function allocateEphemeralPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate sandbox port."));
        return;
      }

      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

const MAX_DIAGNOSTIC_TAIL_CHARS = 600;

function tail(text: string) {
  if (!text) {
    return "(empty)";
  }

  return text.length > MAX_DIAGNOSTIC_TAIL_CHARS
    ? `…${text.slice(-MAX_DIAGNOSTIC_TAIL_CHARS)}`
    : text;
}
