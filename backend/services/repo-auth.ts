// Authenticated GitHub cloning support: repository-identity validation,
// approved clone-URL construction, GitHub App access preflight, typed
// repository errors for retry classification, and a temporary GIT_ASKPASS
// mechanism that keeps the short-lived installation token out of URLs,
// argv, logs, errors, artifacts, and Git configuration.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// --- Typed repository errors --------------------------------------------------
//
// Retry classification is done by TYPE, never by message matching. The
// worker's retry classifier checks `instanceof RepositoryError` and the
// `retryable` flag directly.

export type RepositoryErrorKind =
  // Logical (non-retryable): wrong identity, no access, bad credentials.
  | "invalid_identity"
  | "access_denied"
  | "insufficient_permission"
  | "invalid_credentials"
  | "not_found"
  // Transient (retryable through BullMQ backoff).
  | "transient_github_api"
  | "transient_clone";

export class RepositoryError extends Error {
  constructor(
    readonly kind: RepositoryErrorKind,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

// GitHub intentionally returns indistinguishable 404s for private
// repositories the installation cannot see, so this combined message is the
// most specific safe claim.
export const COMBINED_ACCESS_MESSAGE =
  "Sherlock could not access this repository. Confirm that the GitHub App is installed on the repository and has Contents: Read permission.";

// --- Repository identity validation --------------------------------------------

// GitHub owner: alphanumeric and hyphens, no leading/trailing hyphen, <= 39.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// GitHub repository: word characters, dots, hyphens, <= 100, not "." / "..".
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function validateRepositoryIdentity(owner: string, repo: string): void {
  const problems: string[] = [];

  if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
    problems.push("owner");
  }

  if (
    typeof repo !== "string" ||
    !REPO_PATTERN.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    problems.push("repository name");
  }

  if (problems.length > 0) {
    // Covers path traversal, slashes, query strings, fragments, embedded
    // credentials, schemes, and hosts: none of those characters can pass
    // the allowlisted patterns above.
    throw new RepositoryError(
      "invalid_identity",
      `Invalid repository ${problems.join(" and ")}.`,
      false,
    );
  }
}

// The ONLY clone-URL constructor: authentication is only ever sent to this
// approved GitHub HTTPS host, and the URL is derived exclusively from the
// validated owner/name — never from a webhook-supplied URL.
export function buildGitHubCloneUrl(owner: string, repo: string): string {
  validateRepositoryIdentity(owner, repo);
  return `https://github.com/${owner}/${repo}.git`;
}

// --- GitHub App access preflight -------------------------------------------------

export type GitHubApiResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

// Injectable GitHub API boundary (tests never contact GitHub).
export type GitHubApiClient = (
  apiPath: string,
  token: string,
) => Promise<GitHubApiResponse>;

export const realGitHubApiClient: GitHubApiClient = async (apiPath, token) => {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });

  const body = await response.json().catch(() => null);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return { status: response.status, headers, body };
};

// Permission metadata from the installation access-token response — the
// AUTHORITATIVE record of what the minted token can do. The repository
// response's `permissions.pull` field is NOT authoritative for installation
// tokens and must never be used to infer Contents access.
export type InstallationTokenPermissions = Record<string, string> | null;

export function hasContentsReadPermission(
  permissions: InstallationTokenPermissions | undefined,
): boolean {
  const contents = permissions?.contents;

  return contents === "read" || contents === "write";
}

// Verifies — with the same installation token that will authenticate the
// clone — that this installation can read this exact repository, BEFORE any
// credential-helper file exists or Git starts. Contents permission comes
// from the token-minting response's permission metadata; GET /repos only
// verifies that the token can access the exact repository. Never widens
// token scope and never trusts webhook-supplied permission data.
export async function preflightRepositoryAccess(
  owner: string,
  repo: string,
  token: string,
  github: GitHubApiClient = realGitHubApiClient,
  tokenPermissions?: InstallationTokenPermissions,
): Promise<void> {
  validateRepositoryIdentity(owner, repo);

  // Contents: Read (or Write) must be present in the token's own permission
  // metadata; a missing or "none" Contents permission fails safely before
  // any network call.
  if (!hasContentsReadPermission(tokenPermissions)) {
    throw new RepositoryError(
      "insufficient_permission",
      "The GitHub App installation token was not granted Contents: Read permission, which cloning requires.",
      false,
    );
  }

  let response: GitHubApiResponse;

  try {
    response = await github(`/repos/${owner}/${repo}`, token);
  } catch (error) {
    throw new RepositoryError(
      "transient_github_api",
      `GitHub could not be reached to verify repository access: ${error instanceof Error ? error.message : "network error"}`,
      true,
    );
  }

  if (response.status === 200) {
    // Repository access verified. `body.permissions` is deliberately
    // ignored: it does not reliably describe installation-token Contents
    // access.
    return;
  }

  if (response.status === 401) {
    throw new RepositoryError(
      "invalid_credentials",
      "The GitHub App installation token was rejected as invalid or expired.",
      false,
    );
  }

  if (response.status === 403) {
    // Rate limiting is transient; classify by GitHub's own headers, not by
    // message matching.
    const remaining = response.headers["x-ratelimit-remaining"];

    if (remaining === "0" || response.headers["retry-after"] !== undefined) {
      throw new RepositoryError(
        "transient_github_api",
        "GitHub rate-limited the repository access check.",
        true,
      );
    }

    throw new RepositoryError("access_denied", COMBINED_ACCESS_MESSAGE, false);
  }

  if (response.status === 404) {
    // Intentionally indistinguishable: missing repository, private and
    // inaccessible, or omitted from a selected-repositories installation.
    throw new RepositoryError("access_denied", COMBINED_ACCESS_MESSAGE, false);
  }

  if (response.status >= 500 || response.status === 429) {
    throw new RepositoryError(
      "transient_github_api",
      `GitHub returned a temporary error (HTTP ${response.status}) during the repository access check.`,
      true,
    );
  }

  throw new RepositoryError("access_denied", COMBINED_ACCESS_MESSAGE, false);
}

// --- Temporary Git authentication -------------------------------------------------
//
// GIT_ASKPASS mechanism: the helper script contains NO token — it echoes the
// token from the Git child process's environment. The token therefore exists
// only in that short-lived child environment, never in files, argv, URLs, or
// Git configuration. The helper directory is 0o700 and removed after the
// clone, success or failure.

const TOKEN_ENV_VAR = "SHERLOCK_GIT_TOKEN";

export type GitAuthContext = {
  // Environment variables to add to the Git child process only.
  env: Record<string, string>;
  cleanup: () => Promise<void>;
};

export async function createGitAuthContext(token: string): Promise<GitAuthContext> {
  const authDir = await mkdtemp(path.join(tmpdir(), "sherlock-git-auth-"));
  await chmod(authDir, 0o700);

  const helperPath = path.join(authDir, "askpass.sh");
  const helper = [
    "#!/bin/sh",
    'case "$1" in',
    '  Username*) echo "x-access-token" ;;',
    `  Password*) echo "$${TOKEN_ENV_VAR}" ;;`,
    "esac",
    "",
  ].join("\n");

  await writeFile(helperPath, helper, { mode: 0o700 });

  return {
    env: {
      GIT_ASKPASS: helperPath,
      [TOKEN_ENV_VAR]: token,
      GIT_TERMINAL_PROMPT: "0",
      // Ignore host-level git config (credential helpers, redirects, ...).
      GIT_CONFIG_NOSYSTEM: "1",
    },
    cleanup: async () => {
      await rm(authDir, { recursive: true, force: true });
    },
  };
}

// Scrubs anything credential-adjacent from text that may end up in thrown
// error messages (belt and braces: the token never enters argv or URLs, so
// it should never appear in Git output either).
export function redactGitFailure(text: string, token: string | null): string {
  let scrubbed = text;

  if (token) {
    scrubbed = scrubbed.split(token).join("[REDACTED]");
  }

  return scrubbed
    .replace(/x-access-token:[^@\s]+@/g, "[REDACTED]@")
    .replace(new RegExp(`${TOKEN_ENV_VAR}=\\S+`, "g"), `${TOKEN_ENV_VAR}=[REDACTED]`)
    .replace(/sherlock-git-auth-[A-Za-z0-9]+/g, "sherlock-git-auth-[ELIDED]");
}
