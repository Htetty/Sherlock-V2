// Security hardening regression tests:
//   1.1 screenshot path traversal (plan validation + filesystem containment)
//   1.2 synchronous investigation endpoint lockdown
//   1.3 public replay upload opt-in policy
import { describe, expect, test } from "vitest";
import path from "node:path";
import { validateReproductionPlan, isSafeStepId } from "../backend/services/plan.js";
import { resolveScreenshotPath } from "../backend/services/playwright.js";
import {
  isPublicReplayUploadAllowed,
  normalizeRepositoryIdentity,
  resolvePublicReplayUploadPolicy,
} from "../backend/services/evidence-upload.js";
import {
  isLoopbackAddress,
  isSyncInvestigationEndpointEnabled,
  validateSyncInvestigationInput,
  createApp,
} from "../backend/server.js";

// --- 1.1 Screenshot path traversal -------------------------------------------

function planWithStepId(id: string) {
  return {
    version: 1,
    baseUrl: "http://localhost:3000",
    expectedBehavior: "The page renders.",
    failureCondition: "The page crashes.",
    steps: [{ id, action: "goto", path: "/" }],
    assertion: { type: "console_error", contains: "boom" },
  };
}

describe("screenshot path traversal", () => {
  test.each(["../escape", "../../escape", "/etc/passwd", "..\\escape", "a/../b", "."])(
    "plan validation rejects unsafe step id %j",
    (id) => {
      expect(isSafeStepId(id)).toBe(false);
      const result = validateReproductionPlan(planWithStepId(id));
      expect(result.ok).toBe(false);
    },
  );

  test.each(["step-1", "s", "Step_2", "0abc", "a".repeat(64)])(
    "plan validation accepts safe step id %j",
    (id) => {
      expect(isSafeStepId(id)).toBe(true);
      expect(validateReproductionPlan(planWithStepId(id)).ok).toBe(true);
    },
  );

  test("filesystem containment blocks traversal even if validation were bypassed", () => {
    const dir = "/tmp/sherlock-test/screenshots";

    for (const name of [
      "../escape",
      "../../escape",
      "/abs/path",
      "..\\..\\escape",
      "..",
      "a/../../b",
      "",
    ]) {
      expect(() => resolveScreenshotPath(dir, name), name).toThrow();
    }
  });

  test("valid names resolve to direct children of the screenshots directory", () => {
    const dir = "/tmp/sherlock-test/screenshots";

    const resolved = resolveScreenshotPath(dir, "step-1-failure");
    expect(resolved).toBe(path.join(path.resolve(dir), "step-1-failure.png"));

    // The internal "final" screenshot name keeps working.
    expect(resolveScreenshotPath(dir, "final")).toBe(
      path.join(path.resolve(dir), "final.png"),
    );
  });
});

// --- 1.2 Synchronous endpoint lockdown ----------------------------------------

describe("synchronous investigation endpoint", () => {
  test("disabled by default in every environment", () => {
    expect(isSyncInvestigationEndpointEnabled({})).toBe(false);
    expect(isSyncInvestigationEndpointEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isSyncInvestigationEndpointEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(isSyncInvestigationEndpointEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  test("flag enables it outside production only — never in production", () => {
    expect(
      isSyncInvestigationEndpointEnabled({ ALLOW_SYNC_INVESTIGATIONS: "true" }),
    ).toBe(true);
    expect(
      isSyncInvestigationEndpointEnabled({
        NODE_ENV: "production",
        ALLOW_SYNC_INVESTIGATIONS: "true",
      }),
    ).toBe(false);
  });

  test("loopback detection accepts loopback shapes and rejects everything else", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }

    for (const address of [
      "10.0.0.1",
      "192.168.1.5",
      "8.8.8.8",
      "::ffff:10.0.0.1",
      "2001:db8::1",
      "",
      undefined,
      null,
    ]) {
      expect(isLoopbackAddress(address as string | null | undefined), String(address)).toBe(false);
    }
  });

  test("request bodies are validated before any pipeline work", () => {
    expect(validateSyncInvestigationInput(null).length).toBeGreaterThan(0);
    expect(validateSyncInvestigationInput([]).length).toBeGreaterThan(0);
    expect(validateSyncInvestigationInput({}).length).toBeGreaterThan(0);
    expect(
      validateSyncInvestigationInput({
        repoOwner: "octo",
        repoName: "app",
        repoUrl: "https://github.com/octo/app",
        defaultBranch: "main",
        issueNumber: 12,
        issueTitle: "Bug",
      }),
    ).toEqual([]);
  });

  test("returns a generic 404 when disabled (default), even off-loopback checks never run", async () => {
    const app = createApp({} as NodeJS.ProcessEnv);
    const server = app.listen(0);
    const { port } = server.address() as { port: number };

    try {
      const res = await fetch(`http://127.0.0.1:${port}/investigations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      const raw = await res.text();
      expect(raw).not.toContain("ALLOW_SYNC_INVESTIGATIONS");
    } finally {
      server.close();
    }
  });

  test("when enabled, loopback requests get body validation instead of a 404", async () => {
    const app = createApp({
      NODE_ENV: "development",
      ALLOW_SYNC_INVESTIGATIONS: "true",
    } as NodeJS.ProcessEnv);
    const server = app.listen(0);
    const { port } = server.address() as { port: number };

    try {
      // Loopback client: reaches validation (400), not the 404/403 gates.
      const res = await fetch(`http://127.0.0.1:${port}/investigations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonsense: true }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

// --- 1.3 Public replay upload policy ------------------------------------------

describe("public replay upload policy", () => {
  test("defaults to disabled, and invalid modes fail closed", () => {
    expect(resolvePublicReplayUploadPolicy({}).mode).toBe("disabled");
    expect(
      resolvePublicReplayUploadPolicy({ SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE: "enabled" }).mode,
    ).toBe("disabled");
    expect(
      resolvePublicReplayUploadPolicy({ SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE: "ALLOWLIST" }).mode,
    ).toBe("disabled");
    expect(
      resolvePublicReplayUploadPolicy({ SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE: "allowlist" }).mode,
    ).toBe("allowlist");
  });

  test("disabled mode never allows an upload, allowlisted or not", () => {
    const policy = resolvePublicReplayUploadPolicy({
      SHERLOCK_PUBLIC_REPLAY_ALLOWLIST: "octo/app",
    });
    expect(isPublicReplayUploadAllowed(policy, "octo", "app")).toBe(false);
  });

  test("allowlist mode requires an exact, case-insensitive owner/repo match", () => {
    const policy = resolvePublicReplayUploadPolicy({
      SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE: "allowlist",
      SHERLOCK_PUBLIC_REPLAY_ALLOWLIST: " Octo/App , demo-org/demo.repo ",
    });

    expect(isPublicReplayUploadAllowed(policy, "octo", "app")).toBe(true);
    expect(isPublicReplayUploadAllowed(policy, "OCTO", "APP")).toBe(true);
    expect(isPublicReplayUploadAllowed(policy, "demo-org", "demo.repo")).toBe(true);
    expect(isPublicReplayUploadAllowed(policy, "octo", "other")).toBe(false);
    expect(isPublicReplayUploadAllowed(policy, "other", "app")).toBe(false);
  });

  test("no wildcard matching of any kind", () => {
    const policy = resolvePublicReplayUploadPolicy({
      SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE: "allowlist",
      SHERLOCK_PUBLIC_REPLAY_ALLOWLIST: "octo/*,*/app,*/*",
    });

    // Malformed (wildcard) entries are dropped entirely.
    expect(policy.allowlist.size).toBe(0);
    expect(isPublicReplayUploadAllowed(policy, "octo", "anything")).toBe(false);
    expect(isPublicReplayUploadAllowed(policy, "*", "*")).toBe(false);
  });

  test("missing repository identity never uploads", () => {
    const policy = resolvePublicReplayUploadPolicy({
      SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE: "allowlist",
      SHERLOCK_PUBLIC_REPLAY_ALLOWLIST: "octo/app",
    });

    expect(isPublicReplayUploadAllowed(policy, null, null)).toBe(false);
    expect(isPublicReplayUploadAllowed(policy, "octo", null)).toBe(false);
    expect(isPublicReplayUploadAllowed(policy, undefined, "app")).toBe(false);
  });

  test("repository identity normalization is conservative", () => {
    expect(normalizeRepositoryIdentity("Octo", "App")).toBe("octo/app");
    expect(normalizeRepositoryIdentity("octo", "a/b")).toBeNull();
    expect(normalizeRepositoryIdentity("../x", "app")).toBeNull();
    expect(normalizeRepositoryIdentity("", "app")).toBeNull();
    expect(normalizeRepositoryIdentity("octo", "")).toBeNull();
  });
});
