// GET /api/me — the authenticated user's identity, exactly as the frontend
// contract specifies. requireAuth has already verified the Supabase token,
// extracted the GitHub identity, and synchronized the profile; this route
// only shapes the response. It never returns email, Supabase metadata, or
// any token.

import express from "express";
import { getSyncedProfile } from "../middleware/require-auth.js";
import { sendRouteError } from "./api-errors.js";

export function createMeRouter(requireAuth: express.RequestHandler): express.Router {
  const router = express.Router();

  router.get("/", requireAuth, (_req, res) => {
    try {
      const profile = getSyncedProfile(res);

      res.json({
        user: {
          id: profile.id,
          // Always a decimal string, never a number.
          githubUserId: profile.githubUserId,
          login: profile.githubLogin,
          avatarUrl: profile.avatarUrl,
        },
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  return router;
}
