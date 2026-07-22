// HTTP server for the Sherlock backend:
//
//   - Liveness/readiness endpoints (public, dependency-free).
//   - The protected product API (/api/me, /api/installations,
//     /api/installations/start) authenticated with Supabase bearer tokens.
//   - The public-but-nonce-protected GitHub App setup callback
//     (GET /api/github/installations/callback).
//   - A synchronous investigation endpoint kept ONLY for controlled local
//     debugging: disabled by default in every environment, never available
//     in production, opt-in via ALLOW_SYNC_INVESTIGATIONS=true, and then
//     loopback-only.
//
// GitHub webhooks do NOT flow through this app: Probot serves them in its own
// process (npm run serve:bot), so no middleware here can interfere with
// webhook signature verification.
//
// The pipeline itself (including ContextPack graph context and repo memory)
// lives in backend/services/investigation.ts and is shared with the worker.

// Load .env for local development (same convention as backend/worker.ts).
// In containers the env file is injected by compose and .env does not exist,
// so this is a silent no-op there.
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runInvestigationPipeline,
  type InvestigationPipelineInput,
} from "./services/investigation.js";
import {
  createInvestigationStateStoreFromEnv,
  missingSupabaseStateStoreEnv,
} from "./services/investigation-state-store.js";
import {
  createRequireAuth,
  type RequireAuthDeps,
} from "./middleware/require-auth.js";
import { createMeRouter } from "./routes/me.js";
import {
  createInstallationsRouter,
  isValidGitHubAppSlug,
} from "./routes/installations.js";
import {
  createInstallationCallbackRouter,
  resolveFrontendBaseUrl,
} from "./routes/github-installation-callback.js";
import {
  createSupabaseInstallationDataStore,
  toGitHubIdString,
  type InstallationDataStore,
  type InstallationSnapshot,
} from "./services/github-installations.js";
import {
  createSupabaseProfileStore,
  type ProfileStore,
  type SupabaseAuthUserLike,
} from "./services/github-identity.js";
import {
  getSupabaseAuthVerificationClient,
  getSupabaseServiceRoleClient,
  missingSupabaseAuthEnv,
  missingSupabaseServiceEnv,
} from "./services/supabase-clients.js";
import {
  createInstallationStartRateLimiter,
  asScriptRunner,
  type InstallationStartRateLimiter,
} from "./services/rate-limit.js";

// Bounded JSON bodies everywhere on this server. Protected API requests are
// tiny; the sync debugging endpoint's issue text also fits comfortably.
const JSON_BODY_LIMIT = "512kb";

// --- Synchronous investigation endpoint gating --------------------------------

// Disabled by default in EVERY environment; opt-in via
// ALLOW_SYNC_INVESTIGATIONS=true; never available in production even with
// the flag set.
export function isSyncInvestigationEndpointEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === "production") {
    return false;
  }

  return env.ALLOW_SYNC_INVESTIGATIONS === "true";
}

// Loopback-only check against the actual socket peer address. X-Forwarded-For
// is deliberately ignored: this app has no configured trusted proxy, so any
// forwarded header is attacker-controllable.
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) {
    return false;
  }

  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1).
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;

  if (normalized === "::1") {
    return true;
  }

  // Entire 127.0.0.0/8 loopback range.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

// Minimal shape validation for the sync endpoint: reject before any model or
// Docker work starts. Not exhaustive — the pipeline re-validates — but no
// unshaped request may reach it.
export function validateSyncInvestigationInput(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["Request body must be a JSON object."];
  }

  const input = body as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of ["repoOwner", "repoName", "repoUrl", "defaultBranch"]) {
    if (typeof input[field] !== "string" || input[field] === "") {
      errors.push(`${field} must be a non-empty string.`);
    }
  }

  if (typeof input.issueNumber !== "number" || !Number.isInteger(input.issueNumber)) {
    errors.push("issueNumber must be an integer.");
  }

  if (typeof input.issueTitle !== "string" || input.issueTitle === "") {
    errors.push("issueTitle must be a non-empty string.");
  }

  return errors;
}

// --- Readiness ----------------------------------------------------------------

// A single readiness check. `ok` is a boolean only; `name` is a variable
// NAME, never a value — this result is serialized to /readyz, so it must
// never carry a secret or the contents of any environment variable.
export type ApiReadinessCheck = { name: string; ok: boolean };

export type ApiReadiness = { ready: boolean; checks: ApiReadinessCheck[] };

// True when the operator intends to serve the product API (any of its
// dedicated variables is set). Keeps webhook-only deployments' readiness
// unchanged while catching partially configured dashboard deployments.
export function isProductApiConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.SUPABASE_PUBLISHABLE_KEY || env.GITHUB_APP_SLUG || env.SHERLOCK_FRONTEND_URL,
  );
}

// Config-level readiness for the API/webhook service: are the variables the
// service needs to accept and enqueue investigations present? This is the
// "safe" subset of readiness — it reports presence/absence by NAME and never
// touches values, never dials a dependency, and never runs customer code.
// Deep dependency readiness (Redis, Docker, Playwright, target image) is the
// worker preflight's job (npm run worker:check); the API only needs to know
// it is configured well enough to receive webhooks and put jobs on the queue.
export function evaluateApiReadiness(
  env: NodeJS.ProcessEnv = process.env,
): ApiReadiness {
  const checks: ApiReadinessCheck[] = [
    // GitHub App identity: required to authenticate webhook installations.
    { name: "APP_ID", ok: Boolean(env.APP_ID) },
    // Either an inline key or a path to one is acceptable.
    { name: "PRIVATE_KEY", ok: Boolean(env.PRIVATE_KEY || env.PRIVATE_KEY_PATH) },
    // Webhook signature verification secret (probot). API-only: the worker
    // never receives webhooks, so its preflight does not check this.
    { name: "WEBHOOK_SECRET", ok: Boolean(env.WEBHOOK_SECRET) },
    // Anthropic is required by the pipeline the enqueued job will run.
    { name: "ANTHROPIC_API_KEY", ok: Boolean(env.ANTHROPIC_API_KEY) },
  ];

  // REDIS_URL: in production the queue is the only investigation path, and
  // the localhost default is guaranteed wrong inside a container — silently
  // falling back to it would report "ready" while every enqueue fails. In
  // development the default (redis://localhost:6379) is fine, so the check
  // only applies when NODE_ENV=production.
  if (env.NODE_ENV === "production") {
    checks.push({ name: "REDIS_URL", ok: Boolean(env.REDIS_URL) });
  }

  // Only enforce Supabase credentials when that state store is selected.
  if (env.SHERLOCK_STATE_STORE === "supabase") {
    checks.push({
      name: "state-store:supabase",
      ok: missingSupabaseStateStoreEnv(env).length === 0,
    });
  }

  // Product API (dashboard) readiness, only when the operator has started
  // configuring it. Names only, never values; the frontend URL and app slug
  // additionally get their format validated because a malformed value is as
  // unusable as a missing one.
  if (isProductApiConfigured(env)) {
    checks.push(
      {
        name: "product-api:supabase-auth",
        ok: missingSupabaseAuthEnv(env).length === 0,
      },
      {
        name: "product-api:supabase-service",
        ok: missingSupabaseServiceEnv(env).length === 0,
      },
      {
        name: "product-api:GITHUB_APP_SLUG",
        ok: isValidGitHubAppSlug(env.GITHUB_APP_SLUG),
      },
      {
        name: "product-api:SHERLOCK_FRONTEND_URL",
        ok: resolveFrontendBaseUrl(env) !== null,
      },
    );
  }

  return { ready: checks.every((check) => check.ok), checks };
}

// --- Default product-API dependencies -----------------------------------------
// Everything is created lazily on first use so that constructing the app (or
// importing this module) never requires live Supabase/Redis/GitHub
// configuration — missing configuration surfaces as safe 503s per request.

export type ProductApiDeps = {
  getAuthDeps: () => Promise<RequireAuthDeps>;
  getInstallationStore: () => Promise<InstallationDataStore>;
  getProfileStore: () => Promise<ProfileStore>;
  getRateLimiter: () => Promise<InstallationStartRateLimiter>;
  fetchInstallation: (installationId: string) => Promise<InstallationSnapshot>;
};

// Normalize GitHub's GET /app/installations/{id} response into the snapshot
// shape. Throws on anything unexpected — verification must fail closed.
export function snapshotFromAppApiInstallation(data: unknown): InstallationSnapshot {
  const installation = data as {
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
  } | null;

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
    throw new Error("GitHub returned an unexpected installation shape.");
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
      typeof installation?.suspended_at === "string"
        ? installation.suspended_at
        : null,
  };
}

function createDefaultProductApiDeps(env: NodeJS.ProcessEnv): ProductApiDeps {
  let serviceStores: Promise<{
    installations: InstallationDataStore;
    profiles: ProfileStore;
  }> | null = null;

  const getServiceStores = () => {
    serviceStores ??= getSupabaseServiceRoleClient(env).then((client) => ({
      installations: createSupabaseInstallationDataStore(
        client as unknown as Parameters<typeof createSupabaseInstallationDataStore>[0],
      ),
      profiles: createSupabaseProfileStore(
        client as unknown as Parameters<typeof createSupabaseProfileStore>[0],
      ),
    }));
    return serviceStores;
  };

  let rateLimiter: InstallationStartRateLimiter | null = null;

  // App-authenticated (JWT) Octokit via the existing Probot/GitHub App
  // credential handling — no second private-key parsing system, and no
  // installation access token is minted or persisted here.
  let appAuth: Promise<{ auth: () => Promise<unknown> }> | null = null;

  return {
    getAuthDeps: async () => {
      const authClient = await getSupabaseAuthVerificationClient(env);
      const { profiles } = await getServiceStores();

      return {
        verifyAccessToken: async (accessToken: string) => {
          const { data, error } = await authClient.auth.getUser(accessToken);

          if (error || !data?.user) {
            return null;
          }

          return data.user as unknown as SupabaseAuthUserLike;
        },
        profiles,
      };
    },
    getInstallationStore: async () => (await getServiceStores()).installations,
    getProfileStore: async () => (await getServiceStores()).profiles,
    getRateLimiter: async () => {
      if (!rateLimiter) {
        const { createRedisConnection } = await import(
          "./queue/investigation-queue.js"
        );
        const redis = createRedisConnection();
        rateLimiter = createInstallationStartRateLimiter(() => asScriptRunner(redis));
      }

      return rateLimiter;
    },
    fetchInstallation: async (installationId: string) => {
      const numericId = Number(installationId);

      if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        throw new Error("Installation id is outside the safe integer range.");
      }

      appAuth ??= import("probot").then(({ createProbot }) => createProbot({ env }));
      const probot = await appAuth;
      const octokit = (await probot.auth()) as {
        request: (
          route: string,
          parameters: Record<string, unknown>,
        ) => Promise<{ data: unknown }>;
      };

      const { data } = await octokit.request(
        "GET /app/installations/{installation_id}",
        { installation_id: numericId },
      );

      return snapshotFromAppApiInstallation(data);
    },
  };
}

// --- App ----------------------------------------------------------------------

export function createApp(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ProductApiDeps> = {},
) {
  const app = express();
  const deps: ProductApiDeps = {
    ...createDefaultProductApiDeps(env),
    ...overrides,
  };

  // CORS: never a wildcard. The primary frontend flow is server-to-server
  // (no browser CORS needed); for local development the exact configured
  // frontend origin — and only it — is allowed on the /api surface.
  const frontendBase = resolveFrontendBaseUrl(env);

  if (frontendBase !== null) {
    app.use(
      "/api",
      cors({
        origin: new URL(frontendBase).origin,
        methods: ["GET", "POST"],
        allowedHeaders: ["Authorization", "Content-Type"],
        credentials: false,
      }),
    );
  }

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Liveness: the process is up and the event loop is serving requests.
  // Intentionally trivial and dependency-free so an orchestrator can tell a
  // hung process from a merely-not-ready one. /health is kept as an alias for
  // backward compatibility.
  const liveness = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok" });
  };
  app.get("/healthz", liveness);
  app.get("/health", liveness);

  // Readiness: configured well enough to accept and enqueue investigations.
  // Returns 503 until every required variable is present so a load balancer
  // holds traffic off a misconfigured instance. The body lists variable NAMES
  // and booleans only — never values — so it is safe to expose internally.
  app.get("/readyz", (_req, res) => {
    const readiness = evaluateApiReadiness(env);
    res.status(readiness.ready ? 200 : 503).json({
      status: readiness.ready ? "ready" : "not_ready",
      checks: readiness.checks,
    });
  });

  // --- Protected product API --------------------------------------------------

  const requireAuth = createRequireAuth(deps.getAuthDeps);

  app.use("/api/me", createMeRouter(requireAuth));
  app.use(
    "/api/installations",
    createInstallationsRouter({
      requireAuth,
      getStore: deps.getInstallationStore,
      getRateLimiter: deps.getRateLimiter,
      env,
    }),
  );
  app.use(
    "/api/github/installations/callback",
    createInstallationCallbackRouter({
      getStore: deps.getInstallationStore,
      getProfiles: deps.getProfileStore,
      fetchInstallation: deps.fetchInstallation,
      env,
    }),
  );

  // --- Synchronous investigation endpoint (local debugging only) --------------

  app.post("/investigations", async (req, res) => {
    // Generic 404 when unavailable: this endpoint should be indistinguishable
    // from a nonexistent route unless explicitly enabled.
    if (!isSyncInvestigationEndpointEnabled(env)) {
      res.status(404).json({ error: "Not found." });
      return;
    }

    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }

    const validationErrors = validateSyncInvestigationInput(req.body);

    if (validationErrors.length > 0) {
      res.status(400).json({ error: "Invalid request body.", details: validationErrors });
      return;
    }

    try {
      const result = await runInvestigationPipeline(
        req.body as InvestigationPipelineInput,
        { stateStore: createInvestigationStateStoreFromEnv(env) },
      );
      res.json(result);
    } catch (error) {
      console.error("Investigation failed before producing a result:", error);
      res.status(500).json({
        status: "error",
        outcome: "execution_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return app;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const PORT = Number(process.env.BACKEND_PORT ?? 4000);

  createApp().listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}
