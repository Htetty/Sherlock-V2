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

    expect(shouldRunReproducerFallback("plan_failed", false)).toBe(true);
    expect(shouldRunReproducerFallback("execution_failed", false)).toBe(true);

    process.env.REPRODUCER_AGENT_ENABLED = "false";
    expect(shouldRunReproducerFallback("plan_failed", false)).toBe(true);
    expect(shouldRunReproducerFallback("execution_failed", false)).toBe(true);
  });

  test("memory replay and successful one-shot reproduction skip the fallback", () => {
    expect(shouldRunReproducerFallback("memory_reproduced", true)).toBe(false);
    expect(shouldRunReproducerFallback("reproduced", true)).toBe(false);
  });

  test("not_reproduced escalates only through its existing escalation flag", () => {
    expect(shouldRunReproducerFallback("not_reproduced", false)).toBe(false);
    expect(shouldRunReproducerFallback("not_reproduced", true)).toBe(true);
  });

  test("indeterminate one-shot assertions always escalate", () => {
    expect(
      shouldRunReproducerFallback("not_reproduced", false, false),
    ).toBe(true);
  });

  test("environment failures do not invoke the reproducer fallback", () => {
    expect(shouldRunReproducerFallback("environment_failed", true)).toBe(false);
  });
});
