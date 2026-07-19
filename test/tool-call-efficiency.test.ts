// fable/16-tool-call-efficiency-prompt.md: deterministic regression coverage
// for the new contracts — efficiency policy resolution, conversation cache
// markers, policy composition, run_code output validation, container specs,
// page-snapshot deltas, warm-start rendering, and the budget snapshot that
// fails if this work ever changes a pre-existing budget value.

import { EventEmitter } from "node:events";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_EFFICIENCY_POLICY,
  resolveEfficiencyPolicy,
} from "../backend/services/efficiency-policy.js";
import {
  applyCacheMode,
  mergeInferencePolicies,
} from "../backend/services/inference.js";
import {
  parseRunCodeTimeout,
  executeRunCode,
  validateRunCodeEvidence,
  validateRunCodeOutput,
  RUN_CODE_LIMITS,
} from "../backend/agents/run-code.js";
import { buildContainerRunArgs } from "../backend/services/container.js";
import {
  computePageSnapshotDelta,
  formatPageSnapshot,
} from "../backend/services/playwright.js";
import { planToolBatch, READ_ONLY_FIXER_TOOLS } from "../backend/agents/tool-batch.js";
import {
  DEEP_FIXER_BUDGETS,
  getFixerMinimumInspections,
  STANDARD_FIXER_BUDGETS,
} from "../backend/agents/fixer.js";
import {
  DEEP_REPRODUCER_BUDGETS,
  STANDARD_REPRODUCER_BUDGETS,
  formatPriorAttemptSection,
} from "../backend/agents/reproducer.js";
import { COMPACTION_DEFAULTS, createCompactor } from "../backend/agents/compaction.js";
import {
  buildPriorReproductionAttempt,
  shouldForceReproducerAgent,
} from "../backend/services/investigation.js";
import type { DockerAdapter } from "../backend/services/container.js";

// --- Budget snapshot (fable/16: "Do not change any standard or deep budget") --

describe("budget snapshot", () => {
  test("every pre-existing budget value is unchanged by the efficiency work", () => {
    // Fixer shared limits.
    expect(STANDARD_FIXER_BUDGETS.maxWallTimeMs).toBe(15 * 60_000);
    expect(STANDARD_FIXER_BUDGETS.maxResponseTokens).toBe(4_000);
    expect(STANDARD_FIXER_BUDGETS.maxFileBytes).toBe(64 * 1024);
    expect(STANDARD_FIXER_BUDGETS.maxGrepLines).toBe(50);
    expect(STANDARD_FIXER_BUDGETS.maxAttemptFeedbackBytes).toBe(4 * 1024);
    expect(STANDARD_FIXER_BUDGETS.maxEvidenceBytes).toBe(300 * 1024);
    // Fixer standard profile.
    expect(STANDARD_FIXER_BUDGETS.maxModelTurns).toBe(10);
    expect(STANDARD_FIXER_BUDGETS.maxReadFileCalls).toBe(4);
    expect(STANDARD_FIXER_BUDGETS.maxGrepCalls).toBe(2);
    expect(STANDARD_FIXER_BUDGETS.maxGraphCalls).toBe(3);
    expect(STANDARD_FIXER_BUDGETS.maxExplorationBeforeFirstPatch).toBe(6);
    expect(STANDARD_FIXER_BUDGETS.maxPatchAttempts).toBe(2);
    // Fixer deep profile.
    expect(DEEP_FIXER_BUDGETS.maxModelTurns).toBe(30);
    expect(DEEP_FIXER_BUDGETS.maxReadFileCalls).toBe(20);
    expect(DEEP_FIXER_BUDGETS.maxGrepCalls).toBe(10);
    expect(DEEP_FIXER_BUDGETS.maxGraphCalls).toBe(10);
    expect(DEEP_FIXER_BUDGETS.maxExplorationBeforeFirstPatch).toBe(12);
    expect(DEEP_FIXER_BUDGETS.maxPatchAttempts).toBe(3);
    // Reproducer shared limits.
    expect(STANDARD_REPRODUCER_BUDGETS.maxWallTimeMs).toBe(10 * 60_000);
    expect(STANDARD_REPRODUCER_BUDGETS.maxResponseTokens).toBe(4_000);
    expect(STANDARD_REPRODUCER_BUDGETS.maxDigestBytes).toBe(16 * 1024);
    expect(STANDARD_REPRODUCER_BUDGETS.maxEvidenceBytes).toBe(300 * 1024);
    // Reproducer standard profile.
    expect(STANDARD_REPRODUCER_BUDGETS.maxModelTurns).toBe(16);
    expect(STANDARD_REPRODUCER_BUDGETS.maxBrowserActions).toBe(8);
    expect(STANDARD_REPRODUCER_BUDGETS.maxRequestCalls).toBe(8);
    expect(STANDARD_REPRODUCER_BUDGETS.maxReadPageCalls).toBe(5);
    expect(STANDARD_REPRODUCER_BUDGETS.maxPlanSubmissions).toBe(2);
    // Reproducer deep profile.
    expect(DEEP_REPRODUCER_BUDGETS.maxModelTurns).toBe(40);
    expect(DEEP_REPRODUCER_BUDGETS.maxBrowserActions).toBe(30);
    expect(DEEP_REPRODUCER_BUDGETS.maxRequestCalls).toBe(15);
    expect(DEEP_REPRODUCER_BUDGETS.maxReadPageCalls).toBe(15);
    expect(DEEP_REPRODUCER_BUDGETS.maxPlanSubmissions).toBe(3);
    // Compaction triggers stay 6 tool calls / 60KB / 2 kept pairs.
    expect(COMPACTION_DEFAULTS.everyToolCalls).toBe(6);
    expect(COMPACTION_DEFAULTS.byteThreshold).toBe(60 * 1024);
    expect(COMPACTION_DEFAULTS.keepLastPairs).toBe(2);
  });
});

describe("agent observation switches", () => {
  test("force-reproducer routing is opt-in and policy overrides the environment", () => {
    expect(shouldForceReproducerAgent(undefined, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      shouldForceReproducerAgent(undefined, {
        SHERLOCK_FORCE_REPRODUCER_AGENT: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldForceReproducerAgent(false, {
        SHERLOCK_FORCE_REPRODUCER_AGENT: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  test("fixer minimum inspections defaults off and is bounded by the exploration cap", () => {
    expect(getFixerMinimumInspections(STANDARD_FIXER_BUDGETS, {} as NodeJS.ProcessEnv)).toBe(0);
    expect(
      getFixerMinimumInspections(STANDARD_FIXER_BUDGETS, {
        SHERLOCK_FIXER_MIN_INSPECTIONS: "2",
      } as NodeJS.ProcessEnv),
    ).toBe(2);
    expect(
      getFixerMinimumInspections(STANDARD_FIXER_BUDGETS, {
        SHERLOCK_FIXER_MIN_INSPECTIONS: "999",
      } as NodeJS.ProcessEnv),
    ).toBe(STANDARD_FIXER_BUDGETS.maxExplorationBeforeFirstPatch);
  });
});

// --- Efficiency policy resolution ------------------------------------------------

describe("resolveEfficiencyPolicy", () => {
  test("defaults every completed feature on", () => {
    const policy = resolveEfficiencyPolicy({} as NodeJS.ProcessEnv, () => {});
    expect(policy).toEqual(DEFAULT_EFFICIENCY_POLICY);
  });

  test("kill switches disable individual features", () => {
    const policy = resolveEfficiencyPolicy(
      {
        SHERLOCK_PROMPT_CACHE: "off",
        SHERLOCK_COMPACTION: "false",
        SHERLOCK_FIXER_PARALLEL_READS: "false",
        SHERLOCK_FIXER_RUN_CODE: "false",
        SHERLOCK_REPRODUCER_RUN_STEPS: "false",
        SHERLOCK_REPRODUCER_ACTION_DELTAS: "false",
        SHERLOCK_REPRODUCER_WARM_START: "false",
      } as unknown as NodeJS.ProcessEnv,
      () => {},
    );

    expect(policy.promptCacheMode).toBe("off");
    expect(policy.compaction).toBe(false);
    expect(policy.fixerParallelReads).toBe(false);
    expect(policy.fixerRunCode).toBe(false);
    expect(policy.reproducerRunSteps).toBe(false);
    expect(policy.reproducerActionDeltas).toBe(false);
    expect(policy.reproducerWarmStart).toBe(false);
  });

  test("unknown values fail safely to the default and warn", () => {
    const warnings: string[] = [];
    const policy = resolveEfficiencyPolicy(
      {
        SHERLOCK_PROMPT_CACHE: "everything",
        SHERLOCK_FIXER_RUN_CODE: "yes-please",
      } as unknown as NodeJS.ProcessEnv,
      (message) => warnings.push(message),
    );

    expect(policy.promptCacheMode).toBe("conversation");
    expect(policy.fixerRunCode).toBe(true);
    expect(warnings.length).toBe(2);
  });

  test("the resolved policy is frozen (immutable for the whole run)", () => {
    const policy = resolveEfficiencyPolicy({} as NodeJS.ProcessEnv, () => {});
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

// --- Conversation cache markers ---------------------------------------------------

type Params = Anthropic.Messages.MessageCreateParamsNonStreaming;

function makeParams(): Params {
  return {
    model: "claude-sonnet-5",
    max_tokens: 100,
    system: "You are a test.",
    tools: [
      { name: "a", input_schema: { type: "object" as const } },
      { name: "b", input_schema: { type: "object" as const } },
    ],
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "result" },
        ],
      },
    ],
  } as Params;
}

describe("applyCacheMode conversation", () => {
  test("marks system, last tool, and last message's last block; never mutates input", () => {
    const params = makeParams();
    const originalJson = JSON.stringify(params);
    const next = applyCacheMode(params, "conversation");

    // Caller input untouched (copy-on-write).
    expect(JSON.stringify(params)).toBe(originalJson);
    expect(next).not.toBe(params);

    const system = next.system as Array<{ cache_control?: unknown }>;
    expect(system[system.length - 1].cache_control).toEqual({ type: "ephemeral" });

    const tools = next.tools as Array<{ cache_control?: unknown }>;
    expect(tools[tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
    expect(tools[0].cache_control).toBeUndefined();

    const lastMessage = next.messages[next.messages.length - 1];
    const blocks = lastMessage.content as Array<{ cache_control?: unknown }>;
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: "ephemeral" });

    // Max 4 provider breakpoints; this uses exactly 3.
    const markerCount = JSON.stringify(next).split('"ephemeral"').length - 1;
    expect(markerCount).toBe(3);

    // Earlier messages are the caller's SAME objects: the cached prefix is
    // byte-identical across turns by construction.
    expect(next.messages[0]).toBe(params.messages[0]);
    expect(next.messages[1]).toBe(params.messages[1]);
  });

  test("string content of the last message is wrapped, not modified", () => {
    const params = makeParams();
    params.messages = [{ role: "user", content: "hello" }];
    const next = applyCacheMode(params, "conversation");
    const blocks = next.messages[0].content as Array<{
      type: string;
      text?: string;
      cache_control?: unknown;
    }>;

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("hello");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("thinking blocks are skipped; the marker lands on the last cacheable block", () => {
    const params = makeParams();
    params.messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "visible" },
          { type: "thinking", thinking: "hidden", signature: "s" },
        ] as unknown as Anthropic.Messages.ContentBlockParam[],
      },
    ];
    const next = applyCacheMode(params, "conversation");
    const blocks = next.messages[0].content as Array<{
      type: string;
      cache_control?: unknown;
    }>;

    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toBeUndefined();
  });

  test('"off" returns the identical params object', () => {
    const params = makeParams();
    expect(applyCacheMode(params, "off")).toBe(params);
    expect(applyCacheMode(params, undefined)).toBe(params);
  });

  test("two consecutive turn payloads share an identical prefix up to the previous turn's end", () => {
    const turnOne = makeParams();
    const markedOne = applyCacheMode(turnOne, "conversation");

    // Turn two appends the assistant response + tool result (append-only).
    const turnTwo = makeParams();
    turnTwo.messages = [
      ...turnOne.messages,
      { role: "assistant", content: [{ type: "text", text: "next" }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "r2" }],
      },
    ];
    const markedTwo = applyCacheMode(turnTwo, "conversation");

    // System and tools serialize byte-identically across turns.
    expect(JSON.stringify(markedTwo.system)).toBe(JSON.stringify(markedOne.system));
    expect(JSON.stringify(markedTwo.tools)).toBe(JSON.stringify(markedOne.tools));

    // Every message BEFORE turn one's breakpoint position serializes
    // identically in turn two (the moving marker only touches the last
    // message of each request).
    for (let index = 0; index < turnOne.messages.length - 1; index += 1) {
      expect(JSON.stringify(markedTwo.messages[index])).toBe(
        JSON.stringify(markedOne.messages[index]),
      );
    }
  });
});

// --- Policy composition -----------------------------------------------------------

describe("mergeInferencePolicies", () => {
  test("context fields win but unrelated phase-policy fields survive", () => {
    const merged = mergeInferencePolicies(
      {
        model: "phase-model",
        maxTokens: 9_000,
        serviceTier: "standard_only",
        maxAttempts: 5,
        timeoutMs: 120_000,
        thinking: { type: "enabled", budgetTokens: 2_000 },
        tags: { phase: "fix", experiment: "x1" },
        cacheMode: "off",
      },
      { cacheMode: "conversation", tags: { caller: "agent" } },
    );

    expect(merged.cacheMode).toBe("conversation");
    expect(merged.model).toBe("phase-model");
    expect(merged.maxTokens).toBe(9_000);
    expect(merged.serviceTier).toBe("standard_only");
    expect(merged.maxAttempts).toBe(5);
    expect(merged.timeoutMs).toBe(120_000);
    expect(merged.thinking).toEqual({ type: "enabled", budgetTokens: 2_000 });
    expect(merged.tags).toEqual({ phase: "fix", experiment: "x1", caller: "agent" });
  });

  test("explicitly undefined override fields do not clobber the base", () => {
    const merged = mergeInferencePolicies(
      { model: "phase-model" },
      { model: undefined, cacheMode: "conversation" },
    );
    expect(merged.model).toBe("phase-model");
  });
});

// --- run_code output contract -----------------------------------------------------

const VALID_RUN_CODE_OUTPUT = JSON.stringify({
  summary: "The handler drops the id field.",
  queriesRun: ["rg -n 'writeTaskList'"],
  filesConsidered: ["src/api/tasks.js", "src/store.js"],
  filesExamined: ["src/api/tasks.js"],
  evidence: [
    {
      path: "src/api/tasks.js",
      startLine: 10,
      endLine: 14,
      excerpt: "delete task.id;",
      reason: "id removed before persistence",
    },
  ],
  uncertainties: ["store.js rewrite path not checked"],
});

describe("validateRunCodeOutput", () => {
  test("accepts the full contract and normalizes paths", () => {
    const outcome = validateRunCodeOutput(VALID_RUN_CODE_OUTPUT);
    expect(outcome.ok).toBe(true);

    if (outcome.ok) {
      expect(outcome.result.evidence[0].path).toBe("src/api/tasks.js");
      expect(outcome.result.summary).toContain("drops the id field");
    }
  });

  test("tolerates script noise around exactly one JSON object", () => {
    const outcome = validateRunCodeOutput(`warning: blah\n${VALID_RUN_CODE_OUTPUT}\n`);
    expect(outcome.ok).toBe(true);
  });

  test("rejects prose, missing fields, escaping paths, and bad ranges", () => {
    expect(validateRunCodeOutput("I looked around and found nothing.").ok).toBe(false);
    expect(validateRunCodeOutput(JSON.stringify({ summary: "x" })).ok).toBe(false);

    const escaping = JSON.parse(VALID_RUN_CODE_OUTPUT);
    escaping.evidence[0].path = "../../etc/passwd";
    expect(validateRunCodeOutput(JSON.stringify(escaping)).ok).toBe(false);

    const absolute = JSON.parse(VALID_RUN_CODE_OUTPUT);
    absolute.evidence[0].path = "/app/src/api/tasks.js";
    expect(validateRunCodeOutput(JSON.stringify(absolute)).ok).toBe(false);

    const badRange = JSON.parse(VALID_RUN_CODE_OUTPUT);
    badRange.evidence[0].endLine = 2;
    expect(validateRunCodeOutput(JSON.stringify(badRange)).ok).toBe(false);
  });

  test("bounds every field", () => {
    const oversized = JSON.parse(VALID_RUN_CODE_OUTPUT);
    oversized.summary = "x".repeat(RUN_CODE_LIMITS.maxSummaryBytes * 2);
    oversized.evidence = Array.from({ length: 50 }, () => ({
      path: "src/a.js",
      startLine: 1,
      endLine: 2,
      excerpt: "y".repeat(RUN_CODE_LIMITS.maxExcerptBytes * 2),
      reason: "r",
    }));

    const outcome = validateRunCodeOutput(JSON.stringify(oversized));
    expect(outcome.ok).toBe(true);

    if (outcome.ok) {
      expect(
        Buffer.byteLength(outcome.result.summary, "utf8"),
      ).toBeLessThanOrEqual(RUN_CODE_LIMITS.maxSummaryBytes + 4);
      expect(outcome.result.evidence.length).toBeLessThanOrEqual(
        RUN_CODE_LIMITS.maxEvidenceEntries,
      );
    }
  });
});

function fakeDocker(stdout: string, exitCode: number, seenArgs: string[][]): DockerAdapter {
  return {
    isAvailable: async () => true,
    removeContainer: async () => {},
    spawnContainer: (args) => {
      seenArgs.push(args);
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        (child.stdout as PassThrough).end(stdout);
        (child.stderr as PassThrough).end();
        child.emit("close", exitCode);
      });
      return child as never;
    },
  };
}

describe("executeRunCode", () => {
  test("rejects valid-looking JSON from a nonzero script exit", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "run-code-exit-"));
    const seenArgs: string[][] = [];
    const outcome = await executeRunCode({
      repoPath,
      script: "printf result",
      rawArtifactHandle: "raw.json",
      docker: fakeDocker(VALID_RUN_CODE_OUTPUT, 1, seenArgs),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.resultText).toContain("failed with exit 1");
    expect(seenArgs[0]).toContain("GIT_CONFIG_KEY_0=safe.directory");
    expect(seenArgs[0]).toContain("GIT_CONFIG_VALUE_0=/app");
  });

  test("verifies cited files, ranges, excerpts, and symlink containment", async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), "run-code-evidence-"));
    await writeFile(path.join(repoPath, "good.js"), "one\ntwo\nthree\n", "utf8");
    const structural = validateRunCodeOutput(
      JSON.stringify({
        ...JSON.parse(VALID_RUN_CODE_OUTPUT),
        evidence: [{ path: "good.js", startLine: 2, endLine: 2, excerpt: "two", reason: "match" }],
      }),
    );
    expect(structural.ok).toBe(true);
    if (!structural.ok) return;

    expect((await validateRunCodeEvidence(repoPath, structural.result)).ok).toBe(true);

    const mismatch = {
      ...structural.result,
      evidence: [{ ...structural.result.evidence[0], excerpt: "not present" }],
    };
    expect((await validateRunCodeEvidence(repoPath, mismatch)).ok).toBe(false);

    await symlink("/etc/passwd", path.join(repoPath, "escape"));
    const escaped = {
      ...structural.result,
      evidence: [{ ...structural.result.evidence[0], path: "escape", startLine: 1, endLine: 1 }],
    };
    expect((await validateRunCodeEvidence(repoPath, escaped)).ok).toBe(false);
  });
});

describe("parseRunCodeTimeout", () => {
  test("defaults, clamps, and floors", () => {
    expect(parseRunCodeTimeout(undefined)).toBe(RUN_CODE_LIMITS.defaultTimeoutSeconds);
    expect(parseRunCodeTimeout("10")).toBe(RUN_CODE_LIMITS.defaultTimeoutSeconds);
    expect(parseRunCodeTimeout(10.9)).toBe(10);
    expect(parseRunCodeTimeout(0)).toBe(1);
    expect(parseRunCodeTimeout(10_000)).toBe(RUN_CODE_LIMITS.maxTimeoutSeconds);
  });
});

// --- run_code container spec --------------------------------------------------------

describe("run_code container isolation", () => {
  test("read-only mount and no network are expressible in the docker argv", () => {
    const args = buildContainerRunArgs({
      containerName: "sherlock-run-code-test",
      workspacePath: "/tmp/repo",
      workspaceReadOnly: true,
      env: { PATH: "/usr/bin", HOME: "/tmp" },
      command: ["/bin/sh", "-s"],
      network: "none",
      image: "sherlock-explorer:latest",
      user: "1000:1000",
    });

    expect(args).toContain("--network=none");
    expect(args).toContain("/tmp/repo:/app:ro");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args).toContain("--user=1000:1000");
    // Script travels over stdin: it must never appear in the argv.
    expect(args.join(" ")).not.toContain("rg ");
  });

  test("run_code is never a read-only batch tool; batches reject it unexecuted", () => {
    expect(READ_ONLY_FIXER_TOOLS.has("run_code")).toBe(false);
    expect(READ_ONLY_FIXER_TOOLS.has("read_many")).toBe(true);

    const plan = planToolBatch([
      { type: "tool_use", id: "1", name: "read_file", input: {} },
      { type: "tool_use", id: "2", name: "run_code", input: {} },
    ] as Anthropic.Messages.ToolUseBlock[]);

    expect(plan.execute.map((block) => block.name)).toEqual(["read_file"]);
    expect(plan.rejected.map((entry) => entry.block.name)).toEqual(["run_code"]);
  });
});

// --- Page snapshot deltas ------------------------------------------------------------

describe("computePageSnapshotDelta", () => {
  const before = {
    url: "http://localhost:3000/",
    title: "Tasks",
    elements: ['- button text="Add"', '- input placeholder="Title"'],
  };

  test("reports URL/title changes and appeared/disappeared elements deterministically", () => {
    const after = {
      url: "http://localhost:3000/tasks/1",
      title: "Task 1",
      elements: ['- button text="Add"', '- button text="Delete"'],
    };

    const delta = computePageSnapshotDelta(before, after);
    const rendered = delta.join("\n");

    expect(rendered).toContain("URL changed");
    expect(rendered).toContain("Title changed");
    expect(rendered).toContain('- button text="Delete"');
    expect(rendered).toContain('- input placeholder="Title"');
    // Unchanged elements never appear in a delta.
    expect(rendered.split('- button text="Add"').length - 1).toBe(0);
    // Deterministic: identical inputs, identical output.
    expect(computePageSnapshotDelta(before, after)).toEqual(delta);
  });

  test("no change yields an empty delta", () => {
    expect(computePageSnapshotDelta(before, { ...before })).toEqual([]);
  });

  test("formatPageSnapshot renders the read_page digest shape", () => {
    const digest = formatPageSnapshot(before);
    expect(digest).toContain("URL: http://localhost:3000/");
    expect(digest).toContain("Title: Tasks");
    expect(digest).toContain("Interactive elements:");
  });
});

// --- Warm start rendering ---------------------------------------------------------------

describe("formatPriorAttemptSection", () => {
  test("renders steps, first failure, and usage instructions; bounded", () => {
    const section = formatPriorAttemptSection({
      source: "one_shot",
      planSteps: [
        { id: "s1", action: "goto", path: "/" },
        { id: "s2", action: "click", target: { text: "Add" } },
      ] as never,
      executedSteps: [
        { id: "s1", action: "goto", outcome: "passed" },
        { id: "s2", action: "click", outcome: "failed", error: "ambiguous target" },
      ],
      failedStep: {
        id: "s2",
        action: "click",
        outcome: "failed",
        error: "ambiguous target",
      },
      evidenceSummary: "Replay outcome: execution_failed — step s2 failed",
    });

    expect(section).toContain("PRIOR SCRIPTED ATTEMPT");
    expect(section).toContain("1 of 2 step(s) passed");
    expect(section).toContain("ambiguous target");
    expect(section).toContain("run_steps");
  });

  test("absent or empty attempts render nothing (never fabricated)", () => {
    expect(formatPriorAttemptSection(null)).toBe("");
    expect(formatPriorAttemptSection(undefined)).toBe("");
    expect(
      formatPriorAttemptSection({
        source: "one_shot",
        planSteps: [],
        executedSteps: [],
        failedStep: null,
        evidenceSummary: "",
      }),
    ).toBe("");
  });

  test("output is bounded to the configured byte cap", () => {
    const section = formatPriorAttemptSection(
      {
        source: "memory_replay",
        planSteps: Array.from({ length: 40 }, (_, i) => ({
          id: `s${i}`,
          action: "request",
          method: "GET",
          path: `/api/very/long/path/number/${i}/${"x".repeat(200)}`,
        })) as never,
        executedSteps: Array.from({ length: 40 }, (_, i) => ({
          id: `s${i}`,
          action: "request",
          outcome: "passed",
        })),
        failedStep: null,
        evidenceSummary: "y".repeat(3_000),
      },
      4 * 1024,
    );

    expect(section.length).toBeLessThanOrEqual(4 * 1024 + 20);
  });
});

describe("warm-start construction", () => {
  test("includes only steps that actually started", () => {
    const attempt = buildPriorReproductionAttempt(
      "one_shot",
      {
        version: 1,
        baseUrl: "http://localhost",
        steps: [
          { id: "s1", action: "goto", path: "/" },
          { id: "s2", action: "click", target: { text: "Save" } },
        ],
        expectedBehavior: "saved",
        failureCondition: "not saved",
        assertion: { type: "text_present", text: "saved" },
      } as never,
      {
        outcome: "execution_failed",
        outcomeReason: "first step failed",
        steps: [
          { id: "s1", action: "goto", startedAt: "2026-01-01", outcome: "failed", error: "boom" },
          { id: "s2", action: "click", startedAt: null, outcome: "skipped", error: null },
        ],
        consoleErrors: [], pageErrors: [], networkFailures: [], apiResponses: [],
      } as never,
    );

    expect(attempt?.executedSteps.map((step) => step.id)).toEqual(["s1"]);
  });
});

describe("compaction continuation", () => {
  test("preserves parallel-read permission after compaction", () => {
    const compactor = createCompactor({
      enabled: true,
      everyToolCalls: 1,
      keepLastPairs: 1,
      allowParallelToolCalls: true,
    });
    const messages = [
      { role: "user", content: "initial" },
      { role: "assistant", content: "a1" }, { role: "user", content: "r1" },
      { role: "assistant", content: "a2" }, { role: "user", content: "r2" },
      { role: "assistant", content: "a3" }, { role: "user", content: "r3" },
    ] as Anthropic.Messages.MessageParam[];
    compactor.record(1);
    expect(compactor.maybeCompact(messages, () => "state")).toBe(true);
    expect(JSON.stringify(messages)).toContain("independent read-only inspections may be called in parallel");
    expect(JSON.stringify(messages)).not.toContain("exactly one tool call");
  });
});
