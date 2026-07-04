// Regression tests for the sandbox port-collision bug: a target application's
// own (often misleading) startup log was previously trusted over the actual
// port Sherlock allocated and injected via PORT, which could collide with
// Probot's port 3000 and silently redirect reproduction to the wrong server.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runSandboxInvestigation } from "../backend/services/sandbox.js";

async function createFixture(serverJs: string) {
  const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-sandbox-"));

  await writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "sandbox-fixture",
      version: "1.0.0",
      scripts: { start: "node server.js" },
    }),
    "utf8",
  );
  await writeFile(path.join(repoPath, "server.js"), serverJs, "utf8");

  return repoPath;
}

describe("sandbox port allocation", () => {
  test(
    "never allocates Probot's port 3000 or the backend's port 4000",
    { timeout: 30_000 },
    async () => {
      const repoPath = await createFixture(`
        const http = require("http");
        const port = process.env.PORT;
        http.createServer((req, res) => res.end("ok")).listen(port, () => {
          console.log("listening on " + port);
        });
      `);

      const session = await runSandboxInvestigation({ repoPath });

      try {
        const port = Number(new URL(session.result.baseUrl).port);
        expect(port).not.toBe(3000);
        expect(port).not.toBe(4000);
      } finally {
        await session.stop();
      }
    },
  );

  test(
    "reports the actual allocated base URL even when the app logs a misleading port",
    { timeout: 30_000 },
    async () => {
      // Reproduces the original bug: the app's boilerplate log always
      // mentions port 3000 regardless of the port it actually bound to.
      const repoPath = await createFixture(`
        const http = require("http");
        const port = process.env.PORT;
        console.log("Server listening on http://localhost:3000");
        http.createServer((req, res) => res.end("real-target-app")).listen(port);
      `);

      const session = await runSandboxInvestigation({ repoPath });

      try {
        expect(new URL(session.result.baseUrl).port).not.toBe("3000");

        const response = await fetch(session.result.baseUrl);
        expect(await response.text()).toBe("real-target-app");
      } finally {
        await session.stop();
      }
    },
  );

  test(
    "throws instead of reporting success when the app ignores its allocated port",
    { timeout: 15_000 },
    async () => {
      // Binds a hardcoded port instead of process.env.PORT, so Sherlock's
      // allocated port never becomes reachable.
      const repoPath = await createFixture(`
        const http = require("http");
        http.createServer((req, res) => res.end("wrong-port")).listen(59999);
      `);

      await expect(
        runSandboxInvestigation({ repoPath, startupTimeoutMs: 2_000 }),
      ).rejects.toThrow(/did not become reachable/);
    },
  );
});
