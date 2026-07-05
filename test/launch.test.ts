// Framework-aware sandbox launch adapters: Vite and Next.js require CLI
// flags for their port (they don't read PORT), while a generic Node/Express
// app conventionally does. Getting the wrong one means the target app never
// binds to Sherlock's allocated port and never becomes reachable.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildLaunchConfig } from "../backend/services/launch.js";
import { runSandboxInvestigation } from "../backend/services/sandbox.js";

async function createFixture(packageJson: Record<string, unknown>) {
  const repoPath = await mkdtemp(path.join(tmpdir(), "sherlock-launch-"));

  await writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify(packageJson),
    "utf8",
  );

  return repoPath;
}

describe("framework-aware launch configuration", () => {
  test("a Vite app receives the dynamic --host and --port arguments", async () => {
    const repoPath = await createFixture({
      name: "vite-fixture",
      scripts: { dev: "vite", build: "vite build" },
      devDependencies: { vite: "^5.0.0" },
    });

    const launch = await buildLaunchConfig(repoPath, 51234);

    expect(launch.framework).toBe("vite");
    expect(launch.command).toBe("npm");
    expect(launch.args).toEqual([
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "51234",
    ]);
    expect(launch.env).toEqual({});
    expect(launch.baseUrl).toBe("http://localhost:51234");

    // Falls back to "start" when no "dev" script exists.
    const startOnly = await buildLaunchConfig(
      await createFixture({
        scripts: { start: "vite preview" },
        dependencies: { vite: "^5.0.0" },
      }),
      51240,
    );
    expect(startOnly.args).toEqual([
      "start",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "51240",
    ]);
  });

  test("a Next.js app receives the dynamic -p argument", async () => {
    const repoPath = await createFixture({
      name: "next-fixture",
      scripts: { dev: "next dev", start: "next start" },
      dependencies: { next: "^14.0.0", react: "^18.0.0" },
    });

    const launch = await buildLaunchConfig(repoPath, 51235);

    expect(launch.framework).toBe("nextjs");
    expect(launch.args).toEqual(["run", "dev", "--", "-p", "51235"]);
    expect(launch.env).toEqual({});
  });

  test("a generic Node application receives the PORT environment variable", async () => {
    const repoPath = await createFixture({
      name: "node-fixture",
      scripts: { start: "node server.js" },
      dependencies: { express: "^4.18.0" },
    });

    const launch = await buildLaunchConfig(repoPath, 51236);

    expect(launch.framework).toBe("node");
    expect(launch.command).toBe("npm");
    expect(launch.args).toEqual(["start"]);
    expect(launch.env).toEqual({ PORT: "51236" });
    expect(launch.baseUrl).toBe("http://localhost:51236");
  });

  test(
    "an application that ignores the selected port returns an environment failure with the attempted command",
    { timeout: 15_000 },
    async () => {
      const repoPath = await createFixture({
        name: "stubborn-fixture",
        scripts: { start: "node server.js" },
      });
      await writeFile(
        path.join(repoPath, "server.js"),
        `
          const http = require("http");
          // Ignores process.env.PORT entirely.
          http.createServer((req, res) => res.end("wrong-port")).listen(59999);
        `,
        "utf8",
      );

      let caught: Error | null = null;

      try {
        await runSandboxInvestigation({ repoPath, startupTimeoutMs: 2_000 });
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).toMatch(/did not become reachable/);
      expect(caught?.message).toMatch(/Attempted command: PORT=\d+ npm start/);
      expect(caught?.message).toContain("stdout (tail)");
    },
  );
});
