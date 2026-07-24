import { afterEach, describe, expect, test } from "vitest";
import { shouldRunReproducerFallback } from "../backend/services/investigation.js";

const originalFeatureFlag = process.env.REPRODUCER_AGENT_ENABLED;

afterEach(() => {
  if (originalFeatureFlag === undefined) {
    delete process.env.REPRODUCER_AGENT_ENABLED;
  } else {
    process.env.REPRODUCER_AGENT_ENABLED = originalFeatureFlag;
  }
});

describe("reproducer fallback routing", () => {
  test("plan and execution failures always use the fallback without a feature flag", () => {
    delete process.env.REPRODUCER_AGENT_ENABLED;

    expect(shouldRunReproducerFallback("plan_failed")).toBe(true);
    expect(shouldRunReproducerFallback("execution_failed")).toBe(true);

    process.env.REPRODUCER_AGENT_ENABLED = "false";
    expect(shouldRunReproducerFallback("plan_failed")).toBe(true);
    expect(shouldRunReproducerFallback("execution_failed")).toBe(true);
  });

  test("memory replay and successful one-shot reproduction skip the fallback", () => {
    expect(shouldRunReproducerFallback("memory_reproduced")).toBe(false);
    expect(shouldRunReproducerFallback("reproduced")).toBe(false);
  });

  test("every one-shot not_reproduced result uses the fallback", () => {
    expect(shouldRunReproducerFallback("not_reproduced")).toBe(true);
  });

  test("environment failures do not invoke the reproducer fallback", () => {
    expect(shouldRunReproducerFallback("environment_failed")).toBe(false);
  });
});
