// Regression tests for the sandbox port-collision bug: a target application's
// own (often misleading) startup log was previously trusted over the actual
// port Sherlock allocated and injected via PORT, which could collide with
// Probot's port 3000 and silently redirect reproduction to the wrong server.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  runSandboxInvestigation,
  type DockerAdapter,
} from "../backend/services/sandbox.js";

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

// Apps like the live "Taskboard" repo ignore the injected PORT entirely and
// hardcode their own port. They must be exposed through Docker port mapping
// on a safe dynamic host port — never run directly on the host, where their
// fixed port could collide with Probot (3000) or the backend (4000).
const HARDCODED_3000_SERVER = `
  const http = require("http");
  console.log("Taskboard running on http://localhost:3000");
  const server = http.createServer((req, res) => res.end("taskboard"));
  server.on("error", () => {});
  server.listen(3000);
`;

const dockerUnavailable: DockerAdapter = {
  isAvailable: async () => false,
  spawnContainer: () => {
    throw new Error("spawnContainer must not be called when Docker is unavailable");
  },
  removeContainer: async () => {},
};

describe("fixed-port sandbox fallback", () => {
  test(
    "an app honoring PORT runs directly on the allocated port without Docker",
    { timeout: 30_000 },
    async () => {
      const repoPath = await createFixture(`
        const http = require("http");
        http.createServer((req, res) => res.end("honors-port")).listen(process.env.PORT);
      `);

      const session = await runSandboxInvestigation({
        repoPath,
        docker: dockerUnavailable,
      });

      try {
        expect(session.result.strategy).toBe("direct");
        expect(session.result.internalPort).toBeNull();

        const port = Number(new URL(session.result.baseUrl).port);
        expect(port).not.toBe(3000);
        expect(port).not.toBe(4000);

        const response = await fetch(session.result.baseUrl);
        expect(await response.text()).toBe("honors-port");
      } finally {
        await session.stop();
      }
    },
  );

  test(
    "an app hardcoded to internal port 3000 is exposed through a dynamic host port via container mapping",
    { timeout: 30_000 },
    async () => {
      const repoPath = await createFixture(HARDCODED_3000_SERVER);
      const containerRuns: string[][] = [];

      // Simulates `docker run -p <host>:<internal>`: parses the requested
      // mapping and serves on the host port like a mapped container would.
      const fakeDocker: DockerAdapter = {
        isAvailable: async () => true,
        spawnContainer: (args) => {
          containerRuns.push(args);
          const mapping = args[args.indexOf("-p") + 1];
          const hostPort = Number(mapping.split(":")[0]);

          return spawn(process.execPath, [
            "-e",
            `require("http").createServer((req, res) => res.end("containerized")).listen(${hostPort});`,
          ]);
        },
        removeContainer: async () => {},
      };

      const session = await runSandboxInvestigation({
        repoPath,
        startupTimeoutMs: 4_000,
        docker: fakeDocker,
      });

      try {
        expect(session.result.strategy).toBe("docker-fixed-port");
        expect(session.result.internalPort).toBe(3000);

        // Base URL stays on the allocated dynamic host port, not the logged 3000.
        const hostPort = Number(new URL(session.result.baseUrl).port);
        expect(hostPort).not.toBe(3000);
        expect(hostPort).not.toBe(4000);
        expect(session.result.hostPort).toBe(hostPort);

        // The container was asked for exactly <allocated-host-port>:3000.
        expect(containerRuns).toHaveLength(1);
        const mapping = containerRuns[0][containerRuns[0].indexOf("-p") + 1];
        expect(mapping).toBe(`${hostPort}:3000`);

        expect(session.result.command).toContain(`-p ${hostPort}:3000`);
        expect(session.result.command).toContain("<workspace>");
        expect(session.result.command).not.toContain(repoPath);

        const response = await fetch(session.result.baseUrl);
        expect(await response.text()).toBe("containerized");
      } finally {
        await session.stop();
      }
    },
  );

  test(
    "a hardcoded-port app fails with a clear reason when Docker is unavailable",
    { timeout: 30_000 },
    async () => {
      const repoPath = await createFixture(HARDCODED_3000_SERVER);
      let caught: Error | null = null;

      try {
        await runSandboxInvestigation({
          repoPath,
          startupTimeoutMs: 2_000,
          docker: dockerUnavailable,
        });
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).toMatch(/did not become reachable/);
      expect(caught?.message).toMatch(/fixed internal port 3000/);
      expect(caught?.message).toMatch(/Docker is not available/);
    },
  );
});
