// GitHub App installation domain: installation snapshots, per-installation
// repository snapshots, user↔installation membership, and one-time
// installation-onboarding nonces.
//
// Design rules honored here:
//   - GitHub numeric ids are DECIMAL STRINGS end to end (never JavaScript
//     numbers; precision loss would corrupt identity comparisons).
//   - Installation and repository rows are never deleted: lifecycle events
//     mark them deleted/removed so history and audit remain intact.
//   - A deleted installation id is definitive (GitHub issues a fresh id on
//     reinstall), so out-of-order or duplicate events never revive one.
//   - Membership is only ever created from VERIFIED ownership:
//     personal_account_match (installation account id == profile GitHub id)
//     or installation_webhook_sender (verified installation.created sender id
//     == profile GitHub id). Login strings are never compared.
//   - Nonces store only SHA-256 hashes; the raw value never persists and is
//     consumed atomically exactly once.
//
// Store implementations: Supabase (service role, production) and in-memory
// (tests). Both sit behind the same InstallationDataStore seam so routes and
// webhook handlers are testable without credentials.

import { createHash } from "node:crypto";
import type { ProfileRecord, ProfileStore } from "./github-identity.js";

// --- Types --------------------------------------------------------------------

export type InstallationStatus = "active" | "suspended" | "deleted";
export type InstallationAccountType = "User" | "Organization";
export type RepositorySelection = "all" | "selected";

export type InstallationRecord = {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: InstallationAccountType;
  accountAvatarUrl: string | null;
  repositorySelection: RepositorySelection;
  status: InstallationStatus;
  permissions: Record<string, string>;
  createdByGithubUserId: string | null;
  suspendedAt: string | null;
  deletedAt: string | null;
  lastGithubEventAt: string | null;
};

// Authoritative snapshot of an installation (from the GitHub App API or a
// verified webhook payload) minus lifecycle bookkeeping.
export type InstallationSnapshot = {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: InstallationAccountType;
  accountAvatarUrl: string | null;
  repositorySelection: RepositorySelection;
  permissions: Record<string, string>;
  suspendedAt: string | null;
};

export type RepositorySnapshot = {
  repositoryId: string;
  ownerLogin: string;
  name: string;
  fullName: string;
  private: boolean;
};

export type AuthorizedRepositoryRecord = RepositorySnapshot & {
  installationId: string;
  installationStatus: InstallationStatus;
  ownerAvatarUrl: string | null;
};

export type VerificationMethod =
  | "personal_account_match"
  | "installation_webhook_sender";

export type MembershipRecord = {
  userId: string;
  installationId: string;
  relationship: "installer";
  verificationMethod: VerificationMethod;
};

export type NonceClaimStatus =
  | "unclaimed"
  | "pending_webhook"
  | "verified"
  | "rejected"
  | "expired"
  | "superseded";

export type NonceRecord = {
  id: string;
  nonceHash: string;
  userId: string;
  expiresAt: string;
  consumedAt: string | null;
  installationId: string | null;
  claimStatus: NonceClaimStatus;
  verificationMethod: string | null;
  failureCode: string | null;
};

export type ConsumeNonceResult =
  | { outcome: "consumed"; nonce: NonceRecord }
  // Unknown hash or already consumed — indistinguishable on purpose.
  | { outcome: "not_found" }
  | { outcome: "expired" }
  | { outcome: "superseded" };

export interface InstallationDataStore {
  // Installations.
  getInstallation(installationId: string): Promise<InstallationRecord | null>;
  upsertInstallationSnapshot(
    snapshot: InstallationSnapshot,
    options: { eventAt: string; createdByGithubUserId?: string },
  ): Promise<void>;
  markInstallationDeleted(installationId: string, eventAt: string): Promise<void>;
  setInstallationSuspended(
    installationId: string,
    suspended: boolean,
    eventAt: string,
  ): Promise<void>;

  // Repositories.
  upsertInstallationRepositories(
    installationId: string,
    repositories: RepositorySnapshot[],
    eventAt: string,
  ): Promise<void>;
  markInstallationRepositoriesRemoved(
    installationId: string,
    repositoryIds: string[],
    eventAt: string,
  ): Promise<void>;
  markAllInstallationRepositoriesRemoved(
    installationId: string,
    eventAt: string,
  ): Promise<void>;

  // Membership. upsert is idempotent; existing rows are preserved.
  upsertMembership(membership: MembershipRecord): Promise<void>;
  listInstallationsForUser(userId: string): Promise<InstallationRecord[]>;
  listRepositoriesForUser(userId: string): Promise<AuthorizedRepositoryRecord[]>;

  // Nonces.
  supersedeUnclaimedNonces(userId: string): Promise<void>;
  insertNonce(nonce: {
    nonceHash: string;
    userId: string;
    expiresAt: string;
  }): Promise<void>;
  // Atomic: exactly one caller may consume a given hash.
  consumeNonceByHash(nonceHash: string): Promise<ConsumeNonceResult>;
  attachInstallationToNonce(
    nonceId: string,
    installationId: string,
  ): Promise<void>;
  updateNonceClaim(
    nonceId: string,
    fields: {
      claimStatus: NonceClaimStatus;
      verificationMethod?: VerificationMethod;
      failureCode?: string;
    },
  ): Promise<void>;
  findPendingWebhookClaims(installationId: string): Promise<NonceRecord[]>;
}

// --- Shared helpers -----------------------------------------------------------

const DECIMAL_DIGITS = /^\d{1,20}$/;

// Normalize a GitHub id from a verified payload into a decimal string.
// Numbers are accepted only when they are safe non-negative integers.
export function toGitHubIdString(value: unknown): string | null {
  if (typeof value === "string" && DECIMAL_DIGITS.test(value)) {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  return null;
}

export function hashInstallationNonce(rawNonce: string): string {
  return createHash("sha256").update(rawNonce, "utf8").digest("hex");
}

// Deterministic dashboard ordering: active installations first, then account
// login (case-insensitive), then installation id as a stable tiebreaker.
const STATUS_ORDER: Record<InstallationStatus, number> = {
  active: 0,
  suspended: 1,
  deleted: 2,
};

export function sortInstallationsForListing(
  installations: InstallationRecord[],
): InstallationRecord[] {
  return [...installations].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;

    const byLogin = a.accountLogin
      .toLowerCase()
      .localeCompare(b.accountLogin.toLowerCase());
    if (byLogin !== 0) return byLogin;

    return a.installationId.localeCompare(b.installationId);
  });
}

// --- Ownership verification ---------------------------------------------------

export type OwnershipVerification =
  | { verified: true; method: VerificationMethod }
  | { verified: false; reason: "account_mismatch" | "sender_mismatch" | "sender_unknown" };

// The single ownership policy used by both the setup callback and webhook
// reconciliation. Immutable numeric ids only — never login strings.
export function verifyInstallationOwnership(input: {
  accountType: InstallationAccountType;
  accountId: string;
  createdByGithubUserId: string | null;
  profileGithubUserId: string;
}): OwnershipVerification {
  if (input.accountType === "User") {
    return input.accountId === input.profileGithubUserId
      ? { verified: true, method: "personal_account_match" }
      : { verified: false, reason: "account_mismatch" };
  }

  // Organization: only the verified installation.created webhook sender may
  // claim installer access. No sender captured yet → cannot verify yet.
  if (input.createdByGithubUserId === null) {
    return { verified: false, reason: "sender_unknown" };
  }

  return input.createdByGithubUserId === input.profileGithubUserId
    ? { verified: true, method: "installation_webhook_sender" }
    : { verified: false, reason: "sender_mismatch" };
}

// --- Webhook lifecycle application --------------------------------------------
// Policy layer shared by Probot handlers (src/installation-events.ts) and the
// setup callback. Deletion is definitive per installation id: no later event
// may revive a deleted row.

export type InstallationLifecycleDeps = {
  store: InstallationDataStore;
  profiles: ProfileStore;
  log?: (message: string) => void;
};

export async function applyInstallationCreated(
  deps: InstallationLifecycleDeps,
  input: {
    snapshot: InstallationSnapshot;
    senderGithubUserId: string | null;
    repositories: RepositorySnapshot[];
    eventAt: string;
  },
): Promise<void> {
  const log = deps.log ?? (() => {});
  const existing = await deps.store.getInstallation(input.snapshot.installationId);

  if (existing?.status === "deleted") {
    log(
      `Ignoring installation.created for deleted installation ${input.snapshot.installationId}.`,
    );
    return;
  }

  await deps.store.upsertInstallationSnapshot(input.snapshot, {
    eventAt: input.eventAt,
    ...(input.senderGithubUserId !== null
      ? { createdByGithubUserId: input.senderGithubUserId }
      : {}),
  });

  if (input.repositories.length > 0) {
    await deps.store.upsertInstallationRepositories(
      input.snapshot.installationId,
      input.repositories,
      input.eventAt,
    );
  }

  if (input.senderGithubUserId !== null) {
    await reconcilePendingClaims(
      deps,
      input.snapshot.installationId,
      input.senderGithubUserId,
    );
  }
}

export async function applyInstallationDeleted(
  deps: InstallationLifecycleDeps,
  installationId: string,
  eventAt: string,
): Promise<void> {
  await deps.store.markInstallationDeleted(installationId, eventAt);
  await deps.store.markAllInstallationRepositoriesRemoved(installationId, eventAt);
}

export async function applyInstallationSuspended(
  deps: InstallationLifecycleDeps,
  installationId: string,
  suspended: boolean,
  eventAt: string,
): Promise<void> {
  const existing = await deps.store.getInstallation(installationId);

  if (existing?.status === "deleted") {
    (deps.log ?? (() => {}))(
      `Ignoring suspend/unsuspend for deleted installation ${installationId}.`,
    );
    return;
  }

  await deps.store.setInstallationSuspended(installationId, suspended, eventAt);
}

export async function applyInstallationRepositoriesChanged(
  deps: InstallationLifecycleDeps,
  input: {
    snapshot: InstallationSnapshot | null;
    installationId: string;
    added: RepositorySnapshot[];
    removedRepositoryIds: string[];
    eventAt: string;
  },
): Promise<void> {
  const existing = await deps.store.getInstallation(input.installationId);

  if (existing?.status === "deleted") {
    (deps.log ?? (() => {}))(
      `Ignoring repository change for deleted installation ${input.installationId}.`,
    );
    return;
  }

  // Keep the installation snapshot (repository_selection in particular) in
  // sync when the event carries the full installation object.
  if (input.snapshot) {
    await deps.store.upsertInstallationSnapshot(input.snapshot, {
      eventAt: input.eventAt,
    });
  }

  if (input.added.length > 0) {
    await deps.store.upsertInstallationRepositories(
      input.installationId,
      input.added,
      input.eventAt,
    );
  }

  if (input.removedRepositoryIds.length > 0) {
    await deps.store.markInstallationRepositoriesRemoved(
      input.installationId,
      input.removedRepositoryIds,
      input.eventAt,
    );
  }
}

// Reconcile pending organization claims once the verified installation.created
// sender is known. Idempotent: a claim is finalized at most once, and the
// membership upsert is idempotent by primary key.
export async function reconcilePendingClaims(
  deps: InstallationLifecycleDeps,
  installationId: string,
  senderGithubUserId: string,
): Promise<void> {
  const log = deps.log ?? (() => {});
  const claims = await deps.store.findPendingWebhookClaims(installationId);

  for (const claim of claims) {
    const profile = await deps.profiles.getById(claim.userId);

    if (!profile) {
      await deps.store.updateNonceClaim(claim.id, {
        claimStatus: "rejected",
        failureCode: "profile_missing",
      });
      continue;
    }

    if (profile.githubUserId === senderGithubUserId) {
      await deps.store.upsertMembership({
        userId: claim.userId,
        installationId,
        relationship: "installer",
        verificationMethod: "installation_webhook_sender",
      });
      await deps.store.updateNonceClaim(claim.id, {
        claimStatus: "verified",
        verificationMethod: "installation_webhook_sender",
      });
      log(
        `Verified pending organization claim for installation ${installationId}.`,
      );
    } else {
      await deps.store.updateNonceClaim(claim.id, {
        claimStatus: "rejected",
        failureCode: "sender_mismatch",
      });
      log(
        `Rejected pending organization claim for installation ${installationId}: sender mismatch.`,
      );
    }
  }
}

// --- In-memory store (tests) --------------------------------------------------

export function createInMemoryInstallationDataStore(): InstallationDataStore & {
  // Test helpers.
  snapshotNonces(): NonceRecord[];
  snapshotMemberships(): MembershipRecord[];
  snapshotRepositories(): Array<
    RepositorySnapshot & {
      installationId: string;
      status: "active" | "removed";
      removedAt: string | null;
    }
  >;
} {
  const installations = new Map<string, InstallationRecord>();
  const repositories = new Map<
    string,
    RepositorySnapshot & {
      installationId: string;
      status: "active" | "removed";
      removedAt: string | null;
    }
  >();
  const memberships = new Map<string, MembershipRecord>();
  const nonces: NonceRecord[] = [];
  let nonceCounter = 0;

  const repoKey = (installationId: string, repositoryId: string) =>
    `${installationId}:${repositoryId}`;
  const membershipKey = (userId: string, installationId: string) =>
    `${userId}:${installationId}`;

  return {
    async getInstallation(installationId) {
      return installations.get(installationId) ?? null;
    },
    async upsertInstallationSnapshot(snapshot, options) {
      const existing = installations.get(snapshot.installationId);
      installations.set(snapshot.installationId, {
        ...snapshot,
        status: snapshot.suspendedAt !== null ? "suspended" : "active",
        createdByGithubUserId:
          options.createdByGithubUserId ?? existing?.createdByGithubUserId ?? null,
        deletedAt: existing?.deletedAt ?? null,
        lastGithubEventAt: options.eventAt,
      });
    },
    async markInstallationDeleted(installationId, eventAt) {
      const existing = installations.get(installationId);
      if (!existing) return;
      installations.set(installationId, {
        ...existing,
        status: "deleted",
        deletedAt: eventAt,
        lastGithubEventAt: eventAt,
      });
    },
    async setInstallationSuspended(installationId, suspended, eventAt) {
      const existing = installations.get(installationId);
      if (!existing) return;
      installations.set(installationId, {
        ...existing,
        status: suspended ? "suspended" : "active",
        suspendedAt: suspended ? eventAt : null,
        lastGithubEventAt: eventAt,
      });
    },
    async upsertInstallationRepositories(installationId, repos, eventAt) {
      for (const repo of repos) {
        repositories.set(repoKey(installationId, repo.repositoryId), {
          ...repo,
          installationId,
          status: "active",
          removedAt: null,
        });
      }
      void eventAt;
    },
    async markInstallationRepositoriesRemoved(installationId, repositoryIds, eventAt) {
      for (const repositoryId of repositoryIds) {
        const existing = repositories.get(repoKey(installationId, repositoryId));
        if (existing) {
          existing.status = "removed";
          existing.removedAt = eventAt;
        }
      }
    },
    async markAllInstallationRepositoriesRemoved(installationId, eventAt) {
      for (const repo of repositories.values()) {
        if (repo.installationId === installationId && repo.status === "active") {
          repo.status = "removed";
          repo.removedAt = eventAt;
        }
      }
    },
    async upsertMembership(membership) {
      const key = membershipKey(membership.userId, membership.installationId);
      if (!memberships.has(key)) {
        memberships.set(key, membership);
      }
    },
    async listInstallationsForUser(userId) {
      const result: InstallationRecord[] = [];
      for (const membership of memberships.values()) {
        if (membership.userId !== userId) continue;
        const installation = installations.get(membership.installationId);
        if (installation) result.push(installation);
      }
      return result;
    },
    async listRepositoriesForUser(userId) {
      const installationById = new Map(
        (await this.listInstallationsForUser(userId)).map((installation) => [
          installation.installationId,
          installation,
        ]),
      );
      const result: AuthorizedRepositoryRecord[] = [];
      for (const repository of repositories.values()) {
        const installation = installationById.get(repository.installationId);
        if (
          !installation ||
          installation.status !== "active" ||
          repository.status !== "active"
        ) {
          continue;
        }
        result.push({
          repositoryId: repository.repositoryId,
          ownerLogin: repository.ownerLogin,
          name: repository.name,
          fullName: repository.fullName,
          private: repository.private,
          installationId: repository.installationId,
          installationStatus: installation.status,
          ownerAvatarUrl: installation.accountAvatarUrl,
        });
      }
      return result.sort((left, right) =>
        left.fullName.localeCompare(right.fullName),
      );
    },
    async supersedeUnclaimedNonces(userId) {
      for (const nonce of nonces) {
        if (
          nonce.userId === userId &&
          nonce.consumedAt === null &&
          nonce.claimStatus === "unclaimed"
        ) {
          nonce.claimStatus = "superseded";
        }
      }
    },
    async insertNonce({ nonceHash, userId, expiresAt }) {
      nonceCounter += 1;
      nonces.push({
        id: `nonce-${nonceCounter}`,
        nonceHash,
        userId,
        expiresAt,
        consumedAt: null,
        installationId: null,
        claimStatus: "unclaimed",
        verificationMethod: null,
        failureCode: null,
      });
    },
    async consumeNonceByHash(nonceHash) {
      const nonce = nonces.find(
        (candidate) => candidate.nonceHash === nonceHash && candidate.consumedAt === null,
      );

      if (!nonce) {
        return { outcome: "not_found" };
      }

      nonce.consumedAt = new Date().toISOString();

      if (nonce.claimStatus === "superseded") {
        return { outcome: "superseded" };
      }

      if (Date.parse(nonce.expiresAt) <= Date.now()) {
        nonce.claimStatus = "expired";
        return { outcome: "expired" };
      }

      return { outcome: "consumed", nonce: { ...nonce } };
    },
    async attachInstallationToNonce(nonceId, installationId) {
      const nonce = nonces.find((candidate) => candidate.id === nonceId);
      if (nonce) {
        nonce.installationId = installationId;
        nonce.claimStatus = "pending_webhook";
      }
    },
    async updateNonceClaim(nonceId, fields) {
      const nonce = nonces.find((candidate) => candidate.id === nonceId);
      if (nonce) {
        nonce.claimStatus = fields.claimStatus;
        if (fields.verificationMethod !== undefined) {
          nonce.verificationMethod = fields.verificationMethod;
        }
        if (fields.failureCode !== undefined) {
          nonce.failureCode = fields.failureCode;
        }
      }
    },
    async findPendingWebhookClaims(installationId) {
      return nonces
        .filter(
          (nonce) =>
            nonce.installationId === installationId &&
            nonce.claimStatus === "pending_webhook",
        )
        .map((nonce) => ({ ...nonce }));
    },
    snapshotNonces: () => nonces.map((nonce) => ({ ...nonce })),
    snapshotMemberships: () => [...memberships.values()],
    snapshotRepositories: () => [...repositories.values()].map((repo) => ({ ...repo })),
  };
}

// --- Supabase-backed store ----------------------------------------------------
// Structural client surface (same approach as the state store): awaitable
// PostgREST-style builders. The production adapter casts the real service-role
// client; nothing here ever runs with the publishable key.

type SupabaseResult<T = unknown> = { data: T; error: { message: string } | null };

interface FilterBuilderLike<T = unknown> extends PromiseLike<SupabaseResult<T>> {
  eq(column: string, value: unknown): FilterBuilderLike<T>;
  is(column: string, value: unknown): FilterBuilderLike<T>;
  in(column: string, values: unknown[]): FilterBuilderLike<T>;
  maybeSingle(): Promise<SupabaseResult<T>>;
}

export interface InstallationsClientLike {
  from(table: string): {
    select(columns: string): FilterBuilderLike<unknown>;
    upsert(
      values: unknown,
      options: { onConflict: string },
    ): PromiseLike<SupabaseResult<unknown>>;
    update(values: Record<string, unknown>): FilterBuilderLike<unknown>;
    insert(values: Record<string, unknown>): PromiseLike<SupabaseResult<unknown>>;
  };
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<SupabaseResult<unknown>>;
}

type InstallationRow = {
  installation_id: string;
  account_id: string;
  account_login: string;
  account_type: string;
  account_avatar_url: string | null;
  repository_selection: string;
  status: string;
  permissions: Record<string, string> | null;
  created_by_github_user_id: string | null;
  suspended_at: string | null;
  deleted_at: string | null;
  last_github_event_at: string | null;
};

const INSTALLATION_COLUMNS =
  "installation_id, account_id, account_login, account_type, account_avatar_url, repository_selection, status, permissions, created_by_github_user_id, suspended_at, deleted_at, last_github_event_at";

function rowToInstallation(row: InstallationRow): InstallationRecord {
  return {
    installationId: row.installation_id,
    accountId: row.account_id,
    accountLogin: row.account_login,
    accountType: row.account_type === "Organization" ? "Organization" : "User",
    accountAvatarUrl: row.account_avatar_url ?? null,
    repositorySelection: row.repository_selection === "all" ? "all" : "selected",
    status:
      row.status === "deleted"
        ? "deleted"
        : row.status === "suspended"
          ? "suspended"
          : "active",
    permissions: row.permissions ?? {},
    createdByGithubUserId: row.created_by_github_user_id ?? null,
    suspendedAt: row.suspended_at ?? null,
    deletedAt: row.deleted_at ?? null,
    lastGithubEventAt: row.last_github_event_at ?? null,
  };
}

type NonceRow = {
  id: string;
  nonce_hash: string;
  user_id: string;
  expires_at: string;
  consumed_at: string | null;
  installation_id: string | null;
  claim_status: string;
  verification_method: string | null;
  failure_code: string | null;
};

function rowToNonce(row: NonceRow): NonceRecord {
  return {
    id: row.id,
    nonceHash: row.nonce_hash,
    userId: row.user_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? null,
    installationId: row.installation_id ?? null,
    claimStatus: row.claim_status as NonceClaimStatus,
    verificationMethod: row.verification_method ?? null,
    failureCode: row.failure_code ?? null,
  };
}

function assertNoError(
  result: { error: { message: string } | null },
  operation: string,
): void {
  if (result.error) {
    throw new Error(`${operation} failed: ${result.error.message}`);
  }
}

export function createSupabaseInstallationDataStore(
  supabase: InstallationsClientLike,
): InstallationDataStore {
  return {
    async getInstallation(installationId) {
      const result = await supabase
        .from("github_installations")
        .select(INSTALLATION_COLUMNS)
        .eq("installation_id", installationId)
        .maybeSingle();
      assertNoError(result, "Installation read");
      return result.data ? rowToInstallation(result.data as InstallationRow) : null;
    },

    async upsertInstallationSnapshot(snapshot, options) {
      const now = new Date().toISOString();
      const result = await supabase.from("github_installations").upsert(
        {
          installation_id: snapshot.installationId,
          account_id: snapshot.accountId,
          account_login: snapshot.accountLogin,
          account_type: snapshot.accountType,
          account_avatar_url: snapshot.accountAvatarUrl,
          repository_selection: snapshot.repositorySelection,
          status: snapshot.suspendedAt !== null ? "suspended" : "active",
          permissions: snapshot.permissions,
          suspended_at: snapshot.suspendedAt,
          last_github_event_at: options.eventAt,
          updated_at: now,
          // Only provided on installation.created; omitted columns keep their
          // existing values on conflict-update.
          ...(options.createdByGithubUserId !== undefined
            ? { created_by_github_user_id: options.createdByGithubUserId }
            : {}),
        },
        { onConflict: "installation_id" },
      );
      assertNoError(result, "Installation upsert");
    },

    async markInstallationDeleted(installationId, eventAt) {
      const result = await supabase
        .from("github_installations")
        .update({
          status: "deleted",
          deleted_at: eventAt,
          last_github_event_at: eventAt,
          updated_at: new Date().toISOString(),
        })
        .eq("installation_id", installationId);
      assertNoError(result, "Installation delete-mark");
    },

    async setInstallationSuspended(installationId, suspended, eventAt) {
      const result = await supabase
        .from("github_installations")
        .update({
          status: suspended ? "suspended" : "active",
          suspended_at: suspended ? eventAt : null,
          last_github_event_at: eventAt,
          updated_at: new Date().toISOString(),
        })
        .eq("installation_id", installationId);
      assertNoError(result, "Installation suspend-mark");
    },

    async upsertInstallationRepositories(installationId, repositories, eventAt) {
      const now = new Date().toISOString();
      const result = await supabase.from("installation_repositories").upsert(
        repositories.map((repo) => ({
          installation_id: installationId,
          repository_id: repo.repositoryId,
          owner_login: repo.ownerLogin,
          name: repo.name,
          full_name: repo.fullName,
          private: repo.private,
          status: "active",
          removed_at: null,
          updated_at: now,
        })),
        { onConflict: "installation_id,repository_id" },
      );
      assertNoError(result, "Repository upsert");
      void eventAt;
    },

    async markInstallationRepositoriesRemoved(installationId, repositoryIds, eventAt) {
      if (repositoryIds.length === 0) return;
      const result = await supabase
        .from("installation_repositories")
        .update({
          status: "removed",
          removed_at: eventAt,
          updated_at: new Date().toISOString(),
        })
        .eq("installation_id", installationId)
        .in("repository_id", repositoryIds);
      assertNoError(result, "Repository remove-mark");
    },

    async markAllInstallationRepositoriesRemoved(installationId, eventAt) {
      const result = await supabase
        .from("installation_repositories")
        .update({
          status: "removed",
          removed_at: eventAt,
          updated_at: new Date().toISOString(),
        })
        .eq("installation_id", installationId)
        .eq("status", "active");
      assertNoError(result, "Repository remove-all-mark");
    },

    async upsertMembership(membership) {
      // ignoreDuplicates semantics via ON CONFLICT DO NOTHING are not exposed
      // on this minimal surface; writing identical values is idempotent and
      // never downgrades an existing verified row (verification_method is only
      // ever one of the two verified values).
      const result = await supabase.from("user_installations").upsert(
        {
          user_id: membership.userId,
          installation_id: membership.installationId,
          relationship: membership.relationship,
          verification_method: membership.verificationMethod,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,installation_id" },
      );
      assertNoError(result, "Membership upsert");
    },

    async listInstallationsForUser(userId) {
      // Membership-scoped join: the database only ever sees this user's rows.
      // Never a global list filtered in application memory.
      const result = await supabase
        .from("user_installations")
        .select(`installation_id, github_installations (${INSTALLATION_COLUMNS})`)
        .eq("user_id", userId);
      assertNoError(result, "Installation membership read");

      const rows = (result.data ?? []) as Array<{
        github_installations: InstallationRow | InstallationRow[] | null;
      }>;

      const installations: InstallationRecord[] = [];

      for (const row of rows) {
        const joined = row.github_installations;
        if (!joined) continue;
        for (const installationRow of Array.isArray(joined) ? joined : [joined]) {
          installations.push(rowToInstallation(installationRow));
        }
      }

      return installations;
    },

    async listRepositoriesForUser(userId) {
      const installations = (
        await this.listInstallationsForUser(userId)
      ).filter((installation) => installation.status === "active");
      const repositories = await Promise.all(
        installations.map(async (installation) => {
          const result = await supabase
            .from("installation_repositories")
            .select(
              "repository_id, owner_login, name, full_name, private, status",
            )
            .eq("installation_id", installation.installationId)
            .eq("status", "active");
          assertNoError(result, "Repository membership read");
          return ((result.data ?? []) as Array<{
            repository_id: string;
            owner_login: string;
            name: string;
            full_name: string;
            private: boolean;
            status: string;
          }>).map(
            (repository): AuthorizedRepositoryRecord => ({
              repositoryId: repository.repository_id,
              ownerLogin: repository.owner_login,
              name: repository.name,
              fullName: repository.full_name,
              private: repository.private,
              installationId: installation.installationId,
              installationStatus: installation.status,
              ownerAvatarUrl: installation.accountAvatarUrl,
            }),
          );
        }),
      );

      return repositories
        .flat()
        .sort((left, right) => left.fullName.localeCompare(right.fullName));
    },

    async supersedeUnclaimedNonces(userId) {
      const result = await supabase
        .from("github_installation_nonces")
        .update({ claim_status: "superseded", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("claim_status", "unclaimed")
        .is("consumed_at", null);
      assertNoError(result, "Nonce supersede");
    },

    async insertNonce({ nonceHash, userId, expiresAt }) {
      const result = await supabase.from("github_installation_nonces").insert({
        nonce_hash: nonceHash,
        user_id: userId,
        expires_at: expiresAt,
      });
      assertNoError(result, "Nonce insert");
    },

    async consumeNonceByHash(nonceHash) {
      const result = await supabase.rpc("consume_github_installation_nonce", {
        p_nonce_hash: nonceHash,
      });
      assertNoError(result, "Nonce consume");

      const payload = result.data as {
        outcome?: string;
        nonce?: NonceRow;
      } | null;

      switch (payload?.outcome) {
        case "consumed":
          if (!payload.nonce) {
            throw new Error("Nonce consume returned no record.");
          }
          return { outcome: "consumed", nonce: rowToNonce(payload.nonce) };
        case "expired":
          return { outcome: "expired" };
        case "superseded":
          return { outcome: "superseded" };
        default:
          return { outcome: "not_found" };
      }
    },

    async attachInstallationToNonce(nonceId, installationId) {
      const result = await supabase
        .from("github_installation_nonces")
        .update({
          installation_id: installationId,
          claim_status: "pending_webhook",
          updated_at: new Date().toISOString(),
        })
        .eq("id", nonceId);
      assertNoError(result, "Nonce claim attach");
    },

    async updateNonceClaim(nonceId, fields) {
      const result = await supabase
        .from("github_installation_nonces")
        .update({
          claim_status: fields.claimStatus,
          ...(fields.verificationMethod !== undefined
            ? { verification_method: fields.verificationMethod }
            : {}),
          ...(fields.failureCode !== undefined
            ? { failure_code: fields.failureCode }
            : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", nonceId);
      assertNoError(result, "Nonce claim update");
    },

    async findPendingWebhookClaims(installationId) {
      const result = await supabase
        .from("github_installation_nonces")
        .select(
          "id, nonce_hash, user_id, expires_at, consumed_at, installation_id, claim_status, verification_method, failure_code",
        )
        .eq("installation_id", installationId)
        .eq("claim_status", "pending_webhook");
      assertNoError(result, "Pending claim read");
      return ((result.data ?? []) as NonceRow[]).map(rowToNonce);
    },
  };
}

// Re-exported so webhook wiring can hand both stores around together.
export type { ProfileRecord, ProfileStore };
