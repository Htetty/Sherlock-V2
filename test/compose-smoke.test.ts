// Compose smoke test: isolation (project/override/redis), boot-order gating,
// current-state worker checks, teardown reliability, and secret-safe output.
// The docker CLI, temp files, clock, and sleep are all injected — no real
// Docker host is touched.
import { describe, expect, test } from "vitest";
import {
  SMOKE_PROJECT,
  formatSmokeReport,
  parsePsJson,
  runComposeSmoke,
  smokeOverrideYaml,
  // @ts-expect-error plain .mjs script module without type declarations
} from "../scripts/compose-smoke.mjs";

const SECRET_IN_LOGS = "very-secret-worker-log-value-31c9";
const FAKE_OVERRIDE_PATH = "/tmp/fake-smoke-override.yml";

type CommandResult = { stdout: string; stderr: string };
type Call = { args: string[] };
type ServiceStatus = { state?: string; health?: string };

// Fake docker host: scripted responses per compose subcommand, a virtual
// clock advanced by sleep, and a call log for asserting order/isolation.
function fakeHost(overrides: {
  config?: () => void;
  up?: () => void;
  // per successive `ps` poll of a service (last entry repeats)
  psStatus?: Record<string, ServiceStatus[]>;
  exec?: (probe: string) => void;
  workerLogs?: string[]; // per successive `logs` poll (last repeats)
  down?: () => void;
} = {}) {
  const calls: Call[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const psPolls: Record<string, number> = {};
  let logPolls = 0;
  let clock = 0;

  const psStatus: Record<string, ServiceStatus[]> = {
    redis: [{ state: "running", health: "healthy" }],
    api: [{ state: "running", health: "healthy" }],
    worker: [{ state: "running", health: "" }],
    ...(overrides.psStatus ?? {}),
  };
  const workerLogs = overrides.workerLogs ?? [
    "PASS worker preflight: all mandatory checks passed.",
  ];

  const deps = {
    async runCommand(_command: string, args: string[]): Promise<CommandResult> {
      calls.push({ args });
      const sub = args[9]; // docker compose -p P --env-file E -f F -f OVERRIDE <sub>
      if (sub === "config") {
        overrides.config?.();
        return { stdout: "", stderr: "" };
      }
      if (sub === "up") {
        overrides.up?.();
        return { stdout: "", stderr: "" };
      }
      if (sub === "ps") {
        const service = args[args.length - 1];
        const seq = psStatus[service] ?? [{ state: "running", health: "healthy" }];
        const idx = Math.min(psPolls[service] ?? 0, seq.length - 1);
        psPolls[service] = (psPolls[service] ?? 0) + 1;
        const status = seq[idx];
        if (status.state === "absent") return { stdout: "", stderr: "" };
        return {
          stdout: JSON.stringify({
            Service: service,
            State: status.state ?? "running",
            Health: status.health ?? "",
          }),
          stderr: "",
        };
      }
      if (sub === "exec") {
        overrides.exec?.(args[args.length - 1]);
        return { stdout: "", stderr: "" };
      }
      if (sub === "logs") {
        const idx = Math.min(logPolls, workerLogs.length - 1);
        logPolls += 1;
        return { stdout: workerLogs[idx], stderr: "" };
      }
      if (sub === "down") {
        overrides.down?.();
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected compose subcommand: ${sub}`);
    },
    writeTempFile(content: string): string {
      written.push(content);
      return FAKE_OVERRIDE_PATH;
    },
    removeFile(path: string) {
      removed.push(path);
    },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  return { deps, calls, written, removed };
}

type Report = Awaited<ReturnType<typeof runComposeSmoke>>;

function statusOf(report: Report, name: string) {
  return report.checks.find((check: { name: string }) => check.name === name)?.status;
}

describe("compose smoke test", () => {
  test("healthy stack passes every check and reports the stop command", async () => {
    const { deps, calls } = fakeHost();
    const report = await runComposeSmoke("production", deps);

    expect(report.ok).toBe(true);
    for (const name of [
      "compose:config",
      "compose:up",
      "health:redis",
      "health:api",
      "api:healthz",
      "api:readyz",
      "worker:started",
    ]) {
      expect(statusOf(report, name)).toBe("pass");
    }
    expect(report.leftRunning).toBe(true);
    expect(report.stopCommand).toBe(
      `docker compose -p ${SMOKE_PROJECT} --env-file .env.production -f docker-compose.prod.yml down -v`,
    );
    const subs = calls.map((c) => c.args[9]);
    expect(subs.indexOf("config")).toBeLessThan(subs.indexOf("up"));
    expect(subs).not.toContain("down");
  });

  test("every compose call is isolated: smoke project name, env file, and the override file", async () => {
    const { deps, calls, written, removed } = fakeHost();
    await runComposeSmoke("production", deps);

    for (const call of calls) {
      expect(call.args.slice(0, 9)).toEqual([
        "compose",
        "-p",
        SMOKE_PROJECT,
        "--env-file",
        ".env.production",
        "-f",
        "docker-compose.prod.yml",
        "-f",
        FAKE_OVERRIDE_PATH,
      ]);
    }
    // the override neutralizes real traffic and real queues
    expect(written).toHaveLength(1);
    const override = written[0];
    expect(override).toContain("ports: !reset []");
    expect(override).toContain('WEBHOOK_PROXY_URL: ""');
    expect(override.match(/REDIS_URL: redis:\/\/redis:6379/g)).toHaveLength(2);
    // the fixed-name sandbox network is renamed so the smoke project never
    // collides with (or attaches to) the real stack's sherlock-sandbox
    expect(override).toContain("SHERLOCK_SANDBOX_NETWORK: sherlock-smoke-sandbox");
    expect(override).toContain("name: sherlock-smoke-sandbox");
    expect(smokeOverrideYaml()).toBe(override);
    // temp override is cleaned up
    expect(removed).toEqual([FAKE_OVERRIDE_PATH]);
  });

  test("staging uses .env.staging", async () => {
    const { deps, calls } = fakeHost();
    await runComposeSmoke("staging", deps);
    expect(calls[0].args[4]).toBe(".env.staging");
  });

  test("config failure aborts before up, skips everything, and needs no teardown", async () => {
    const { deps, calls } = fakeHost({
      config: () => {
        throw new Error("bad interpolation");
      },
    });
    const report = await runComposeSmoke("production", deps, { down: true });
    expect(report.ok).toBe(false);
    expect(statusOf(report, "compose:config")).toBe("fail");
    expect(statusOf(report, "compose:up")).toBe("skip");
    expect(statusOf(report, "worker:started")).toBe("skip");
    expect(report.leftRunning).toBe(false);
    const subs = calls.map((c) => c.args[9]);
    expect(subs).not.toContain("up");
    expect(subs).not.toContain("down");
  });

  test("up failure skips the health checks", async () => {
    const { deps } = fakeHost({
      up: () => {
        throw new Error("build failed");
      },
    });
    const report = await runComposeSmoke("production", deps);
    expect(report.ok).toBe(false);
    expect(statusOf(report, "compose:up")).toBe("fail");
    expect(statusOf(report, "health:redis")).toBe("skip");
    expect(statusOf(report, "api:healthz")).toBe("skip");
  });

  test("--down still tears down after a partial up failure", async () => {
    const { deps, calls } = fakeHost({
      up: () => {
        throw new Error("api built, worker build failed");
      },
    });
    const report = await runComposeSmoke("production", deps, { down: true });
    expect(report.ok).toBe(false);
    expect(statusOf(report, "compose:up")).toBe("fail");
    expect(statusOf(report, "compose:down")).toBe("pass");
    expect(report.leftRunning).toBe(false);
    expect(calls.map((c) => c.args[9])).toContain("down");
  });

  test("a failed --down teardown is a blocker (nonzero) and keeps the stop hint", async () => {
    const { deps } = fakeHost({
      down: () => {
        throw new Error("cannot remove container");
      },
    });
    const report = await runComposeSmoke("production", deps, { down: true });
    expect(report.ok).toBe(false); // exit nonzero
    expect(statusOf(report, "compose:down")).toBe("fail");
    expect(report.leftRunning).toBe(true);
    const output = formatSmokeReport("production", report);
    expect(output).toContain(`Stop them with: ${report.stopCommand}`);
  });

  test("waits through starting -> healthy transitions", async () => {
    const { deps } = fakeHost({
      psStatus: {
        redis: [{ state: "running", health: "starting" }, { state: "running", health: "starting" }, { state: "running", health: "healthy" }],
        api: [{ state: "running", health: "starting" }, { state: "running", health: "healthy" }],
      },
    });
    const report = await runComposeSmoke("production", deps);
    expect(report.ok).toBe(true);
    expect(statusOf(report, "health:redis")).toBe("pass");
    expect(statusOf(report, "health:api")).toBe("pass");
  });

  test("a service that never becomes healthy fails after the timeout, and probes are skipped", async () => {
    const { deps } = fakeHost({ psStatus: { api: [{ state: "running", health: "starting" }] } });
    const report = await runComposeSmoke("production", deps);
    expect(report.ok).toBe(false);
    expect(statusOf(report, "health:api")).toBe("fail");
    expect(statusOf(report, "api:healthz")).toBe("skip");
    expect(statusOf(report, "api:readyz")).toBe("skip");
  });

  test("failing /healthz or /readyz probes inside the api container are blockers", async () => {
    const healthzFail = await runComposeSmoke(
      "production",
      fakeHost({
        exec: (probe) => {
          if (probe.includes("healthz")) throw new Error("exit 1");
        },
      }).deps,
    );
    expect(healthzFail.ok).toBe(false);
    expect(statusOf(healthzFail, "api:healthz")).toBe("fail");

    const readyzFail = await runComposeSmoke(
      "production",
      fakeHost({
        exec: (probe) => {
          if (probe.includes("readyz")) throw new Error("exit 1");
        },
      }).deps,
    );
    expect(readyzFail.ok).toBe(false);
    expect(statusOf(readyzFail, "api:healthz")).toBe("pass");
    expect(statusOf(readyzFail, "api:readyz")).toBe("fail");
  });

  test("worker logs are read with --since the run start (current run only)", async () => {
    const { deps, calls } = fakeHost();
    await runComposeSmoke("production", deps);
    const logCall = calls.find((c) => c.args[9] === "logs");
    expect(logCall).toBeDefined();
    const sinceIdx = logCall!.args.indexOf("--since");
    expect(sinceIdx).toBeGreaterThan(0);
    expect(logCall!.args[sinceIdx + 1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("worker marker can appear after a few log polls", async () => {
    const { deps } = fakeHost({
      workerLogs: ["", "still booting", "Sherlock investigation worker started (queue …)."],
    });
    const report = await runComposeSmoke("production", deps);
    expect(statusOf(report, "worker:started")).toBe("pass");
  });

  test("a stale PASS marker plus a current FAIL marker does not pass", async () => {
    const { deps } = fakeHost({
      workerLogs: [
        [
          "PASS worker preflight: all mandatory checks passed.",
          "FAIL worker preflight: mandatory checks failed; the worker must not consume jobs.",
        ].join("\n"),
      ],
    });
    const report = await runComposeSmoke("production", deps);
    expect(report.ok).toBe(false);
    expect(statusOf(report, "worker:started")).toBe("fail");
  });

  test("an exited worker fails even when its logs contain a PASS marker", async () => {
    const { deps } = fakeHost({
      psStatus: { worker: [{ state: "exited", health: "" }] },
      workerLogs: ["PASS worker preflight: all mandatory checks passed."],
    });
    const report = await runComposeSmoke("production", deps);
    expect(report.ok).toBe(false);
    expect(statusOf(report, "worker:started")).toBe("fail");
    const check = report.checks.find((c: { name: string }) => c.name === "worker:started");
    expect(check?.detail).toContain("not running");
  });

  test("a worker that dies mid-wait fails", async () => {
    const { deps } = fakeHost({
      psStatus: {
        worker: [
          { state: "running", health: "" },
          { state: "dead", health: "" },
        ],
      },
      workerLogs: ["nothing yet"],
    });
    const report = await runComposeSmoke("production", deps);
    expect(report.ok).toBe(false);
    expect(statusOf(report, "worker:started")).toBe("fail");
  });

  test("no worker marker before the timeout is a blocker", async () => {
    const { deps } = fakeHost({ workerLogs: ["nothing useful yet"] });
    const report = await runComposeSmoke("production", deps);
    expect(report.ok).toBe(false);
    expect(statusOf(report, "worker:started")).toBe("fail");
  });

  test("--down tears the smoke stack and its volumes down and drops the stop hint", async () => {
    const { deps, calls } = fakeHost();
    const report = await runComposeSmoke("production", deps, { down: true });
    expect(report.ok).toBe(true);
    expect(statusOf(report, "compose:down")).toBe("pass");
    expect(report.leftRunning).toBe(false);
    const downCall = calls.find((c) => c.args[9] === "down");
    expect(downCall!.args).toContain("-v");
    const output = formatSmokeReport("production", report);
    expect(output).not.toContain("still be running");

    const kept = await runComposeSmoke("production", fakeHost().deps);
    const keptOutput = formatSmokeReport("production", kept);
    expect(keptOutput).toContain("Smoke containers may still be running. Stop them with: docker compose -p");
  });

  test("report never echoes worker log contents, only markers", async () => {
    const { deps } = fakeHost({
      workerLogs: [`${SECRET_IN_LOGS}\nPASS worker preflight: all mandatory checks passed.`],
    });
    const report = await runComposeSmoke("production", deps);
    const output = formatSmokeReport("production", report);
    expect(output).not.toContain(SECRET_IN_LOGS);
    expect(output).toContain('worker is running and logged "PASS worker preflight"');
  });

  test("parsePsJson handles arrays, json-lines, and empty output", () => {
    expect(parsePsJson("")).toEqual([]);
    expect(parsePsJson('[{"Service":"redis"}]')).toEqual([{ Service: "redis" }]);
    expect(parsePsJson('{"Service":"redis"}\n{"Service":"api"}\n')).toEqual([
      { Service: "redis" },
      { Service: "api" },
    ]);
  });

  test("unknown environment throws", async () => {
    const { deps } = fakeHost();
    await expect(runComposeSmoke("qa", deps)).rejects.toThrow(/unknown environment/);
  });
});
