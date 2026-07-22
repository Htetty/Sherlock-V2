// Consistent error envelope for the protected product API (/api/*).
//
// Every JSON error a protected route returns has the shape:
//   { "error": { "code": "MACHINE_READABLE_CODE", "message": "..." } }
//
// Codes are stable machine-readable strings the frontend switches on;
// messages are short, safe, human-readable summaries. Nothing here may ever
// carry stack traces, database/Supabase/GitHub error details, tokens, state
// nonces, secrets, SQL, or filesystem paths. Unexpected failures are logged
// server-side with an internal correlation id; the repository has no public
// request-id convention, so the id stays internal.

import { randomUUID } from "node:crypto";
import type express from "express";

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "GITHUB_IDENTITY_REQUIRED"
  | "GITHUB_IDENTITY_CONFLICT"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "INSTALLATION_START_RATE_LIMITED"
  | "INSTALLATION_STATE_INVALID"
  | "INSTALLATION_STATE_EXPIRED"
  | "INSTALLATION_STATE_ALREADY_USED"
  | "INSTALLATION_VERIFICATION_FAILED"
  | "INSTALLATION_OWNERSHIP_NOT_VERIFIED"
  | "INSTALLATION_CONFLICT"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    // Optional response headers (e.g. Retry-After on 429s).
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const apiErrors = {
  authRequired: () =>
    new ApiError(401, "AUTH_REQUIRED", "Authentication is required."),
  authInvalid: () =>
    new ApiError(401, "AUTH_INVALID", "The provided credentials are invalid or expired."),
  githubIdentityRequired: () =>
    new ApiError(
      403,
      "GITHUB_IDENTITY_REQUIRED",
      "The signed-in account has no usable GitHub identity.",
    ),
  githubIdentityConflict: () =>
    new ApiError(
      409,
      "GITHUB_IDENTITY_CONFLICT",
      "This account's GitHub identity conflicts with an existing profile.",
    ),
  invalidRequest: (message = "The request is invalid.") =>
    new ApiError(400, "INVALID_REQUEST", message),
  installationStartRateLimited: (retryAfterSeconds: number) =>
    new ApiError(
      429,
      "INSTALLATION_START_RATE_LIMITED",
      "Too many installation attempts. Please try again later.",
      { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    ),
  dependencyUnavailable: () =>
    new ApiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "A required backend dependency is unavailable.",
    ),
  internal: () =>
    new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred."),
} as const;

export function sendApiError(res: express.Response, error: ApiError): void {
  for (const [name, value] of Object.entries(error.headers ?? {})) {
    res.setHeader(name, value);
  }

  res.status(error.status).json({
    error: { code: error.code, message: error.message },
  });
}

// Terminal handler for protected route failures. Known ApiErrors pass
// through; anything else is logged (sanitized, with a correlation id) and
// mapped to a generic INTERNAL_ERROR so no dependency detail leaks.
export function sendRouteError(
  res: express.Response,
  error: unknown,
  log: (message: string) => void = (message) => console.error(message),
): void {
  if (error instanceof ApiError) {
    sendApiError(res, error);
    return;
  }

  const correlationId = randomUUID();
  const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log(`[api:${correlationId}] Unexpected API failure: ${summary}`);
  sendApiError(res, apiErrors.internal());
}
