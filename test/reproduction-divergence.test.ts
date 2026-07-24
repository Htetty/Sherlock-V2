// Live-vs-replay divergence tests (REPRODUCER_LOOP_UPGRADE_PROMPT.md, Change 4b)
// plus the hoisted canonical plan hash (Change 3 input).

import { describe, expect, test } from "vitest";
import { hashPlanBehavior, type ReproductionPlan } from "../backend/services/plan.js";
import type { ReproductionResult } from "../backend/services/playwright.js";
import {
  MAX_DIVERGENCE_ITEMS,
  MAX_DIVERGENCE_ITEM_BYTES,
  computeReproducerDivergence,
  formatReproducerDivergence,
  hasDivergence,
  type LiveFinding,
} from "../backend/services/reproduction-divergence.js";

function plan(steps: unknown[], assertion: unknown = { type: "response_body", pathPattern: "/api/tasks", failureContains: "error" }): ReproductionPlan {
  return {
    version: 1,
    baseUrl: "http://localhost:3000",
    steps,
    expectedBehavior: "works",
    failureCondition: "breaks",
    assertion,
  } as unknown as ReproductionPlan;
}

function replay(overrides: Partial<ReproductionResult> = {}): ReproductionResult {
  return {
    planVersion: 1,
    baseUrl: "http://localhost:49152",
    startedAt: "",
    finishedAt: "",
    outcome: "not_reproduced",
    outcomeReason: "Expected behavior observed.",
    steps: [],
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
    httpResponses: [],
    apiResponses: [],
    screenshots: [],
    assertion: null,
    events: [],
    html: "",
    ...overrides,
  } as ReproductionResult;
}

const finding = (kind: string, observation: string): LiveFinding => ({ kind, observation });

describe("hashPlanBehavior (hoisted)", () => {
  test("excludes baseUrl; sensitive to steps and assertion", () => {
    const steps = [{ id: "s1", action: "goto", path: "/" }];
    const a = hashPlanBehavior(plan(steps));
    const b = hashPlanBehavior({ ...plan(steps), baseUrl: "http://localhost:49152" });
    expect(a).toBe(b);

    expect(hashPlanBehavior(plan([...steps, { id: "s2", action: "wait", ms: 100 }]))).not.toBe(a);
    expect(hashPlanBehavior(plan(steps, { type: "console_error", contains: "x" }))).not.toBe(a);
  });
});

describe("computeReproducerDivergence", () => {
  test("live 500 missing from a clean replay flags missing signal and likely setup", () => {
    const divergence = computeReproducerDivergence(
      [finding("response", "POST http://localhost:3000/api/archive -> 500")],
      plan([{ id: "s1", action: "request", method: "GET", path: "/api/tasks" }]),
      replay(),
    );

    expect(divergence.missingInReplay).toEqual([
      { kind: "response", observation: "POST /api/archive -> 500" },
    ]);
    expect(divergence.uncoveredRoutes).toContain("POST /api/archive");
    expect(divergence.likelyMissingSetup).toBe(true);
  });

  test("replay showing the same failure clears missingInReplay and likely cause", () => {
    const divergence = computeReproducerDivergence(
      [finding("response", "POST http://localhost:3000/api/archive -> 500")],
      plan([{ id: "s1", action: "request", method: "POST", path: "/api/archive" }]),
      replay({
        outcome: "reproduced",
        apiResponses: [
          {
            method: "POST",
            url: "http://localhost:49152/api/archive",
            status: 500,
            statusText: "ISE",
            body: "boom",
          },
        ],
      }),
    );

    expect(divergence.missingInReplay).toEqual([]);
    expect(divergence.likelyMissingSetup).toBe(false);
  });

  test("origin differences never produce false divergence", () => {
    const divergence = computeReproducerDivergence(
      [finding("response", "GET http://localhost:3000/api/tasks -> 500")],
      plan([{ id: "s1", action: "request", method: "GET", path: "/api/tasks" }]),
      replay({
        networkFailures: [
          {
            method: "GET",
            url: "http://localhost:49152/api/tasks",
            status: 500,
            statusText: "",
            failure: "",
          },
        ],
      }),
    );

    expect(divergence.missingInReplay).toEqual([]);
    expect(divergence.uncoveredRoutes).toEqual([]);
  });

  test("runtime errors absent from replay errors are missing; present ones are not", () => {
    const missing = computeReproducerDivergence(
      [finding("runtime_error", "TypeError: Converting circular structure to JSON")],
      plan([]),
      replay(),
    );
    expect(missing.missingInReplay[0]).toMatchObject({ kind: "runtime_error" });

    const present = computeReproducerDivergence(
      [finding("runtime_error", "TypeError: Converting circular structure to JSON")],
      plan([]),
      replay({ pageErrors: ["TypeError: Converting circular structure to JSON at archive()"] }),
    );
    expect(present.missingInReplay).toEqual([]);
  });

  test("live element interactions with no plan counterpart are uncovered", () => {
    const divergence = computeReproducerDivergence(
      [finding("element", 'click {"testId":"archive-btn"} existed and the action succeeded')],
      plan([{ id: "s1", action: "request", method: "GET", path: "/api/tasks" }]),
      replay(),
    );
    expect(divergence.uncoveredActions).toHaveLength(1);

    const covered = computeReproducerDivergence(
      [finding("element", 'click {"testId":"archive-btn"} existed and the action succeeded')],
      plan([{ id: "s1", action: "click", target: { testId: "archive-btn" } }]),
      replay(),
    );
    expect(covered.uncoveredActions).toEqual([]);
  });

  test("bounds: arrays capped, items byte-bounded, secrets redacted", () => {
    const findings: LiveFinding[] = Array.from({ length: 10 }, (_, index) =>
      finding("response", `POST http://x/api/route-${index} -> 500 Bearer sk-secret-${index} ${"x".repeat(400)}`),
    );

    const divergence = computeReproducerDivergence(findings, plan([]), replay());
    expect(divergence.missingInReplay.length).toBeLessThanOrEqual(MAX_DIVERGENCE_ITEMS);

    for (const item of divergence.missingInReplay) {
      expect(Buffer.byteLength(item.observation, "utf8")).toBeLessThanOrEqual(
        MAX_DIVERGENCE_ITEM_BYTES,
      );
      expect(item.observation).not.toContain("sk-secret");
    }
  });
});

describe("formatReproducerDivergence", () => {
  test("renders only when non-empty; Likely cause only when likelyMissingSetup", () => {
    const empty = computeReproducerDivergence([], plan([]), replay());
    expect(hasDivergence(empty)).toBe(false);
    expect(formatReproducerDivergence(empty)).toBe("");

    const setup = computeReproducerDivergence(
      [finding("response", "POST /api/archive -> 500")],
      plan([]),
      replay(),
    );
    const rendered = formatReproducerDivergence(setup);
    expect(rendered).toContain("DIVERGENCE (live exploration vs this replay):");
    expect(rendered).toContain("Likely cause:");

    // Replay failed differently (not clean) -> no Likely cause line.
    const failedReplay = computeReproducerDivergence(
      [finding("response", "POST /api/archive -> 500")],
      plan([]),
      replay({ outcome: "execution_failed" }),
    );
    expect(formatReproducerDivergence(failedReplay)).not.toContain("Likely cause:");
  });
});
