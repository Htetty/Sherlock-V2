// Supabase bearer-token authentication for the protected product API.
//
// Every protected route runs through this middleware:
//   1. Parse exactly one `Authorization: Bearer <token>` header.
//   2. Verify the token with the auth-verification Supabase client
//      (supabase.auth.getUser(accessToken)) — never by decoding the JWT
//      payload locally and never via getSession().
//   3. Extract the immutable GitHub identity (numeric id as a string).
//   4. Synchronize public.profiles (service role), failing closed on
//      identity conflicts.
//   5. Attach a minimal auth context to res.locals. The access token stays
//      server-side: it is never logged and never appears in a response.

import type express from "express";
import {
  extractGitHubIdentity,
  GitHubIdentityConflictError,
  syncProfile,
  type ProfileRecord,
  type ProfileStore,
  type SupabaseAuthUserLike,
} from "../services/github-identity.js";
import { SupabaseConfigurationError } from "../services/supabase-clients.js";
import { ApiError, apiErrors, sendApiError, sendRouteError } from "../routes/api-errors.js";

export type AuthContext = {
  userId: string;
  accessToken: string;
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
};

export type RequireAuthDeps = {
  // Returns the verified Supabase user for the token, or null when the token
  // is invalid/expired. Implementations must not throw for ordinary
  // invalid-token outcomes.
  verifyAccessToken: (accessToken: string) => Promise<SupabaseAuthUserLike | null>;
  profiles: ProfileStore;
  log?: (message: string) => void;
};

const AUTH_CONTEXT_KEY = "sherlockAuth";
const PROFILE_KEY = "sherlockProfile";

export function getAuthContext(res: express.Response): AuthContext {
  const auth = res.locals[AUTH_CONTEXT_KEY] as AuthContext | undefined;

  if (!auth) {
    throw new Error("Auth context is missing; requireAuth must run first.");
  }

  return auth;
}

export function getSyncedProfile(res: express.Response): ProfileRecord {
  const profile = res.locals[PROFILE_KEY] as ProfileRecord | undefined;

  if (!profile) {
    throw new Error("Profile is missing; requireAuth must run first.");
  }

  return profile;
}

// Parse the bearer token, rejecting duplicates, foreign schemes, and empty
// tokens. Node's HTTP parser keeps only the first `authorization` value, so
// duplicates are detected from rawHeaders.
export function parseBearerToken(req: express.Request): string {
  const occurrences = countAuthorizationHeaders(req);

  if (occurrences === 0) {
    throw apiErrors.authRequired();
  }

  if (occurrences > 1) {
    throw apiErrors.authInvalid();
  }

  const header = req.headers.authorization;

  if (typeof header !== "string") {
    throw apiErrors.authRequired();
  }

  const match = /^Bearer[ ]+(.+)$/.exec(header.trim());
  const token = match?.[1]?.trim();

  if (!token) {
    throw apiErrors.authInvalid();
  }

  return token;
}

function countAuthorizationHeaders(req: express.Request): number {
  const rawHeaders: string[] = req.rawHeaders ?? [];
  let count = 0;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "authorization") {
      count += 1;
    }
  }

  // Fallback for synthetic requests without rawHeaders (tests, adapters).
  if (count === 0 && typeof req.headers.authorization === "string") {
    return 1;
  }

  return count;
}

// getDeps is async and evaluated per request so environment problems surface
// as safe 503s at request time instead of import-time crashes in unrelated
// processes.
export function createRequireAuth(
  getDeps: () => Promise<RequireAuthDeps>,
): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const accessToken = parseBearerToken(req);

      let deps: RequireAuthDeps;

      try {
        deps = await getDeps();
      } catch (error) {
        if (error instanceof SupabaseConfigurationError) {
          // Names of missing variables only — never values, never to clients.
          console.error(`Auth dependencies unavailable: ${error.message}`);
          sendApiError(res, apiErrors.dependencyUnavailable());
          return;
        }
        throw error;
      }

      const user = await deps.verifyAccessToken(accessToken);

      if (!user || typeof user.id !== "string" || user.id.length === 0) {
        throw apiErrors.authInvalid();
      }

      const identity = extractGitHubIdentity(user);

      if (identity === null) {
        throw apiErrors.githubIdentityRequired();
      }

      let profile: ProfileRecord;

      try {
        profile = await syncProfile(deps.profiles, user.id, identity);
      } catch (error) {
        if (error instanceof GitHubIdentityConflictError) {
          throw apiErrors.githubIdentityConflict();
        }
        throw error;
      }

      const auth: AuthContext = {
        userId: user.id,
        accessToken,
        githubUserId: identity.githubUserId,
        githubLogin: identity.githubLogin,
        avatarUrl: identity.avatarUrl,
      };

      res.locals[AUTH_CONTEXT_KEY] = auth;
      res.locals[PROFILE_KEY] = profile;
      next();
    } catch (error) {
      if (error instanceof ApiError) {
        sendApiError(res, error);
        return;
      }

      sendRouteError(res, error);
    }
  };
}
