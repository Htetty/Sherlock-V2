// Repository validation: discover the repository's REAL test / typecheck /
// lint / build commands from package.json (Node repositories only, never
// executed on the host) and run them through the restricted container
// runner. Unavailable categories are reported truthfully as not_available —
// never as a fake pass.

import { readFile, access } from "node:fs/promises";
import path from "node:path";
import {
  buildTargetEnv,
  getSandboxNetworkPolicy,
  runContainerCommand,
  type DockerAdapter,
  type SandboxNetworkPolicy,
} from "./container.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type ValidationCategory = "test" | "typecheck" | "lint" | "build";

export type ValidationStatus = "passed" | "failed" | "not_available" | "timed_out";

// Aggregate: "passed" = at least one command ran and every available command
// passed; "failed" = any command failed or timed out; "not_available" = no
// category had a declared script.
export type ValidationAggregate = "passed" | "failed" | "not_available";

export type ValidationCategoryResult = {
  category: ValidationCategory;
  status: ValidationStatus;
  packageManager: PackageManager;
  scriptName: string | null;
  argv: string[] | null;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  reason: string | null;
};

export type RepositoryValidation = {
  packageManager: PackageManager;
  results: ValidationCategoryResult[];
  aggregate: ValidationAggregate;
  startedAt: string;
  finishedAt: string;
};

export const VALIDATION_CATEGORY_ORDER: ValidationCategory[] = [
  "test",
  "typecheck",
  "lint",
  "build",
];

// Only scripts explicitly declared in package.json are considered; the
// first matching name per category wins. Nothing is ever inferred from
// dependencies, filenames, or README text.
const SCRIPT_PRIORITIES: Record<ValidationCategory, string[]> = {
  test: ["test:ci", "test"],
  typecheck: ["typecheck", "type-check", "check:types"],
  lint: ["lint"],
  build: ["build"],
};

// npm's scaffolded placeholder is not a real test command.
const NPM_TEST_PLACEHOLDER = /echo\s+["']Error: no test specified["']\s*&&\s*exit 1/;

const MAX_OUTPUT_CHARS = 10_000;

const DEFAULT_VALIDATION_TIMEOUT_MS = 180_000;

export function getValidationTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SHERLOCK_VALIDATION_TIMEOUT_MS);

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_VALIDATION_TIMEOUT_MS;
}

// Lockfile priority, checked in order.
const LOCKFILE_MANAGERS: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

export async function detectPackageManager(repoPath: string): Promise<PackageManager> {
  for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
    if (await fileExists(path.join(repoPath, lockfile))) {
      return manager;
    }
  }

  return "npm";
}

export type ValidationPlan = {
  packageManager: PackageManager;
  commands: {
    category: ValidationCategory;
    scriptName: string | null;
    argv: string[] | null;
    reason: string | null;
  }[];
};

// Reads package.json as data (never executed) and plans at most one command
// per category.
export async function discoverRepositoryValidation(
  repoPath: string,
): Promise<ValidationPlan> {
  const packageManager = await detectPackageManager(repoPath);
  let scripts: Record<string, string> = {};
  let unavailableReason: string | null = null;

  const raw = await readFileOrNull(path.join(repoPath, "package.json"));

  if (raw === null) {
    unavailableReason = "The repository has no package.json.";
  } else {
    try {
      const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
      for (const [name, value] of Object.entries(parsed.scripts ?? {})) {
        if (typeof value === "string") {
          scripts[name] = value;
        }
      }
    } catch {
      unavailableReason = "The repository's package.json could not be parsed.";
    }
  }

  const commands = VALIDATION_CATEGORY_ORDER.map((category) => {
    if (unavailableReason) {
      return { category, scriptName: null, argv: null, reason: unavailableReason };
    }

    const scriptName =
      SCRIPT_PRIORITIES[category].find((name) => scripts[name] !== undefined) ?? null;

    if (scriptName === null) {
      return {
        category,
        scriptName: null,
        argv: null,
        reason: `No ${SCRIPT_PRIORITIES[category].join("/")} script is declared in package.json.`,
      };
    }

    if (NPM_TEST_PLACEHOLDER.test(scripts[scriptName])) {
      return {
        category,
        scriptName: null,
        argv: null,
        reason: `The "${scriptName}" script is npm's default "no test specified" placeholder.`,
      };
    }

    return {
      category,
      scriptName,
      argv: [packageManager, "run", scriptName],
      reason: null,
    };
  });

  return { packageManager, commands };
}

// Runs every discovered command in its own short-lived restricted container
// (argv arrays, CI=true, bounded output, explicit timeout). Unavailable
// categories execute nothing.
export async function runRepositoryValidation(
  docker: DockerAdapter,
  options: {
    repoPath: string;
    timeoutMs?: number;
    networkPolicy?: SandboxNetworkPolicy;
  },
): Promise<RepositoryValidation> {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? getValidationTimeoutMs();
  // Validation commands (test/typecheck/lint/build) run against already
  // installed dependencies: under the strict policy they get no network at
  // all, so repository code cannot exfiltrate or call external services.
  const networkPolicy = options.networkPolicy ?? getSandboxNetworkPolicy();
  const plan = await discoverRepositoryValidation(options.repoPath);
  const results: ValidationCategoryResult[] = [];

  for (const command of plan.commands) {
    if (command.argv === null) {
      results.push({
        category: command.category,
        status: "not_available",
        packageManager: plan.packageManager,
        scriptName: null,
        argv: null,
        exitCode: null,
        durationMs: null,
        stdout: "",
        stderr: "",
        reason: command.reason,
      });
      continue;
    }

    const run = await runContainerCommand(docker, {
      purpose: `validate-${command.category}`,
      workspacePath: options.repoPath,
      env: buildTargetEnv({ extra: { CI: "true" } }),
      command: command.argv,
      timeoutMs,
      network: networkPolicy === "strict" ? "none" : undefined,
    });

    const status: ValidationStatus = run.timedOut
      ? "timed_out"
      : run.exitCode === 0
        ? "passed"
        : "failed";

    results.push({
      category: command.category,
      status,
      packageManager: plan.packageManager,
      scriptName: command.scriptName,
      argv: command.argv,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      stdout: bound(run.stdout),
      stderr: bound(run.stderr),
      reason: run.timedOut
        ? `The command exceeded the ${timeoutMs}ms timeout and its container was force-removed.`
        : run.exitCode === 127
          ? "The declared command could not be launched inside the validation container."
          : null,
    });
  }

  return {
    packageManager: plan.packageManager,
    results,
    aggregate: aggregateValidation(results),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export function aggregateValidation(
  results: ValidationCategoryResult[],
): ValidationAggregate {
  if (results.some((result) => result.status === "failed" || result.status === "timed_out")) {
    return "failed";
  }

  if (results.some((result) => result.status === "passed")) {
    return "passed";
  }

  return "not_available";
}

const CATEGORY_LABELS: Record<ValidationCategory, string> = {
  test: "Tests",
  typecheck: "Typecheck",
  lint: "Lint",
  build: "Build",
};

const STATUS_LABELS: Record<ValidationStatus, string> = {
  passed: "passed",
  failed: "failed",
  not_available: "not available",
  timed_out: "timed out",
};

// Human-readable per-category lines for logs and GitHub comments.
export function formatValidationLine(result: {
  category: ValidationCategory;
  status: ValidationStatus;
}): string {
  return `${CATEGORY_LABELS[result.category]}: ${STATUS_LABELS[result.status]}`;
}

function bound(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`
    : text;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
