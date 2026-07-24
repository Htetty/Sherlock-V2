import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProductReadStore } from "../backend/services/product-read.js";
import {
  bootProductApi,
  createFakeAuthDeps,
  createInMemoryInstallationDataStore,
  createInMemoryProfileStore,
  makeGitHubUser,
  makeSnapshot,
  type BootedApp,
} from "./product-api-helpers.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const INV = "inv_01K123456789AB";

function investigationView() {
  return {
    id: INV,
    issueTitle: "Broken dashboard",
    status: "active" as const,
    error: null,
    updatedAt: "2026-07-23T00:00:00.000Z",
    version: 4,
    timeline: [
      {
        id: "open_preview" as const,
        label: "Open repository preview",
        status: "completed" as const,
        message: "Repository preview opened.",
        startedAt: "2026-07-23T00:00:00.000Z",
        finishedAt: "2026-07-23T00:00:01.000Z",
      },
    ],
    evidence: {
      before: { replay: { status: "pending" as const }, screenshots: [] },
      after: { replay: { status: "pending" as const }, screenshots: [] },
    },
    fix: null,
    pullRequest: null,
  };
}

describe("dashboard product API", () => {
  let booted: BootedApp;
  let store: ReturnType<typeof createInMemoryInstallationDataStore>;
  let productRead: ProductReadStore;
  const listIssues = vi.fn();

  beforeEach(async () => {
    store = createInMemoryInstallationDataStore();
    const profiles = createInMemoryProfileStore();
    await store.upsertInstallationSnapshot(makeSnapshot(), {
      eventAt: "2026-07-23T00:00:00.000Z",
    });
    await store.upsertMembership({
      userId: USER_A,
      installationId: "987654321",
      relationship: "installer",
      verificationMethod: "installation_webhook_sender",
    });
    await store.upsertInstallationRepositories(
      "987654321",
      [
        {
          repositoryId: "555",
          ownerLogin: "SherlockHQ",
          name: "sherlock",
          fullName: "SherlockHQ/sherlock",
          private: true,
        },
      ],
      "2026-07-23T00:00:00.000Z",
    );

    productRead = {
      findIssueInvestigation: async (input) =>
        input.userId === USER_A &&
        input.repositoryId === "555" &&
        input.issueNumber === 7
          ? {
              investigationId: INV,
              status: "active",
              statusUrl: `/investigations/${INV}`,
            }
          : null,
      getInvestigation: async (userId, investigationId) =>
        userId === USER_A && investigationId === INV
          ? investigationView()
          : null,
      getInvestigationDiff: async (userId, investigationId) =>
        userId === USER_A && investigationId === INV
          ? { diff: "diff --git a/a.ts b/a.ts\n", diffTruncated: false }
          : null,
    };
    listIssues.mockReset();
    listIssues.mockResolvedValue({
      issues: [
        {
          id: "700",
          number: 7,
          title: "Broken dashboard",
          body: "The page fails.",
          state: "open",
          htmlUrl: "https://github.com/SherlockHQ/sherlock/issues/7",
          author: { login: "octo", avatarUrl: null },
          labels: ["bug"],
          createdAt: "2026-07-22T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      ],
      hasNextPage: false,
    });

    booted = await bootProductApi(
      { NODE_ENV: "test" },
      {
        getAuthDeps: async () =>
          createFakeAuthDeps(
            {
              "token-a": makeGitHubUser({ id: USER_A }),
              "token-b": makeGitHubUser({
                id: USER_B,
                githubUserId: "987",
                login: "other",
              }),
            },
            profiles,
          ),
        getInstallationStore: async () => store,
        getProductReadStore: async () => productRead,
        listGitHubIssues: listIssues,
      },
    );
  });

  afterEach(async () => {
    await booted.close();
  });

  test("lists only repositories authorized through installation membership", async () => {
    const allowed = await fetch(`${booted.baseUrl}/api/repositories`, {
      headers: { Authorization: "Bearer token-a" },
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      repositories: [
        {
          id: "555",
          fullName: "SherlockHQ/sherlock",
          htmlUrl: "https://github.com/SherlockHQ/sherlock",
          private: true,
          ownerAvatarUrl: "https://avatars.githubusercontent.com/u/123456789",
          installationId: "987654321",
        },
      ],
    });

    const denied = await fetch(`${booted.baseUrl}/api/repositories`, {
      headers: { Authorization: "Bearer token-b" },
    });
    await expect(denied.json()).resolves.toEqual({ repositories: [] });
  });

  test("lists GitHub issues only after repository authorization", async () => {
    const response = await fetch(
      `${booted.baseUrl}/api/repositories/555/issues?state=all&page=2&perPage=30`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issues: Array<{ id: string; number: number }>;
      pagination: { page: number; hasNextPage: boolean };
    };
    expect(body.issues).toEqual([{ id: "700", number: 7 }].map((partial) =>
      expect.objectContaining(partial),
    ));
    expect(body.pagination).toMatchObject({ page: 2, hasNextPage: false });
    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "987654321",
        owner: "SherlockHQ",
        repository: "sherlock",
        state: "all",
        page: 2,
      }),
    );

    const denied = await fetch(
      `${booted.baseUrl}/api/repositories/555/issues`,
      { headers: { Authorization: "Bearer token-b" } },
    );
    expect(denied.status).toBe(404);
    expect(listIssues).toHaveBeenCalledTimes(1);
  });

  test("looks up the latest investigation for an authorized issue", async () => {
    const response = await fetch(
      `${booted.baseUrl}/api/repositories/555/issues/7/investigation`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      investigationId: INV,
      status: "active",
      statusUrl: `/investigations/${INV}`,
    });
  });

  test("returns a private ETag and hides cross-user investigations as 404", async () => {
    const response = await fetch(
      `${booted.baseUrl}/api/investigations/${INV}`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    const etag = response.headers.get("etag");
    expect(etag).toBe(`W/"investigation-${INV}-4"`);

    const unchanged = await fetch(
      `${booted.baseUrl}/api/investigations/${INV}`,
      {
        headers: {
          Authorization: "Bearer token-a",
          "If-None-Match": etag as string,
        },
      },
    );
    expect(unchanged.status).toBe(304);

    const denied = await fetch(
      `${booted.baseUrl}/api/investigations/${INV}`,
      { headers: { Authorization: "Bearer token-b" } },
    );
    expect(denied.status).toBe(404);
  });

  test("returns authorized exact diff data and rejects malformed ids", async () => {
    const response = await fetch(
      `${booted.baseUrl}/api/investigations/${INV}/diff`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      diff: "diff --git a/a.ts b/a.ts\n",
      diffTruncated: false,
    });

    const malformed = await fetch(
      `${booted.baseUrl}/api/investigations/not-an-id`,
      { headers: { Authorization: "Bearer token-a" } },
    );
    expect(malformed.status).toBe(404);
  });
});
