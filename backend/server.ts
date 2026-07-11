// Thin HTTP wrapper around the investigation pipeline, kept for manual and
// development use. Production investigations must go through the Redis
// queue (backend/worker.ts): the synchronous endpoint is disabled when
// NODE_ENV=production unless ALLOW_SYNC_INVESTIGATIONS=true is set
// explicitly. Health endpoints stay available in all environments.
//
// The pipeline itself (including ContextPack graph context and repo memory)
// lives in backend/services/investigation.ts and is shared with the worker.

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

export function isSyncInvestigationEndpointEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV !== "production") {
    return true;
  }

  return env.ALLOW_SYNC_INVESTIGATIONS === "true";
}

// A single readiness check. `ok` is a boolean only; `name` is a variable
// NAME, never a value — this result is serialized to /readyz, so it must
// never carry a secret or the contents of any environment variable.
export type ApiReadinessCheck = { name: string; ok: boolean };

export type ApiReadiness = { ready: boolean; checks: ApiReadinessCheck[] };

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

  return { ready: checks.every((check) => check.ok), checks };
}

export function createApp(env: NodeJS.ProcessEnv = process.env) {
  const app = express();

  app.use(cors());
  app.use(express.json());

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

  app.post("/investigations", async (req, res) => {
    if (!isSyncInvestigationEndpointEnabled(env)) {
      res.status(403).json({
        error:
          "The synchronous investigation endpoint is disabled in production. Investigations run through the Redis queue; set ALLOW_SYNC_INVESTIGATIONS=true only for controlled debugging.",
      });
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
