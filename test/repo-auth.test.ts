// Authenticated private-repository cloning: identity validation, GitHub App
// access preflight, temporary askpass authentication, secret safety, typed
// retry classification, and transient-error propagation through the
// pipeline. No test contacts GitHub or needs a real private repository —
// GitHub and Git-process boundaries are injected, and "clones" are served
// from a local bare fixture repository.
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  buildGitHubCloneUrl,
  COMBINED_ACCESS_MESSAGE,
  createGitAuthContext,
  preflightRepositoryAccess,
  redactGitFailure,
  RepositoryError,
  validateRepositoryIdentity,
  type GitHubApiClient,
  type GitHubApiResponse,
} from "../backend/services/repo-auth.js";
import {
  cloneRepoForInvestigation,
  type GitRunner,
} from "../backend/services/repo.js";
import { runInvestigationPipeline } from "../backend/services/investigation.js";
import { isTransientInfrastructureError } from "../backend/queue/process-investigation.js";

const execFileAsync = promisify(execFile);

const TOKEN = "ghs_testInstallToken12345";
const CLONE_URL = "https://github.com/acme/private-app.git";

async function createBareFixtureRepo() {
  const base = await mkdtemp(path.join(tmpdir(), "sherlock-repoauth-"));
  const src = path.join(base, "src");

  await execFileAsync("git", ["init", "-b", "main", src]);
  await writeFile(path.join(src, "package.json"), '{"name":"fixture"}', "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: src });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.email=f@example.com",
      "-c",
      "user.name=Fixture",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: src },
  );

  const bare = path.join(base, "bare.git");
  await execFileAsync("git", ["clone", "--bare", "--quiet", src, bare]);

  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: src });
  return { bare, headCommit: stdout.trim() };
}

// Records every git invocation (args + env + askpass inspection) and
// delegates to REAL git, rewriting the GitHub URL to the local bare fixture
// only for clone calls — so the produced repository is fully functional.
function createRecordingGitRunner(fixturePath: string, events: string[]) {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const askpassInspections: { dir: string; helperContents: string; mode: number }[] = [];

  const runner: GitRunner = async (args, options) => {
    events.push(`git:${args.includes("clone") ? "clone" : args.join(" ")}`);
    calls.push({ args, env: options.env });

    if (options.env?.GIT_ASKPASS) {
      const helperPath = options.env.GIT_ASKPASS;
      askpassInspections.push({
        dir: path.dirname(helperPath),
        helperContents: await readFile(helperPath, "utf8"),
        mode: (await stat(helperPath)).mode & 0o777,
      });
    }

    const effectiveArgs = args.includes("clone")
      ? args.map((arg) => (arg === CLONE_URL ? fixturePath : arg))
      : args;

    const { stdout } = await execFileAsync("git", effectiveArgs, {
      cwd: options.cwd,
      env: { ...process.env },
    });

    return { stdout };
  };

  return { runner, calls, askpassInspections };
}

function githubRespondingWith(
  response: Partial<GitHubApiResponse>,
  events: string[] = [],
): GitHubApiClient {
  return async () => {
    events.push("preflight");
    return { status: 200, headers: {}, body: null, ...response };
  };
}

describe("repository identity validation and clone URL construction", () => {
  test("valid identities produce the approved GitHub HTTPS URL; unsafe inputs are rejected as typed identity errors", () => {
    expect(buildGitHubCloneUrl("acme", "private-app")).toBe(CLONE_URL);
    expect(buildGitHubCloneUrl("a1-b2", "repo.name_v2")).toBe(
      "https://github.com/a1-b2/repo.name_v2.git",
    );

    const unsafe: [string, string][] = [
      ["..", "repo"], // owner traversal
      ["acme", ".."], // repo traversal
      ["acme/evil", "repo"], // slash in owner
      ["acme", "repo/../../etc"], // slash + traversal in repo
      ["acme", "repo?x=1"], // query string
      ["acme", "repo#frag"], // fragment
      ["user:pass@github.com", "repo"], // embedded credentials
      ["acme", "repo.git;rm -rf"], // shell-ish garbage
      ["-acme", "repo"], // malformed owner
      ["", "repo"], // empty owner
      ["acme", ""], // empty repo
    ];

    for (const [owner, repo] of unsafe) {
      let caught: unknown = null;

      try {
        buildGitHubCloneUrl(owner, repo);
      } catch (error) {
        caught = error;
      }

      expect(caught, `${owner}/${repo} must be rejected`).toBeInstanceOf(RepositoryError);
      expect((caught as RepositoryError).kind).toBe("invalid_identity");
      expect((caught as RepositoryError).retryable).toBe(false);
    }

    // Host-shaped owners are rejected outright (GitHub owners cannot
    // contain dots), so an arbitrary host can never be smuggled into the
    // approved URL through the owner component.
    expect(() => validateRepositoryIdentity("evil.example.com", "repo")).toThrow(
      RepositoryError,
    );
  });

  test("accepts valid GitHub repository names containing underscores (Htetty/Demo_Broken_Repo regression)", () => {
    // Live investigations against this repository must never fail identity
    // validation: underscores are legal in GitHub repository names.
    expect(() => validateRepositoryIdentity("Htetty", "Demo_Broken_Repo")).not.toThrow();
    expect(buildGitHubCloneUrl("Htetty", "Demo_Broken_Repo")).toBe(
      "https://github.com/Htetty/Demo_Broken_Repo.git",
    );
  });
});

describe("GitHub App access preflight", () => {
  const check = (
    response: Partial<GitHubApiResponse>,
    tokenPermissions: Record<string, string> | null = { contents: "write" },
  ) =>
    preflightRepositoryAccess(
      "acme",
      "private-app",
      TOKEN,
      githubRespondingWith(response),
      tokenPermissions,
    );

  test("Contents permission comes from the token metadata, never from repository.permissions.pull", async () => {
    // Regression (Htetty/Demo_Broken_Repo): token minted with
    // contents: write, but GET /repos reports permissions.pull=false —
    // that field is not authoritative and must be ignored.
    await expect(
      check({ status: 200, body: { permissions: { pull: false } } }, { contents: "write" }),
    ).resolves.toBeUndefined();

    // contents: read is sufficient.
    await expect(
      check({ status: 200, body: {} }, { contents: "read" }),
    ).resolves.toBeUndefined();

    // Missing or "none" Contents permission fails safely — before any
    // GitHub request is made.
    for (const permissions of [
      { contents: "none" },
      { issues: "write" },
      {},
      null,
    ] as (Record<string, string> | null)[]) {
      const events: string[] = [];

      await expect(
        preflightRepositoryAccess(
          "acme",
          "private-app",
          TOKEN,
          githubRespondingWith({ status: 200 }, events),
          permissions,
        ),
      ).rejects.toMatchObject({
        name: "RepositoryError",
        kind: "insufficient_permission",
        retryable: false,
      });
      expect(events).toHaveLength(0);
    }

    // Invalid or expired installation token (repo-access check).
    await expect(check({ status: 401 })).rejects.toMatchObject({
      kind: "invalid_credentials",
      retryable: false,
    });
  });

  test("uses the safe combined message when GitHub cannot distinguish missing from inaccessible", async () => {
    // 404: not found, private-and-inaccessible, or omitted from a
    // selected-repositories installation — intentionally indistinguishable.
    await expect(check({ status: 404 })).rejects.toMatchObject({
      kind: "access_denied",
      retryable: false,
      message: COMBINED_ACCESS_MESSAGE,
    });

    // Non-rate-limit 403 gets the same safe combined message.
    await expect(check({ status: 403 })).rejects.toMatchObject({
      kind: "access_denied",
      message: COMBINED_ACCESS_MESSAGE,
    });
  });

  test("classifies temporary GitHub failures as typed retryable errors", async () => {
    await expect(check({ status: 502 })).rejects.toMatchObject({
      kind: "transient_github_api",
      retryable: true,
    });

    await expect(
      check({ status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    ).rejects.toMatchObject({ kind: "transient_github_api", retryable: true });

    const networkFailure: GitHubApiClient = async () => {
      throw new Error("socket disconnected");
    };

    await expect(
      preflightRepositoryAccess("acme", "private-app", TOKEN, networkFailure, {
        contents: "write",
      }),
    ).rejects.toMatchObject({ kind: "transient_github_api", retryable: true });
  });
});

describe("authenticated cloning", () => {
  test(
    "private clones authenticate only through the temporary askpass mechanism, with preflight before git",
    { timeout: 30_000 },
    async () => {
      const fixture = await createBareFixtureRepo();
      const events: string[] = [];
      const git = createRecordingGitRunner(fixture.bare, events);

      const context = await cloneRepoForInvestigation({
        repoOwner: "acme",
        repoName: "private-app",
        defaultBranch: "main",
        installationToken: TOKEN,
        // Token metadata is authoritative; the repository response's
        // pull=false must not block the authenticated clone.
        installationPermissions: { contents: "write" },
        github: githubRespondingWith(
          { status: 200, body: { permissions: { pull: false } } },
          events,
        ),
        runGit: git.runner,
      });

      // Preflight strictly precedes any git invocation.
      expect(events[0]).toBe("preflight");
      expect(events.filter((event) => event.startsWith("git:")).length).toBeGreaterThan(0);

      const clone = git.calls[0];

      // Shallow clone of the requested default branch, from the validated
      // URL, with redirect-following disabled and credential helpers
      // cleared — and no token anywhere in argv.
      expect(clone.args).toContain("clone");
      expect(clone.args).toContain("--depth");
      expect(clone.args).toContain("--branch");
      expect(clone.args).toContain("main");
      expect(clone.args).toContain(CLONE_URL);
      expect(clone.args.join(" ")).toContain("http.followRedirects=false");
      expect(clone.args.join(" ")).toContain("credential.helper=");
      expect(clone.args.join(" ")).not.toContain(TOKEN);

      // Authentication exists only in the git child environment.
      expect(clone.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(clone.env?.SHERLOCK_GIT_TOKEN).toBe(TOKEN);
      expect(clone.env?.GIT_ASKPASS).toBeDefined();

      // Host git configuration is fully disabled for the clone child, so no
      // host-configured credential helper can participate: global and system
      // config point at /dev/null, NOSYSTEM stays set, and the per-process
      // credential.helper= override is present in argv.
      expect(clone.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(clone.env?.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(clone.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(clone.env?.HOME).toBeUndefined();

      // The askpass helper (inspected while it existed) contains no token
      // and is permission-restricted inside its dedicated temp directory.
      const askpass = git.askpassInspections[0];
      expect(askpass.helperContents).not.toContain(TOKEN);
      expect(askpass.helperContents).toContain("SHERLOCK_GIT_TOKEN");
      expect(askpass.mode).toBe(0o700);
      expect((await stat(askpass.dir).catch(() => null))).toBeNull(); // removed after success

      // Origin is the clean unauthenticated GitHub URL.
      const { stdout: origin } = await execFileAsync(
        "git",
        ["remote", "get-url", "origin"],
        { cwd: context.repoPath },
      );
      expect(origin.trim()).toBe(CLONE_URL);
      expect(origin).not.toContain("@");

      // No credential configuration persisted inside the repository.
      const { stdout: config } = await execFileAsync(
        "git",
        ["config", "--local", "--list"],
        { cwd: context.repoPath },
      );
      expect(config).not.toContain("askpass");
      expect(config).not.toContain("credential");
      expect(config).not.toContain(TOKEN);

      // Returned metadata carries no token or credential paths, and the
      // commit is recorded as before.
      expect(context.commit).toBe(fixture.headCommit);
      expect(JSON.stringify(context)).not.toContain(TOKEN);
      expect(JSON.stringify(context)).not.toContain("sherlock-git-auth");
    },
  );

  test(
    "credential directory is removed and errors stay sanitized when the clone fails",
    { timeout: 30_000 },
    async () => {
      let capturedAuthDir: string | null = null;

      const failingRunner: GitRunner = async (_args, options) => {
        if (options.env?.GIT_ASKPASS) {
          capturedAuthDir = path.dirname(options.env.GIT_ASKPASS);
        }

        const error = new Error("fatal: unable to access remote") as Error & {
          stderr: string;
        };
        error.stderr = `fatal: could not read Password for SHERLOCK_GIT_TOKEN=${TOKEN}`;
        throw error;
      };

      let caught: RepositoryError | null = null;

      try {
        await cloneRepoForInvestigation({
          repoOwner: "acme",
          repoName: "private-app",
          defaultBranch: "main",
          installationToken: TOKEN,
          installationPermissions: { contents: "write" },
          github: githubRespondingWith({ status: 200 }),
          runGit: failingRunner,
        });
      } catch (error) {
        caught = error as RepositoryError;
      }

      // Typed retryable transport failure with scrubbed diagnostics.
      expect(caught).toBeInstanceOf(RepositoryError);
      expect(caught?.kind).toBe("transient_clone");
      expect(caught?.retryable).toBe(true);
      expect(caught?.message).not.toContain(TOKEN);
      expect(caught?.message).not.toContain(capturedAuthDir!);

      // Credential directory removed after failure too.
      expect(capturedAuthDir).not.toBeNull();
      await expect(access(capturedAuthDir!)).rejects.toThrow();
    },
  );

  test(
    "public repositories clone through the same validated flow without credentials",
    { timeout: 30_000 },
    async () => {
      const fixture = await createBareFixtureRepo();
      const events: string[] = [];
      const git = createRecordingGitRunner(fixture.bare, events);

      const context = await cloneRepoForInvestigation({
        repoOwner: "acme",
        repoName: "private-app",
        defaultBranch: "main",
        installationToken: null,
        github: githubRespondingWith({ status: 500 }, events), // must not be called
        runGit: git.runner,
      });

      // No preflight without a token, and no auth material in the child env.
      expect(events.filter((event) => event === "preflight")).toHaveLength(0);
      const clone = git.calls[0];
      expect(clone.env?.GIT_ASKPASS).toBeUndefined();
      expect(clone.env?.SHERLOCK_GIT_TOKEN).toBeUndefined();
      expect(clone.env?.GIT_TERMINAL_PROMPT).toBe("0");
      // Host git config is disabled for public clones too.
      expect(clone.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(clone.env?.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(clone.args.join(" ")).toContain("http.followRedirects=false");
      expect(clone.args).toContain(CLONE_URL);
      expect(context.commit).toBe(fixture.headCommit);
    },
  );

  test(
    "default-branch fallback behavior is preserved",
    { timeout: 30_000 },
    async () => {
      const fixture = await createBareFixtureRepo();
      const events: string[] = [];
      const git = createRecordingGitRunner(fixture.bare, events);

      // Branch that does not exist in the fixture: the first clone attempt
      // fails and the fallback clones the repository default branch.
      const context = await cloneRepoForInvestigation({
        repoOwner: "acme",
        repoName: "private-app",
        defaultBranch: "release-42",
        installationToken: null,
        runGit: git.runner,
      });

      const cloneCalls = git.calls.filter((call) => call.args.includes("clone"));
      expect(cloneCalls).toHaveLength(2);
      expect(cloneCalls[0].args).toContain("release-42");
      expect(cloneCalls[1].args).not.toContain("--branch");
      expect(context.commit).toBe(fixture.headCommit);
    },
  );
});

describe("transient repository errors and worker retries", () => {
  const basePayload = {
    repoOwner: "acme",
    repoName: "private-app",
    repoUrl: "https://github.com/acme/private-app",
    defaultBranch: "main",
    issueNumber: 7,
    issueTitle: "Example bug",
    issueBody: "",
  };

  test("transient preflight and clone failures propagate out of runInvestigationPipeline to the retry classifier", async () => {
    for (const kind of ["transient_github_api", "transient_clone"] as const) {
      const transient = new RepositoryError(kind, "blip", true);

      let caught: unknown = null;

      try {
        await runInvestigationPipeline(basePayload, {
          cloneRepo: async () => {
            throw transient;
          },
        });
      } catch (error) {
        caught = error;
      }

      // The exact typed error escapes the pipeline (no environment_failed
      // conversion) and the worker classifier retries it — by type, not by
      // message ("blip" matches no transient pattern).
      expect(caught).toBe(transient);
      expect(isTransientInfrastructureError(caught)).toBe(true);
    }
  });

  test("logical access failures return non-retryable environment_failed results with the safe message", async () => {
    const denied = new RepositoryError("access_denied", COMBINED_ACCESS_MESSAGE, false);

    const result = await runInvestigationPipeline(basePayload, {
      cloneRepo: async () => {
        throw denied;
      },
    });

    expect(result.outcome).toBe("environment_failed");
    expect(result.githubComment).toContain(COMBINED_ACCESS_MESSAGE);
    expect(isTransientInfrastructureError(denied)).toBe(false);
  });

  test("classification is typed, never message-matched, for repository errors", () => {
    // A logical error whose message LOOKS transient must not be retried...
    const trap = new RepositoryError(
      "access_denied",
      "rate limit service unavailable timed out",
      false,
    );
    expect(isTransientInfrastructureError(trap)).toBe(false);

    // ...and a transient error with a bland message must be retried.
    expect(
      isTransientInfrastructureError(new RepositoryError("transient_clone", "x", true)),
    ).toBe(true);

    // Redaction helper scrubs credential-adjacent content.
    const scrubbed = redactGitFailure(
      `https://x-access-token:${TOKEN}@github.com/a/b.git SHERLOCK_GIT_TOKEN=${TOKEN} /tmp/sherlock-git-auth-Ab12Cd/askpass.sh`,
      TOKEN,
    );
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).toContain("sherlock-git-auth-[ELIDED]");
  });

  test("askpass context creation is restricted and cleanable", async () => {
    const auth = await createGitAuthContext(TOKEN);
    const helperPath = auth.env.GIT_ASKPASS;
    const dir = path.dirname(helperPath);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(helperPath)).mode & 0o777).toBe(0o700);
    expect(await readFile(helperPath, "utf8")).not.toContain(TOKEN);
    expect(auth.env.GIT_TERMINAL_PROMPT).toBe("0");

    await auth.cleanup();
    await expect(access(dir)).rejects.toThrow();
  });
});
