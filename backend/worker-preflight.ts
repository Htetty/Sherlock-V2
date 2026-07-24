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
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { redactSecrets } from "./services/report.js";
import { getSandboxAddressing, isContainerizedWorker } from "./services/container.js";
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
  // Identity of the current container (Docker sets the hostname to the short
  // container id); injectable so attachment tests need no real container.
  hostname?: () => string;
  // Reads /proc/self/cgroup for the full container id; injectable likewise.
  readTextFile?: (filePath: string) => string;
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
  const getHostname = deps.hostname ?? hostname;
  const readTextFile =
    deps.readTextFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));

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

  const runCodeEnabled = env.SHERLOCK_FIXER_RUN_CODE !== "false";
  const explorerImage = env.SHERLOCK_EXPLORER_IMAGE?.trim() || "sherlock-explorer:latest";

  if (!runCodeEnabled) {
    add(
      "docker:explorer-image",
      "PASS",
      "run_code is disabled; no explorer image is required.",
    );
  } else if (!dockerDaemonReachable) {
    add("docker:explorer-image", "FAIL", "Skipped: Docker daemon is not reachable.");
  } else {
    try {
      await runCommand("docker", ["image", "inspect", explorerImage]);
      add(
        "docker:explorer-image",
        "PASS",
        `Explorer image ${explorerImage} is available locally.`,
      );
    } catch (error) {
      add(
        "docker:explorer-image",
        "FAIL",
        `run_code is enabled but explorer image ${explorerImage} is unavailable: ${message(error)}. Build Dockerfile.explorer or set SHERLOCK_FIXER_RUN_CODE=false.`,
      );
    }
  }

  const pricingFile = env.SHERLOCK_PRICING_FILE?.trim() || path.resolve("evals", "pricing.v1.json");
  if (fileExists(pricingFile)) {
    add("pricing:file", "PASS", `Pricing file ${pricingFile} exists.`);
  } else {
    add(
      "pricing:file",
      "FAIL",
      `Pricing file ${pricingFile} is missing; inference costs cannot be measured.`,
    );
  }

  // --- Sandbox addressing ----------------------------------------------------
  // A containerized worker can never reach sibling target containers through
  // its own localhost: it must share a Docker network with them
  // (SHERLOCK_SANDBOX_NETWORK; docker-compose.prod.yml configures this).
  const addressing = getSandboxAddressing(env);
  const containerized = isContainerizedWorker(env, fileExists);

  if (addressing.mode === "network") {
    if (!dockerDaemonReachable) {
      add("sandbox:addressing", "FAIL", "Skipped: Docker daemon is not reachable.");
    } else {
      let containersJson: string | null = null;

      try {
        // One inspect proves the network exists AND yields its attached
        // containers for the self-attachment check below.
        const { stdout } = await runCommand("docker", [
          "network",
          "inspect",
          addressing.network,
          "--format",
          "{{json .Containers}}",
        ]);
        containersJson = stdout;
      } catch (error) {
        add(
          "sandbox:addressing",
          "FAIL",
          `SHERLOCK_SANDBOX_NETWORK="${addressing.network}" but that Docker network does not exist: ${message(error)}`,
        );
      }

      if (containersJson !== null && !containerized) {
        // Host-run worker with network addressing: there is no worker
        // container to be attached, so existence is all we can verify.
        add(
          "sandbox:addressing",
          "PASS",
          `Shared sandbox network "${addressing.network}" exists.`,
        );
      } else if (containersJson !== null) {
        // The network existing is not enough: an unattached worker resolves
        // no target container names and every sandbox probe times out.
        // Identity must be PROVEN by container id — a configured name (env
        // var) is never proof, because any attached container's name could
        // be claimed by an unattached worker. Sources, in order: the full id
        // from /proc/self/cgroup, else the hostname when it is Docker's
        // default (the short container id, >= 12 lowercase hex chars).
        const selfId = resolveSelfContainerId(getHostname, readTextFile);

        if (selfId === null) {
          add(
            "sandbox:addressing",
            "FAIL",
            `Could not determine this worker's container id (the hostname is not a Docker container id and /proc/self/cgroup yielded none), so attachment to "${addressing.network}" cannot be verified. Run the worker with Docker's default hostname (remove hostname:/--hostname overrides).`,
          );
        } else if (isAttachedToNetwork(containersJson, selfId)) {
          add(
            "sandbox:addressing",
            "PASS",
            `Shared sandbox network "${addressing.network}" exists and this worker container (id ${selfId.slice(0, 12)}…) is attached to it.`,
          );
        } else {
          add(
            "sandbox:addressing",
            "FAIL",
            `Shared sandbox network "${addressing.network}" exists but this worker container (id ${selfId.slice(0, 12)}…) is NOT attached to it, so target containers on that network are unreachable. Attach the worker (compose: list the network under the worker's networks:; docker run: add --network ${addressing.network}).`,
          );
        }
      }
    }
  } else if (containerized) {
    add(
      "sandbox:addressing",
      "FAIL",
      "Worker runs inside a container but SHERLOCK_SANDBOX_NETWORK is not set; target apps published on the host loopback are unreachable from here. Set SHERLOCK_SANDBOX_NETWORK to the shared sandbox network (see docker-compose.prod.yml).",
    );
  } else {
    add(
      "sandbox:addressing",
      "PASS",
      "Host-run worker uses loopback port publishing (host addressing).",
    );
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

  // --- ffmpeg (optional: replay-evidence comparison media degrades without it)
  try {
    await runCommand("ffmpeg", ["-version"]);
    add("ffmpeg", "PASS", "ffmpeg is available.", false);
  } catch (error) {
    add(
      "ffmpeg",
      "WARN",
      `ffmpeg is not available (${message(error)}); replay-evidence videos are still saved, but no comparison mp4/GIF is produced.`,
      false,
    );
  }

  return {
    checks,
    ok: checks.every((check) => !check.mandatory || check.status !== "FAIL"),
  };
}

// Docker container ids are 64 lowercase hex chars; the default container
// hostname is the first 12. Anything shorter is not a safe prefix: it could
// accidentally (or deliberately) match another container's id.
const MIN_CONTAINER_ID_PREFIX = 12;
const CONTAINER_ID_HOSTNAME = /^[0-9a-f]{12,64}$/;
const CGROUP_CONTAINER_ID = /([0-9a-f]{64})/;

// Proof of the current container's identity, by id only:
// 1. /proc/self/cgroup contains the full 64-hex container id on Docker
//    (e.g. .../docker/<id> or docker-<id>.scope) — works even under a
//    custom hostname.
// 2. Otherwise the hostname, only when it looks like a Docker container id
//    (>= 12 lowercase hex chars — the Docker/Compose default).
// Returns null when neither yields an id; callers must fail closed.
function resolveSelfContainerId(
  getHostname: () => string,
  readTextFile: (filePath: string) => string,
): string | null {
  try {
    const match = readTextFile("/proc/self/cgroup").match(CGROUP_CONTAINER_ID);

    if (match) {
      return match[1];
    }
  } catch {
    // No cgroup file (macOS, non-Linux CI): fall through to the hostname.
  }

  const host = getHostname().trim();

  return CONTAINER_ID_HOSTNAME.test(host) ? host : null;
}

// `docker network inspect --format {{json .Containers}}` output: FULL
// container ids mapped to endpoint details. Attached means an id matches the
// proven self id as a >= 12-char hex prefix (either may be the shorter one:
// hostname-derived ids are 12 chars, cgroup-derived ids are 64). Endpoint
// names are deliberately NOT matched — names are claimable via env/config
// and would let an unattached worker pass. Unparseable output is NOT
// attached: the check must never pass on evidence it could not read.
function isAttachedToNetwork(containersJson: string, selfId: string): boolean {
  if (selfId.length < MIN_CONTAINER_ID_PREFIX) {
    return false;
  }

  let containers: unknown;

  try {
    containers = JSON.parse(containersJson.trim());
  } catch {
    return false;
  }

  if (!containers || typeof containers !== "object" || Array.isArray(containers)) {
    return false;
  }

  return Object.keys(containers as Record<string, unknown>).some(
    (containerId) =>
      containerId.length >= MIN_CONTAINER_ID_PREFIX &&
      (containerId.startsWith(selfId) || selfId.startsWith(containerId)),
  );
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
