import express from "express";
import { isInvestigationId } from "../services/artifacts.js";
import { getAuthContext } from "../middleware/require-auth.js";
import type { ProductReadStore } from "../services/product-read.js";
import { apiErrors, sendRouteError } from "./api-errors.js";

export type InvestigationsRouterDeps = {
  requireAuth: express.RequestHandler;
  getProductReadStore: () => Promise<ProductReadStore>;
};

export function createInvestigationsRouter(
  deps: InvestigationsRouterDeps,
): express.Router {
  const router = express.Router();

  router.get("/:investigationId", deps.requireAuth, async (req, res) => {
    try {
      const investigationId = req.params.investigationId;
      if (!isInvestigationId(investigationId)) throw apiErrors.notFound();
      const auth = getAuthContext(res);
      const reader = await deps.getProductReadStore();
      const investigation = await reader.getInvestigation(
        auth.userId,
        investigationId,
      );
      if (!investigation) throw apiErrors.notFound();

      const etag = `W/"investigation-${investigation.id}-${investigation.version}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, no-cache");
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      res.json(investigation);
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.get("/:investigationId/diff", deps.requireAuth, async (req, res) => {
    try {
      const investigationId = req.params.investigationId;
      if (!isInvestigationId(investigationId)) throw apiErrors.notFound();
      const auth = getAuthContext(res);
      const reader = await deps.getProductReadStore();
      const diff = await reader.getInvestigationDiff(
        auth.userId,
        investigationId,
      );
      if (!diff) throw apiErrors.notFound();
      res.setHeader("Cache-Control", "private, no-store");
      res.json(diff);
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  return router;
}
