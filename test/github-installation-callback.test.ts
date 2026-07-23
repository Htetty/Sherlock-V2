// GET /api/github/installations/callback: state-nonce consumption, GitHub
// App verification, the ownership policy (personal account match /
// organization webhook sender), callback↔webhook ordering, and safe
// redirects. The router is exercised directly with injected fakes so the
// bounded webhook wait is controllable.
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createInstallationCallbackRouter,
  resolveFrontendBaseUrl,
  type InstallationCallbackDeps,
} from "../backend/routes/github-installation-callback.js";
import {
  applyInstallationCreated,
  hashInstallationNonce,
  type InstallationSnapshot,
} from "../backend/services/github-installations.js";
import {
  createInMemoryInstallationDataStore,
  createInMemoryProfileStore,
  makeSnapshot,
} from "./product-api-helpers.js";

const FRONTEND = "http://localhost:3000";
const ONBOARDING = `${FRONTEND}/onboarding`;
const SUCCESS = `${FRONTEND}/dashboard?installation=success`;
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// 43-char base64url state like the real generator produces.
const RAW_STATE = "s".repeat(43);

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  vi.restoreAllMocks();
});

type Harness = {
  baseUrl: string;
  store: ReturnType<typeof createInMemoryInstallationDataStore>;
  profiles: ReturnType<typeof createInMemoryProfileStore>;
};

async function bootCallback(
  options: {
    snapshot?: InstallationSnapshot;
    fetchInstallation?: InstallationCallbackDeps["fetchInstallation"];
    fetchInstallationRepositories?: InstallationCallbackDeps["fetchInstallationRepositories"];
    sleep?: (ms: number) => Promise<void>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Harness> {
  const store = createInMemoryInstallationDataStore();
  const profiles = createInMemoryProfileStore();
  const snapshot = options.snapshot ?? makeSnapshot();

  const app = express();
  app.use(
    "/api/github/installations/callback",
    createInstallationCallbackRouter({
      getStore: async () => store,
      getProfiles: async () => profiles,
      fetchInstallation:
        options.fetchInstallation ?? (async () => ({ ...snapshot })),
      fetchInstallationRepositories: options.fetchInstallationRepositories,
      env: options.env ?? ({ SHERLOCK_FRONTEND_URL: FRONTEND } as NodeJS.ProcessEnv),
      sleep: options.sleep ?? (async () => {}),
      webhookWaitAttempts: 2,
      webhookWaitDelayMs: 1,
      log: () => {},
    }),
  );

  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const { port } = server!.address() as AddressInfo;

  return { baseUrl: `http://127.0.0.1:${port}`, store, profiles };
}

async function seedProfileAndNonce(
  harness: Harness,
  githubUserId: string,
  rawState = RAW_STATE,
  expiresInMs = 15 * 60 * 1000,
) {
  await harness.profiles.upsert({
    id: USER_ID,
    githubUserId,
    githubLogin: "octo-dev",
    avatarUrl: null,
  });
  await harness.store.insertNonce({
    nonceHash: hashInstallationNonce(rawState),
    userId: USER_ID,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });
}

function callbackUrl(
  baseUrl: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(`${baseUrl}/api/github/installations/callback`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

async function invoke(baseUrl: string, params: Record<string, string | undefined>) {
  const res = await fetch(callbackUrl(baseUrl, params), { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") };
}

const VALID_PARAMS = {
  state: RAW_STATE,
  installation_id: "987654321",
  setup_action: "install",
};

describe("frontend base URL validation", () => {
  test("accepts https and dev-localhost http; rejects everything unsafe", () => {
    expect(resolveFrontendBaseUrl({ SHERLOCK_FRONTEND_URL: "https://getsherlock.dev" }))
      .toBe("https://getsherlock.dev");
    expect(resolveFrontendBaseUrl({ SHERLOCK_FRONTEND_URL: "http://localhost:3000" }))
      .toBe("http://localhost:3000");
    expect(
      resolveFrontendBaseUrl({
        NODE_ENV: "production",
        SHERLOCK_FRONTEND_URL: "http://localhost:3000",
      }),
    ).toBeNull();
    expect(resolveFrontendBaseUrl({ SHERLOCK_FRONTEND_URL: "http://evil.com" })).toBeNull();
    expect(
      resolveFrontendBaseUrl({ SHERLOCK_FRONTEND_URL: "https://a:b@getsherlock.dev" }),
    ).toBeNull();
    expect(
      resolveFrontendBaseUrl({ SHERLOCK_FRONTEND_URL: "https://getsherlock.dev?q=1" }),
    ).toBeNull();
    expect(
      resolveFrontendBaseUrl({ SHERLOCK_FRONTEND_URL: "https://getsherlock.dev#f" }),
    ).toBeNull();
    expect(resolveFrontendBaseUrl({ SHERLOCK_FRONTEND_URL: "not a url" })).toBeNull();
    expect(resolveFrontendBaseUrl({})).toBeNull();
  });
});

describe("callback validation", () => {
  test("missing state → onboarding redirect, nothing consumed", async () => {
    const harness = await bootCallback();
    await seedProfileAndNonce(harness, "123456789");

    const { status, location } = await invoke(harness.baseUrl, {
      installation_id: "987654321",
      setup_action: "install",
    });

    expect(status).toBe(302);
    expect(location).toBe(ONBOARDING);
    expect(harness.store.snapshotNonces()[0].consumedAt).toBeNull();
  });

  test.each(["short", "has spaces", "bad$chars", "x".repeat(500)])(
    "invalid state format %j → onboarding",
    async (state) => {
      const harness = await bootCallback();
      const { location } = await invoke(harness.baseUrl, {
        ...VALID_PARAMS,
        state,
      });
      expect(location).toBe(ONBOARDING);
    },
  );

  test("unknown state → onboarding", async () => {
    const harness = await bootCallback();
    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);
    expect(location).toBe(ONBOARDING);
  });

  test("expired state → onboarding and marked expired", async () => {
    const harness = await bootCallback();
    await seedProfileAndNonce(harness, "123456789", RAW_STATE, -1000);

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(ONBOARDING);
    expect(harness.store.snapshotNonces()[0].claimStatus).toBe("expired");
    expect(harness.store.snapshotMemberships()).toEqual([]);
  });

  test("superseded state → onboarding, no membership", async () => {
    const harness = await bootCallback();
    await seedProfileAndNonce(harness, "123456789");
    await harness.store.supersedeUnclaimedNonces(USER_ID);

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(ONBOARDING);
    expect(harness.store.snapshotMemberships()).toEqual([]);
  });

  test("malformed installation id → onboarding, nonce rejected", async () => {
    const harness = await bootCallback();
    await seedProfileAndNonce(harness, "123456789");

    const { location } = await invoke(harness.baseUrl, {
      ...VALID_PARAMS,
      installation_id: "12abc",
    });

    expect(location).toBe(ONBOARDING);
    expect(harness.store.snapshotNonces()[0].claimStatus).toBe("rejected");
  });

  test("unsupported setup_action → onboarding, nonce spent", async () => {
    const harness = await bootCallback();
    await seedProfileAndNonce(harness, "123456789");

    const { location } = await invoke(harness.baseUrl, {
      ...VALID_PARAMS,
      setup_action: "request",
    });

    expect(location).toBe(ONBOARDING);
    const nonce = harness.store.snapshotNonces()[0];
    expect(nonce.consumedAt).not.toBeNull();
    expect(nonce.claimStatus).toBe("rejected");
  });

  test("GitHub App lookup failure → onboarding, no membership", async () => {
    const harness = await bootCallback({
      fetchInstallation: async () => {
        throw new Error("boom");
      },
    });
    await seedProfileAndNonce(harness, "123456789");

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(ONBOARDING);
    expect(harness.store.snapshotMemberships()).toEqual([]);
  });

  test("callback installation id mismatch with GitHub's answer → onboarding", async () => {
    const harness = await bootCallback({
      snapshot: makeSnapshot({ installationId: "111" }),
    });
    await seedProfileAndNonce(harness, "123456789");

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(ONBOARDING);
    expect(harness.store.snapshotMemberships()).toEqual([]);
  });
});

describe("personal-account ownership", () => {
  test("account id match → membership + success redirect", async () => {
    const harness = await bootCallback({
      snapshot: makeSnapshot({
        installationId: "987654321",
        accountType: "User",
        accountId: "123456789",
        accountLogin: "octo-dev",
      }),
    });
    await seedProfileAndNonce(harness, "123456789");

    const { status, location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(status).toBe(302);
    expect(location).toBe(SUCCESS);
    expect(harness.store.snapshotMemberships()).toEqual([
      {
        userId: USER_ID,
        installationId: "987654321",
        relationship: "installer",
        verificationMethod: "personal_account_match",
      },
    ]);
    expect(harness.store.snapshotNonces()[0].claimStatus).toBe("verified");
  });

  test("a verified callback reconciles the authoritative repository selection", async () => {
    const harness = await bootCallback({
      snapshot: makeSnapshot({
        accountType: "User",
        accountId: "123456789",
      }),
      fetchInstallationRepositories: async () => [
        {
          repositoryId: "88",
          ownerLogin: "octo-dev",
          name: "dashboard",
          fullName: "octo-dev/dashboard",
          private: true,
        },
      ],
    });
    await seedProfileAndNonce(harness, "123456789");

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(SUCCESS);
    expect(harness.store.snapshotRepositories()).toMatchObject([
      {
        installationId: "987654321",
        repositoryId: "88",
        status: "active",
      },
    ]);
  });

  test("account id mismatch → rejected, no membership", async () => {
    const harness = await bootCallback({
      snapshot: makeSnapshot({
        installationId: "987654321",
        accountType: "User",
        accountId: "999999999",
      }),
    });
    await seedProfileAndNonce(harness, "123456789");

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(ONBOARDING);
    expect(harness.store.snapshotMemberships()).toEqual([]);
    expect(harness.store.snapshotNonces()[0].claimStatus).toBe("rejected");
  });
});

describe("organization ownership (webhook sender)", () => {
  const orgSnapshot = () =>
    makeSnapshot({
      installationId: "987654321",
      accountType: "Organization",
      accountId: "42424242",
      accountLogin: "SherlockHQ",
    });

  test("webhook before callback: matching sender → success", async () => {
    const harness = await bootCallback({ snapshot: orgSnapshot() });
    await seedProfileAndNonce(harness, "123456789");

    // installation.created already processed with sender = the user.
    await applyInstallationCreated(
      { store: harness.store, profiles: harness.profiles },
      {
        snapshot: orgSnapshot(),
        senderGithubUserId: "123456789",
        repositories: [],
        eventAt: new Date().toISOString(),
      },
    );

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(SUCCESS);
    expect(harness.store.snapshotMemberships()).toEqual([
      {
        userId: USER_ID,
        installationId: "987654321",
        relationship: "installer",
        verificationMethod: "installation_webhook_sender",
      },
    ]);
  });

  test("webhook before callback: sender mismatch → rejected", async () => {
    const harness = await bootCallback({ snapshot: orgSnapshot() });
    await seedProfileAndNonce(harness, "123456789");

    await applyInstallationCreated(
      { store: harness.store, profiles: harness.profiles },
      {
        snapshot: orgSnapshot(),
        senderGithubUserId: "555555555",
        repositories: [],
        eventAt: new Date().toISOString(),
      },
    );

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(ONBOARDING);
    expect(harness.store.snapshotMemberships()).toEqual([]);
    expect(harness.store.snapshotNonces()[0].claimStatus).toBe("rejected");
  });

  test("callback before webhook: webhook arrives during the bounded wait → success", async () => {
    let delivered = false;
    let harnessRef: Harness | undefined;
    const harness = await bootCallback({
      snapshot: orgSnapshot(),
      sleep: async () => {
        if (!delivered && harnessRef) {
          delivered = true;
          await applyInstallationCreated(
            { store: harnessRef.store, profiles: harnessRef.profiles },
            {
              snapshot: orgSnapshot(),
              senderGithubUserId: "123456789",
              repositories: [],
              eventAt: new Date().toISOString(),
            },
          );
        }
      },
    });
    harnessRef = harness;
    await seedProfileAndNonce(harness, "123456789");

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(SUCCESS);
    expect(harness.store.snapshotMemberships()).toHaveLength(1);
    expect(harness.store.snapshotNonces()[0].claimStatus).toBe("verified");
  });

  test("callback before webhook: webhook never arrives → onboarding with a pending claim, then the late webhook reconciles it", async () => {
    const harness = await bootCallback({ snapshot: orgSnapshot() });
    await seedProfileAndNonce(harness, "123456789");

    const { location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(location).toBe(ONBOARDING);
    const pending = harness.store.snapshotNonces()[0];
    expect(pending.claimStatus).toBe("pending_webhook");
    expect(pending.installationId).toBe("987654321");
    expect(harness.store.snapshotMemberships()).toEqual([]);

    // The webhook lands later and reconciles the pending claim.
    await applyInstallationCreated(
      { store: harness.store, profiles: harness.profiles },
      {
        snapshot: orgSnapshot(),
        senderGithubUserId: "123456789",
        repositories: [],
        eventAt: new Date().toISOString(),
      },
    );

    expect(harness.store.snapshotNonces()[0].claimStatus).toBe("verified");
    expect(harness.store.snapshotMemberships()).toEqual([
      {
        userId: USER_ID,
        installationId: "987654321",
        relationship: "installer",
        verificationMethod: "installation_webhook_sender",
      },
    ]);
  });
});

describe("replay and redirect safety", () => {
  test("a consumed state cannot be replayed", async () => {
    const harness = await bootCallback({
      snapshot: makeSnapshot({
        accountType: "User",
        accountId: "123456789",
      }),
    });
    await seedProfileAndNonce(harness, "123456789");

    const first = await invoke(harness.baseUrl, VALID_PARAMS);
    expect(first.location).toBe(SUCCESS);

    const replay = await invoke(harness.baseUrl, VALID_PARAMS);
    expect(replay.location).toBe(ONBOARDING);

    // Still exactly one membership.
    expect(harness.store.snapshotMemberships()).toHaveLength(1);
  });

  test("redirects never carry state, ids, or error details", async () => {
    const harness = await bootCallback({
      fetchInstallation: async () => {
        throw new Error("secret-github-error installation 987654321");
      },
    });
    await seedProfileAndNonce(harness, "123456789");

    const success = await invoke(harness.baseUrl, VALID_PARAMS);

    for (const location of [success.location]) {
      expect(location).toBe(ONBOARDING);
      expect(location).not.toContain(RAW_STATE);
      expect(location).not.toContain("987654321");
      expect(location).not.toContain(USER_ID);
      expect(location).not.toContain("secret-github-error");
    }
  });

  test("a missing/invalid frontend URL cannot redirect anywhere", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await bootCallback({ env: {} as NodeJS.ProcessEnv });

    const { status, location } = await invoke(harness.baseUrl, VALID_PARAMS);

    expect(status).toBe(500);
    expect(location).toBeNull();
  });
});
