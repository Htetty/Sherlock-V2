// Thin HTTP wrapper around the investigation pipeline, kept for manual and
// development use. Production investigations must go through the Redis
// queue (backend/worker.ts): the synchronous endpoint is disabled when
// NODE_ENV=production unless ALLOW_SYNC_INVESTIGATIONS=true is set
// explicitly. Health endpoints stay available in all environments.

import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runInvestigationPipeline,
  type InvestigationPipelineInput,
} from "./services/investigation.js";

export function isSyncInvestigationEndpointEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV !== "production") {
    return true;
  }

  return env.ALLOW_SYNC_INVESTIGATIONS === "true";
}

export function createApp(env: NodeJS.ProcessEnv = process.env) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
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
