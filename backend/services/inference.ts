// Central inference gateway (FABLE_IMPLEMENTATION_PROMPT.md, Phase 1.1).
//
// Every production model call flows through runInference(), which adds
// measurement WITHOUT changing prompt content, tool schemas, model selection,
// or response semantics by default:
//
// - One append-only JSONL record per LOGICAL call (success or failure) via a
//   crash-safe recorder. Telemetry failures are counted and surfaced on the
//   recorder, never thrown into the inference path.
// - Thinking stays disabled unless the caller's params or an explicit policy
//   enable it (same default as the previous createModelMessage wrapper).
// - Prompt-cache markers (cacheMode "system_and_tools") exist but default to
//   "off"; behavior is byte-identical to pre-gateway requests until a policy
//   turns them on.
// - Costs come from a versioned pricing file keyed by exact model id. An
//   unknown model/tier yields estimatedCostUsd: null — never a guessed cost.
//
// Retry semantics: the gateway owns every retry and always disables SDK
// retries. This keeps attemptCount accurate and lets eval budget guards stop
// work before an HTTP request is made.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// Lazy client, same pattern as claude.ts: importing this module (e.g. from
// tests with injected create functions) never requires ANTHROPIC_API_KEY.
let client: Anthropic | null = null;

function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

// --- Types (FABLE_IMPLEMENTATION_PROMPT.md §1.1) -----------------------------

export type AgentPhase =
  | "plan" // one-shot reproduction plan
  | "reproduce" // reproducer agent loop
  | "fix" // fixer agent loop
  | "regression_test" // regression-test proposal
  | "analysis" // analyzeIssue diagnostic
  | "memory_reflection" // memory reflection
  | "grader"; // eval-only model grader

export interface InferencePolicy {
  model?: string;
  maxTokens?: number;
  thinking?: { type: "enabled"; budgetTokens: number };
  cacheMode?: "off" | "system_and_tools";
  serviceTier?: "auto" | "standard_only";
  maxAttempts?: number;
  timeoutMs?: number;
  tags?: Record<string, string>;
}

export interface InferenceRecord {
  schemaVersion: 1;
  logicalCallId: string;
  investigationId: string;
  phase: AgentPhase;
  model: string;
  serviceTier?: string;
  status: "succeeded" | "failed";
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  attemptCount: number;
  errorCategory?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
  thinkingTokens: number | null;
  stopReason: string | null;
  estimatedCostUsd: number | null;
  tags?: Record<string, string>;
}

// A recorder never throws into the caller. Failures are counted and the last
// error is retained for observability/tests.
export type InferenceRecorder = {
  record: (record: InferenceRecord) => Promise<void>;
  readonly failures: number;
  readonly lastError: string | null;
};

// Threaded from the orchestrator to every call site. `recorder: null` means
// telemetry is unavailable (e.g. before an artifact store exists); the call
// itself is unaffected. `policies` carries optional per-phase inference
// policies (Phase 2 experiments): a call site's phase selects its policy, so
// per-task policy flows through the existing threading with no signature
// churn. Absent phases keep default behavior.
export type InferenceTelemetry = {
  investigationId: string;
  recorder: InferenceRecorder | null;
  policies?: Partial<Record<AgentPhase, InferencePolicy>>;
  budgetGuard?: InferenceBudgetGuard;
};

export type InferenceBudgetReservation = {
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  estimatedCostUsd: number | null;
  maxAttempts: number;
};

export type InferenceBudgetGuard = {
  beforeLogicalCall: (
    reservation: InferenceBudgetReservation,
  ) => void | Promise<void>;
  beforeHttpAttempt: () => void | Promise<void>;
};

export type InferenceContext = {
  phase: AgentPhase;
  telemetry?: InferenceTelemetry | null;
  policy?: InferencePolicy;
};

export type CreateFn = (
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  options?: { timeout?: number; maxRetries?: number },
) => Promise<Anthropic.Messages.Message>;

export type InferenceDeps = {
  create?: CreateFn;
  now?: () => number;
};

// --- Recorder ----------------------------------------------------------------

export const INFERENCE_RECORDS_FILE = "inference-records.jsonl";
// Bound one serialized record line. Tags are the only unbounded-ish field and
// are truncated first; a record that still exceeds the cap is dropped and
// counted as a recorder failure rather than corrupting the JSONL stream.
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_TAG_VALUE_CHARS = 200;

export function createInferenceRecorder(dir: string): InferenceRecorder {
  const filePath = path.join(dir, INFERENCE_RECORDS_FILE);
  // Serialize concurrent appends: each write awaits the previous one, so
  // interleaved half-lines cannot occur within this process.
  let queue: Promise<void> = Promise.resolve();
  let failures = 0;
  let lastError: string | null = null;

  return {
    get failures() {
      return failures;
    },
    get lastError() {
      return lastError;
    },
    record: (record: InferenceRecord) => {
      queue = queue.then(async () => {
        try {
          const line = JSON.stringify(sanitizeRecord(record));

          if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
            throw new Error(
              `inference record exceeds ${MAX_RECORD_BYTES} bytes and was dropped`,
            );
          }

          await mkdir(dir, { recursive: true });
          await appendFile(filePath, `${line}\n`, "utf8");
        } catch (error) {
          failures += 1;
          lastError = error instanceof Error ? error.message : String(error);
        }
      });

      return queue;
    },
  };
}

function sanitizeRecord(record: InferenceRecord): InferenceRecord {
  if (!record.tags) {
    return record;
  }

  const tags: Record<string, string> = {};

  for (const [key, value] of Object.entries(record.tags).slice(0, 20)) {
    tags[key.slice(0, 64)] = String(value).slice(0, MAX_TAG_VALUE_CHARS);
  }

  return { ...record, tags };
}

// --- Pricing (versioned, exact-model; unknown => null) ------------------------
//
// evals/pricing.v1.json shape:
// {
//   "schemaVersion": 1,
//   "currency": "USD",
//   "models": {
//     "<exact-model-id>": {
//       "effectiveDate": "YYYY-MM-DD",
//       "perMTok": { "input": n, "output": n, "cacheRead": n,
//                     "cacheWrite5m": n, "cacheWrite1h": n }
//     }
//   }
// }
// Rates must be filled in by an operator from the provider's current price
// sheet. This repository intentionally ships an EMPTY models map: an unknown
// model produces estimatedCostUsd: null and a report-level warning downstream
// — never a guessed cost.

type ModelPricing = {
  effectiveDate: string;
  perMTok: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  };
};

type PricingTable = {
  schemaVersion: number;
  currency: string;
  models: Record<string, ModelPricing>;
};

let pricingCache: PricingTable | null | undefined;

export function resolvePricingPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHERLOCK_PRICING_FILE?.trim() || path.resolve("evals", "pricing.v1.json");
}

async function loadPricing(): Promise<PricingTable | null> {
  if (pricingCache !== undefined) {
    return pricingCache;
  }

  try {
    const raw = await readFile(resolvePricingPath(), "utf8");
    const parsed = JSON.parse(raw) as PricingTable;
    pricingCache =
      parsed && parsed.schemaVersion === 1 && parsed.models && typeof parsed.models === "object"
        ? parsed
        : null;
  } catch {
    pricingCache = null;
  }

  return pricingCache;
}

export async function estimateRequestCostUsd(
  model: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): Promise<number | null> {
  return estimateCostUsd(await loadPricing(), model, {
    inputTokens: estimatedInputTokens,
    outputTokens: maxOutputTokens,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
  });
}

// Test seam: reset the memoized pricing table.
export function resetPricingCacheForTests(): void {
  pricingCache = undefined;
}

export function estimateCostUsd(
  pricing: PricingTable | null,
  model: string,
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreation5mTokens: number | null;
    cacheCreation1hTokens: number | null;
  },
): number | null {
  const rates = pricing?.models[model];

  if (!rates || usage.inputTokens === null || usage.outputTokens === null) {
    return null;
  }

  const per = rates.perMTok;
  const cost =
    (usage.inputTokens * per.input +
      usage.outputTokens * per.output +
      (usage.cacheReadTokens ?? 0) * per.cacheRead +
      (usage.cacheCreation5mTokens ?? 0) * per.cacheWrite5m +
      (usage.cacheCreation1hTokens ?? 0) * per.cacheWrite1h) /
    1_000_000;

  return Number.isFinite(cost) ? cost : null;
}

// --- Cache markers (default off) ----------------------------------------------

// "system_and_tools": mark the end of the system prompt and the last tool
// definition as cache breakpoints. Only structural wrapping is performed; text
// content is never modified. With cacheMode "off" (the default), params are
// returned unchanged (same object), preserving pre-gateway request bytes.
export function applyCacheMode(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  cacheMode: InferencePolicy["cacheMode"],
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  if (cacheMode !== "system_and_tools") {
    return params;
  }

  const next = { ...params };

  if (typeof next.system === "string") {
    next.system = [
      { type: "text", text: next.system, cache_control: { type: "ephemeral" } },
    ];
  } else if (Array.isArray(next.system) && next.system.length > 0) {
    next.system = next.system.map((block, index) =>
      index === next.system!.length - 1
        ? { ...block, cache_control: { type: "ephemeral" } }
        : block,
    );
  }

  if (Array.isArray(next.tools) && next.tools.length > 0) {
    next.tools = next.tools.map((tool, index) =>
      index === next.tools!.length - 1
        ? ({ ...tool, cache_control: { type: "ephemeral" } } as typeof tool)
        : tool,
    );
  }

  return next;
}

// --- Gateway -------------------------------------------------------------------

let callCounter = 0;

function nextLogicalCallId(): string {
  callCounter += 1;
  return `inf_${Date.now().toString(36)}_${callCounter.toString(36)}`;
}

export function classifyError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/timed? ?out/i.test(message)) {
    return "timeout";
  }

  if (error instanceof Anthropic.APIError) {
    return `api_${error.status ?? "error"}`;
  }

  if (/fetch|network|ECONNREFUSED|ENOTFOUND|socket/i.test(message)) {
    return "network";
  }

  return "unknown";
}

export function isRetryableInferenceError(error: unknown): boolean {
  const category = classifyError(error);
  if (category === "timeout" || category === "network") return true;
  if (!category.startsWith("api_")) return false;
  const status = Number(category.slice(4));
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function estimateInputTokens(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): number {
  // A conservative, deterministic reservation. Actual usage is still
  // recorded from the provider response.
  return Math.ceil(Buffer.byteLength(JSON.stringify({
    system: params.system,
    tools: params.tools,
    messages: params.messages,
  }), "utf8") / 3);
}

// The single production entry point for model calls. Default behavior is
// semantically identical to the previous createModelMessage(): thinking
// disabled unless the caller opts in, no cache markers, and gateway-owned
// retry accounting.
export async function runInference(
  context: InferenceContext,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  deps: InferenceDeps = {},
): Promise<Anthropic.Messages.Message> {
  const create: CreateFn =
    deps.create ?? ((finalParams, options) => getClient().messages.create(finalParams, options));
  const now = deps.now ?? Date.now;
  const policy =
    context.policy ?? context.telemetry?.policies?.[context.phase] ?? {};

  // Assemble final params. Preserved default: thinking disabled unless the
  // caller's params or the policy explicitly enable it (claude.ts:44-51).
  let finalParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    thinking: policy.thinking
      ? { type: "enabled", budget_tokens: policy.thinking.budgetTokens }
      : { type: "disabled" },
    ...params,
    ...(policy.model ? { model: policy.model } : {}),
    ...(policy.maxTokens ? { max_tokens: policy.maxTokens } : {}),
    ...(policy.serviceTier ? { service_tier: policy.serviceTier } : {}),
  };
  finalParams = applyCacheMode(finalParams, policy.cacheMode ?? "off");

  const maxAttempts = Math.max(1, policy.maxAttempts ?? 3);
  const requestOptions: { timeout?: number; maxRetries?: number } = {
    ...(policy.timeoutMs ? { timeout: policy.timeoutMs } : {}),
    maxRetries: 0,
  };

  const estimatedInputTokens = estimateInputTokens(finalParams);
  await context.telemetry?.budgetGuard?.beforeLogicalCall({
    model: finalParams.model,
    estimatedInputTokens,
    maxOutputTokens: finalParams.max_tokens,
    estimatedCostUsd: await estimateRequestCostUsd(
      finalParams.model,
      estimatedInputTokens,
      finalParams.max_tokens,
    ),
    maxAttempts,
  });

  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  let attemptCount = 0;
  let lastError: unknown = null;
  let message: Anthropic.Messages.Message | null = null;

  while (attemptCount < maxAttempts) {
    await context.telemetry?.budgetGuard?.beforeHttpAttempt();
    attemptCount += 1;

    try {
      message = await create(finalParams, requestOptions);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;

      if (!isRetryableInferenceError(error)) {
        break;
      }
    }
  }

  const finishedAtMs = now();
  const usage = message?.usage ?? null;
  const cacheCreation = usage?.cache_creation ?? null;
  const usageFields = {
    inputTokens: usage ? usage.input_tokens : null,
    outputTokens: usage ? usage.output_tokens : null,
    cacheReadTokens: usage ? (usage.cache_read_input_tokens ?? null) : null,
    cacheCreationTokens: usage ? (usage.cache_creation_input_tokens ?? null) : null,
    cacheCreation5mTokens: cacheCreation ? cacheCreation.ephemeral_5m_input_tokens : null,
    cacheCreation1hTokens: cacheCreation ? cacheCreation.ephemeral_1h_input_tokens : null,
    // The SDK does not expose a separate thinking-token count in usage;
    // thinking tokens bill as output tokens. Recorded as null, not zero.
    thinkingTokens: null,
  };

  const record: InferenceRecord = {
    schemaVersion: 1,
    logicalCallId: nextLogicalCallId(),
    investigationId: context.telemetry?.investigationId ?? "(unattributed)",
    phase: context.phase,
    model: message?.model ?? finalParams.model,
    ...((usage as { service_tier?: string } | null)?.service_tier || policy.serviceTier
      ? { serviceTier: (usage as { service_tier?: string } | null)?.service_tier ?? policy.serviceTier }
      : {}),
    status: message ? "succeeded" : "failed",
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    latencyMs: finishedAtMs - startedAtMs,
    attemptCount,
    ...(lastError !== null ? { errorCategory: classifyError(lastError) } : {}),
    ...usageFields,
    stopReason: message?.stop_reason ?? null,
    estimatedCostUsd: estimateCostUsd(
      await loadPricing(),
      message?.model ?? finalParams.model,
      usageFields,
    ),
    ...(policy.tags ? { tags: policy.tags } : {}),
  };

  // Never log prompt bodies, tool payloads, or response bodies: the record
  // contains only identifiers, counters, and enums by construction.
  if (context.telemetry?.recorder) {
    const failuresBefore = context.telemetry.recorder.failures;
    await context.telemetry.recorder.record(record);
    if (context.telemetry.recorder.failures > failuresBefore) {
      console.warn(
        `Inference telemetry write failed: ${context.telemetry.recorder.lastError ?? "unknown recorder error"}`,
      );
    }
  }

  if (!message) {
    throw lastError;
  }

  return message;
}
