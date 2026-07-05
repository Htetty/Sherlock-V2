import {
  exec,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "child_process";
import { randomUUID } from "crypto";
import { createServer } from "net";
import { promisify } from "util";
import { buildLaunchConfig, formatSanitizedCommand } from "./launch.js";

const execAsync = promisify(exec);

// stop the sandbox if the app keeps running instead of exiting
const SANDBOX_TIMEOUT_MS = 8_000;
const SANDBOX_STARTUP_TIMEOUT_MS = 30_000;
const DOCKER_CHECK_TIMEOUT_MS = 5_000;

// Probot (3000) and the Sherlock backend (4000) must never be handed out as a
// target-application sandbox port: a collision makes reproduction silently
// talk to the wrong server instead of the cloned app.
const RESERVED_PORTS = new Set([3000, 4000]);
const MAX_PORT_ALLOCATION_ATTEMPTS = 10;

type SandboxExecError = Error & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: string | number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
};

export type SandboxStrategy = "direct" | "docker-fixed-port";

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

// Thrown when the target application never becomes reachable on its
// allocated port (it crashed, hung, or ignored PORT). Callers must classify
// this as an environment failure, never as part of the reproduction result.
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

// All Docker interactions go through this adapter so tests can simulate
// container behavior without a running Docker daemon.
export type DockerAdapter = {
  isAvailable: () => Promise<boolean>;
  spawnContainer: (args: string[]) => ChildProcessWithoutNullStreams;
  removeContainer: (containerName: string) => Promise<void>;
};

const defaultDockerAdapter: DockerAdapter = {
  isAvailable: async () => {
    try {
      await execAsync("docker info", { timeout: DOCKER_CHECK_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  },
  spawnContainer: (args) => spawn("docker", args),
  removeContainer: async (containerName) => {
    await execAsync(`docker rm -f ${containerName}`);
  },
};

export async function runSandboxInvestigation({
  repoPath,
  startupTimeoutMs = SANDBOX_STARTUP_TIMEOUT_MS,
  docker = defaultDockerAdapter,
}: {
  repoPath: string;
  startupTimeoutMs?: number;
  docker?: DockerAdapter;
}): Promise<SandboxSession> {
  // 1) Normal startup: run the framework-appropriate command directly with
  // the allocated dynamic port.
  let directError: SandboxUnreachableError;
  let details: NonNullable<SandboxUnreachableError["details"]>;

  try {
    return await runLocalSandbox(repoPath, startupTimeoutMs);
  } catch (error) {
    if (!(error instanceof SandboxUnreachableError) || !error.details) {
      throw error;
    }

    directError = error;
    details = error.details;
  }

  // 2) The app never bound the allocated port. Inspect its startup output
  // for evidence of a fixed internal port (e.g. "running on
  // http://localhost:3000" while PORT pointed elsewhere). The logged port is
  // only ever used as a container-internal port, never as the base URL.
  const internalPort = detectFixedInternalPort(
    `${details.stdout}\n${details.stderr}`,
    details.allocatedPort,
  );

  if (internalPort === null) {
    throw directError;
  }

  // 3) A fixed-port app must never run directly on the host: its hardcoded
  // port could collide with Probot (3000) or the Sherlock backend (4000).
  // Docker port mapping exposes it on the safe allocated host port instead.
  if (!(await docker.isAvailable())) {
    throw new SandboxUnreachableError(
      [
        directError.message,
        `The application appears to ignore PORT and listen on fixed internal port ${internalPort}.`,
        "Docker is not available, so Sherlock cannot isolate the fixed port behind a safe host port mapping.",
        "Start Docker (or make the application honor PORT) and retry.",
      ].join("\n"),
      details,
    );
  }

  return runFixedPortContainerSandbox(
    repoPath,
    details.allocatedPort,
    internalPort,
    startupTimeoutMs,
    docker,
  );
}

async function runLocalSandbox(
  repoPath: string,
  startupTimeoutMs: number,
): Promise<SandboxSession> {
  const port = await getAvailablePort();
  const launch = await buildLaunchConfig(repoPath, port);
  const installResult = await runCommand("npm install", repoPath);
  const appProcess = spawn(launch.command, launch.args, {
    cwd: repoPath,
    env: {
      ...process.env,
      ...launch.env,
    },
    shell: true,
  });

  const output: SandboxResult = {
    baseUrl: launch.baseUrl,
    stdout: installResult.stdout,
    stderr: installResult.stderr,
    strategy: "direct",
    hostPort: port,
    internalPort: null,
    command: formatSanitizedCommand(launch),
  };

  // keep collecting app logs while playwright reproduces the issue
  collectProcessOutput(appProcess, output);

  // The base URL is always the port Sherlock allocated, launched with a
  // framework-appropriate command (see launch.ts), never a value scraped
  // from the app's own log output: apps often print a hardcoded default
  // port in their boilerplate startup message regardless of what they
  // actually bind to, which previously caused Sherlock to trust a stale or
  // incorrect URL instead of the real one.
  try {
    await Promise.race([
      waitForSandboxUrl(launch.baseUrl, output, startupTimeoutMs),
      waitForProcessSpawnError(appProcess),
    ]);
  } catch (error) {
    await stopSandboxApp(appProcess, output);
    throw new SandboxUnreachableError(
      [
        `Target application (${launch.framework}) did not become reachable at ${launch.baseUrl}: ${formatError(error)}`,
        `Attempted command: ${formatSanitizedCommand(launch)}`,
        `stdout (tail): ${tail(output.stdout)}`,
        `stderr (tail): ${tail(output.stderr)}`,
      ].join("\n"),
      { stdout: output.stdout, stderr: output.stderr, allocatedPort: port },
    );
  }

  return {
    result: output,
    stop: async () => {
      await stopSandboxApp(appProcess, output);
    },
  };
}

// Runs an app that ignores PORT inside an isolated container, mapping the
// safe allocated host port onto the app's fixed internal port. The
// reproduction base URL stays http://localhost:<allocated-host-port>.
async function runFixedPortContainerSandbox(
  repoPath: string,
  hostPort: number,
  internalPort: number,
  startupTimeoutMs: number,
  docker: DockerAdapter,
): Promise<SandboxSession> {
  const baseUrl = `http://localhost:${hostPort}`;
  const containerName = `bugfixbot-sandbox-${randomUUID()}`;
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "-p",
    `${hostPort}:${internalPort}`,
    "-e",
    `PORT=${internalPort}`,
    "-v",
    `${repoPath}:/app`,
    "-w",
    "/app",
    "node:20-slim",
    "sh",
    "-lc",
    "npm install && npm start",
  ];
  // Local absolute workspace paths must not leak into diagnostics that can
  // end up in public GitHub comments.
  const sanitizedCommand = `docker ${args.join(" ")}`.replace(
    repoPath,
    "<workspace>",
  );
  const appProcess = docker.spawnContainer(args);

  const output: SandboxResult = {
    baseUrl,
    stdout: "",
    stderr: `Application ignored PORT; retried in a container with host port mapping ${hostPort}:${internalPort}.\n`,
    strategy: "docker-fixed-port",
    hostPort,
    internalPort,
    command: sanitizedCommand,
  };

  collectProcessOutput(appProcess, output);

  const stop = async () => {
    await docker.removeContainer(containerName).catch((error: unknown) => {
      output.stderr += `\nCould not remove sandbox container: ${formatError(error)}`;
    });

    if (appProcess.exitCode === null) {
      appProcess.kill("SIGTERM");
    }
  };

  try {
    await Promise.race([
      waitForSandboxUrl(baseUrl, output, startupTimeoutMs),
      waitForProcessSpawnError(appProcess),
    ]);
  } catch (error) {
    await stop();
    throw new SandboxUnreachableError(
      [
        `Target application (fixed internal port ${internalPort}) did not become reachable at ${baseUrl} through container port mapping: ${formatError(error)}`,
        `Attempted command: ${sanitizedCommand}`,
        `stdout (tail): ${tail(output.stdout)}`,
        `stderr (tail): ${tail(output.stderr)}`,
      ].join("\n"),
      { stdout: output.stdout, stderr: output.stderr, allocatedPort: hostPort },
    );
  }

  return { result: output, stop };
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

async function runCommand(
  command: string,
  repoPath: string,
): Promise<SandboxResult> {
  try {
    // run setup commands and collect their output for claude
    const { stdout, stderr } = await execAsync(command, {
      cwd: repoPath,
      timeout: SANDBOX_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    return {
      baseUrl: "",
      stdout,
      stderr,
    };
  } catch (error) {
    const execError = error as SandboxExecError;

    // return failed command output so claude can use it as evidence
    return {
      baseUrl: "",
      stdout: formatCommandOutput(execError.stdout),
      stderr: [
        formatCommandOutput(execError.stderr),
        formatSandboxError(execError),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
}

async function stopSandboxApp(
  appProcess: ChildProcessWithoutNullStreams,
  output: SandboxResult,
) {
  if (appProcess.exitCode !== null) {
    return;
  }

  appProcess.kill("SIGTERM");
  await wait(500);

  if (appProcess.exitCode === null) {
    appProcess.kill("SIGKILL");
    output.stderr += "\nSandbox app was force killed after investigation.";
  }
}

async function waitForSandboxUrl(
  baseUrl: string,
  output: SandboxResult,
  timeoutMs: number,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(baseUrl);
      return;
    } catch {
      await wait(500);
    }
  }

  output.stderr += `\nSandbox did not respond at ${baseUrl} within ${timeoutMs}ms.`;
  throw new Error(`Sandbox did not respond at ${baseUrl} within ${timeoutMs}ms.`);
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

// convert command output into text that can be added to the claude prompt
function formatCommandOutput(output: string | Buffer | undefined) {
  if (!output) {
    return "";
  }

  return output.toString();
}

// include why the sandbox stopped, especially timeout and exit code info
function formatSandboxError(error: SandboxExecError) {
  const details = [
    `Sandbox command failed: ${error.message}`,
    error.code === undefined || error.code === null
      ? null
      : `Exit code: ${error.code}`,
    error.signal ? `Signal: ${error.signal}` : null,
    error.killed ? "Process was killed after sandbox timeout." : null,
  ];

  return details.filter(Boolean).join("\n");
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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
