// Parallel tool-use contract (FABLE_IMPLEMENTATION_PROMPT.md Phase 2,
// "Parallel tool-use contract"). Default ON (fable/16):
// SHERLOCK_FIXER_PARALLEL_READS=false (or an explicit agent-input opt-out)
// disables the fixer's ability to emit multiple tool calls per turn.
//
// Guarantees when enabled:
// - Every tool_use block receives exactly one tool_result, in deterministic
//   model order (assembleBatchResults preserves block order).
// - Only independent, read-only tools may run concurrently. Mutation and
//   terminal tools (propose_patch, submit_blocked) in a multi-call batch are
//   rejected with a structured error result and are NOT executed.
// - Duplicate tool_use IDs are rejected (first occurrence wins; later
//   duplicates get an error result) so the tool_use/tool_result pairing can
//   never be ambiguous.
// - Partial failures stay structured: one failing read never discards its
//   successful siblings.

import type Anthropic from "@anthropic-ai/sdk";

// NOTE: run_code is deliberately NOT read-only for batching purposes — it
// holds the workspace (a Docker container with the repo mounted) and must
// never run concurrently with other tools. read_many is read-only and safe.
export const READ_ONLY_FIXER_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "read_many",
  "grep",
  "get_graph_neighbors",
]);
export const MAX_PARALLEL_READS = 8;

export function parallelReadsEnabled(
  override?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return override ?? env.SHERLOCK_FIXER_PARALLEL_READS !== "false";
}

export type ToolBatchPlan = {
  // Read-only, unique-id blocks safe to execute concurrently.
  execute: Anthropic.Messages.ToolUseBlock[];
  // Blocks that must not run in this batch, each with the structured error
  // result it must receive instead.
  rejected: Array<{ block: Anthropic.Messages.ToolUseBlock; reason: string }>;
  fatalReason: string | null;
};

export function planToolBatch(
  blocks: Anthropic.Messages.ToolUseBlock[],
  readOnlyTools: ReadonlySet<string> = READ_ONLY_FIXER_TOOLS,
): ToolBatchPlan {
  if (blocks.length > MAX_PARALLEL_READS) {
    return {
      execute: [],
      rejected: [],
      fatalReason: `Rejected parallel batch of ${blocks.length}; maximum is ${MAX_PARALLEL_READS} tool calls.`,
    };
  }
  const ids = new Set(blocks.map((block) => block.id));
  if (ids.size !== blocks.length) {
    return {
      execute: [],
      rejected: [],
      fatalReason:
        "Rejected response with duplicate tool_use ids; it cannot be represented by the provider's unique tool_result protocol.",
    };
  }
  const seenIds = new Set<string>();
  const execute: Anthropic.Messages.ToolUseBlock[] = [];
  const rejected: ToolBatchPlan["rejected"] = [];

  for (const block of blocks) {
    if (seenIds.has(block.id)) {
      rejected.push({
        block,
        reason: `Rejected: duplicate tool_use id "${block.id}" in one response. Each tool call must have a unique id.`,
      });
      continue;
    }

    seenIds.add(block.id);

    if (!readOnlyTools.has(block.name)) {
      rejected.push({
        block,
        reason: `Rejected: "${block.name}" is a terminal or state-changing tool and must be called ALONE in its own turn. It was not executed. Re-issue it as the only tool call of a turn.`,
      });
      continue;
    }

    execute.push(block);
  }

  return { execute, rejected, fatalReason: null };
}

export type BatchResultEntry = {
  toolUseId: string;
  content: string;
  isError: boolean;
};

// Returns exactly one tool_result per tool_use block, in the model's block
// order. Throws if a result is missing — a violated pairing must never be
// sent to the API silently.
export function assembleBatchResults(
  blocks: Anthropic.Messages.ToolUseBlock[],
  resultsById: Map<string, { content: string; isError: boolean }>,
): Anthropic.Messages.ToolResultBlockParam[] {
  return blocks.map((block) => {
    const result = resultsById.get(block.id);

    if (!result) {
      throw new Error(`tool-batch invariant violated: no result for tool_use id "${block.id}"`);
    }

    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: result.content,
      is_error: result.isError,
    };
  });
}
