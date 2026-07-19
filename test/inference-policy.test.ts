// Per-phase inference policy selection (Phase 2.5) and cache application.

import { describe, expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runInference } from "../backend/services/inference.js";

const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-5",
  max_tokens: 100,
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
};

function fakeMessage(): Anthropic.Messages.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "ok", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    } as Anthropic.Messages.Usage,
  } as Anthropic.Messages.Message;
}

describe("per-phase policy from telemetry", () => {
  test("telemetry.policies[phase] applies its model, thinking, and cache", async () => {
    let seen: Anthropic.Messages.MessageCreateParamsNonStreaming | null = null;

    await runInference(
      {
        phase: "memory_reflection",
        telemetry: {
          investigationId: "inv",
          recorder: null,
          policies: {
            memory_reflection: {
              model: "cheap-model",
              thinking: { type: "enabled", budgetTokens: 512 },
              cacheMode: "system_and_tools",
            },
          },
        },
      },
      params,
      {
        create: async (finalParams) => {
          seen = finalParams;
          return fakeMessage();
        },
      },
    );

    expect(seen!.model).toBe("cheap-model");
    expect(seen!.thinking).toEqual({ type: "enabled", budget_tokens: 512 });
    // cache mode wrapped the system prompt.
    expect(Array.isArray(seen!.system)).toBe(true);
  });

  test("a phase with no policy keeps default behavior (thinking disabled, string system)", async () => {
    let seen: Anthropic.Messages.MessageCreateParamsNonStreaming | null = null;

    await runInference(
      {
        phase: "fix",
        telemetry: {
          investigationId: "inv",
          recorder: null,
          policies: { memory_reflection: { model: "cheap-model" } },
        },
      },
      params,
      {
        create: async (finalParams) => {
          seen = finalParams;
          return fakeMessage();
        },
      },
    );

    expect(seen!.model).toBe("claude-sonnet-5");
    expect(seen!.thinking).toEqual({ type: "disabled" });
    expect(typeof seen!.system).toBe("string");
  });

  test("explicit context.policy overrides telemetry.policies", async () => {
    let seen: Anthropic.Messages.MessageCreateParamsNonStreaming | null = null;

    await runInference(
      {
        phase: "fix",
        policy: { model: "explicit-model" },
        telemetry: {
          investigationId: "inv",
          recorder: null,
          policies: { fix: { model: "telemetry-model" } },
        },
      },
      params,
      {
        create: async (finalParams) => {
          seen = finalParams;
          return fakeMessage();
        },
      },
    );

    expect(seen!.model).toBe("explicit-model");
  });
});
