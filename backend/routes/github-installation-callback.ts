// GET /api/github/installations/callback — the GitHub App setup callback.
//
// This route is public in the transport sense (GitHub's browser redirect
// carries no Supabase bearer token and no frontend cookie; the frontend may
// live on a different domain). Its authorization boundary is:
//
//   1. the one-time, hashed, expiring state nonce minted by
//      POST /api/installations/start (binds the callback to a Sherlock user);
//   2. verification of the installation through GitHub's App API
//      (the callback's installation_id is never trusted on its own);
//   3. the ownership policy: personal installations require the installation
//      account id to equal the profile's GitHub id; organization
//      installations require the verified installation.created webhook
//      sender id to equal the profile's GitHub id.
//
// Outcomes always end in a redirect to the single trusted frontend origin —
// success to /dashboard?installation=success, everything else to /onboarding.
// No installation id, user id, state, token, or error detail ever appears in
// a redirect URL or in logs.

import express from "express";
import {
  hashInstallationNonce,
  verifyInstallationOwnership,
  type InstallationDataStore,
  type InstallationSnapshot,
  type NonceRecord,
  type ProfileStore,
  type RepositorySnapshot,
} from "../services/github-installations.js";

// Bounded base64url shape for the state parameter (the minted state is 43
// characters; the bounds leave headroom without accepting arbitrary blobs).
const STATE_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;
const INSTALLATION_ID_PATTERN = /^\d{1,20}$/;

// GitHub's setup flow redirects with setup_action=install|update. Anything
// else (e.g. "request", where an org owner must first approve and no
// installation exists yet) cannot be verified here.
const SUPPORTED_SETUP_ACTIONS = new Set(["install", "update"]);

// How long the callback will wait for the installation.created webhook when
// the callback wins the race (bounded; the webhook handler reconciles later
// arrivals on its own).
const WEBHOOK_WAIT_ATTEMPTS = 3;
const WEBHOOK_WAIT_DELAY_MS = 1_000;

// --- Frontend base URL --------------------------------------------------------

// SHERLOCK_FRONTEND_URL is the single trusted redirect origin: absolute, no
// credentials, no query/fragment, https except for local development hosts.
export function resolveFrontendBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.SHERLOCK_FRONTEND_URL;

  if (!raw) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const httpsRequired = env.NODE_ENV === "production" || !isLocalhost;

  if (
    (url.protocol !== "https:" && (httpsRequired || url.protocol !== "http:")) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  // Normalize away a trailing slash so path concatenation stays exact.
  return url.origin + url.pathname.replace(/\/+$/, "");
}

// --- Route --------------------------------------------------------------------

export type InstallationCallbackDeps = {
  getStore: () => Promise<InstallationDataStore>;
  getProfiles: () => Promise<ProfileStore>;
  // Fetch the authoritative installation from GitHub's App API using the
  // existing GitHub App credentials. Must throw when the lookup fails.
  fetchInstallation: (installationId: string) => Promise<InstallationSnapshot>;
  fetchInstallationRepositories?: (
    installationId: string,
  ) => Promise<RepositorySnapshot[]>;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  webhookWaitAttempts?: number;
  webhookWaitDelayMs?: number;
  log?: (message: string) => void;
};

function singleQueryValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function createInstallationCallbackRouter(
  deps: InstallationCallbackDeps,
): express.Router {
  const router = express.Router();
  const env = deps.env ?? process.env;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.log(message));
  const waitAttempts = deps.webhookWaitAttempts ?? WEBHOOK_WAIT_ATTEMPTS;
  const waitDelayMs = deps.webhookWaitDelayMs ?? WEBHOOK_WAIT_DELAY_MS;

  router.get("/", async (req, res) => {
    const frontendBase = resolveFrontendBaseUrl(env);

    if (frontendBase === null) {
      // Without a validated trusted origin there is nowhere safe to send the
      // browser. Generic response; details stay in logs.
      console.error(
        "GitHub setup callback cannot redirect: SHERLOCK_FRONTEND_URL is missing or invalid.",
      );
      res.status(500).send("Setup callback is not configured.");
      return;
    }

    const redirectOnboarding = () => res.redirect(302, `${frontendBase}/onboarding`);
    const redirectSuccess = () =>
      res.redirect(302, `${frontendBase}/dashboard?installation=success`);

    try {
      const state = singleQueryValue(req.query.state);

      if (state === null || !STATE_PATTERN.test(state)) {
        log("Setup callback rejected: missing or malformed state.");
        redirectOnboarding();
        return;
      }

      const store = await deps.getStore();

      // Atomically consume the nonce FIRST: whatever else happens, this state
      // value is now spent and can never be replayed.
      const consumed = await store.consumeNonceByHash(hashInstallationNonce(state));

      if (consumed.outcome !== "consumed") {
        log(`Setup callback rejected: state was ${consumed.outcome}.`);
        redirectOnboarding();
        return;
      }

      const nonce = consumed.nonce;

      const finalizeRejected = async (failureCode: string) => {
        await store.updateNonceClaim(nonce.id, {
          claimStatus: "rejected",
          failureCode,
        });
        redirectOnboarding();
      };

      const setupAction = singleQueryValue(req.query.setup_action);

      if (setupAction === null || !SUPPORTED_SETUP_ACTIONS.has(setupAction)) {
        log("Setup callback rejected: unsupported setup_action.");
        await finalizeRejected("unsupported_setup_action");
        return;
      }

      const installationId = singleQueryValue(req.query.installation_id);

      if (installationId === null || !INSTALLATION_ID_PATTERN.test(installationId)) {
        log("Setup callback rejected: malformed installation id.");
        await finalizeRejected("malformed_installation_id");
        return;
      }

      // Verify through GitHub: the callback parameters prove nothing by
      // themselves. App authentication only; no installation token is minted
      // or persisted here.
      let snapshot: InstallationSnapshot;

      try {
        snapshot = await deps.fetchInstallation(installationId);
      } catch (error) {
        log(
          `Setup callback rejected: GitHub installation lookup failed (${error instanceof Error ? error.name : "error"}).`,
        );
        await finalizeRejected("github_lookup_failed");
        return;
      }

      if (snapshot.installationId !== installationId) {
        log("Setup callback rejected: installation id mismatch.");
        await finalizeRejected("installation_id_mismatch");
        return;
      }

      // Persist the authoritative snapshot regardless of the ownership
      // outcome; created_by remains owned by the verified webhook.
      const eventAt = now().toISOString();
      const existing = await store.getInstallation(installationId);

      if (existing?.status !== "deleted") {
        await store.upsertInstallationSnapshot(snapshot, { eventAt });
      }

      const profiles = await deps.getProfiles();
      const profile = await profiles.getById(nonce.userId);

      if (!profile) {
        log("Setup callback rejected: bound profile no longer exists.");
        await finalizeRejected("profile_missing");
        return;
      }

      const finalizeVerified = async (
        method: "personal_account_match" | "installation_webhook_sender",
      ) => {
        if (deps.fetchInstallationRepositories) {
          try {
            const repositories =
              await deps.fetchInstallationRepositories(installationId);
            await store.upsertInstallationRepositories(
              installationId,
              repositories,
              now().toISOString(),
            );
          } catch (error) {
            // Ownership remains valid even if GitHub's repository-list API is
            // temporarily unavailable. Installation/repository webhooks and a
            // later setup callback can reconcile the projection.
            log(
              `Setup callback repository reconciliation deferred (${error instanceof Error ? error.name : "error"}).`,
            );
          }
        }
        await store.upsertMembership({
          userId: profile.id,
          installationId,
          relationship: "installer",
          verificationMethod: method,
        });
        await store.attachInstallationToNonce(nonce.id, installationId);
        await store.updateNonceClaim(nonce.id, {
          claimStatus: "verified",
          verificationMethod: method,
        });
        redirectSuccess();
      };

      const ownership = verifyInstallationOwnership({
        accountType: snapshot.accountType,
        accountId: snapshot.accountId,
        createdByGithubUserId: existing?.createdByGithubUserId ?? null,
        profileGithubUserId: profile.githubUserId,
      });

      if (ownership.verified) {
        await finalizeVerified(ownership.method);
        return;
      }

      if (ownership.reason !== "sender_unknown") {
        log(`Setup callback rejected: ownership not verified (${ownership.reason}).`);
        await finalizeRejected(ownership.reason);
        return;
      }

      // Organization installation whose installation.created webhook has not
      // been observed yet: record the pending claim, then briefly poll for
      // the webhook-recorded sender. If it does not arrive in time, the
      // webhook handler reconciles the pending claim later.
      await store.attachInstallationToNonce(nonce.id, installationId);

      for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
        await sleep(waitDelayMs);

        const refreshed = await store.getInstallation(installationId);
        const senderId = refreshed?.createdByGithubUserId ?? null;

        if (senderId === null) {
          continue;
        }

        if (senderId === profile.githubUserId) {
          await finalizeVerified("installation_webhook_sender");
          return;
        }

        log("Setup callback rejected: webhook sender mismatch.");
        await finalizeRejected("sender_mismatch");
        return;
      }

      // Webhook still pending — the claim reconciles asynchronously. This
      // pending state also covers claims verified by the webhook handler
      // during the poll window (updateNonceClaim there is idempotent).
      log("Setup callback pending: awaiting installation webhook verification.");
      redirectOnboarding();
    } catch (error) {
      // Never leak details into the redirect; log a sanitized summary.
      console.error(
        `GitHub setup callback failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`,
      );
      redirectOnboarding();
    }
  });

  return router;
}

// Narrow re-export so server wiring can type its nonce handling without
// importing the whole service module.
export type { NonceRecord };
