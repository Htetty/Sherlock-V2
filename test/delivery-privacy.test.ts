import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildDeliveryState,
  createFileDeliveryStateStore,
  type DeliveryFile,
  type PullRequestRetryPayload,
} from "../backend/services/delivery.js";

const INV = "inv_0PRIVATEPAY1";
const FIX = "fix_0PRIVATEFIX1";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "sherlock-private-"));
  roots.push(value);
  return value;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function pendingState(
  artifacts: string,
  files: DeliveryFile[],
) {
  const store = createFileDeliveryStateStore(artifacts);
  const retryPayload: PullRequestRetryPayload = {
    version: 1,
    investigationId: INV,
    title: "Sherlock verified delivery",
    body: "Protected pull request body",
    commitMessage: `fix: protected delivery\n\nSherlock-Investigation: ${INV}\nSherlock-Fix-Attempt: ${FIX}`,
    files,
  };
  const payload = await store.persistPayload(INV, "retry", retryPayload);
  const state = await buildDeliveryState(
    {
      investigationId: INV,
      tenantId: "tenant-gh-2",
      installationId: 2,
      repoOwner: "acme",
      repoName: "app",
      issueNumber: 42,
      issueTitle: "private customer issue",
      outcome: "verified_fix",
      summary: { investigationId: INV, outcome: "verified_fix" },
      fixVerified: true,
      fixAttemptId: FIX,
      analysisComment: "protected analysis",
      fixComment: "protected fix report",
      pullRequest: {
        status: "push_failed",
        key: "safe-key",
        owner: "acme",
        repo: "app",
        remote: "origin",
        branch: "sherlock/fix-42-private",
        baseBranch: "main",
        commitSha: null,
        sourceCommit: "c0ffee123",
        pullRequestNumber: null,
        pullRequestUrl: null,
        reason: "network unavailable",
        startedAt: new Date(0).toISOString(),
        createdAt: new Date(0).toISOString(),
      },
      retryPlan: {
        branch: "sherlock/fix-42-private",
        sourceCommit: "c0ffee123",
        baseBranch: "main",
        expectedTreeSha: "deadbeef1",
        files: files.map((file) => ({
          path: file.path,
          mode: file.mode,
          contentSha256:
            file.contents === null ? null : digest(file.contents),
        })),
        payload,
      },
    },
    store,
  );
  await store.save(state);
  return { store, state, payload };
}

describe("credential-free delivery state", () => {
  test("source and multiple credential forms stay only in protected raw artifacts", async () => {
    const artifacts = await root();
    const privateSource = [
      '{"github_token":"github_pat_CUSTOMERSECRET123456"}',
      "anthropic_api_key: sk-ant-CUSTOMERSECRET123456",
      "Authorization: Bearer header-secret-123456",
      "unchanged = 'ghp_TOKENONUNCHANGEDLINE123456'",
      "-----BEGIN PRIVATE KEY-----",
      "multiline-private-material",
      "-----END PRIVATE KEY-----",
      "export function ordinarySource() { return 42; }",
    ].join("\n");
    const fixture = await pendingState(artifacts, [
      { path: "src/server.ts", contents: privateSource, mode: "100644" },
    ]);
    const stateJson = await readFile(
      path.join(artifacts, INV, "delivery-state.json"),
      "utf8",
    );

    for (const marker of [
      "github_pat_",
      "sk-ant-",
      "Authorization: Bearer",
      "ghp_",
      "BEGIN PRIVATE KEY",
      "ordinarySource",
      "contents",
    ]) {
      expect(stateJson).not.toContain(marker);
    }
    expect(stateJson.length).toBeLessThan(16_000);

    const protectedPayload = JSON.stringify(
      await fixture.store.loadPayload(INV, fixture.payload),
    );
    expect(protectedPayload).toContain("ordinarySource");
    expect(protectedPayload).toContain("BEGIN PRIVATE KEY");
  });

  test("artifact references reject traversal and symlink escapes", async () => {
    const artifacts = await root();
    const fixture = await pendingState(artifacts, [
      { path: "src/server.ts", contents: "export const ok = true;\n", mode: "100644" },
    ]);

    await expect(
      fixture.store.loadPayload(INV, {
        path: "protected-delivery/../outside.json",
        sha256: "a".repeat(64),
        sizeBytes: 10,
      }),
    ).rejects.toThrow(/unsafe/i);

    const outside = path.join(artifacts, "outside.json");
    await writeFile(outside, "{}\n", "utf8");
    const link = path.join(
      artifacts,
      INV,
      "protected-delivery",
      "terminal-link.json",
    );
    await symlink(outside, link);
    await expect(
      fixture.store.loadPayload(INV, {
        path: "protected-delivery/terminal-link.json",
        sha256: digest("{}\n"),
        sizeBytes: 3,
      }),
    ).rejects.toThrow(/unsafe|changed/i);
  });

  test("content-addressed artifacts are integrity checked before use", async () => {
    const artifacts = await root();
    const fixture = await pendingState(artifacts, [
      { path: "src/server.ts", contents: "export const ok = true;\n", mode: "100644" },
    ]);
    await writeFile(
      path.join(artifacts, INV, ...fixture.payload.path.split("/")),
      "tampered\n",
      "utf8",
    );
    await expect(
      fixture.store.loadPayload(INV, fixture.payload),
    ).rejects.toThrow(/integrity|changed/i);
  });
});
