// Worker preflight: validates the runtime dependencies the investigation
// worker needs BEFORE it starts consuming jobs. Read-only and local: it
// never clones customer repositories, calls GitHub or Anthropic, runs
// customer code, or prints secret values — env checks report only variable
// NAMES, and diagnostic output is passed through the secret redactor.
//
// Run manually:      npm run worker:check
// Run at startup:    SHERLOCK_RUN_STARTUP_CHECKS=true npm run worker

import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { redactSecrets } from "./services/report.js";
import { missingSupabaseStateStoreEnv } from "./services/investigation-state-store.js";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 15_000;
const IMAGE_PULL_TIMEOUT_MS = 300_000;

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
  // Warnings never fail the preflight; mandatory failures do.
  mandatory: boolean;
};

export type PreflightReport = {
  checks: CheckResult[];
  ok: boolean;
};

// Injectable boundaries so unit tests run without Docker, Redis, Git,
// Playwright, or Graphify.
export type PreflightDeps = {
  env?: NodeJS.ProcessEnv;
  runCommand?: (
    command: string,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string }>;
  pingRedis?: (redisUrl: string) => Promise<void>;
  launchChromium?: () => Promise<void>;
  checkWritableDir?: (dir: string) => Promise<void>;
  fileExists?: (filePath: string) => boolean;
};

const defaultRunCommand = async (
  command: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });

  return { stdout, stderr };
};

const defaultPingRedis = async (redisUrl: string) => {
  // Lazy import so the CLI works even when Redis packages misbehave.
  const { Redis } = await import("ioredis");
  const connection = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });

  try {
    await connection.connect();
    await connection.ping();
  } finally {
    connection.disconnect();
  }
};

const defaultLaunchChromium = async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  await browser.close();
};

const defaultCheckWritableDir = async (dir: string) => {
  await mkdir(dir, { recursive: true });
  const probe = path.join(dir, `.sherlock-preflight-${Date.now()}`);
  await writeFile(probe, "ok", "utf8");
  await rm(probe, { force: true });
};

export const DEFAULT_REDIS_URL = "redis://localhost:6379";

export async function runWorkerPreflight(
  deps: PreflightDeps = {},
): Promise<PreflightReport> {
  const env = deps.env ?? process.env;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const pingRedis = deps.pingRedis ?? defaultPingRedis;
  const launchChromium = deps.launchChromium ?? defaultLaunchChromium;
  const checkWritableDir = deps.checkWritableDir ?? defaultCheckWritableDir;
  const fileExists = deps.fileExists ?? existsSync;

  const checks: CheckResult[] = [];
  const add = (name: string, status: CheckStatus, detail: string, mandatory = true) => {
    checks.push({ name, status, detail: redactSecrets(detail), mandatory });
  };

  // --- Required environment variables (names only, never values) ----------
  for (const name of ["APP_ID", "ANTHROPIC_API_KEY"]) {
    if (env[name]) {
      add(`env:${name}`, "PASS", `${name} is set.`);
    } else {
      add(`env:${name}`, "FAIL", `${name} is not set.`);
    }
  }

  if (env.PRIVATE_KEY) {
    add("env:PRIVATE_KEY", "PASS", "PRIVATE_KEY is set.");
  } else if (env.PRIVATE_KEY_PATH) {
    if (fileExists(env.PRIVATE_KEY_PATH)) {
      add("env:PRIVATE_KEY", "PASS", "PRIVATE_KEY_PATH is set and the file exists.");
    } else {
      add(
        "env:PRIVATE_KEY",
        "FAIL",
        "PRIVATE_KEY_PATH is set but the file does not exist.",
      );
    }
  } else {
    add("env:PRIVATE_KEY", "FAIL", "Neither PRIVATE_KEY nor PRIVATE_KEY_PATH is set.");
  }

  const redisUrl = env.REDIS_URL ?? DEFAULT_REDIS_URL;

  if (env.REDIS_URL) {
    add("env:REDIS_URL", "PASS", "REDIS_URL is set.");
  } else {
    add(
      "env:REDIS_URL",
      "PASS",
      `REDIS_URL is not set; using the default ${DEFAULT_REDIS_URL}.`,
    );
  }

  // --- State store (only when Supabase persistence is explicitly selected) --
  // Names only; the service role key value is never read or printed here.
  if (env.SHERLOCK_STATE_STORE === "supabase") {
    const missing = missingSupabaseStateStoreEnv(env);
    if (missing.length === 0) {
      add(
        "state-store:supabase",
        "PASS",
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.",
      );
    } else {
      add(
        "state-store:supabase",
        "FAIL",
        `SHERLOCK_STATE_STORE=supabase but ${missing.join(" and ")} ${
          missing.length > 1 ? "are" : "is"
        } not set.`,
      );
    }
  }

  // --- Toolchain -----------------------------------------------------------
  try {
    await runCommand("git", ["--version"]);
    add("git", "PASS", "git is available.");
  } catch (error) {
    add("git", "FAIL", `git is not available: ${message(error)}`);
  }

  let dockerCliAvailable = false;

  try {
    await runCommand("docker", ["--version"]);
    dockerCliAvailable = true;
    add("docker:cli", "PASS", "Docker CLI is available.");
  } catch (error) {
    add("docker:cli", "FAIL", `Docker CLI is not available: ${message(error)}`);
  }

  let dockerDaemonReachable = false;

  if (dockerCliAvailable) {
    try {
      await runCommand("docker", ["info"]);
      dockerDaemonReachable = true;
      add("docker:daemon", "PASS", "Docker daemon is reachable.");
    } catch (error) {
      add("docker:daemon", "FAIL", `Docker daemon is not reachable: ${message(error)}`);
    }
  } else {
    add("docker:daemon", "FAIL", "Skipped: Docker CLI is not available.");
  }

  const targetImage = env.SHERLOCK_TARGET_IMAGE ?? "node:20-slim";

  if (dockerDaemonReachable) {
    try {
      await runCommand("docker", ["image", "inspect", targetImage]);
      add("docker:target-image", "PASS", `Target image ${targetImage} is available locally.`);
    } catch {
      try {
        await runCommand("docker", ["pull", targetImage], IMAGE_PULL_TIMEOUT_MS);
        add("docker:target-image", "PASS", `Target image ${targetImage} was pulled.`);
      } catch (error) {
        add(
          "docker:target-image",
          "FAIL",
          `Target image ${targetImage} is neither available nor pullable: ${message(error)}`,
        );
      }
    }
  } else {
    add("docker:target-image", "FAIL", "Skipped: Docker daemon is not reachable.");
  }

  // --- Redis ---------------------------------------------------------------
  try {
    await pingRedis(redisUrl);
    add("redis", "PASS", "Redis is reachable.");
  } catch (error) {
    add("redis", "FAIL", `Redis is not reachable: ${message(error)}`);
  }

  // --- Playwright ------------------------------------------------------------
  try {
    await launchChromium();
    add("playwright:chromium", "PASS", "Playwright Chromium launches.");
  } catch (error) {
    add(
      "playwright:chromium",
      "FAIL",
      `Playwright Chromium could not launch: ${message(error)}`,
    );
  }

  // --- Writable directories ---------------------------------------------------
  const artifactsDir = env.ARTIFACTS_DIR ?? path.resolve("artifacts");
  const dataDir = env.SHERLOCK_DATA_DIR ?? path.join(homedir(), ".sherlock");

  for (const [name, dir] of [
    ["artifacts-dir", artifactsDir],
    ["data-dir", dataDir],
    ["temp-dir", tmpdir()],
  ] as const) {
    try {
      await checkWritableDir(dir);
      add(`writable:${name}`, "PASS", `${dir} is writable.`);
    } catch (error) {
      add(`writable:${name}`, "FAIL", `${dir} is not writable: ${message(error)}`);
    }
  }

  // --- Graphify (optional: the pipeline degrades gracefully without it) -----
  try {
    try {
      await runCommand("graphify", ["--version"]);
    } catch {
      await runCommand("graphify", ["--help"]);
    }
    add("graphify", "PASS", "graphify is available.", false);
  } catch (error) {
    add(
      "graphify",
      "WARN",
      `graphify is not available (${message(error)}); investigations fall back to heuristic repository context.`,
      false,
    );
  }

  return {
    checks,
    ok: checks.every((check) => !check.mandatory || check.status !== "FAIL"),
  };
}

export function formatPreflightReport(report: PreflightReport): string {
  const lines = report.checks.map(
    (check) => `${check.status.padEnd(4)} ${check.name}: ${check.detail}`,
  );

  lines.push(
    report.ok
      ? "PASS worker preflight: all mandatory checks passed."
      : "FAIL worker preflight: mandatory checks failed; the worker must not consume jobs.",
  );

  return lines.join("\n");
}

// Startup enforcement used by worker.ts. Local development stays convenient:
// without SHERLOCK_RUN_STARTUP_CHECKS=true the worker behaves exactly as
// before (no preflight). With the flag, a failed preflight prevents the
// BullMQ worker from ever being created.
export async function enforceStartupChecks(
  env: NodeJS.ProcessEnv,
  runPreflight: () => Promise<PreflightReport>,
  onFailure: () => void,
  log: (message: string) => void = console.log,
): Promise<boolean> {
  if (env.SHERLOCK_RUN_STARTUP_CHECKS !== "true") {
    return true;
  }

  log("Running worker startup preflight (SHERLOCK_RUN_STARTUP_CHECKS=true)...");
  const report = await runPreflight();
  log(formatPreflightReport(report));

  if (!report.ok) {
    onFailure();
    return false;
  }

  return true;
}

// Safe rendering for BullMQ worker/Redis errors: message only, redacted.
export function describeWorkerError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);

  return redactSecrets(text);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

// CLI entry: npm run worker:check
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runWorkerPreflight()
    .then((report) => {
      console.log(formatPreflightReport(report));
      process.exit(report.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(`Worker preflight crashed: ${describeWorkerError(error)}`);
      process.exit(1);
    });
}
