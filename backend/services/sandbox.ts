import {
  exec,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "child_process";
import { randomUUID } from "crypto";
import { createServer } from "net";
import { promisify } from "util";

const execAsync = promisify(exec);

// stop the sandbox if the app keeps running instead of exiting
const SANDBOX_TIMEOUT_MS = 8_000;
const SANDBOX_STARTUP_TIMEOUT_MS = 30_000;

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

export type SandboxResult = {
  baseUrl: string;
  stdout: string;
  stderr: string;
};

export type SandboxSession = {
  result: SandboxResult;
  stop: () => Promise<void>;
};

// Thrown when the target application never becomes reachable on its
// allocated port (it crashed, hung, or ignored PORT). Callers must classify
// this as an environment failure, never as part of the reproduction result.
export class SandboxUnreachableError extends Error {}

export async function runSandboxInvestigation({
  repoPath,
  startupTimeoutMs = SANDBOX_STARTUP_TIMEOUT_MS,
}: {
  repoPath: string;
  startupTimeoutMs?: number;
}): Promise<SandboxSession> {
  try {
    return await runDockerSandbox(repoPath, startupTimeoutMs);
  } catch (error) {
    const session = await runLocalSandbox(repoPath, startupTimeoutMs);
    session.result.stderr = [
      `Docker sandbox failed, falling back to local process: ${formatError(error)}`,
      session.result.stderr,
    ]
      .filter(Boolean)
      .join("\n");

    return session;
  }
}

async function runDockerSandbox(
  repoPath: string,
  startupTimeoutMs: number,
): Promise<SandboxSession> {
  const port = await getAvailablePort();
  const baseUrl = `http://localhost:${port}`;
  const containerName = `bugfixbot-sandbox-${randomUUID()}`;
  const appProcess = spawn("docker", [
    "run",
    "--rm",
    "--name",
    containerName,
    "-p",
    `${port}:3000`,
    "-e",
    "PORT=3000",
    "-v",
    `${repoPath}:/app`,
    "-w",
    "/app",
    "node:20-slim",
    "sh",
    "-lc",
    "npm install && npm start",
  ]);

  const output = {
    baseUrl,
    stdout: "",
    stderr: "",
  };

  collectProcessOutput(appProcess, output);

  // wait until the mapped sandbox URL is reachable before playwright starts
  try {
    await Promise.race([
      waitForSandboxUrl(baseUrl, output, startupTimeoutMs),
      waitForProcessSpawnError(appProcess),
    ]);
  } catch (error) {
    await stopDockerSandbox(containerName, appProcess, output);
    throw new SandboxUnreachableError(
      `Target application container did not become reachable at ${baseUrl}: ${formatError(error)}`,
    );
  }

  return {
    result: output,
    stop: async () => {
      await stopDockerSandbox(containerName, appProcess, output);
    },
  };
}

async function runLocalSandbox(
  repoPath: string,
  startupTimeoutMs: number,
): Promise<SandboxSession> {
  const port = await getAvailablePort();
  const baseUrl = `http://localhost:${port}`;
  const installResult = await runCommand("npm install", repoPath);
  const appProcess = spawn("npm", ["start"], {
    cwd: repoPath,
    env: {
      ...process.env,
      PORT: String(port),
    },
    shell: true,
  });

  const output = {
    baseUrl,
    stdout: installResult.stdout,
    stderr: installResult.stderr,
  };

  // keep collecting app logs while playwright reproduces the issue
  collectProcessOutput(appProcess, output);

  // The base URL is always the port Sherlock allocated and injected via
  // PORT, never a value scraped from the app's own log output: apps often
  // print a hardcoded default port in their boilerplate startup message
  // regardless of what they actually bind to, which previously caused
  // Sherlock to trust a stale/incorrect URL instead of the real one.
  try {
    await Promise.race([
      waitForSandboxUrl(baseUrl, output, startupTimeoutMs),
      waitForProcessSpawnError(appProcess),
    ]);
  } catch (error) {
    await stopSandboxApp(appProcess, output);
    throw new SandboxUnreachableError(
      `Target application did not become reachable at ${baseUrl} (allocated via PORT=${port}): ${formatError(error)}`,
    );
  }

  return {
    result: output,
    stop: async () => {
      await stopSandboxApp(appProcess, output);
    },
  };
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

async function stopDockerSandbox(
  containerName: string,
  appProcess: ChildProcessWithoutNullStreams,
  output: SandboxResult,
) {
  await execAsync(`docker rm -f ${containerName}`).catch((error: unknown) => {
    output.stderr += `\nCould not remove sandbox container: ${formatError(error)}`;
  });

  if (appProcess.exitCode === null) {
    appProcess.kill("SIGTERM");
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
