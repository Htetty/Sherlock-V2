// Health/readiness endpoints and the readiness evaluator. The evaluator is
// pure and reports variable NAMES only; the integration cases boot the real
// Express app on an ephemeral port and assert status codes and that no secret
// value ever appears in a /readyz body.
import { afterEach, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, evaluateApiReadiness } from "../backend/server.js";

// Placeholder-only credentials — never real, token-shaped, or secret.
const readyEnv = {
  APP_ID: "123456",
  PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----placeholder",
  WEBHOOK_SECRET: "example-webhook-secret",
  ANTHROPIC_API_KEY: "placeholder-anthropic-key",
} as NodeJS.ProcessEnv;

function checkOf(readiness: ReturnType<typeof evaluateApiReadiness>, name: string) {
  return readiness.checks.find((check) => check.name === name)?.ok;
}

describe("evaluateApiReadiness", () => {
  test("ready when every required variable is present", () => {
    const readiness = evaluateApiReadiness(readyEnv);
    expect(readiness.ready).toBe(true);
    for (const name of ["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET", "ANTHROPIC_API_KEY"]) {
      expect(checkOf(readiness, name), name).toBe(true);
    }
  });

  test("PRIVATE_KEY_PATH satisfies the private-key requirement", () => {
    const readiness = evaluateApiReadiness({
      ...readyEnv,
      PRIVATE_KEY: undefined,
      PRIVATE_KEY_PATH: "/etc/sherlock/key.pem",
    } as NodeJS.ProcessEnv);
    expect(checkOf(readiness, "PRIVATE_KEY")).toBe(true);
    expect(readiness.ready).toBe(true);
  });

  test("missing required variables make it not ready, by name", () => {
    const readiness = evaluateApiReadiness({ APP_ID: "123456" } as NodeJS.ProcessEnv);
    expect(readiness.ready).toBe(false);
    expect(checkOf(readiness, "WEBHOOK_SECRET")).toBe(false);
    expect(checkOf(readiness, "ANTHROPIC_API_KEY")).toBe(false);
    expect(checkOf(readiness, "PRIVATE_KEY")).toBe(false);
  });

  test("REDIS_URL is required in production but optional otherwise", () => {
    // Development / unset NODE_ENV: no REDIS_URL check at all (localhost
    // default is fine) — unchanged local-dev behavior.
    expect(
      evaluateApiReadiness(readyEnv).checks.some((c) => c.name === "REDIS_URL"),
    ).toBe(false);
    expect(evaluateApiReadiness(readyEnv).ready).toBe(true);

    // Production without REDIS_URL: not ready (queue is the only path and
    // the localhost default is wrong inside a container).
    const missing = evaluateApiReadiness({
      ...readyEnv,
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(checkOf(missing, "REDIS_URL")).toBe(false);
    expect(missing.ready).toBe(false);

    // Production with REDIS_URL: ready.
    const configured = evaluateApiReadiness({
      ...readyEnv,
      NODE_ENV: "production",
      REDIS_URL: "redis://redis:6379",
    } as NodeJS.ProcessEnv);
    expect(checkOf(configured, "REDIS_URL")).toBe(true);
    expect(configured.ready).toBe(true);
  });

  test("Supabase credentials are only required when that store is selected", () => {
    // Not selected: no supabase check is added.
    expect(
      evaluateApiReadiness(readyEnv).checks.some((c) => c.name === "state-store:supabase"),
    ).toBe(false);

    // Selected but unconfigured: not ready.
    const missing = evaluateApiReadiness({
      ...readyEnv,
      SHERLOCK_STATE_STORE: "supabase",
    } as NodeJS.ProcessEnv);
    expect(checkOf(missing, "state-store:supabase")).toBe(false);
    expect(missing.ready).toBe(false);

    // Selected and configured with placeholder values: ready.
    const configured = evaluateApiReadiness({
      ...readyEnv,
      SHERLOCK_STATE_STORE: "supabase",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "redact-me",
    } as NodeJS.ProcessEnv);
    expect(checkOf(configured, "state-store:supabase")).toBe(true);
    expect(configured.ready).toBe(true);
  });
});

describe("health endpoints", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function listen(env: NodeJS.ProcessEnv): Promise<string> {
    server = createApp(env).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  test("/healthz and /health are always 200 regardless of config", async () => {
    const base = await listen({} as NodeJS.ProcessEnv);
    for (const path of ["/healthz", "/health"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    }
  });

  test("/readyz is 200 when configured", async () => {
    const base = await listen(readyEnv);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ready");
  });

  test("/readyz is 503 when unconfigured and never leaks a secret value", async () => {
    const secretValue = "super-secret-anthropic-value";
    const base = await listen({
      APP_ID: "123456",
      ANTHROPIC_API_KEY: secretValue,
      // WEBHOOK_SECRET and PRIVATE_KEY intentionally absent -> not ready.
    } as NodeJS.ProcessEnv);

    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(JSON.parse(raw).status).toBe("not_ready");
    // Names appear; values never do.
    expect(raw).toContain("ANTHROPIC_API_KEY");
    expect(raw).not.toContain(secretValue);
    expect(raw).not.toContain("123456");
  });
});
