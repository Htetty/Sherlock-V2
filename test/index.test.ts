import nock from "nock";
// Requiring our app implementation
import myProbotApp from "../src/index.js";
import { Probot, ProbotOctokit } from "probot";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, beforeEach, afterEach, test, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const privateKey = fs.readFileSync(
  path.join(__dirname, "fixtures/mock-cert.pem"),
  "utf-8",
);

const resultComment = [
  "Sherlock reproduced the reported failure.",
  "",
  "Investigation: inv_0TEST123ABC",
  "Outcome: reproduced",
  "Observed: Login request returned HTTP 500",
  "Expected: Login request should return HTTP 401",
  "Evidence: 3 screenshots, 1 console error, 1 failed network request, 1 failed assertion",
].join("\n");

const payload = {
  action: "created",
  issue: {
    number: 1,
    title: "Example bug",
    body: "Something broke",
    html_url: "https://github.com/hiimbex/testing-things/issues/1",
  },
  comment: {
    body: "Please investigate this",
    user: { login: "hiimbex" },
  },
  repository: {
    name: "testing-things",
    html_url: "https://github.com/hiimbex/testing-things",
    default_branch: "main",
    owner: { login: "hiimbex" },
  },
  installation: { id: 2 },
};

describe("My Probot app", () => {
  let probot: any;

  beforeEach(() => {
    nock.disableNetConnect();
    probot = new Probot({
      appId: 123,
      privateKey,
      // disable request throttling and retries for testing
      Octokit: ProbotOctokit.defaults((instanceOptions: {}) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });
    // Load our app into probot
    probot.load(myProbotApp);
  });

  test("posts a progress comment with the investigation id and the backend result comment", async () => {
    let progressCommentId: string | undefined;

    const backendMock = nock("http://localhost:4000")
      .post("/investigations", (body: any) => {
        expect(body.investigationId).toMatch(/^inv_[0-9A-Z]{10,}$/);
        // Same id the progress comment announced (posted before this call)
        expect(body.investigationId).toBe(progressCommentId);
        expect(body.repoUrl).toBe("https://github.com/hiimbex/testing-things");
        return true;
      })
      .reply(200, {
        investigationId: "inv_0TEST123ABC",
        outcome: "reproduced",
        githubComment: resultComment,
      });

    const mock = nock("https://api.github.com")
      // Test that we correctly return a test token
      .post("/app/installations/2/access_tokens")
      .reply(200, {
        token: "test",
        permissions: {
          issues: "write",
        },
      })

      // Progress comment includes the investigation id
      .post("/repos/hiimbex/testing-things/issues/1/comments", (body: any) => {
        expect(body.body).toContain("Investigation started.");
        const match = body.body.match(/Investigation: (inv_[0-9A-Z]{10,})/);
        expect(match).not.toBeNull();
        progressCommentId = match?.[1];
        return true;
      })
      .reply(200)

      // Result comment is exactly what the backend produced
      .post("/repos/hiimbex/testing-things/issues/1/comments", (body: any) => {
        expect(body.body).toBe(resultComment);
        return true;
      })
      .reply(200);

    // Receive a webhook event
    await probot.receive({ name: "issue_comment", payload: payload as any });

    expect(mock.pendingMocks()).toStrictEqual([]);
    expect(backendMock.pendingMocks()).toStrictEqual([]);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });
});
