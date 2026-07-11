// Shared reproduction evidence contract tests (AGENT_LOOP_UPGRADE_PROMPT.md,
// Change 1): bounded summaries, deterministic origin-free signatures, and the
// PRE/POST delta formatter.

import { describe, expect, test } from "vitest";
import type { ReproductionResult } from "../backend/services/playwright.js";
import {
  MAX_EVIDENCE_ITEMS_PER_KIND,
  MAX_EVIDENCE_SUMMARY_BYTES,
  MAX_FAILURE_SIGNATURE_BYTES,
  formatReproductionEvidenceDelta,
  summarizeReproductionEvidence,
  truncateUtf8Bytes,
} from "../backend/services/reproduction-evidence.js";

function baseResult(overrides: Partial<ReproductionResult> = {}): ReproductionResult {
  return {
    planVersion: 1,
    baseUrl: "http://localhost:3000",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    outcome: "reproduced",
    outcomeReason: "Assertion matched the failure value.",
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

describe("summarizeReproductionEvidence", () => {
  test("reproduced API failure keeps assertion, failed step, and API status", () => {
    const result = baseResult({
      assertion: {
        assertion: { type: "response_body" },
        observed: "Internal Server Error",
        matchedFailure: true,
        matchedExpected: false,
        detail: 'Observed "Internal Server Error".',
      } as ReproductionResult["assertion"],
      steps: [
        {
          id: "request-archive",
          action: "request",
          startedAt: null,
          finishedAt: null,
          outcome: "failed",
          error: "500 Internal Server Error",
          ambiguous: false,
          screenshot: null,
        },
      ],
      apiResponses: [
        {
          method: "POST",
          url: "http://localhost:3000/api/archive",
          status: 500,
          statusText: "Internal Server Error",
          body: "boom",
        },
      ],
    });

    const summary = summarizeReproductionEvidence(result);
    expect(summary.outcome).toBe("reproduced");
    expect(summary.assertion?.observed).toBe("Internal Server Error");
    expect(summary.failedStep).toMatchObject({ id: "request-archive", action: "request" });
    expect(summary.apiResponses[0]).toContain("POST http://localhost:3000/api/archive -> 500");
    expect(summary.signature).toContain("reproduced");
    expect(summary.signature).toContain("request-archive");
  });

  test("browser failure captures console and page errors, bounded per kind", () => {
    const result = baseResult({
      consoleErrors: Array.from({ length: 10 }, (_, index) => `console error ${index}`),
      pageErrors: ["TypeError: Converting circular structure to JSON"],
    });

    const summary = summarizeReproductionEvidence(result);
    expect(summary.consoleErrors).toHaveLength(MAX_EVIDENCE_ITEMS_PER_KIND);
    expect(summary.pageErrors[0]).toContain("TypeError");
    expect(summary.signature).toContain("TypeError");
  });

  test("execution failure keeps failed/ambiguous step identity", () => {
    const result = baseResult({
      outcome: "execution_failed",
      outcomeReason: "Step click-archive failed.",
      steps: [
        {
          id: "click-archive",
          action: "click",
          startedAt: null,
          finishedAt: null,
          outcome: "failed",
          error: "strict mode violation: matched 3 elements",
          ambiguous: true,
          screenshot: null,
        },
      ],
    });

    const summary = summarizeReproductionEvidence(result);
    expect(summary.failedStep?.ambiguous).toBe(true);
    expect(summary.signature).toContain("execution_failed");
    expect(summary.signature).toContain("click-archive");
  });

  test("secrets are redacted from prompt-facing text", () => {
    const result = baseResult({
      consoleErrors: ["request failed with Bearer sk-super-secret-token"],
    });

    const summary = summarizeReproductionEvidence(result);
    expect(summary.consoleErrors[0]).not.toContain("sk-super-secret-token");
    expect(summary.consoleErrors[0]).toContain("[REDACTED]");
  });

  test("network failure secrets are also redacted from the signature", () => {
    const result = baseResult({
      networkFailures: [
        {
          method: "GET",
          url: "http://localhost:3000/api/tasks",
          status: null,
          statusText: "",
          failure: "Bearer sk-super-secret-token",
        },
      ],
    });

    const summary = summarizeReproductionEvidence(result);
    expect(summary.signature).toContain("[REDACTED]");
    expect(summary.signature).not.toContain("sk-super-secret-token");
  });

  test("the complete structured summary obeys its aggregate byte cap", () => {
    const item = "é".repeat(300);
    const result = baseResult({
      outcomeReason: item,
      consoleErrors: Array(5).fill(item),
      pageErrors: Array(5).fill(item),
      networkFailures: Array.from({ length: 5 }, (_, index) => ({
        method: "GET",
        url: `http://localhost:3000/api/${index}/${item}`,
        status: 500,
        statusText: "error",
        failure: "",
      })),
      apiResponses: Array.from({ length: 5 }, (_, index) => ({
        method: "GET",
        url: `http://localhost:3000/api/${index}/${item}`,
        status: 500,
        statusText: "error",
        body: "",
      })),
    });

    const summary = summarizeReproductionEvidence(result);
    expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeLessThanOrEqual(
      MAX_EVIDENCE_SUMMARY_BYTES,
    );
    expect(summary.consoleErrorCount).toBe(5);
    expect(summary.networkFailureCount).toBe(5);
  });

  test("signatures are deterministic and change with the observed failure", () => {
    const make = (observed: string) =>
      summarizeReproductionEvidence(
        baseResult({
          assertion: {
            assertion: { type: "response_body" },
            observed,
            matchedFailure: true,
            matchedExpected: false,
            detail: `Observed "${observed}".`,
          } as ReproductionResult["assertion"],
        }),
      ).signature;

    expect(make("500")).toBe(make("500"));
    expect(make("500")).not.toBe(make("404"));
  });

  test("signatures are origin-free: same failure on different base URLs matches", () => {
    const make = (origin: string) =>
      summarizeReproductionEvidence(
        baseResult({
          baseUrl: origin,
          networkFailures: [
            {
              method: "POST",
              url: `${origin}/api/archive`,
              status: 500,
              statusText: "Internal Server Error",
              failure: "",
            },
          ],
        }),
      ).signature;

    const a = make("http://localhost:3000");
    const b = make("http://localhost:49152");
    expect(a).toBe(b);
    expect(a).toContain("/api/archive");
    expect(a).not.toContain("localhost");
    expect(Buffer.byteLength(a, "utf8")).toBeLessThanOrEqual(MAX_FAILURE_SIGNATURE_BYTES);
  });
});

describe("truncateUtf8Bytes", () => {
  test("truncates by bytes without splitting code points", () => {
    const text = "héllo wörld"; // multi-byte characters
    const truncated = truncateUtf8Bytes(text, 4);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(4);
    expect(truncated).not.toContain("�");
  });

  test("returns short text unchanged", () => {
    expect(truncateUtf8Bytes("abc", 100)).toBe("abc");
  });
});

describe("formatReproductionEvidenceDelta", () => {
  test("identical signatures report no change; different report change", () => {
    const before = summarizeReproductionEvidence(baseResult());
    const sameAfter = summarizeReproductionEvidence(baseResult());
    const differentAfter = summarizeReproductionEvidence(
      baseResult({ outcome: "not_reproduced", outcomeReason: "Expected behavior observed." }),
    );

    expect(formatReproductionEvidenceDelta(before, sameAfter, 4_096)).toContain(
      "Signature changed: no",
    );
    expect(formatReproductionEvidenceDelta(before, differentAfter, 4_096)).toContain(
      "Signature changed: yes",
    );
  });

  test("signature lines survive a tight byte budget; detail lines are dropped first", () => {
    const before = summarizeReproductionEvidence(baseResult());
    const after = summarizeReproductionEvidence(baseResult());
    const core = formatReproductionEvidenceDelta(before, after, 250);

    expect(core).toContain("Before signature:");
    expect(core).toContain("After signature:");
    expect(core).toContain("Signature changed:");
    expect(core).not.toContain("Interpretation:");
    expect(Buffer.byteLength(core, "utf8")).toBeLessThanOrEqual(250);
  });

  test("delta counts reflect original evidence rather than retained samples", () => {
    const before = summarizeReproductionEvidence(
      baseResult({ consoleErrors: Array.from({ length: 100 }, (_, i) => `before ${i}`) }),
    );
    const after = summarizeReproductionEvidence(
      baseResult({ consoleErrors: Array.from({ length: 6 }, (_, i) => `after ${i}`) }),
    );
    const delta = formatReproductionEvidenceDelta(before, after, 4_096);

    expect(delta).toContain("Console errors: before 100, after 6");
  });
});
