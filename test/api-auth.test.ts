// Supabase bearer authentication, GitHub identity extraction, profile
// synchronization, and the exact GET /api/me contract. The Supabase Auth
// boundary is mocked (verifyAccessToken); no external credentials involved.
import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import {
  extractGitHubIdentity,
  GitHubIdentityConflictError,
  syncProfile,
} from "../backend/services/github-identity.js";
import {
  bootProductApi,
  createFakeAuthDeps,
  createInMemoryProfileStore,
  makeGitHubUser,
  type BootedApp,
} from "./product-api-helpers.js";

let booted: BootedApp | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

async function bootWithUser(token = "valid-token", user = makeGitHubUser()) {
  const profiles = createInMemoryProfileStore();
  const authDeps = createFakeAuthDeps({ [token]: user }, profiles);
  booted = await bootProductApi({} as NodeJS.ProcessEnv, {
    getAuthDeps: async () => authDeps,
  });
  return { baseUrl: booted.baseUrl, profiles };
}

async function getMe(baseUrl: string, headers: Record<string, string>) {
  const res = await fetch(`${baseUrl}/api/me`, { headers });
  const body = (await res.json()) as {
    user?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  return { status: res.status, body, raw: JSON.stringify(body) };
}

describe("GitHub identity extraction", () => {
  test("prefers identity_data.provider_id, then sub, then identity id", () => {
    expect(
      extractGitHubIdentity(
        makeGitHubUser({ identityData: { provider_id: "42", user_name: "octo" } }),
      ),
    ).toMatchObject({ githubUserId: "42" });

    expect(
      extractGitHubIdentity(
        makeGitHubUser({ identityData: { sub: "43", user_name: "octo" } }),
      ),
    ).toMatchObject({ githubUserId: "43" });

    expect(
      extractGitHubIdentity({
        id: "u1",
        identities: [
          { provider: "github", id: "44", identity_data: { user_name: "octo" } },
        ],
      }),
    ).toMatchObject({ githubUserId: "44" });
  });

  test("fails closed without a github identity or a digits-only id", () => {
    expect(extractGitHubIdentity({ id: "u1", identities: [] })).toBeNull();
    expect(
      extractGitHubIdentity({
        id: "u1",
        identities: [{ provider: "google", id: "9", identity_data: {} }],
      }),
    ).toBeNull();
    // Malformed ids everywhere → null (login/email are never fallbacks).
    expect(
      extractGitHubIdentity(
        makeGitHubUser({
          identities: [
            {
              provider: "github",
              id: "not-digits",
              identity_data: {
                provider_id: "12x",
                sub: "-3",
                user_name: "octo",
                email: "octo@example.com",
              },
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  test("numeric ids never lose precision and stay strings", () => {
    const identity = extractGitHubIdentity(
      makeGitHubUser({
        identityData: { provider_id: "9007199254740993", user_name: "octo" },
      }),
    );
    expect(identity?.githubUserId).toBe("9007199254740993");
  });

  test("missing login fails closed; avatar falls back to null", () => {
    expect(
      extractGitHubIdentity(
        makeGitHubUser({ identityData: { provider_id: "42" } }),
      ),
    ).toBeNull();

    const identity = extractGitHubIdentity(
      makeGitHubUser({
        identityData: { provider_id: "42", user_name: "octo", avatar_url: "javascript:x" },
      }),
    );
    expect(identity?.avatarUrl).toBeNull();
  });
});

describe("profile synchronization", () => {
  test("creates a profile on first sight and refreshes mutable metadata", async () => {
    const profiles = createInMemoryProfileStore();

    await syncProfile(profiles, "user-1", {
      githubUserId: "42",
      githubLogin: "old-login",
      avatarUrl: null,
    });
    expect(profiles.snapshot()).toEqual([
      { id: "user-1", githubUserId: "42", githubLogin: "old-login", avatarUrl: null },
    ]);

    await syncProfile(profiles, "user-1", {
      githubUserId: "42",
      githubLogin: "new-login",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
    });
    expect(profiles.snapshot()[0]).toMatchObject({
      githubLogin: "new-login",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
    });
  });

  test("rejects an immutable identity change for the same Supabase user", async () => {
    const profiles = createInMemoryProfileStore();
    await syncProfile(profiles, "user-1", {
      githubUserId: "42",
      githubLogin: "octo",
      avatarUrl: null,
    });

    await expect(
      syncProfile(profiles, "user-1", {
        githubUserId: "43",
        githubLogin: "octo",
        avatarUrl: null,
      }),
    ).rejects.toThrow(GitHubIdentityConflictError);
  });

  test("rejects a GitHub id already bound to another Supabase user", async () => {
    const profiles = createInMemoryProfileStore();
    await syncProfile(profiles, "user-1", {
      githubUserId: "42",
      githubLogin: "octo",
      avatarUrl: null,
    });

    await expect(
      syncProfile(profiles, "user-2", {
        githubUserId: "42",
        githubLogin: "octo-clone",
        avatarUrl: null,
      }),
    ).rejects.toThrow(GitHubIdentityConflictError);
  });
});

describe("GET /api/me authentication", () => {
  test("missing Authorization header → 401 AUTH_REQUIRED", async () => {
    const { baseUrl } = await bootWithUser();
    const { status, body } = await getMe(baseUrl, {});
    expect(status).toBe(401);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
  });

  test("unsupported scheme → 401 AUTH_INVALID", async () => {
    const { baseUrl } = await bootWithUser();
    const { status, body } = await getMe(baseUrl, {
      Authorization: "Basic dXNlcjpwYXNz",
    });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("AUTH_INVALID");
  });

  test("empty bearer token → 401 AUTH_INVALID", async () => {
    const { baseUrl } = await bootWithUser();
    const { status, body } = await getMe(baseUrl, { Authorization: "Bearer " });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("AUTH_INVALID");
  });

  test("multiple Authorization headers → 401", async () => {
    const { baseUrl } = await bootWithUser();
    const url = new URL(`${baseUrl}/api/me`);

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "GET",
          headers: { Authorization: ["Bearer valid-token", "Bearer valid-token"] },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(401);
  });

  test("invalid/expired Supabase token → 401 AUTH_INVALID", async () => {
    const { baseUrl } = await bootWithUser();
    const { status, body } = await getMe(baseUrl, {
      Authorization: "Bearer wrong-token",
    });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("AUTH_INVALID");
  });

  test("valid token → exact contract shape; the token is never echoed", async () => {
    const { baseUrl } = await bootWithUser(
      "valid-token",
      makeGitHubUser({
        id: "22222222-2222-4222-8222-222222222222",
        githubUserId: "123456789",
        login: "octo-dev",
        avatarUrl: null,
      }),
    );

    const { status, body, raw } = await getMe(baseUrl, {
      Authorization: "Bearer valid-token",
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      user: {
        id: "22222222-2222-4222-8222-222222222222",
        githubUserId: "123456789",
        login: "octo-dev",
        avatarUrl: null,
      },
    });
    // Strings, not numbers; no token, no email, no Supabase metadata.
    expect(typeof body.user?.githubUserId).toBe("string");
    expect(raw).not.toContain("valid-token");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("user_metadata");
  });

  test("user without a GitHub identity → 403 GITHUB_IDENTITY_REQUIRED", async () => {
    const { baseUrl } = await bootWithUser(
      "valid-token",
      makeGitHubUser({ identities: [] }),
    );
    const { status, body } = await getMe(baseUrl, {
      Authorization: "Bearer valid-token",
    });
    expect(status).toBe(403);
    expect(body.error?.code).toBe("GITHUB_IDENTITY_REQUIRED");
  });

  test("malformed GitHub id → 403 GITHUB_IDENTITY_REQUIRED", async () => {
    const { baseUrl } = await bootWithUser(
      "valid-token",
      makeGitHubUser({
        identities: [
          {
            provider: "github",
            id: "abc",
            identity_data: { provider_id: "12x", user_name: "octo" },
          },
        ],
      }),
    );
    const { status, body } = await getMe(baseUrl, {
      Authorization: "Bearer valid-token",
    });
    expect(status).toBe(403);
    expect(body.error?.code).toBe("GITHUB_IDENTITY_REQUIRED");
  });

  test("identity conflicts → 409 GITHUB_IDENTITY_CONFLICT", async () => {
    const profiles = createInMemoryProfileStore();
    // GitHub id 123456789 already belongs to a different Supabase user.
    await profiles.upsert({
      id: "33333333-3333-4333-8333-333333333333",
      githubUserId: "123456789",
      githubLogin: "someone-else",
      avatarUrl: null,
    });

    const authDeps = createFakeAuthDeps({ "valid-token": makeGitHubUser() }, profiles);
    booted = await bootProductApi({} as NodeJS.ProcessEnv, {
      getAuthDeps: async () => authDeps,
    });

    const { status, body } = await getMe(booted.baseUrl, {
      Authorization: "Bearer valid-token",
    });
    expect(status).toBe(409);
    expect(body.error?.code).toBe("GITHUB_IDENTITY_CONFLICT");
  });
});
