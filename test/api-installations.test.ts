// GET /api/installations (membership-scoped listing) and
// POST /api/installations/start (secure one-time installation URL).
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildInstallationUrl,
  isValidGitHubAppSlug,
  INSTALLATION_STATE_TTL_MS,
} from "../backend/routes/installations.js";
import {
  hashInstallationNonce,
  sortInstallationsForListing,
  type InstallationRecord,
} from "../backend/services/github-installations.js";
import {
  bootProductApi,
  createFakeAuthDeps,
  createFakeRateLimiter,
  createInMemoryInstallationDataStore,
  createInMemoryProfileStore,
  makeGitHubUser,
  makeSnapshot,
  type BootedApp,
} from "./product-api-helpers.js";

let booted: BootedApp | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
  vi.restoreAllMocks();
});

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function bootInstallations(options: {
  env?: NodeJS.ProcessEnv;
  rateLimiterAllowed?: boolean;
} = {}) {
  const store = createInMemoryInstallationDataStore();
  const profiles = createInMemoryProfileStore();
  const rateLimiter = createFakeRateLimiter(options.rateLimiterAllowed ?? true);
  const tokens = {
    "token-a": makeGitHubUser({ id: USER_A, githubUserId: "1001", login: "user-a" }),
    "token-b": makeGitHubUser({ id: USER_B, githubUserId: "1002", login: "user-b" }),
  };

  booted = await bootProductApi(
    options.env ?? ({ GITHUB_APP_SLUG: "sherlock-bot" } as NodeJS.ProcessEnv),
    {
      getAuthDeps: async () => createFakeAuthDeps(tokens, profiles),
      getInstallationStore: async () => store,
      getProfileStore: async () => profiles,
      getRateLimiter: async () => rateLimiter,
    },
  );

  return { baseUrl: booted.baseUrl, store, profiles, rateLimiter };
}

async function seedInstallation(
  store: ReturnType<typeof createInMemoryInstallationDataStore>,
  userId: string,
  overrides: Parameters<typeof makeSnapshot>[0] = {},
  status: "active" | "suspended" | "deleted" = "active",
) {
  const snapshot = makeSnapshot(overrides);
  await store.upsertInstallationSnapshot(snapshot, {
    eventAt: "2026-07-22T00:00:00.000Z",
  });

  if (status === "suspended") {
    await store.setInstallationSuspended(snapshot.installationId, true, "2026-07-22T01:00:00.000Z");
  } else if (status === "deleted") {
    await store.markInstallationDeleted(snapshot.installationId, "2026-07-22T01:00:00.000Z");
  }

  await store.upsertMembership({
    userId,
    installationId: snapshot.installationId,
    relationship: "installer",
    verificationMethod: "personal_account_match",
  });
}

describe("GET /api/installations", () => {
  test("requires authentication", async () => {
    const { baseUrl } = await bootInstallations();
    const res = await fetch(`${baseUrl}/api/installations`);
    expect(res.status).toBe(401);
  });

  test("returns an empty list for a user without installations", async () => {
    const { baseUrl } = await bootInstallations();
    const res = await fetch(`${baseUrl}/api/installations`, {
      headers: { Authorization: "Bearer token-a" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installations: [] });
  });

  test("returns the exact contract shape with allowed enum values", async () => {
    const { baseUrl, store } = await bootInstallations();
    await seedInstallation(store, USER_A);

    const res = await fetch(`${baseUrl}/api/installations`, {
      headers: { Authorization: "Bearer token-a" },
    });
    const body = (await res.json()) as { installations: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(body).toEqual({
      installations: [
        {
          installationId: "987654321",
          account: {
            id: "123456789",
            login: "SherlockHQ",
            type: "Organization",
            avatarUrl: "https://avatars.githubusercontent.com/u/123456789",
          },
          status: "active",
          repositorySelection: "selected",
        },
      ],
    });
    expect(typeof body.installations[0].installationId).toBe("string");
  });

  test("includes suspended and deleted installations with their state", async () => {
    const { baseUrl, store } = await bootInstallations();
    await seedInstallation(store, USER_A, { installationId: "1" }, "suspended");
    await seedInstallation(store, USER_A, { installationId: "2" }, "deleted");

    const res = await fetch(`${baseUrl}/api/installations`, {
      headers: { Authorization: "Bearer token-a" },
    });
    const body = (await res.json()) as {
      installations: Array<{ installationId: string; status: string }>;
    };

    expect(body.installations.map((entry) => entry.status).sort()).toEqual([
      "deleted",
      "suspended",
    ]);
  });

  test("sorts deterministically: active first, then account login", async () => {
    const { baseUrl, store } = await bootInstallations();
    await seedInstallation(store, USER_A, { installationId: "1", accountLogin: "zeta" });
    await seedInstallation(
      store,
      USER_A,
      { installationId: "2", accountLogin: "alpha" },
      "suspended",
    );
    await seedInstallation(store, USER_A, { installationId: "3", accountLogin: "Beta" });

    const res = await fetch(`${baseUrl}/api/installations`, {
      headers: { Authorization: "Bearer token-a" },
    });
    const body = (await res.json()) as {
      installations: Array<{ installationId: string }>;
    };

    // active (Beta, zeta) before suspended (alpha); logins case-insensitive.
    expect(body.installations.map((entry) => entry.installationId)).toEqual([
      "3",
      "1",
      "2",
    ]);
  });

  test("user A never receives user B's installations", async () => {
    const { baseUrl, store } = await bootInstallations();
    await seedInstallation(store, USER_B, { installationId: "555", accountLogin: "b-org" });

    const res = await fetch(`${baseUrl}/api/installations`, {
      headers: { Authorization: "Bearer token-a" },
    });
    const body = (await res.json()) as { installations: unknown[] };

    // The store holds B's installation globally (service-role visibility),
    // but membership scoping keeps it out of A's response.
    expect(body.installations).toEqual([]);
    expect(await store.getInstallation("555")).not.toBeNull();
  });

  test("sortInstallationsForListing is stable across equal fields", () => {
    const base: Omit<InstallationRecord, "installationId"> = {
      accountId: "1",
      accountLogin: "same",
      accountType: "User",
      accountAvatarUrl: null,
      repositorySelection: "all",
      status: "active",
      permissions: {},
      createdByGithubUserId: null,
      suspendedAt: null,
      deletedAt: null,
      lastGithubEventAt: null,
    };
    const sorted = sortInstallationsForListing([
      { ...base, installationId: "20" },
      { ...base, installationId: "10" },
    ]);
    expect(sorted.map((entry) => entry.installationId)).toEqual(["10", "20"]);
  });
});

describe("POST /api/installations/start", () => {
  test("requires authentication", async () => {
    const { baseUrl } = await bootInstallations();
    const res = await fetch(`${baseUrl}/api/installations/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("rejects any non-empty body", async () => {
    const { baseUrl } = await bootInstallations();
    const res = await fetch(`${baseUrl}/api/installations/start`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  test("returns the exact GitHub URL and persists only the nonce hash", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { baseUrl, store } = await bootInstallations();

    const res = await fetch(`${baseUrl}/api/installations/start`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    const url = new URL(body.url);

    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toBe("/apps/sherlock-bot/installations/new");
    expect([...url.searchParams.keys()]).toEqual(["state"]);

    const rawState = url.searchParams.get("state") as string;
    // ≥ 256 bits of randomness, base64url-encoded → 43 characters.
    expect(rawState).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    // Only the SHA-256 hash is persisted; the raw nonce appears nowhere.
    const nonces = store.snapshotNonces();
    expect(nonces).toHaveLength(1);
    expect(nonces[0].nonceHash).toBe(hashInstallationNonce(rawState));
    expect(nonces[0].nonceHash).not.toBe(rawState);
    expect(nonces[0].userId).toBe(USER_A);

    // 15-minute expiry.
    const ttl = Date.parse(nonces[0].expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(INSTALLATION_STATE_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(INSTALLATION_STATE_TTL_MS);

    // The raw nonce is never logged.
    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(logged).not.toContain(rawState);
  });

  test("two starts produce different states and supersede the prior nonce", async () => {
    const { baseUrl, store } = await bootInstallations();

    const request = () =>
      fetch(`${baseUrl}/api/installations/start`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-a",
          "content-type": "application/json",
        },
        body: "{}",
      }).then(async (res) => ((await res.json()) as { url: string }).url);

    const first = new URL(await request()).searchParams.get("state");
    const second = new URL(await request()).searchParams.get("state");

    expect(first).not.toBe(second);

    const nonces = store.snapshotNonces();
    expect(nonces).toHaveLength(2);
    expect(nonces[0].claimStatus).toBe("superseded");
    expect(nonces[1].claimStatus).toBe("unclaimed");
  });

  test("rate limiting returns 429 with Retry-After and consumes per user", async () => {
    const { baseUrl, rateLimiter } = await bootInstallations({
      rateLimiterAllowed: false,
    });

    const res = await fetch(`${baseUrl}/api/installations/start`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INSTALLATION_START_RATE_LIMITED");
    expect(rateLimiter.calls).toEqual([USER_A]);
  });

  test("a failing rate limiter dependency yields 503, never an open gate", async () => {
    const store = createInMemoryInstallationDataStore();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    booted = await bootProductApi({ GITHUB_APP_SLUG: "sherlock-bot" } as NodeJS.ProcessEnv, {
      getAuthDeps: async () =>
        createFakeAuthDeps({ "token-a": makeGitHubUser({ id: USER_A }) }),
      getInstallationStore: async () => store,
      getRateLimiter: async () => ({
        checkAndConsumeInstallationStart: async () => {
          throw new Error("redis down");
        },
      }),
    });

    const res = await fetch(`${booted.baseUrl}/api/installations/start`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(503);
    expect(store.snapshotNonces()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  test("an invalid GITHUB_APP_SLUG is rejected as a dependency failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { baseUrl } = await bootInstallations({
      env: { GITHUB_APP_SLUG: "Bad Slug!" } as NodeJS.ProcessEnv,
    });

    const res = await fetch(`${baseUrl}/api/installations/start`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(503);
  });

  test("slug and URL validation stay conservative", () => {
    expect(isValidGitHubAppSlug("sherlock-bot")).toBe(true);
    expect(isValidGitHubAppSlug("a")).toBe(true);
    expect(isValidGitHubAppSlug("")).toBe(false);
    expect(isValidGitHubAppSlug("-leading")).toBe(false);
    expect(isValidGitHubAppSlug("trailing-")).toBe(false);
    expect(isValidGitHubAppSlug("UPPER")).toBe(false);
    expect(isValidGitHubAppSlug("has space")).toBe(false);
    expect(isValidGitHubAppSlug("slash/inject")).toBe(false);

    expect(buildInstallationUrl("sherlock-bot", "state123state123state123")).toBe(
      "https://github.com/apps/sherlock-bot/installations/new?state=state123state123state123",
    );
    expect(() => buildInstallationUrl("bad slug", "s")).toThrow();
  });
});
