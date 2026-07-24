import { describe, expect, test } from "vitest";
import {
  GRAPHIFY_LOCAL_ONLY_EXCLUDES,
  buildLocalGraphifyArgs,
  buildLocalGraphifyEnv,
} from "../backend/services/graphContext.js";

describe("local-only Graphify execution", () => {
  test("passes exclusions for every document and media extension", () => {
    const args = buildLocalGraphifyArgs();

    expect(args.slice(0, 3)).toEqual(["extract", ".", "--no-viz"]);
    for (const pattern of GRAPHIFY_LOCAL_ONLY_EXCLUDES) {
      expect(args).toContain(pattern);
    }

    expect(args.filter((arg) => arg === "--exclude")).toHaveLength(
      GRAPHIFY_LOCAL_ONLY_EXCLUDES.length,
    );
  });

  test("does not expose provider credentials or endpoints to Graphify", () => {
    const env = buildLocalGraphifyEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/test-home",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_MODEL: "claude-sonnet-5",
      OPENAI_API_KEY: "openai-secret",
      GEMINI_API_KEY: "gemini-secret",
      AWS_PROFILE: "production",
      OLLAMA_BASE_URL: "https://remote-model.example/v1",
      CUSTOM_PROVIDER_TOKEN: "custom-secret",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/test-home",
      LANG: "en_US.UTF-8",
    });
  });
});
