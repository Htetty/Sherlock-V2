// Agent conversation compaction, gated behind SHERLOCK_COMPACTION=true.
//
// Both agents append full tool results to the Anthropic message history
// forever, so every turn resends everything. When enabled, the compactor
// periodically replaces old history with a compact, locally assembled state
// summary (no model call). Full raw tool-call artifacts stay on disk.
//
// API correctness: tool_use and tool_result blocks are paired, so splicing
// only ever removes whole assistant+user turn pairs. The system prompt, the
// initial task message, and the last complete turns are always kept, and the
// summary is inserted as an assistant+user pair so roles keep alternating and
// no tool_use is ever orphaned.

import type Anthropic from "@anthropic-ai/sdk";

export const COMPACTION_DEFAULTS = {
  // Compact after every N tool calls...
  everyToolCalls: 6,
  // ...or when cumulative tool-result bytes since the last compaction exceed
  // this threshold, whichever comes first.
  byteThreshold: 60 * 1024,
  // Complete assistant+user turn pairs preserved at the end of history.
  keepLastPairs: 2,
};

export function compactionEnabled(): boolean {
  return process.env.SHERLOCK_COMPACTION === "true";
}

export type Compactor = {
  readonly enabled: boolean;
  readonly events: number;
  // Record one tool result that was appended to the history.
  record: (resultBytes: number) => void;
  // Compact `messages` in place if a trigger fired. Returns true when a
  // compaction happened. `buildSummary` must produce the compact state
  // summary from tracked agent state (facts learned, failed attempts,
  // remaining budgets, latest replay/verifier feedback).
  maybeCompact: (
    messages: Anthropic.Messages.MessageParam[],
    buildSummary: () => string,
  ) => boolean;
};

export function createCompactor(
  options: Partial<typeof COMPACTION_DEFAULTS> & { enabled?: boolean } = {},
): Compactor {
  const enabled = options.enabled ?? compactionEnabled();
  const everyToolCalls = options.everyToolCalls ?? COMPACTION_DEFAULTS.everyToolCalls;
  const byteThreshold = options.byteThreshold ?? COMPACTION_DEFAULTS.byteThreshold;
  const keepLastPairs = options.keepLastPairs ?? COMPACTION_DEFAULTS.keepLastPairs;

  let toolCallsSinceCompaction = 0;
  let bytesSinceCompaction = 0;
  let events = 0;

  return {
    enabled,
    get events() {
      return events;
    },
    record: (resultBytes: number) => {
      toolCallsSinceCompaction += 1;
      bytesSinceCompaction += Math.max(0, resultBytes);
    },
    maybeCompact: (messages, buildSummary) => {
      if (!enabled) {
        return false;
      }

      if (
        toolCallsSinceCompaction < everyToolCalls &&
        bytesSinceCompaction < byteThreshold
      ) {
        return false;
      }

      // History layout: [user initial, (assistant, user)*]. Keep the initial
      // task message and the last `keepLastPairs` complete pairs; there must
      // be at least one whole pair in the middle to remove.
      const keepTail = keepLastPairs * 2;
      const middleLength = messages.length - 1 - keepTail;

      if (middleLength < 2) {
        return false;
      }

      const summaryPair: Anthropic.Messages.MessageParam[] = [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "(Earlier turns were compacted. A summary of the session state so far follows.)",
            },
          ],
        },
        {
          role: "user",
          content: `SESSION STATE SUMMARY (earlier turns compacted; full raw tool results are preserved on disk):\n\n${buildSummary()}\n\nContinue from this state. Respond with exactly one tool call.`,
        },
      ];

      messages.splice(1, middleLength, ...summaryPair);

      toolCallsSinceCompaction = 0;
      bytesSinceCompaction = 0;
      events += 1;

      return true;
    },
  };
}
