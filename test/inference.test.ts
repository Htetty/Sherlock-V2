// Inference gateway tests (FABLE_IMPLEMENTATION_PROMPT.md Phase 1.1/1.2).
//
// All model calls are injected; no test here talks to the network or needs
// ANTHROPIC_API_KEY.

import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  INFERENCE_RECORDS_FILE,
  applyCacheMode,
  classifyError,
  createInferenceRecorder,
  estimateCostUsd,
  resetPricingCacheForTests,
  runInference,
  type InferenceRecord,
} from "../backend/services/inference.js";

afterEach(() => {
  resetPricingCacheForTests();
  delete process.env.SHERLOCK_PRICING_FILE;
});

function fakeMessage(overrides: Partial<Anthropic.Messages.Message> = {}): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "ok", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 900,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
      server_tool_use: null,
      service_tier: null,
    } as Anthropic.Messages.Usage,
    ...overrides,
  } as Anthropic.Messages.Message;
}

const BASE_PARAMS: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "hello" }],
};

async function makeRecorderDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "inference-test-"));
}

async function readRecords(dir: string): Promise<InferenceRecord[]> {
  const raw = await readFile(path.join(dir, INFERENCE_RECORDS_FILE), "utf8");

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InferenceRecord);
}

describe("runInference", () => {
  test("success writes one schema-valid record with mapped usage", async () => {
    const dir = await makeRecorderDir();
    const recorder = createInferenceRecorder(dir);

    const message = await runInference(
      { phase: "fix", telemetry: { investigationId: "inv_TEST", recorder } },
      BASE_PARAMS,
      { create: async () => fakeMessage() },
    );

    expect(message.content[0]).toMatchObject({ type: "text", text: "ok" });

    const records = await readRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      investigationId: "inv_TEST",
      phase: "fix",
      model: "claude-sonnet-5",
      status: "succeeded",
      attemptCount: 1,
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 900,
      cacheCreationTokens: 300,
      cacheCreation5mTokens: 300,
      cacheCreation1hTokens: 0,
      thinkingTokens: null,
      stopReason: "end_turn",
      // Pricing table ships empty: unknown model => null, never a guess.
      estimatedCostUsd: null,
    });
    expect(records[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(recorder.failures).toBe(0);
  });

  test("failure without usage records nulls and rethrows the error", async () => {
    const dir = await makeRecorderDir();
    const recorder = createInferenceRecorder(dir);

    await expect(
      runInference(
        { phase: "plan", telemetry: { investigationId: "inv_TEST", recorder } },
        BASE_PARAMS,
        {
          create: async () => {
            throw new Error("boom");
          },
        },
      ),
    ).rejects.toThrow("boom");

    const records = await readRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "failed",
      errorCategory: "unknown",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      stopReason: null,
      estimatedCostUsd: null,
      attemptCount: 1,
    });
  });

  test("recorder failure never breaks the inference result", async () => {
    // Point the recorder at a path that cannot be a directory.
    const dir = await makeRecorderDir();
    const filePath = path.join(dir, "not-a-dir");
    await readdir(dir); // dir exists
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "occupied", "utf8");
    const recorder = createInferenceRecorder(path.join(filePath, "child"));

    const message = await runInference(
      { phase: "analysis", telemetry: { investigationId: "inv_TEST", recorder } },
      BASE_PARAMS,
      { create: async () => fakeMessage() },
    );

    expect(message.stop_reason).toBe("end_turn");
    expect(recorder.failures).toBe(1);
    expect(recorder.lastError).toBeTruthy();
  });

  test("null telemetry runs untelemetered without error", async () => {
    const message = await runInference({ phase: "reproduce", telemetry: null }, BASE_PARAMS, {
      create: async () => fakeMessage(),
    });

    expect(message.role).toBe("assistant");
  });

  test("thinking stays disabled by default and honors caller override", async () => {
    let seen: Anthropic.Messages.MessageCreateParamsNonStreaming | null = null;
    const create = async (params: Anthropic.Messages.MessageCreateParamsNonStreaming) => {
      seen = params;
      return fakeMessage();
    };

    await runInference({ phase: "fix" }, BASE_PARAMS, { create });
    expect(seen!.thinking).toEqual({ type: "disabled" });

    await runInference(
      { phase: "fix" },
      { ...BASE_PARAMS, thinking: { type: "enabled", budget_tokens: 2048 } },
      { create },
    );
    expect(seen!.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });

    await runInference(
      { phase: "fix", policy: { thinking: { type: "enabled", budgetTokens: 1024 } } },
      BASE_PARAMS,
      { create },
    );
    expect(seen!.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("gateway-owned retries count attempts, disable SDK retries, and never retry aborts", async () => {
    const dir = await makeRecorderDir();
    const recorder = createInferenceRecorder(dir);
    let calls = 0;
    let seenOptions: { maxRetries?: number } | undefined;

    const message = await runInference(
      {
        phase: "fix",
        telemetry: { investigationId: "inv_TEST", recorder },
        policy: { maxAttempts: 3 },
      },
      BASE_PARAMS,
      {
        create: async (_params, options) => {
          seenOptions = options;
          calls += 1;
          if (calls < 2) throw new Error("transient network flake");
          return fakeMessage();
        },
      },
    );

    expect(message.stop_reason).toBe("end_turn");
    expect(calls).toBe(2);
    expect(seenOptions?.maxRetries).toBe(0);

    const records = await readRecords(dir);
    expect(records[0]).toMatchObject({ status: "succeeded", attemptCount: 2 });

    // Aborts are terminal even with attempts remaining.
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    let abortCalls = 0;
    await expect(
      runInference(
        { phase: "fix", policy: { maxAttempts: 3 } },
        BASE_PARAMS,
        {
          create: async () => {
            abortCalls += 1;
            throw abortError;
          },
        },
      ),
    ).rejects.toThrow("aborted");
    expect(abortCalls).toBe(1);
  });

  test("permanent API errors are not retried", async () => {
    let calls = 0;
    const error = new Anthropic.BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "bad" } },
      "bad request",
      new Headers(),
    );
    await expect(
      runInference(
        { phase: "fix", policy: { maxAttempts: 3 } },
        BASE_PARAMS,
        {
          create: async () => {
            calls += 1;
            throw error;
          },
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("service tier is sent and actual response tier is recorded", async () => {
    const dir = await makeRecorderDir();
    const recorder = createInferenceRecorder(dir);
    let seen: Anthropic.Messages.MessageCreateParamsNonStreaming | null = null;
    await runInference(
      {
        phase: "fix",
        policy: { serviceTier: "standard_only" },
        telemetry: { investigationId: "inv_TEST", recorder },
      },
      BASE_PARAMS,
      {
        create: async (params) => {
          seen = params;
          return fakeMessage({
            usage: {
              ...fakeMessage().usage,
              service_tier: "standard",
            } as Anthropic.Messages.Usage,
          });
        },
      },
    );
    expect(seen!.service_tier).toBe("standard_only");
    expect((await readRecords(dir))[0].serviceTier).toBe("standard");
  });

  test("default retries are gateway-owned and SDK retries are disabled", async () => {
    let seenOptions: unknown = "sentinel";
    await runInference({ phase: "plan" }, BASE_PARAMS, {
      create: async (_params, options) => {
        seenOptions = options;
        return fakeMessage();
      },
    });

    expect(seenOptions).toEqual({ maxRetries: 0 });
  });

  test("concurrent calls append every record without corruption", async () => {
    const dir = await makeRecorderDir();
    const recorder = createInferenceRecorder(dir);

    await Promise.all(
      Array.from({ length: 12 }, (_value, index) =>
        runInference(
          { phase: "reproduce", telemetry: { investigationId: `inv_${index}`, recorder } },
          BASE_PARAMS,
          { create: async () => fakeMessage() },
        ),
      ),
    );

    const records = await readRecords(dir);
    expect(records).toHaveLength(12);
    expect(new Set(records.map((record) => record.logicalCallId)).size).toBe(12);
  });

  test("pricing: known model computes cost from the table; unknown stays null", async () => {
    const pricing = {
      schemaVersion: 1,
      currency: "USD",
      models: {
        "claude-sonnet-5": {
          effectiveDate: "2026-01-01",
          perMTok: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
        },
      },
    };
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreation5mTokens: 1_000_000,
      cacheCreation1hTokens: 0,
    };

    expect(estimateCostUsd(pricing, "claude-sonnet-5", usage)).toBeCloseTo(3 + 15 + 0.3 + 3.75);
    expect(estimateCostUsd(pricing, "some-unknown-model", usage)).toBeNull();
    expect(estimateCostUsd(null, "claude-sonnet-5", usage)).toBeNull();
    expect(
      estimateCostUsd(pricing, "claude-sonnet-5", { ...usage, inputTokens: null }),
    ).toBeNull();
  });
});

describe("applyCacheMode", () => {
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    ...BASE_PARAMS,
    system: "You are a test system prompt.",
    tools: [
      { name: "a", input_schema: { type: "object" as const, properties: {} } },
      { name: "b", input_schema: { type: "object" as const, properties: {} } },
    ],
  };

  test("off returns the exact same params object (pre-gateway bytes preserved)", () => {
    expect(applyCacheMode(params, "off")).toBe(params);
    expect(applyCacheMode(params, undefined)).toBe(params);
  });

  test("system_and_tools marks system prompt and last tool only", () => {
    const marked = applyCacheMode(params, "system_and_tools");

    expect(marked).not.toBe(params);
    expect(marked.system).toEqual([
      {
        type: "text",
        text: "You are a test system prompt.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect((marked.tools![0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((marked.tools![1] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
    });
    // Original params are never mutated.
    expect(typeof params.system).toBe("string");
    expect((params.tools![1] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });
});

describe("classifyError", () => {
  test("categories", () => {
    const abort = new Error("x");
    abort.name = "AbortError";
    expect(classifyError(abort)).toBe("aborted");
    expect(classifyError(new Error("Request timed out"))).toBe("timeout");
    expect(classifyError(new Error("ECONNREFUSED 127.0.0.1"))).toBe("network");
    expect(classifyError(new Error("weird"))).toBe("unknown");
  });
});

describe("SDK-call guard", () => {
  test("no production file outside the gateway constructs an Anthropic client or calls messages.create", async () => {
    const { readdir: rd, readFile: rf } = await import("node:fs/promises");
    const root = new URL("../backend", import.meta.url).pathname;
    const offenders: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await rd(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const relative = path.relative(root, full);
          if (relative === path.join("services", "inference.ts")) continue;
          const contents = await rf(full, "utf8");
          if (/new Anthropic\(|messages\.create\(/.test(contents)) {
            offenders.push(relative);
          }
        }
      }
    };

    await walk(root);
    expect(offenders).toEqual([]);
  });
});
