import { describe, expect, test } from "vitest";
import { buildReproductionPlanPrompt } from "../backend/services/claude.js";
import {
  validateReproductionPlan,
  validatePlanTargetsAgainstDigest,
  REPRODUCTION_PLAN_VERSION,
} from "../backend/services/plan.js";

const validPlan = {
  version: REPRODUCTION_PLAN_VERSION,
  baseUrl: "http://localhost:3000",
  steps: [
    { id: "step-1", action: "goto", path: "/login" },
    { id: "step-2", action: "fill", selector: "[name='email']", value: "a@b.c" },
    { id: "step-3", action: "click", selector: "button[type='submit']" },
    {
      id: "step-4",
      action: "request",
      method: "POST",
      path: "/api/login",
      body: { email: "a@b.c" },
    },
    { id: "step-5", action: "screenshot" },
  ],
  expectedBehavior: "Login returns HTTP 401 for unknown users.",
  failureCondition: "Login returns HTTP 500 for unknown users.",
  assertion: {
    type: "response_status",
    pathPattern: "/api/login",
    method: "POST",
    expected: 401,
    failureValue: 500,
  },
};

describe("validateReproductionPlan", () => {
  test("accepts a valid plan", () => {
    const result = validateReproductionPlan(validPlan);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.plan.steps).toHaveLength(5);
    }
  });

  test("rejects a plan with an unsupported action", () => {
    const result = validateReproductionPlan({
      ...validPlan,
      steps: [{ id: "step-1", action: "evaluate", script: "alert(1)" }],
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("unsupported action");
    }
  });

  test("rejects a plan without an assertion", () => {
    const result = validateReproductionPlan({ ...validPlan, assertion: undefined });

    expect(result.ok).toBe(false);
  });

  test("rejects browser-state assertions on plans with no browser steps", () => {
    // A console_error assertion over a pure-API plan can only ever pass:
    // no page is loaded, so no console error can be observed (the false
    // not_reproduced from investigation inv_1JSNU471PMDETKX).
    const apiOnlyPlan = {
      ...validPlan,
      steps: [
        { id: "step-1", action: "request", method: "POST", path: "/tasks", body: { title: "A" } },
        { id: "step-2", action: "request", method: "GET", path: "/tasks" },
      ],
      assertion: { type: "console_error", contains: "Archive job" },
    };

    const rejected = validateReproductionPlan(apiOnlyPlan);
    expect(rejected.ok).toBe(false);

    if (!rejected.ok) {
      expect(rejected.errors.join(" ")).toContain("requires at least one browser step");
    }

    // The same assertion is fine once the plan actually opens a page.
    const withBrowserStep = validateReproductionPlan({
      ...apiOnlyPlan,
      steps: [{ id: "step-0", action: "goto", path: "/" }, ...apiOnlyPlan.steps],
    });
    expect(withBrowserStep.ok).toBe(true);
  });

  test("validates wait steps and their bounds", () => {
    const withWait = validateReproductionPlan({
      ...validPlan,
      steps: [...validPlan.steps, { id: "step-6", action: "wait", ms: 2_000 }],
    });
    expect(withWait.ok).toBe(true);

    for (const ms of [0, -5, 10_001, 1.5, "2000"]) {
      const result = validateReproductionPlan({
        ...validPlan,
        steps: [...validPlan.steps, { id: "step-6", action: "wait", ms }],
      });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.errors.join(" ")).toContain("(wait)");
      }
    }
  });

  test("validates response_body assertions", () => {
    const valid = validateReproductionPlan({
      ...validPlan,
      assertion: {
        type: "response_body",
        pathPattern: "/tasks",
        method: "GET",
        failureContains: '"completed":true',
        expectedContains: '"tasks"',
      },
    });
    expect(valid.ok).toBe(true);

    const missingFailure = validateReproductionPlan({
      ...validPlan,
      assertion: { type: "response_body", pathPattern: "/tasks" },
    });
    expect(missingFailure.ok).toBe(false);

    const sameValues = validateReproductionPlan({
      ...validPlan,
      assertion: { type: "response_body", failureContains: "x", expectedContains: "x" },
    });
    expect(sameValues.ok).toBe(false);
  });

  test("rejects a plan with duplicate step ids", () => {
    const result = validateReproductionPlan({
      ...validPlan,
      steps: [
        { id: "step-1", action: "goto", path: "/" },
        { id: "step-1", action: "screenshot" },
      ],
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("Duplicate step id");
    }
  });

  test("rejects a plan targeting a non-local base URL", () => {
    const result = validateReproductionPlan({
      ...validPlan,
      baseUrl: "https://example.com",
    });

    expect(result.ok).toBe(false);
  });

  test("accepts the sandbox app container hostname (network addressing) but no other remote host", () => {
    // Under a containerized worker the sandbox base URL names the target app
    // container on the shared sandbox network (container.ts createContainerName).
    const containerHost = validateReproductionPlan({
      ...validPlan,
      baseUrl: "http://sherlock-app-2b8ee9ba-6a11-4b53-9d6d-0d47a29f1a01:51234",
    });
    expect(containerHost.ok).toBe(true);

    // Names that merely resemble the prefix stay rejected.
    const lookalike = validateReproductionPlan({
      ...validPlan,
      baseUrl: "http://sherlock-app-evil.example.com:51234",
    });
    expect(lookalike.ok).toBe(false);
  });

  test("rejects a plan with the wrong version", () => {
    const result = validateReproductionPlan({ ...validPlan, version: 999 });

    expect(result.ok).toBe(false);
  });

  test("rejects a plan with an absolute goto path", () => {
    const result = validateReproductionPlan({
      ...validPlan,
      steps: [{ id: "step-1", action: "goto", path: "https://example.com" }],
    });

    expect(result.ok).toBe(false);
  });

  test("rejects non-object input", () => {
    expect(validateReproductionPlan(null).ok).toBe(false);
    expect(validateReproductionPlan("plan").ok).toBe(false);
    expect(validateReproductionPlan([validPlan]).ok).toBe(false);
  });
});

describe("reproduction plan prompt", () => {
  test("rejects a browser target that was not present in the live digest", () => {
    const plan = {
      ...validPlan,
      steps: [
        { id: "open", action: "goto", path: "/" },
        {
          id: "search",
          action: "fill",
          target: { placeholder: "Search recipes" },
          value: "pasta",
        },
        {
          id: "invented",
          action: "click",
          target: { role: "button", name: "Search" },
        },
      ],
    } as never;
    const digest =
      'URL: http://localhost:3000/\n- textbox placeholder="Search recipes"';

    expect(validatePlanTargetsAgainstDigest(plan, digest)).toEqual([
      'steps[2].target.role "button" was not present in the live page digest.',
    ]);
  });

  test("requires browser-first reproduction when the issue provides grounded UI steps", () => {
    const prompt = buildReproductionPlanPrompt({
      issueTitle: "Empty notes can be created",
      issueBody: "Leave the input empty, click Add, then refresh.",
      repoUrl: "https://github.com/acme/notes",
      defaultBranch: "main",
      fileTree: ["public/app.js", "server.js"],
      packageJson: null,
      readme: null,
      sourceFiles: [],
      sandboxResult: {
        baseUrl: "http://localhost:3000",
        stdout: "",
        stderr: "",
      },
    } as never);

    expect(prompt).toContain("Browser-first reproduction policy");
    expect(prompt).toContain("MUST reproduce through those browser controls first");
    expect(prompt).toContain("Direct API requests are a fallback");
    expect(prompt).toContain(
      "response_status assertion may observe a request triggered by a browser click",
    );
  });
});
