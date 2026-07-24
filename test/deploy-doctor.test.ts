// Deployment doctor: env-file validation, placeholder detection, staging
// footguns, docker checks, and secret-safe output. All external boundaries
// (filesystem, docker CLI) are injected — nothing real is touched.
import { describe, expect, test } from "vitest";
import {
  formatDoctorReport,
  looksLikePlaceholder,
  parseEnvFile,
  runDeployDoctor,
  sanitizeCrashMessage,
  // @ts-expect-error plain .mjs script module without type declarations
} from "../scripts/deploy-doctor.mjs";

const SECRET_WEBHOOK = ["webhook", "value", "for", "redaction"].join("-");
const SECRET_ANTHROPIC = ["anthropic", "value", "for", "redaction"].join("-");
const SECRET_SUPABASE = ["supabase", "value", "for", "redaction"].join("-");

function envFileText(overrides: Record<string, string | null> = {}): string {
  const base: Record<string, string | null> = {
    APP_ID: "123456",
    PRIVATE_KEY_PATH: "/run/secrets/github_app_private_key",
    WEBHOOK_SECRET: SECRET_WEBHOOK,
    WEBHOOK_PROXY_URL: "",
    ANTHROPIC_API_KEY: SECRET_ANTHROPIC,
    REDIS_URL: "redis://redis:6379",
    SHERLOCK_STATE_STORE: "supabase",
    SUPABASE_URL: "https://real-project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: SECRET_SUPABASE,
    SHERLOCK_ENV_FILE: ".env.production",
    ...overrides,
  };
  return Object.entries(base)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

type Deps = {
  readFile: (path: string) => string;
  fileSize: (path: string) => number;
  runCommand: (command: string, args: string[]) => Promise<{ stdout: string } | void>;
  shellEnv?: Record<string, string>;
  cwd?: string;
};

// What `docker compose config` would render after interpolation.
function renderedConfig(envFile = ".env.production", keyPath = "/repo/secrets/github-app-private-key.pem"): string {
  return [
    "services:",
    "  api:",
    "    environment:",
    `      SHERLOCK_ENV_FILE: ${envFile}`,
    "  worker:",
    "    environment:",
    `      SHERLOCK_ENV_FILE: ${envFile}`,
    "secrets:",
    "  github_app_private_key:",
    `    file: ${keyPath}`,
    "",
  ].join("\n");
}

// Env file present, key file non-empty, docker commands succeed, compose
// config renders matching production values.
function passingDeps(text: string, overrides: Partial<Deps> = {}, rendered = renderedConfig()): Deps {
  return {
    readFile: () => text,
    fileSize: () => 1024,
    runCommand: async (_command: string, args: string[]) =>
      args.includes("config") ? { stdout: rendered } : { stdout: "" },
    shellEnv: {},
    cwd: "/repo",
    ...overrides,
  };
}

type Report = Awaited<ReturnType<typeof runDeployDoctor>>;

function statusOf(report: Report, name: string) {
  return report.checks.find((check: { name: string }) => check.name === name)?.status;
}

describe("deploy doctor", () => {
  test("fully configured production env passes with no failures", async () => {
    const report = await runDeployDoctor("production", passingDeps(envFileText()));
    expect(report.ok).toBe(true);
    expect(statusOf(report, "env-file")).toBe("pass");
    expect(statusOf(report, "env:SHERLOCK_ENV_FILE")).toBe("pass");
    expect(statusOf(report, "secrets:private-key-file")).toBe("pass");
    expect(statusOf(report, "docker:compose-config")).toBe("pass");
    expect(statusOf(report, "compose:resolved-env-file")).toBe("pass");
    expect(statusOf(report, "compose:resolved-private-key")).toBe("pass");
  });

  test("missing env file is a blocker and skips compose config", async () => {
    const report = await runDeployDoctor(
      "production",
      passingDeps("", {
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, "env-file")).toBe("fail");
    expect(statusOf(report, "docker:compose-config")).toBe("skip");
  });

  test("placeholder values from the example files fail", async () => {
    const text = envFileText({
      APP_ID: "000000",
      WEBHOOK_SECRET: "example-webhook-secret",
      ANTHROPIC_API_KEY: "placeholder-anthropic-key",
      SUPABASE_SERVICE_ROLE_KEY: "redact-me",
      SUPABASE_URL: "https://example.supabase.co",
    });
    const report = await runDeployDoctor("production", passingDeps(text));
    expect(report.ok).toBe(false);
    for (const key of [
      "env:APP_ID",
      "env:WEBHOOK_SECRET",
      "env:ANTHROPIC_API_KEY",
      "env:SUPABASE_SERVICE_ROLE_KEY",
      "env:SUPABASE_URL",
    ]) {
      expect(statusOf(report, key)).toBe("fail");
    }
  });

  test("missing required keys fail", async () => {
    const report = await runDeployDoctor(
      "production",
      passingDeps(envFileText({ REDIS_URL: "", ANTHROPIC_API_KEY: null })),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, "env:REDIS_URL")).toBe("fail");
    expect(statusOf(report, "env:ANTHROPIC_API_KEY")).toBe("fail");
  });

  test("SHERLOCK_ENV_FILE mismatch fails; unset warns on production", async () => {
    const mismatch = await runDeployDoctor(
      "production",
      passingDeps(envFileText({ SHERLOCK_ENV_FILE: ".env.staging" })),
    );
    expect(statusOf(mismatch, "env:SHERLOCK_ENV_FILE")).toBe("fail");

    const unset = await runDeployDoctor(
      "production",
      passingDeps(envFileText({ SHERLOCK_ENV_FILE: null })),
    );
    expect(statusOf(unset, "env:SHERLOCK_ENV_FILE")).toBe("warn");
    expect(unset.ok).toBe(true);
  });

  test("staging must set SHERLOCK_ENV_FILE and SHERLOCK_PRIVATE_KEY_FILE explicitly", async () => {
    const report = await runDeployDoctor(
      "staging",
      passingDeps(envFileText({ SHERLOCK_ENV_FILE: null })),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, "env:SHERLOCK_ENV_FILE")).toBe("fail");
    expect(statusOf(report, "secrets:private-key-file")).toBe("fail");

    const explicit = await runDeployDoctor(
      "staging",
      passingDeps(
        envFileText({
          SHERLOCK_ENV_FILE: ".env.staging",
          SHERLOCK_PRIVATE_KEY_FILE: "./secrets/github-app-staging-private-key.pem",
        }),
        {},
        renderedConfig(".env.staging", "/repo/secrets/github-app-staging-private-key.pem"),
      ),
    );
    expect(explicit.ok).toBe(true);
    expect(statusOf(explicit, "secrets:private-key-file")).toBe("pass");
    expect(statusOf(explicit, "compose:resolved-env-file")).toBe("pass");
    expect(statusOf(explicit, "compose:resolved-private-key")).toBe("pass");
  });

  test("staging rejects the production private key path, relative or absolute", async () => {
    for (const productionKeyPath of [
      "./secrets/github-app-private-key.pem",
      "secrets/github-app-private-key.pem",
      "/repo/secrets/github-app-private-key.pem", // absolute path to the same file
      "/srv/other-root/secrets/github-app-private-key.pem", // production key under another root
      "/repo/staging/../secrets/github-app-private-key.pem", // needs canonicalization
    ]) {
      const report = await runDeployDoctor(
        "staging",
        passingDeps(
          envFileText({
            SHERLOCK_ENV_FILE: ".env.staging",
            SHERLOCK_PRIVATE_KEY_FILE: productionKeyPath,
          }),
          {},
          renderedConfig(".env.staging", "/repo/secrets/github-app-staging-private-key.pem"),
        ),
      );
      expect(report.ok).toBe(false);
      expect(statusOf(report, "secrets:private-key-file")).toBe("fail");
    }
  });

  test("shell-exported SHERLOCK_ENV_FILE overriding --env-file is a blocker; a matching export warns", async () => {
    const stagingEnv = envFileText({
      SHERLOCK_ENV_FILE: ".env.staging",
      SHERLOCK_PRIVATE_KEY_FILE: "./secrets/github-app-staging-private-key.pem",
    });
    const overridden = await runDeployDoctor(
      "staging",
      passingDeps(
        stagingEnv,
        { shellEnv: { SHERLOCK_ENV_FILE: ".env.production" } },
        renderedConfig(".env.staging", "/repo/secrets/github-app-staging-private-key.pem"),
      ),
    );
    expect(overridden.ok).toBe(false);
    expect(statusOf(overridden, "shell:SHERLOCK_ENV_FILE")).toBe("fail");

    const matching = await runDeployDoctor(
      "staging",
      passingDeps(
        stagingEnv,
        { shellEnv: { SHERLOCK_ENV_FILE: ".env.staging" } },
        renderedConfig(".env.staging", "/repo/secrets/github-app-staging-private-key.pem"),
      ),
    );
    expect(statusOf(matching, "shell:SHERLOCK_ENV_FILE")).toBe("warn");
  });

  test("shell-exported SHERLOCK_PRIVATE_KEY_FILE pointing staging at the production key is a blocker", async () => {
    const report = await runDeployDoctor(
      "staging",
      passingDeps(
        envFileText({
          SHERLOCK_ENV_FILE: ".env.staging",
          SHERLOCK_PRIVATE_KEY_FILE: "./secrets/github-app-staging-private-key.pem",
        }),
        { shellEnv: { SHERLOCK_PRIVATE_KEY_FILE: "./secrets/github-app-private-key.pem" } },
        renderedConfig(".env.staging", "/repo/secrets/github-app-staging-private-key.pem"),
      ),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, "shell:SHERLOCK_PRIVATE_KEY_FILE")).toBe("fail");
    // the shell export wins in compose, so the key-file check must fail too
    expect(statusOf(report, "secrets:private-key-file")).toBe("fail");
  });

  test("compose resolving production values during a staging run is detected", async () => {
    const report = await runDeployDoctor(
      "staging",
      passingDeps(
        envFileText({
          SHERLOCK_ENV_FILE: ".env.staging",
          SHERLOCK_PRIVATE_KEY_FILE: "./secrets/github-app-staging-private-key.pem",
        }),
        {},
        renderedConfig(".env.production", "/repo/secrets/github-app-private-key.pem"),
      ),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, "compose:resolved-env-file")).toBe("fail");
    expect(statusOf(report, "compose:resolved-private-key")).toBe("fail");
  });

  test("empty or missing private key file is a blocker", async () => {
    const empty = await runDeployDoctor(
      "production",
      passingDeps(envFileText(), { fileSize: () => 0 }),
    );
    expect(statusOf(empty, "secrets:private-key-file")).toBe("fail");

    const missing = await runDeployDoctor(
      "production",
      passingDeps(envFileText(), {
        fileSize: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(statusOf(missing, "secrets:private-key-file")).toBe("fail");
  });

  test("exactly one of PRIVATE_KEY_PATH / PRIVATE_KEY must be set", async () => {
    const both = await runDeployDoctor(
      "production",
      passingDeps(envFileText({ PRIVATE_KEY: "inline-key-material" })),
    );
    expect(statusOf(both, "env:private-key")).toBe("fail");

    const neither = await runDeployDoctor(
      "production",
      passingDeps(envFileText({ PRIVATE_KEY_PATH: null })),
    );
    expect(statusOf(neither, "env:private-key")).toBe("fail");
  });

  test("unreachable docker daemon fails and skips compose config", async () => {
    const report = await runDeployDoctor(
      "production",
      passingDeps(envFileText(), {
        runCommand: async (command: string) => {
          if (command === "docker") throw new Error("cannot connect");
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, "docker:daemon")).toBe("fail");
    expect(statusOf(report, "docker:compose-config")).toBe("skip");
  });

  test("compose config failure is a blocker", async () => {
    const report = await runDeployDoctor(
      "production",
      passingDeps(envFileText(), {
        runCommand: async (_command: string, args: string[]) => {
          if (args[0] === "compose") throw new Error("invalid interpolation");
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, "docker:compose-config")).toBe("fail");
  });

  test("localhost REDIS_URL and enabled sync investigations are flagged", async () => {
    const report = await runDeployDoctor(
      "production",
      passingDeps(
        envFileText({
          REDIS_URL: "redis://127.0.0.1:6379",
          ALLOW_SYNC_INVESTIGATIONS: "true",
          WEBHOOK_PROXY_URL: "https://smee.io/some-channel",
        }),
      ),
    );
    expect(statusOf(report, "redis:url")).toBe("warn");
    expect(statusOf(report, "env:ALLOW_SYNC_INVESTIGATIONS")).toBe("fail");
    expect(statusOf(report, "env:WEBHOOK_PROXY_URL")).toBe("warn");
    expect(report.ok).toBe(false);
  });

  test("report output never contains secret values", async () => {
    const text = envFileText({
      REDIS_URL: "rediss://:another-real-password-value@managed.example.net:6380",
    });
    const report = await runDeployDoctor("production", passingDeps(text));
    const output = formatDoctorReport("production", report);
    for (const secret of [
      SECRET_WEBHOOK,
      SECRET_ANTHROPIC,
      SECRET_SUPABASE,
      "another-real-password-value",
      "real-project.supabase.co",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("PASS");
  });

  test("formatted report has PASS/WARN/FAIL lines and a verdict", async () => {
    const report = await runDeployDoctor(
      "production",
      passingDeps(envFileText({ WEBHOOK_SECRET: "example-webhook-secret" })),
    );
    const output = formatDoctorReport("production", report);
    expect(output).toMatch(/^FAIL {2}env:WEBHOOK_SECRET/m);
    expect(output).toMatch(/^PASS {2}env:APP_ID/m);
    expect(output).toContain("BLOCKED");
  });

  test("parseEnvFile skips comments and strips quotes", () => {
    const env = parseEnvFile('# comment\nA=1\nB="two"\nC=\n\nnot-a-pair\n');
    expect(env.get("A")).toBe("1");
    expect(env.get("B")).toBe("two");
    expect(env.get("C")).toBe("");
    expect(env.has("not-a-pair")).toBe(false);
  });

  test("looksLikePlaceholder catches example markers but not real-looking values", () => {
    expect(looksLikePlaceholder("redact-me")).toBe(true);
    expect(looksLikePlaceholder("000000")).toBe(true);
    expect(looksLikePlaceholder("replace-with-your-key")).toBe(true);
    expect(looksLikePlaceholder("123456")).toBe(false);
    expect(looksLikePlaceholder(SECRET_ANTHROPIC)).toBe(false);
  });

  test("crash messages redact short sensitive assignments", () => {
    for (const line of [
      "env parse failed near WEBHOOK_SECRET=hunter2",
      "bad value: api_key: shortsecret",
      'invalid ANTHROPIC_API_KEY="shortsecret"',
      "SUPABASE_SERVICE_ROLE_KEY=hunter2 rejected",
      "could not connect with PASSWORD=hunter2",
    ]) {
      const sanitized = sanitizeCrashMessage(new Error(line));
      expect(sanitized).not.toContain("hunter2");
      expect(sanitized).not.toContain("shortsecret");
      expect(sanitized).toContain("[redacted]");
    }
  });

  test("crash messages redact credentials embedded in URLs", () => {
    const sanitized = sanitizeCrashMessage(
      new Error("connect failed: redis://sherlock:hunter2@redis.example.net:6379"),
    );
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).toContain("redis://[redacted]@redis.example.net:6379");

    const emptyUser = sanitizeCrashMessage(new Error("bad url rediss://:hunter2@managed.example.net"));
    expect(emptyUser).not.toContain("hunter2");
    expect(emptyUser).toContain("@managed.example.net");
  });

  test("crash messages redact long unbroken value-like runs but keep normal text useful", () => {
    const longRun = "a".repeat(40);
    const sanitized = sanitizeCrashMessage(new Error(`unexpected value ${longRun} in output`));
    expect(sanitized).not.toContain(longRun);
    expect(sanitized).toContain("[redacted]");

    const plain = sanitizeCrashMessage(new Error("ENOENT: no such file .env.staging"));
    expect(plain).toContain("ENOENT: no such file .env.staging");
  });

  test("unknown environment throws", async () => {
    await expect(runDeployDoctor("qa", passingDeps(envFileText()))).rejects.toThrow(
      /unknown environment/,
    );
  });
});
