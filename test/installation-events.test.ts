// GitHub App installation lifecycle persistence: payload normalization, the
// apply* policy functions (idempotency, deletion permanence, pending-claim
// reconciliation), and a real Probot receive path for installation.created.
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Probot, ProbotOctokit } from "probot";
import { createSherlockApp } from "../src/index.js";
import {
  repositoriesFromWebhookList,
  snapshotFromWebhookInstallation,
} from "../src/installation-events.js";
import {
  applyInstallationCreated,
  applyInstallationDeleted,
  applyInstallationRepositoriesChanged,
  applyInstallationSuspended,
  toGitHubIdString,
  verifyInstallationOwnership,
} from "../backend/services/github-installations.js";
import {
  createInMemoryInstallationDataStore,
  createInMemoryProfileStore,
  makeSnapshot,
} from "./product-api-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(
  path.join(__dirname, "fixtures/mock-cert.pem"),
  "utf-8",
);

const AT = "2026-07-22T00:00:00.000Z";
const LATER = "2026-07-22T01:00:00.000Z";

function lifecycleDeps() {
  const store = createInMemoryInstallationDataStore();
  const profiles = createInMemoryProfileStore();
  return { store, profiles, deps: { store, profiles } };
}

describe("id and payload normalization", () => {
  test("toGitHubIdString accepts digit strings and safe integers only", () => {
    expect(toGitHubIdString("123")).toBe("123");
    expect(toGitHubIdString(123)).toBe("123");
    expect(toGitHubIdString(0)).toBe("0");
    expect(toGitHubIdString("12x")).toBeNull();
    expect(toGitHubIdString(-5)).toBeNull();
    expect(toGitHubIdString(1.5)).toBeNull();
    expect(toGitHubIdString(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(toGitHubIdString(null)).toBeNull();
  });

  test("snapshotFromWebhookInstallation validates shape and stringifies ids", () => {
    const snapshot = snapshotFromWebhookInstallation({
      id: 987654321,
      account: {
        id: 123456789,
        login: "SherlockHQ",
        type: "Organization",
        avatar_url: "https://avatars.githubusercontent.com/u/123456789",
      },
      repository_selection: "selected",
      permissions: { contents: "write", issues: "write", bogus: 42 },
      suspended_at: null,
    });

    expect(snapshot).toEqual({
      installationId: "987654321",
      accountId: "123456789",
      accountLogin: "SherlockHQ",
      accountType: "Organization",
      accountAvatarUrl: "https://avatars.githubusercontent.com/u/123456789",
      repositorySelection: "selected",
      permissions: { contents: "write", issues: "write" },
      suspendedAt: null,
    });

    expect(snapshotFromWebhookInstallation({ id: 1 })).toBeNull();
    expect(
      snapshotFromWebhookInstallation({
        id: 1,
        account: { id: 2, login: "x", type: "Bot" },
        repository_selection: "selected",
      }),
    ).toBeNull();
  });

  test("repositoriesFromWebhookList keeps parseable entries and derives owners", () => {
    const repos = repositoriesFromWebhookList(
      [
        { id: 1, name: "app", full_name: "SherlockHQ/app", private: true },
        { id: "2", name: "site", private: false },
        { id: "bad", name: "skipped" },
      ],
      "SherlockHQ",
    );

    expect(repos).toEqual([
      {
        repositoryId: "1",
        ownerLogin: "SherlockHQ",
        name: "app",
        fullName: "SherlockHQ/app",
        private: true,
      },
      {
        repositoryId: "2",
        ownerLogin: "SherlockHQ",
        name: "site",
        fullName: "SherlockHQ/site",
        private: false,
      },
    ]);
  });
});

describe("ownership policy", () => {
  test("uses only immutable numeric ids", () => {
    expect(
      verifyInstallationOwnership({
        accountType: "User",
        accountId: "42",
        createdByGithubUserId: null,
        profileGithubUserId: "42",
      }),
    ).toEqual({ verified: true, method: "personal_account_match" });

    expect(
      verifyInstallationOwnership({
        accountType: "User",
        accountId: "43",
        createdByGithubUserId: "42",
        profileGithubUserId: "42",
      }),
    ).toMatchObject({ verified: false, reason: "account_mismatch" });

    expect(
      verifyInstallationOwnership({
        accountType: "Organization",
        accountId: "42",
        createdByGithubUserId: null,
        profileGithubUserId: "42",
      }),
    ).toMatchObject({ verified: false, reason: "sender_unknown" });

    expect(
      verifyInstallationOwnership({
        accountType: "Organization",
        accountId: "1",
        createdByGithubUserId: "42",
        profileGithubUserId: "42",
      }),
    ).toEqual({ verified: true, method: "installation_webhook_sender" });
  });
});

describe("lifecycle application", () => {
  test("installation.created upserts the snapshot, sender, and repositories", async () => {
    const { store, deps } = lifecycleDeps();

    await applyInstallationCreated(deps, {
      snapshot: makeSnapshot(),
      senderGithubUserId: "123456789",
      repositories: [
        {
          repositoryId: "1",
          ownerLogin: "SherlockHQ",
          name: "app",
          fullName: "SherlockHQ/app",
          private: true,
        },
      ],
      eventAt: AT,
    });

    const installation = await store.getInstallation("987654321");
    expect(installation).toMatchObject({
      status: "active",
      accountLogin: "SherlockHQ",
      createdByGithubUserId: "123456789",
      lastGithubEventAt: AT,
    });
    expect(store.snapshotRepositories()).toHaveLength(1);
  });

  test("duplicate deliveries are idempotent", async () => {
    const { store, deps } = lifecycleDeps();
    const input = {
      snapshot: makeSnapshot(),
      senderGithubUserId: "123456789",
      repositories: [],
      eventAt: AT,
    };

    await applyInstallationCreated(deps, input);
    await applyInstallationCreated(deps, input);

    expect(await store.getInstallation("987654321")).toMatchObject({
      status: "active",
      createdByGithubUserId: "123456789",
    });
  });

  test("deleted installations are marked, never removed, and repos go removed", async () => {
    const { store, deps } = lifecycleDeps();

    await applyInstallationCreated(deps, {
      snapshot: makeSnapshot(),
      senderGithubUserId: "123456789",
      repositories: [
        {
          repositoryId: "1",
          ownerLogin: "SherlockHQ",
          name: "app",
          fullName: "SherlockHQ/app",
          private: true,
        },
      ],
      eventAt: AT,
    });
    await applyInstallationDeleted(deps, "987654321", LATER);

    const installation = await store.getInstallation("987654321");
    expect(installation).toMatchObject({ status: "deleted", deletedAt: LATER });
    expect(store.snapshotRepositories()[0]).toMatchObject({
      status: "removed",
      removedAt: LATER,
    });
  });

  test("a late installation.created never revives a deleted installation", async () => {
    const { store, deps } = lifecycleDeps();

    await applyInstallationCreated(deps, {
      snapshot: makeSnapshot(),
      senderGithubUserId: "123456789",
      repositories: [],
      eventAt: AT,
    });
    await applyInstallationDeleted(deps, "987654321", AT);

    // Out-of-order redelivery of the original created event.
    await applyInstallationCreated(deps, {
      snapshot: makeSnapshot(),
      senderGithubUserId: "123456789",
      repositories: [],
      eventAt: LATER,
    });

    expect((await store.getInstallation("987654321"))?.status).toBe("deleted");
  });

  test("suspend and unsuspend flip status without touching deletion metadata", async () => {
    const { store, deps } = lifecycleDeps();

    await applyInstallationCreated(deps, {
      snapshot: makeSnapshot(),
      senderGithubUserId: null,
      repositories: [],
      eventAt: AT,
    });

    await applyInstallationSuspended(deps, "987654321", true, LATER);
    expect(await store.getInstallation("987654321")).toMatchObject({
      status: "suspended",
      suspendedAt: LATER,
    });

    await applyInstallationSuspended(deps, "987654321", false, LATER);
    expect(await store.getInstallation("987654321")).toMatchObject({
      status: "active",
      suspendedAt: null,
      deletedAt: null,
    });

    // Suspension cannot resurrect a deleted installation either.
    await applyInstallationDeleted(deps, "987654321", LATER);
    await applyInstallationSuspended(deps, "987654321", false, LATER);
    expect((await store.getInstallation("987654321"))?.status).toBe("deleted");
  });

  test("repository add/remove marks rows instead of deleting them", async () => {
    const { store, deps } = lifecycleDeps();

    await applyInstallationCreated(deps, {
      snapshot: makeSnapshot(),
      senderGithubUserId: null,
      repositories: [],
      eventAt: AT,
    });

    await applyInstallationRepositoriesChanged(deps, {
      snapshot: makeSnapshot({ repositorySelection: "selected" }),
      installationId: "987654321",
      added: [
        {
          repositoryId: "7",
          ownerLogin: "SherlockHQ",
          name: "web",
          fullName: "SherlockHQ/web",
          private: false,
        },
      ],
      removedRepositoryIds: [],
      eventAt: AT,
    });
    expect(store.snapshotRepositories()[0]).toMatchObject({ status: "active" });

    await applyInstallationRepositoriesChanged(deps, {
      snapshot: makeSnapshot(),
      installationId: "987654321",
      added: [],
      removedRepositoryIds: ["7"],
      eventAt: LATER,
    });
    expect(store.snapshotRepositories()[0]).toMatchObject({
      status: "removed",
      removedAt: LATER,
    });

    // Re-adding clears the removed marker.
    await applyInstallationRepositoriesChanged(deps, {
      snapshot: makeSnapshot(),
      installationId: "987654321",
      added: [
        {
          repositoryId: "7",
          ownerLogin: "SherlockHQ",
          name: "web",
          fullName: "SherlockHQ/web",
          private: false,
        },
      ],
      removedRepositoryIds: [],
      eventAt: LATER,
    });
    expect(store.snapshotRepositories()[0]).toMatchObject({
      status: "active",
      removedAt: null,
    });
  });

  test("pending claims reconcile on the webhook: match verifies, mismatch rejects", async () => {
    const { store, profiles, deps } = lifecycleDeps();

    await profiles.upsert({
      id: "user-1",
      githubUserId: "123456789",
      githubLogin: "octo",
      avatarUrl: null,
    });
    await profiles.upsert({
      id: "user-2",
      githubUserId: "999",
      githubLogin: "impostor",
      avatarUrl: null,
    });

    // Two consumed callbacks left pending claims for the same installation.
    for (const userId of ["user-1", "user-2"]) {
      await store.insertNonce({
        nonceHash: `hash-${userId}`,
        userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    const [first, second] = store.snapshotNonces();
    await store.attachInstallationToNonce(first.id, "987654321");
    await store.attachInstallationToNonce(second.id, "987654321");

    await applyInstallationCreated(deps, {
      snapshot: makeSnapshot(),
      senderGithubUserId: "123456789",
      repositories: [],
      eventAt: AT,
    });

    const nonces = store.snapshotNonces();
    expect(nonces.find((nonce) => nonce.userId === "user-1")?.claimStatus).toBe("verified");
    expect(nonces.find((nonce) => nonce.userId === "user-2")?.claimStatus).toBe("rejected");
    expect(store.snapshotMemberships()).toEqual([
      {
        userId: "user-1",
        installationId: "987654321",
        relationship: "installer",
        verificationMethod: "installation_webhook_sender",
      },
    ]);
  });
});

describe("Probot receive path", () => {
  test("installation.created flows through the verified Probot handler", async () => {
    const store = createInMemoryInstallationDataStore();
    const profiles = createInMemoryProfileStore();

    const probot = new Probot({
      appId: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults((instanceOptions: object) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });

    probot.load(
      createSherlockApp({
        queue: {
          add: async () => ({ jobId: "unused", deduplicated: false, rateLimited: false }),
        },
        getRepositoryRole: async () => ({ roleName: "write", permission: "write" }),
        rateLimiter: {
          checkAndConsumeInvestigationRateLimit: async (tenantKey) => ({
            allowed: true,
            tenantKey,
            count: 1,
            limit: 10,
            windowSeconds: 600,
          }),
        },
        installationEvents: {
          getLifecycleDeps: async () => ({ store, profiles }),
        },
      }),
    );

    await probot.receive({
      id: "delivery-1",
      name: "installation",
      payload: {
        action: "created",
        installation: {
          id: 987654321,
          account: {
            id: 123456789,
            login: "SherlockHQ",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/123456789",
          },
          repository_selection: "selected",
          permissions: { contents: "write" },
          suspended_at: null,
        },
        repositories: [
          { id: 1, name: "app", full_name: "SherlockHQ/app", private: true },
        ],
        sender: { id: 123456789, login: "octo-dev" },
      },
    } as never);

    expect(await store.getInstallation("987654321")).toMatchObject({
      status: "active",
      createdByGithubUserId: "123456789",
    });
    expect(store.snapshotRepositories()).toHaveLength(1);
  });

  test("missing Supabase configuration skips persistence without failing the delivery", async () => {
    const probot = new Probot({
      appId: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults((instanceOptions: object) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });

    probot.load(
      createSherlockApp({
        queue: {
          add: async () => ({ jobId: "unused", deduplicated: false, rateLimited: false }),
        },
        installationEvents: { getLifecycleDeps: async () => null, log: () => {} },
      }),
    );

    await expect(
      probot.receive({
        id: "delivery-2",
        name: "installation",
        payload: {
          action: "deleted",
          installation: {
            id: 987654321,
            account: { id: 1, login: "x", type: "Organization" },
          },
        },
      } as never),
    ).resolves.not.toThrow();
  });
});
