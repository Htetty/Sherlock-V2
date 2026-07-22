// Protected installation endpoints:
//
//   GET  /api/installations        — the caller's authorized installations,
//                                    joined strictly through membership.
//   POST /api/installations/start  — mint a one-time GitHub App installation
//                                    URL bound to the authenticated user.
//
// Authorization model: every query goes through
//   profile → user_installations → github_installations
// (enforced inside InstallationDataStore.listInstallationsForUser). No route
// ever accepts a caller-supplied installation id, and service-role visibility
// is never treated as user access.

import { randomBytes } from "node:crypto";
import express from "express";
import { getAuthContext } from "../middleware/require-auth.js";
import {
  hashInstallationNonce,
  sortInstallationsForListing,
  type InstallationDataStore,
} from "../services/github-installations.js";
import type { InstallationStartRateLimiter } from "../services/rate-limit.js";
import { apiErrors, sendRouteError } from "./api-errors.js";

// Conservative GitHub App slug shape: lowercase alphanumerics and single
// hyphens, no leading/trailing hyphen, bounded length. (GitHub slugs are the
// lowercased URL form of the app name.)
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,99}$/;

export function isValidGitHubAppSlug(value: unknown): value is string {
  return typeof value === "string" && APP_SLUG_PATTERN.test(value);
}

// Installation state: at least 256 bits of CSPRNG randomness, base64url.
export const INSTALLATION_STATE_BYTES = 32;
export const INSTALLATION_STATE_TTL_MS = 15 * 60 * 1000;

export function generateInstallationState(): string {
  return randomBytes(INSTALLATION_STATE_BYTES).toString("base64url");
}

// The backend is the only place the GitHub installation URL is constructed.
// The final URL is re-validated structurally before it is returned so a
// malformed slug or state can never smuggle in a foreign host or extra
// parameters.
export function buildInstallationUrl(appSlug: string, state: string): string {
  if (!isValidGitHubAppSlug(appSlug)) {
    throw new Error("GITHUB_APP_SLUG is not a valid GitHub App slug.");
  }

  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);

  const expectedPath = `/apps/${appSlug}/installations/new`;
  const paramNames = [...url.searchParams.keys()];

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPath ||
    paramNames.length !== 1 ||
    paramNames[0] !== "state"
  ) {
    throw new Error("Constructed installation URL failed validation.");
  }

  return url.toString();
}

export type InstallationsRouterDeps = {
  requireAuth: express.RequestHandler;
  getStore: () => Promise<InstallationDataStore>;
  getRateLimiter: () => Promise<InstallationStartRateLimiter>;
  env?: NodeJS.ProcessEnv;
  // Injectable for tests; production uses CSPRNG randomness.
  generateState?: () => string;
  now?: () => Date;
};

export function createInstallationsRouter(
  deps: InstallationsRouterDeps,
): express.Router {
  const router = express.Router();
  const env = deps.env ?? process.env;
  const generateState = deps.generateState ?? generateInstallationState;
  const now = deps.now ?? (() => new Date());

  router.get("/", deps.requireAuth, async (_req, res) => {
    try {
      const auth = getAuthContext(res);
      const store = await deps.getStore();
      const installations = sortInstallationsForListing(
        await store.listInstallationsForUser(auth.userId),
      );

      res.json({
        installations: installations.map((installation) => ({
          installationId: installation.installationId,
          account: {
            id: installation.accountId,
            login: installation.accountLogin,
            type: installation.accountType,
            avatarUrl: installation.accountAvatarUrl,
          },
          status: installation.status,
          repositorySelection: installation.repositorySelection,
        })),
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.post("/start", deps.requireAuth, async (req, res) => {
    try {
      // The contract requires an exactly-empty JSON object body; unexpected
      // fields are rejected rather than ignored.
      const body: unknown = req.body;

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      ) {
        throw apiErrors.invalidRequest("Request body must be an empty JSON object.");
      }

      const appSlug = env.GITHUB_APP_SLUG;

      if (!isValidGitHubAppSlug(appSlug)) {
        // Server misconfiguration, not a caller problem. Details stay in logs.
        console.error(
          "POST /api/installations/start unavailable: GITHUB_APP_SLUG is missing or not a valid slug.",
        );
        throw apiErrors.dependencyUnavailable();
      }

      const auth = getAuthContext(res);

      // Atomic, user-scoped, Redis-backed limit. A Redis outage is a 503;
      // it never silently disables rate limiting.
      let decision;

      try {
        const rateLimiter = await deps.getRateLimiter();
        decision = await rateLimiter.checkAndConsumeInstallationStart(auth.userId);
      } catch (error) {
        console.error(
          `Installation-start rate limiter unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        throw apiErrors.dependencyUnavailable();
      }

      if (!decision.allowed) {
        throw apiErrors.installationStartRateLimited(decision.windowSeconds);
      }

      const store = await deps.getStore();

      // One live onboarding attempt per user: supersede any prior unconsumed
      // nonce before minting a new one, then store ONLY the SHA-256 hash.
      const rawState = generateState();
      const expiresAt = new Date(now().getTime() + INSTALLATION_STATE_TTL_MS);

      await store.supersedeUnclaimedNonces(auth.userId);
      await store.insertNonce({
        nonceHash: hashInstallationNonce(rawState),
        userId: auth.userId,
        expiresAt: expiresAt.toISOString(),
      });

      // The raw state leaves the backend exactly once: inside this URL.
      res.json({ url: buildInstallationUrl(appSlug, rawState) });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  return router;
}
