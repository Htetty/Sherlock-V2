import { describe, expect, test } from "vitest";
import {
  formatAnalysisComment,
  formatResultComment,
  redactSecrets,
} from "../backend/services/report.js";

describe("formatResultComment", () => {
  test("formats a reproduced outcome with evidence", () => {
    const comment = formatResultComment({
      investigationId: "inv_123ABC456DEF",
      outcome: "reproduced",
      observed: "POST /api/login returned HTTP 500",
      expected: "Login request should return HTTP 401",
      evidence: {
        screenshots: 3,
        consoleErrors: 1,
        networkFailures: 1,
        failedAssertions: 1,
      },
    });

    expect(comment).toContain("Sherlock reproduced the reported failure.");
    expect(comment).toContain("Investigation: inv_123ABC456DEF");
    expect(comment).toContain("Outcome: reproduced");
    expect(comment).toContain("Observed: POST /api/login returned HTTP 500");
    expect(comment).toContain("Expected: Login request should return HTTP 401");
    expect(comment).toContain(
      "Evidence: 3 screenshots, 1 console error, 1 failed network request, 1 failed assertion",
    );
  });

  test("formats an environment failure with stage and error", () => {
    const comment = formatResultComment({
      investigationId: "inv_123ABC456DEF",
      outcome: "environment_failed",
      stage: "npm run build",
      error: "Missing required DATABASE_URL",
    });

    expect(comment).toContain(
      "the application environment failed to start",
    );
    expect(comment).toContain("Outcome: environment_failed");
    expect(comment).toContain("Stage: npm run build");
    expect(comment).toContain("Error: Missing required DATABASE_URL");
  });

  test("redacts secrets that leak into error text", () => {
    const comment = formatResultComment({
      investigationId: "inv_123ABC456DEF",
      outcome: "environment_failed",
      stage: "npm start",
      error:
        "Startup failed: DATABASE_URL=postgres://admin:hunter2@db.internal:5432/app ANTHROPIC_API_KEY=sk-ant-abc123 api_key: supersecret Authorization: Bearer eyJtoken",
    });

    expect(comment).not.toContain("hunter2");
    expect(comment).not.toContain("sk-ant-abc123");
    expect(comment).not.toContain("supersecret");
    expect(comment).not.toContain("eyJtoken");
    expect(comment).toContain("[REDACTED]");
  });
});

describe("formatAnalysisComment", () => {
  test("surfaces bounded text analysis and redacts secrets", () => {
    const comment = formatAnalysisComment({
      type: "text",
      text: "Likely cause: handler uses DATABASE_URL=postgres://u:secret@db/app and returns stale cache.",
    });

    expect(comment).toContain("Analysis:");
    expect(comment).toContain("Likely cause");
    expect(comment).not.toContain("secret");
    expect(comment).toContain("[REDACTED]");
  });
});

describe("redactSecrets", () => {
  test("redacts env-style assignments but keeps the key name", () => {
    expect(redactSecrets("Missing DATABASE_URL=postgres://u:p@h/db")).toBe(
      "Missing DATABASE_URL=[REDACTED]",
    );
  });

  test("redacts credentials embedded in URLs", () => {
    expect(redactSecrets("connecting to postgres://admin:hunter2@db:5432")).toContain(
      "postgres://admin:[REDACTED]@",
    );
  });

  test("leaves ordinary text untouched", () => {
    const text = "Login request returned HTTP 500 instead of HTTP 401.";

    expect(redactSecrets(text)).toBe(text);
  });

  test("keeps benign env vars like PORT visible in startup diagnostics", () => {
    const text =
      "Attempted command: PORT=59743 npm start\nStartup env: NODE_ENV=production DATABASE_URL=postgres://u:p@h/db";
    const redacted = redactSecrets(text);

    expect(redacted).toContain("PORT=59743");
    expect(redacted).toContain("NODE_ENV=production");
    expect(redacted).toContain("DATABASE_URL=[REDACTED]");
  });
});
