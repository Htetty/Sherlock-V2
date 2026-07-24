// Shared fakes for the product-API tests (not a test file itself).
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, type ProductApiDeps } from "../backend/server.js";
import type {
  ProfileRecord,
  ProfileStore,
  SupabaseAuthUserLike,
} from "../backend/services/github-identity.js";
import type { RequireAuthDeps } from "../backend/middleware/require-auth.js";
import type { InstallationStartRateLimiter } from "../backend/services/rate-limit.js";
import {
  createInMemoryInstallationDataStore,
  type InstallationSnapshot,
} from "../backend/services/github-installations.js";

export function createInMemoryProfileStore(): ProfileStore & {
  snapshot(): ProfileRecord[];
} {
  const profiles = new Map<string, ProfileRecord>();

  return {
    async getById(id) {
      return profiles.get(id) ?? null;
    },
    async getByGithubUserId(githubUserId) {
      for (const profile of profiles.values()) {
        if (profile.githubUserId === githubUserId) return profile;
      }
      return null;
    },
    async upsert(profile) {
      profiles.set(profile.id, { ...profile });
    },
    snapshot: () => [...profiles.values()],
  };
}

// Representative Supabase GitHub user shape (documented identity_data fields).
export function makeGitHubUser(overrides: {
  id?: string;
  githubUserId?: string;
  login?: string;
  avatarUrl?: string | null;
  identityData?: Record<string, unknown> | null;
  identities?: SupabaseAuthUserLike["identities"];
} = {}): SupabaseAuthUserLike {
  const githubUserId = overrides.githubUserId ?? "123456789";
  const login = overrides.login ?? "octo-dev";
  const avatarUrl =
    overrides.avatarUrl === undefined
      ? "https://avatars.githubusercontent.com/u/123456789"
      : overrides.avatarUrl;

  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    identities:
      overrides.identities !== undefined
        ? overrides.identities
        : [
            {
              provider: "github",
              id: githubUserId,
              identity_data:
                overrides.identityData !== undefined
                  ? overrides.identityData
                  : {
                      provider_id: githubUserId,
                      sub: githubUserId,
                      user_name: login,
                      preferred_username: login,
                      ...(avatarUrl !== null ? { avatar_url: avatarUrl } : {}),
                    },
            },
          ],
    user_metadata: {},
  };
}

export function createFakeAuthDeps(
  tokens: Record<string, SupabaseAuthUserLike>,
  profiles: ProfileStore = createInMemoryProfileStore(),
): RequireAuthDeps {
  return {
    verifyAccessToken: async (accessToken) => tokens[accessToken] ?? null,
    profiles,
  };
}

export function createFakeRateLimiter(
  allowed = true,
): InstallationStartRateLimiter & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    checkAndConsumeInstallationStart: async (userId) => {
      calls.push(userId);
      return { allowed, count: allowed ? 1 : 11, limit: 10, windowSeconds: 600 };
    },
  };
}

export type BootedApp = {
  baseUrl: string;
  close: () => Promise<void>;
};

export async function bootProductApi(
  env: NodeJS.ProcessEnv,
  overrides: Partial<ProductApiDeps>,
): Promise<BootedApp> {
  const app = createApp(env, overrides);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function makeSnapshot(
  overrides: Partial<InstallationSnapshot> = {},
): InstallationSnapshot {
  return {
    installationId: "987654321",
    accountId: "123456789",
    accountLogin: "SherlockHQ",
    accountType: "Organization",
    accountAvatarUrl: "https://avatars.githubusercontent.com/u/123456789",
    repositorySelection: "selected",
    permissions: { contents: "write", issues: "write" },
    suspendedAt: null,
    ...overrides,
  };
}

export { createInMemoryInstallationDataStore };
