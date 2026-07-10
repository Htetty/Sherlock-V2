// Command parsing and authorization for the Sherlock webhook. Everything
// here is pure so it can be tested without GitHub or Redis. Rate limiting
// lives in backend/services/rate-limit.ts (Redis-backed, shared across
// processes).

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
