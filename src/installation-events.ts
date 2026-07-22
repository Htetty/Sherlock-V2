// GitHub App installation lifecycle webhooks (Probot-verified only — no
// second webhook endpoint exists, so signature verification is inherited).
//
// Registered alongside the existing issue_comment.created investigation flow
// without touching it: a failing installation-metadata write never affects
// investigations, but lifecycle handler failures are rethrown so GitHub
// redelivers authoritative state instead of it being silently dropped.
//
// All GitHub numeric ids are converted to decimal strings at this boundary
// (toGitHubIdString) and stay strings from here on.

import type { Probot } from "probot";
import {
  applyInstallationCreated,
  applyInstallationDeleted,
  applyInstallationRepositoriesChanged,
  applyInstallationSuspended,
  toGitHubIdString,
  type InstallationLifecycleDeps,
  type InstallationSnapshot,
  type RepositorySnapshot,
} from "../backend/services/github-installations.js";

// Lazily resolved so that environments without Supabase configuration (local
// bot development, tests) skip persistence with a warning instead of failing
// every webhook or crashing at import time.
export type InstallationEventDeps = {
  getLifecycleDeps: () => Promise<InstallationLifecycleDeps | null>;
  log?: (message: string) => void;
};

// --- Payload normalization ----------------------------------------------------
// Verified webhook payloads only; still parsed defensively because these
// shapes are external input. A malformed payload is logged and skipped —
// redelivery of the same malformed payload cannot succeed either.

type WebhookInstallationLike = {
  id?: unknown;
  account?: {
    id?: unknown;
    login?: unknown;
    type?: unknown;
    avatar_url?: unknown;
  } | null;
  repository_selection?: unknown;
  permissions?: unknown;
  suspended_at?: unknown;
};

type WebhookRepositoryLike = {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  private?: unknown;
};

export function snapshotFromWebhookInstallation(
  installation: WebhookInstallationLike | null | undefined,
): InstallationSnapshot | null {
  const installationId = toGitHubIdString(installation?.id);
  const accountId = toGitHubIdString(installation?.account?.id);
  const accountLogin = installation?.account?.login;
  const accountType = installation?.account?.type;
  const repositorySelection = installation?.repository_selection;

  if (
    installationId === null ||
    accountId === null ||
    typeof accountLogin !== "string" ||
    accountLogin === "" ||
    (accountType !== "User" && accountType !== "Organization") ||
    (repositorySelection !== "all" && repositorySelection !== "selected")
  ) {
    return null;
  }

  const permissions: Record<string, string> = {};

  if (installation?.permissions && typeof installation.permissions === "object") {
    for (const [name, level] of Object.entries(installation.permissions)) {
      if (typeof level === "string") {
        permissions[name] = level;
      }
    }
  }

  return {
    installationId,
    accountId,
    accountLogin,
    accountType,
    accountAvatarUrl:
      typeof installation?.account?.avatar_url === "string"
        ? installation.account.avatar_url
        : null,
    repositorySelection,
    permissions,
    suspendedAt:
      typeof installation?.suspended_at === "string" ? installation.suspended_at : null,
  };
}

export function repositoriesFromWebhookList(
  repositories: WebhookRepositoryLike[] | null | undefined,
  fallbackOwnerLogin: string,
): RepositorySnapshot[] {
  const snapshots: RepositorySnapshot[] = [];

  for (const repository of repositories ?? []) {
    const repositoryId = toGitHubIdString(repository?.id);
    const name = repository?.name;
    const fullName = repository?.full_name;

    if (repositoryId === null || typeof name !== "string" || name === "") {
      continue;
    }

    const resolvedFullName =
      typeof fullName === "string" && fullName.includes("/")
        ? fullName
        : `${fallbackOwnerLogin}/${name}`;

    snapshots.push({
      repositoryId,
      ownerLogin: resolvedFullName.split("/")[0] ?? fallbackOwnerLogin,
      name,
      fullName: resolvedFullName,
      private: repository?.private === true,
    });
  }

  return snapshots;
}

// --- Registration -------------------------------------------------------------

export function registerInstallationEvents(
  app: Probot,
  deps: InstallationEventDeps,
): void {
  const log = deps.log ?? ((message: string) => console.log(message));

  // Shared prologue: resolve persistence, skip with a warning when the
  // backend has no Supabase configuration.
  const withLifecycleDeps = async (
    eventName: string,
    handler: (lifecycle: InstallationLifecycleDeps) => Promise<void>,
  ) => {
    const lifecycle = await deps.getLifecycleDeps();

    if (!lifecycle) {
      log(
        `Skipping ${eventName}: installation persistence is not configured (Supabase env missing).`,
      );
      return;
    }

    try {
      await handler({ ...lifecycle, log: lifecycle.log ?? log });
    } catch (error) {
      // Sanitized log, then rethrow so Probot returns an error and GitHub
      // retries the delivery.
      log(
        `Installation lifecycle handler ${eventName} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      throw error;
    }
  };

  app.on("installation.created", async (context) => {
    const payload = context.payload as {
      installation?: WebhookInstallationLike;
      repositories?: WebhookRepositoryLike[];
      sender?: { id?: unknown };
    };
    const snapshot = snapshotFromWebhookInstallation(payload.installation);

    if (!snapshot) {
      log("Ignoring installation.created with an unparseable installation payload.");
      return;
    }

    await withLifecycleDeps("installation.created", (lifecycle) =>
      applyInstallationCreated(lifecycle, {
        snapshot,
        senderGithubUserId: toGitHubIdString(payload.sender?.id),
        repositories: repositoriesFromWebhookList(
          payload.repositories,
          snapshot.accountLogin,
        ),
        eventAt: new Date().toISOString(),
      }),
    );
  });

  app.on("installation.deleted", async (context) => {
    const payload = context.payload as { installation?: WebhookInstallationLike };
    const installationId = toGitHubIdString(payload.installation?.id);

    if (installationId === null) {
      log("Ignoring installation.deleted without a valid installation id.");
      return;
    }

    await withLifecycleDeps("installation.deleted", (lifecycle) =>
      applyInstallationDeleted(lifecycle, installationId, new Date().toISOString()),
    );
  });

  const handleSuspension = (suspended: boolean) => async (context: { payload: unknown }) => {
    const payload = context.payload as { installation?: WebhookInstallationLike };
    const installationId = toGitHubIdString(payload.installation?.id);
    const eventName = suspended ? "installation.suspend" : "installation.unsuspend";

    if (installationId === null) {
      log(`Ignoring ${eventName} without a valid installation id.`);
      return;
    }

    await withLifecycleDeps(eventName, (lifecycle) =>
      applyInstallationSuspended(
        lifecycle,
        installationId,
        suspended,
        new Date().toISOString(),
      ),
    );
  };

  app.on("installation.suspend", handleSuspension(true));
  app.on("installation.unsuspend", handleSuspension(false));

  const handleRepositoriesChanged = async (context: { payload: unknown }) => {
    const payload = context.payload as {
      installation?: WebhookInstallationLike;
      repositories_added?: WebhookRepositoryLike[];
      repositories_removed?: WebhookRepositoryLike[];
    };
    const snapshot = snapshotFromWebhookInstallation(payload.installation);
    const installationId = snapshot?.installationId ?? toGitHubIdString(payload.installation?.id);

    if (installationId === null) {
      log("Ignoring installation_repositories event without a valid installation id.");
      return;
    }

    const removedRepositoryIds: string[] = [];

    for (const repository of payload.repositories_removed ?? []) {
      const repositoryId = toGitHubIdString(repository?.id);
      if (repositoryId !== null) {
        removedRepositoryIds.push(repositoryId);
      }
    }

    await withLifecycleDeps("installation_repositories", (lifecycle) =>
      applyInstallationRepositoriesChanged(lifecycle, {
        snapshot,
        installationId,
        added: repositoriesFromWebhookList(
          payload.repositories_added,
          snapshot?.accountLogin ?? "",
        ),
        removedRepositoryIds,
        eventAt: new Date().toISOString(),
      }),
    );
  };

  app.on("installation_repositories.added", handleRepositoriesChanged);
  app.on("installation_repositories.removed", handleRepositoriesChanged);
}
