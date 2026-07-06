// Command parsing, authorization, and rate limiting for the Sherlock
// webhook. Everything here is pure or dependency-injected so it can be
// tested without GitHub or Redis.

export type SherlockCommand = "investigate";

// The entire trimmed comment must be the command — prose that merely
// mentions the word ("please investigate this", "/sherlock investigate
// later") must never trigger an investigation. Case-insensitive, tolerant
// of repeated spaces/tabs but not newlines: a multiline comment such as
// "/sherlock\ninvestigate" is not the command.
const COMMAND_PATTERN = /^\/sherlock[ \t]+investigate$/i;

export function parseSherlockCommand(commentBody: string): SherlockCommand | null {
  return COMMAND_PATTERN.test(commentBody.trim()) ? "investigate" : null;
}

// GitHub marks app/bot accounts (including Sherlock itself) with type
// "Bot"; the login suffix is a belt-and-braces check.
export function isBotUser(
  user: { type?: string; login?: string } | null | undefined,
): boolean {
  if (!user) {
    return true;
  }

  return user.type === "Bot" || (user.login ?? "").endsWith("[bot]");
}

// Repository roles allowed to start investigations. Everything else —
// read, triage, none, or any unknown/custom role — is rejected.
export const ALLOWED_REPOSITORY_ROLES = new Set(["write", "maintain", "admin"]);

export type RepositoryRole = {
  // Fine-grained role from the collaborator-permission API (covers
  // maintain/triage and custom org roles).
  roleName?: string | null;
  // Coarse classic permission (admin/write/read/none) as a fallback.
  permission?: string | null;
};

export function isAuthorizedRole(role: RepositoryRole): boolean {
  const effective = (role.roleName || role.permission || "").toLowerCase();

  return ALLOWED_REPOSITORY_ROLES.has(effective);
}

// --- In-process rate limiting ----------------------------------------------
//
// MVP guard only: this limiter lives in webhook-process memory, so it resets
// on restart and is per-process (not shared across replicas). Durable,
// distributed rate limiting will move to Redis or the database together with
// subscription plans.

export type RateLimiterOptions = {
  maxCommands?: number;
  windowMs?: number;
  now?: () => number;
};

export const RATE_LIMIT_DEFAULTS = {
  maxCommands: 5,
  windowMs: 10 * 60_000, // 10 minutes
};

export type InstallationRateLimiter = {
  // True when the command fits within the window and was counted;
  // false when the installation has exhausted its budget.
  tryAcquire: (installationId: number) => boolean;
};

export function createInstallationRateLimiter(
  options: RateLimiterOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): InstallationRateLimiter {
  const maxCommands =
    options.maxCommands ??
    positiveNumber(env.SHERLOCK_MAX_COMMANDS_PER_WINDOW) ??
    RATE_LIMIT_DEFAULTS.maxCommands;
  const windowMinutes = positiveNumber(env.SHERLOCK_COMMAND_WINDOW_MINUTES);
  const windowMs =
    options.windowMs ??
    (windowMinutes !== null ? windowMinutes * 60_000 : RATE_LIMIT_DEFAULTS.windowMs);
  const now = options.now ?? Date.now;
  const commandTimes = new Map<number, number[]>();

  return {
    tryAcquire: (installationId: number) => {
      const current = now();
      const cutoff = current - windowMs;
      const recent = (commandTimes.get(installationId) ?? []).filter(
        (timestamp) => timestamp > cutoff,
      );

      if (recent.length >= maxCommands) {
        commandTimes.set(installationId, recent);
        return false;
      }

      recent.push(current);
      commandTimes.set(installationId, recent);
      return true;
    },
  };
}

function positiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
