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
const STARTUP_WAIT_MS = 3_000;
const SANDBOX_STARTUP_TIMEOUT_MS = 30_000;

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

export async function runSandboxInvestigation({
  repoPath,
}: {
  repoPath: string;
}): Promise<SandboxSession> {
  try {
    return await runDockerSandbox(repoPath);
  } catch (error) {
    const session = await runLocalSandbox(repoPath);
    session.result.stderr = [
      `Docker sandbox failed, falling back to local process: ${formatError(error)}`,
      session.result.stderr,
    ]
      .filter(Boolean)
      .join("\n");

    return session;
  }
}

async function runDockerSandbox(repoPath: string): Promise<SandboxSession> {
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
  await Promise.race([
    waitForSandboxUrl(baseUrl, output),
    waitForProcessSpawnError(appProcess),
  ]);

  return {
    result: output,
    stop: async () => {
      await stopDockerSandbox(containerName, appProcess, output);
    },
  };
}

async function runLocalSandbox(repoPath: string): Promise<SandboxSession> {
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

  await wait(STARTUP_WAIT_MS);
  output.baseUrl = getLoggedBaseUrl(output.stdout) ?? output.baseUrl;

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

async function waitForSandboxUrl(baseUrl: string, output: SandboxResult) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < SANDBOX_STARTUP_TIMEOUT_MS) {
    try {
      await fetch(baseUrl);
      return;
    } catch {
      await wait(500);
    }
  }

  output.stderr += `\nSandbox did not respond at ${baseUrl} within ${SANDBOX_STARTUP_TIMEOUT_MS}ms.`;
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

function getAvailablePort() {
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

function getLoggedBaseUrl(stdout: string) {
  const match = stdout.match(/https?:\/\/localhost:\d+/);

  return match?.[0] ?? null;
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
