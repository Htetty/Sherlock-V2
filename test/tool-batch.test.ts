// Parallel tool-use contract tests (Phase 2).

import { describe, expect, test } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  assembleBatchResults,
  parallelReadsEnabled,
  planToolBatch,
} from "../backend/agents/tool-batch.js";

function block(id: string, name: string): Anthropic.Messages.ToolUseBlock {
  return { type: "tool_use", id, name, input: {} } as Anthropic.Messages.ToolUseBlock;
}

describe("parallelReadsEnabled", () => {
  test("defaults on (fable/16); env kill switch and override control it", () => {
    expect(parallelReadsEnabled(undefined, {} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      parallelReadsEnabled(undefined, { SHERLOCK_FIXER_PARALLEL_READS: "false" } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      parallelReadsEnabled(undefined, { SHERLOCK_FIXER_PARALLEL_READS: "true" } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(parallelReadsEnabled(true, {} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      parallelReadsEnabled(false, { SHERLOCK_FIXER_PARALLEL_READS: "true" } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("planToolBatch", () => {
  test("only read-only tools execute; terminal/mutation tools are rejected unexecuted", () => {
    const plan = planToolBatch([
      block("1", "read_file"),
      block("2", "grep"),
      block("3", "propose_patch"),
      block("4", "submit_blocked"),
      block("5", "get_graph_neighbors"),
    ]);

    expect(plan.execute.map((b) => b.name)).toEqual(["read_file", "grep", "get_graph_neighbors"]);
    expect(plan.rejected.map((entry) => entry.block.name).sort()).toEqual([
      "propose_patch",
      "submit_blocked",
    ]);
  });

  test("duplicate ids reject the whole response before an invalid protocol turn", () => {
    const plan = planToolBatch([block("1", "read_file"), block("1", "grep")]);
    expect(plan.execute).toEqual([]);
    expect(plan.fatalReason).toMatch(/duplicate tool_use ids/);
  });

  test("caps oversized parallel batches", () => {
    const plan = planToolBatch(
      Array.from({ length: 9 }, (_value, index) => block(String(index), "read_file")),
    );
    expect(plan.execute).toEqual([]);
    expect(plan.fatalReason).toMatch(/maximum is 8/);
  });
});

describe("assembleBatchResults", () => {
  test("returns exactly one result per block, in model order", () => {
    const blocks = [block("a", "read_file"), block("b", "grep")];
    const results = new Map([
      ["a", { content: "file", isError: false }],
      ["b", { content: "matches", isError: false }],
    ]);

    const assembled = assembleBatchResults(blocks, results);
    expect(assembled.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
    expect(assembled).toHaveLength(2);
  });

  test("throws when a pairing is missing rather than sending an orphan", () => {
    const blocks = [block("a", "read_file"), block("b", "grep")];
    const results = new Map([["a", { content: "file", isError: false }]]);
    expect(() => assembleBatchResults(blocks, results)).toThrow(/invariant violated/);
  });

  test("partial failure keeps successful siblings' results", () => {
    const blocks = [block("a", "read_file"), block("b", "grep")];
    const results = new Map([
      ["a", { content: "ok", isError: false }],
      ["b", { content: "budget exhausted", isError: true }],
    ]);
    const assembled = assembleBatchResults(blocks, results);
    expect(assembled[0]).toMatchObject({ tool_use_id: "a", is_error: false });
    expect(assembled[1]).toMatchObject({ tool_use_id: "b", is_error: true });
  });
});
