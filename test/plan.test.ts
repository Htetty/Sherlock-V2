import { describe, expect, test } from "vitest";
import {
  validateReproductionPlan,
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
