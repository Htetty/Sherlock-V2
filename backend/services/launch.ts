// Framework-aware launch configuration for the sandbox.
//
// Different dev-server frameworks accept port configuration differently:
// Vite and Next.js ignore the PORT environment variable and require a CLI
// flag, while a generic Node/Express app conventionally reads PORT from its
// environment. Getting this wrong means the allocated port is never actually
// bound, and the target application never becomes reachable.

import { readFile } from "node:fs/promises";
import path from "node:path";

export type Framework = "vite" | "nextjs" | "node";

export type LaunchConfig = {
  framework: Framework;
  command: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  baseUrl: string;
};

// Scripts are tried in this order; the first one present in package.json
// wins. If neither exists, "start" is attempted anyway (matches the prior
// behavior of always running `npm start`) and npm's own error becomes part
// of the unreachable-sandbox diagnostics.
const PREFERRED_SCRIPTS = ["dev", "start"];

export async function buildLaunchConfig(
  repoPath: string,
  port: number,
): Promise<LaunchConfig> {
  const baseUrl = `http://localhost:${port}`;
  const pkg = await readPackageJson(repoPath);
  const scripts = pkg?.scripts ?? {};
  const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };

  if ("vite" in dependencies) {
    return {
      framework: "vite",
      command: "npm",
      args: buildNpmArgs(scripts, [
        // 0.0.0.0 because the app runs inside a container: it must bind all
        // interfaces for the (localhost-only) host port mapping to reach it.
        "--host",
        "0.0.0.0",
        "--port",
        String(port),
      ]),
      env: {},
      port,
      baseUrl,
    };
  }

  if ("next" in dependencies) {
    return {
      framework: "nextjs",
      command: "npm",
      args: buildNpmArgs(scripts, ["-p", String(port)]),
      env: {},
      port,
      baseUrl,
    };
  }

  return {
    framework: "node",
    command: "npm",
    args: ["start"],
    env: { PORT: String(port) },
    port,
    baseUrl,
  };
}

function buildNpmArgs(
  scripts: Record<string, string>,
  extraArgs: string[],
): string[] {
  const script =
    PREFERRED_SCRIPTS.find((name) => typeof scripts[name] === "string") ??
    "start";
  const base = script === "start" ? ["start"] : ["run", script];

  return [...base, "--", ...extraArgs];
}

async function readPackageJson(repoPath: string): Promise<{
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null> {
  try {
    const contents = await readFile(
      path.join(repoPath, "package.json"),
      "utf8",
    );

    return JSON.parse(contents) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

// A single-line, safe-to-log rendering of the launch command. Only ever
// includes Sherlock's own controlled config (command, args, the env vars it
// chose to set); it never includes the process's inherited environment, so
// it cannot leak secrets from the sandbox host.
export function formatSanitizedCommand(launch: LaunchConfig): string {
  const envPrefix = Object.entries(launch.env)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  return [envPrefix, launch.command, ...launch.args].filter(Boolean).join(" ");
}
