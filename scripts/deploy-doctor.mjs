// Deployment doctor: validates the env file, secrets wiring, and compose
// configuration for a production or staging deploy BEFORE `compose up`.
//
//   npm run deploy:doctor:prod       # checks .env.production
//   npm run deploy:doctor:staging    # checks .env.staging
//
// Prints one PASS/WARN/FAIL line per check and exits nonzero when any check
// FAILs. It reads secret values only to classify them (present / empty /
// placeholder) and NEVER prints them — details reference key names only.
//
// Like backend/worker-preflight.ts, every external boundary (filesystem,
// docker CLI) is injected so the logic is unit-testable without a host.

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ENVIRONMENTS = {
  production: { envFile: ".env.production" },
  staging: { envFile: ".env.staging" },
};

const COMPOSE_FILE = "docker-compose.prod.yml";
const DEFAULT_PRIVATE_KEY_FILE = "./secrets/github-app-private-key.pem";

// Values copied verbatim from the .env.*.example files, plus generic
// fill-me-in markers. Matched case-insensitively as substrings.
const PLACEHOLDER_MARKERS = [
  "placeholder",
  "redact-me",
  "replace-with",
  "changeme",
  "change-me",
  "your-",
  "example-webhook-secret",
  "example-staging-webhook-secret",
  "example.supabase.co",
  "example-staging.supabase.co",
];

// Keys every deploy must set to a real (non-empty, non-placeholder) value.
const REQUIRED_KEYS = ["APP_ID", "WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "REDIS_URL"];

// Compose-interpolation variables where a shell export silently overrides
// the --env-file value (shell wins in Compose precedence).
const SHELL_OVERRIDE_KEYS = ["SHERLOCK_ENV_FILE", "SHERLOCK_PRIVATE_KEY_FILE"];

const stripDotSlash = (path) => path.replace(/^\.\//, "");

/** True when `path` (relative or absolute) resolves to the production
 * GitHub App key: the compose default itself, or any
 * `…/secrets/github-app-private-key.pem` under a different root. */
function resolvesToProductionKey(path, cwd) {
  return resolve(cwd ?? ".", path).endsWith(`/${stripDotSlash(DEFAULT_PRIVATE_KEY_FILE)}`);
}

/** Redact secret-bearing content from an unexpected error before printing:
 * crash messages can echo command output or env-file content. Covers
 * sensitive KEY=value / key: value assignments (names containing SECRET,
 * TOKEN, KEY, PASSWORD, or REDIS_URL), credentialed URLs
 * (scheme://user:password@host), and long unbroken token-shaped runs.
 * Ordinary error text (codes, paths, filenames) stays readable. */
export function sanitizeCrashMessage(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|KEY|PASSWORD|REDIS_URL)[A-Za-z0-9_.-]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9+=_.-]{24,}/g, "[redacted]");
}

/** Minimal KEY=VALUE parser for our env files (comments/blank lines skipped,
 * single/double surrounding quotes stripped). No interpolation. */
export function parseEnvFile(text) {
  const env = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env.set(key, value);
  }
  return env;
}

export function looksLikePlaceholder(value) {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))) return true;
  // The example files use APP_ID=000000; all-zero ids are never real.
  if (/^0+$/.test(value)) return true;
  return false;
}

/** Real deps: touch the local filesystem and docker CLI. */
export function realDoctorDeps(cwd = process.cwd()) {
  return {
    cwd,
    readFile(path) {
      return readFileSync(resolve(cwd, path), "utf8");
    },
    fileSize(path) {
      const stats = statSync(resolve(cwd, path));
      return stats.isFile() ? stats.size : -1;
    },
    async runCommand(command, args) {
      const { stdout } = await execFileAsync(command, args, {
        cwd,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout };
    },
    shellEnv: process.env,
  };
}

/**
 * Run every doctor check for `envName` ("production" | "staging").
 * Returns { ok, checks: [{ name, status: "pass"|"warn"|"fail"|"skip", detail }] }.
 * Details never contain env values — key names and classifications only.
 */
export async function runDeployDoctor(envName, deps) {
  const target = ENVIRONMENTS[envName];
  if (!target) {
    throw new Error(
      `unknown environment "${envName}" (expected: ${Object.keys(ENVIRONMENTS).join(", ")})`,
    );
  }
  const { envFile } = target;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const shellEnv = deps.shellEnv ?? {};
  // The key file compose will actually mount (shell export > env file >
  // compose default); also used to cross-check the rendered config below.
  let effectiveKeyFile = DEFAULT_PRIVATE_KEY_FILE;

  // --- env file exists and parses -----------------------------------------
  let env = null;
  try {
    env = parseEnvFile(deps.readFile(envFile));
    add("env-file", "pass", `${envFile} exists`);
  } catch {
    add(
      "env-file",
      "fail",
      `${envFile} not found — copy ${envFile}.example and fill it in`,
    );
  }

  if (env) {
    const missing = (key) => !env.has(key) || env.get(key) === "";

    // --- required keys present, no placeholder values left ------------------
    for (const key of REQUIRED_KEYS) {
      if (missing(key)) {
        add(`env:${key}`, "fail", `${key} is missing or empty in ${envFile}`);
      } else if (looksLikePlaceholder(env.get(key))) {
        add(`env:${key}`, "fail", `${key} still has a placeholder value`);
      } else {
        add(`env:${key}`, "pass", `${key} is set`);
      }
    }

    // Exactly one of PRIVATE_KEY_PATH / PRIVATE_KEY must be configured.
    const hasKeyPath = !missing("PRIVATE_KEY_PATH");
    const hasInlineKey = !missing("PRIVATE_KEY");
    if (hasKeyPath && hasInlineKey) {
      add("env:private-key", "fail", "set only one of PRIVATE_KEY_PATH or PRIVATE_KEY");
    } else if (!hasKeyPath && !hasInlineKey) {
      add("env:private-key", "fail", "one of PRIVATE_KEY_PATH or PRIVATE_KEY is required");
    } else if (hasInlineKey && looksLikePlaceholder(env.get("PRIVATE_KEY"))) {
      add("env:private-key", "fail", "PRIVATE_KEY still has a placeholder value");
    } else {
      add("env:private-key", "pass", hasKeyPath ? "PRIVATE_KEY_PATH is set" : "PRIVATE_KEY is set");
    }

    // --- SHERLOCK_ENV_FILE must point back at the selected file ------------
    // Compose interpolation defaults it to .env.production, so a staging file
    // that omits it silently loads production config into the containers.
    const declaredEnvFile = env.get("SHERLOCK_ENV_FILE") ?? "";
    if (declaredEnvFile === envFile) {
      add("env:SHERLOCK_ENV_FILE", "pass", `SHERLOCK_ENV_FILE=${envFile}`);
    } else if (declaredEnvFile === "") {
      add(
        "env:SHERLOCK_ENV_FILE",
        envName === "production" ? "warn" : "fail",
        envName === "production"
          ? `SHERLOCK_ENV_FILE is unset; the compose default (.env.production) matches, but set it explicitly`
          : `SHERLOCK_ENV_FILE is unset; compose would default to .env.production — set SHERLOCK_ENV_FILE=${envFile}`,
      );
    } else {
      add(
        "env:SHERLOCK_ENV_FILE",
        "fail",
        `SHERLOCK_ENV_FILE does not match ${envFile} — containers would load a different env file`,
      );
    }

    // --- shell-exported compose interpolation overrides ---------------------
    // Compose precedence: a variable exported in the shell BEATS the same
    // variable passed via --env-file. An exported SHERLOCK_ENV_FILE or
    // SHERLOCK_PRIVATE_KEY_FILE from an earlier production session would
    // silently point a staging deploy at production files.
    for (const key of SHELL_OVERRIDE_KEYS) {
      const shellValue = shellEnv[key];
      if (shellValue === undefined || shellValue === "") continue;
      const expected = key === "SHERLOCK_ENV_FILE" ? envFile : (env.get(key) ?? "");
      const matchesExpected =
        key === "SHERLOCK_ENV_FILE"
          ? shellValue === expected
          : expected !== "" &&
            resolve(deps.cwd ?? ".", shellValue) === resolve(deps.cwd ?? ".", expected);
      if (matchesExpected) {
        add(
          `shell:${key}`,
          "warn",
          `${key} is exported in the shell (it matches, but unset it — exports override --env-file)`,
        );
      } else {
        add(
          `shell:${key}`,
          "fail",
          `${key} is exported in the shell and OVERRIDES the --env-file value — unset it before deploying`,
        );
      }
    }

    // --- GitHub App private key file (compose `secrets:` source) -----------
    // Compose mounts this file even when PRIVATE_KEY is inline, so it must
    // exist either way. Staging must set it explicitly or it would mount the
    // production key. A shell export wins over the env file, so validate
    // what compose will actually use.
    const shellKeyFile = shellEnv.SHERLOCK_PRIVATE_KEY_FILE ?? "";
    const declaredKeyFile =
      shellKeyFile !== "" ? shellKeyFile : env.get("SHERLOCK_PRIVATE_KEY_FILE") ?? "";
    if (envName !== "production" && declaredKeyFile === "") {
      add(
        "secrets:private-key-file",
        "fail",
        "SHERLOCK_PRIVATE_KEY_FILE is unset; compose would mount the PRODUCTION key path — point it at the staging .pem",
      );
    } else if (
      envName !== "production" &&
      resolvesToProductionKey(declaredKeyFile, deps.cwd)
    ) {
      effectiveKeyFile = declaredKeyFile;
      add(
        "secrets:private-key-file",
        "fail",
        "SHERLOCK_PRIVATE_KEY_FILE resolves to the PRODUCTION key path — staging must use its own key file",
      );
    } else {
      const keyFile = declaredKeyFile === "" ? DEFAULT_PRIVATE_KEY_FILE : declaredKeyFile;
      effectiveKeyFile = keyFile;
      let size = -1;
      try {
        size = deps.fileSize(keyFile);
      } catch {
        size = -1;
      }
      if (size > 0) {
        add("secrets:private-key-file", "pass", `${keyFile} exists and is non-empty`);
      } else if (size === 0) {
        add("secrets:private-key-file", "fail", `${keyFile} exists but is EMPTY`);
      } else {
        add(
          "secrets:private-key-file",
          "fail",
          `${keyFile} not found (compose secret github_app_private_key)`,
        );
      }
    }

    // --- Redis sanity (presence already enforced above) ---------------------
    const redisUrl = env.get("REDIS_URL") ?? "";
    if (redisUrl !== "" && !looksLikePlaceholder(redisUrl)) {
      let host = "";
      try {
        host = new URL(redisUrl).hostname;
      } catch {
        add("redis:url", "fail", "REDIS_URL is not a parseable URL");
      }
      if (host === "localhost" || host === "127.0.0.1") {
        add(
          "redis:url",
          "warn",
          "REDIS_URL points at localhost, which does not resolve from inside a container",
        );
      } else if (host !== "") {
        add("redis:url", "pass", host === "redis" ? "bundled compose redis" : "external redis host");
      }
    }

    // --- Supabase state store (presence only; values never printed) --------
    const stateStore = env.get("SHERLOCK_STATE_STORE") ?? "";
    if (stateStore === "supabase") {
      for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
        if (missing(key)) {
          add(`env:${key}`, "fail", `${key} is required when SHERLOCK_STATE_STORE=supabase`);
        } else if (looksLikePlaceholder(env.get(key))) {
          add(`env:${key}`, "fail", `${key} still has a placeholder value`);
        } else {
          add(`env:${key}`, "pass", `${key} is set`);
        }
      }
      if (env.has("SUPABASE_URL") && !(env.get("SUPABASE_URL") ?? "").startsWith("https://")) {
        add("supabase:url-scheme", "warn", "SUPABASE_URL does not start with https://");
      }
    } else if (stateStore === "") {
      add(
        "env:SHERLOCK_STATE_STORE",
        "warn",
        "SHERLOCK_STATE_STORE is unset — investigation state will not be recorded",
      );
    } else {
      add("env:SHERLOCK_STATE_STORE", "pass", `state store: ${stateStore}`);
    }

    // --- environment-specific footguns --------------------------------------
    if (envName === "production") {
      if ((env.get("WEBHOOK_PROXY_URL") ?? "") !== "") {
        add(
          "env:WEBHOOK_PROXY_URL",
          "warn",
          "WEBHOOK_PROXY_URL is set — production should receive webhooks directly (leave it blank)",
        );
      }
      const allowSync = (env.get("ALLOW_SYNC_INVESTIGATIONS") ?? "").toLowerCase();
      if (allowSync === "true" || allowSync === "1") {
        add(
          "env:ALLOW_SYNC_INVESTIGATIONS",
          "fail",
          "ALLOW_SYNC_INVESTIGATIONS must never be enabled in production",
        );
      }
    }
  }

  // --- Docker daemon + compose config --------------------------------------
  let dockerOk = false;
  try {
    await deps.runCommand("docker", ["info"]);
    dockerOk = true;
    add("docker:daemon", "pass", "docker daemon is reachable");
  } catch {
    add("docker:daemon", "fail", "docker daemon is not reachable (is Docker running?)");
  }

  if (dockerOk && env) {
    let rendered = "";
    try {
      const result = await deps.runCommand("docker", [
        "compose",
        "--env-file",
        envFile,
        "-f",
        COMPOSE_FILE,
        "config",
      ]);
      rendered = result?.stdout ?? "";
      add("docker:compose-config", "pass", `compose config validates with --env-file ${envFile}`);
    } catch {
      add(
        "docker:compose-config",
        "fail",
        `docker compose --env-file ${envFile} -f ${COMPOSE_FILE} config failed — run it directly for details`,
      );
    }

    // Cross-check what compose ACTUALLY resolved — this is ground truth and
    // catches shell exports or interpolation mistakes the file-based checks
    // above cannot see. The rendered config (which contains the injected
    // secrets) is parsed in memory and NEVER printed.
    if (rendered !== "") {
      const envFileValues = [...rendered.matchAll(/SHERLOCK_ENV_FILE:\s*["']?([^\s"']+)/g)].map(
        (match) => match[1],
      );
      if (envFileValues.length === 0) {
        add(
          "compose:resolved-env-file",
          "skip",
          "SHERLOCK_ENV_FILE not visible in the rendered config; cannot cross-check",
        );
      } else if (envFileValues.every((value) => value === envFile)) {
        add("compose:resolved-env-file", "pass", `compose resolved SHERLOCK_ENV_FILE=${envFile}`);
      } else {
        add(
          "compose:resolved-env-file",
          "fail",
          `compose resolved SHERLOCK_ENV_FILE to a DIFFERENT file than ${envFile} — check shell exports and the env file`,
        );
      }

      const keyMatch = rendered.match(
        /github_app_private_key:\s*\n(?:\s*name:[^\n]*\n)?\s*file:\s*["']?([^\s"']+)/,
      );
      if (!keyMatch) {
        add(
          "compose:resolved-private-key",
          "skip",
          "private key secret not visible in the rendered config; cannot cross-check",
        );
      } else {
        const resolvedPath = keyMatch[1];
        const expectedSuffix = stripDotSlash(effectiveKeyFile);
        if (resolvedPath === effectiveKeyFile || resolvedPath.endsWith(`/${expectedSuffix}`)) {
          add(
            "compose:resolved-private-key",
            "pass",
            "compose resolved the expected private key file",
          );
        } else {
          add(
            "compose:resolved-private-key",
            "fail",
            "compose resolved the private key secret to a DIFFERENT path than SHERLOCK_PRIVATE_KEY_FILE — check shell exports",
          );
        }
      }
    }
  } else {
    add("docker:compose-config", "skip", "skipped (docker daemon or env file check failed)");
  }

  const ok = checks.every((check) => check.status !== "fail");
  return { ok, checks };
}

const STATUS_LABEL = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export function formatDoctorReport(envName, report) {
  const lines = [`Sherlock deploy doctor — ${envName}`];
  for (const check of report.checks) {
    lines.push(`${STATUS_LABEL[check.status]}  ${check.name}: ${check.detail}`);
  }
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  lines.push(
    report.ok
      ? `OK — no blockers${warns > 0 ? ` (${warns} warning${warns === 1 ? "" : "s"})` : ""}; safe to run compose up`
      : `BLOCKED — ${fails} failing check${fails === 1 ? "" : "s"}; fix before deploying`,
  );
  return lines.join("\n");
}

async function main() {
  const envName = process.argv[2];
  if (!ENVIRONMENTS[envName]) {
    console.error(`usage: node scripts/deploy-doctor.mjs <${Object.keys(ENVIRONMENTS).join("|")}>`);
    process.exit(2);
  }
  const report = await runDeployDoctor(envName, realDoctorDeps());
  console.log(formatDoctorReport(envName, report));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Sanitized: an unexpected error's message could echo env content.
    console.error(`deploy doctor crashed: ${sanitizeCrashMessage(error)}`);
    process.exit(2);
  });
}
