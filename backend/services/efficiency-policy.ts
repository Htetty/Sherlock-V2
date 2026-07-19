// Per-investigation efficiency policy (fable/16-tool-call-efficiency-prompt.md).
//
// The completed efficiency configuration is resolved ONCE per investigation
// (in investigation.ts), passed explicitly to both agents as an immutable
// value, and persisted in the investigation artifacts. Environment variables
// provide deployment defaults and emergency kill switches only — agent
// behavior never depends on re-reading worker-global flags mid-run.
//
// Defaults: every completed efficiency feature is ON. Unknown environment
// values fail safely to the default and log a warning.

export type PromptCacheMode = "off" | "system_and_tools" | "conversation";

export type EfficiencyPolicy = {
  // Prompt-cache marker mode for both agent loops (inference.ts).
  promptCacheMode: PromptCacheMode;
  // Agent conversation compaction (compaction.ts). Unchanged triggers
  // (6 tool calls / 60KB); caching makes the prefix cheap but does not remove
  // irrelevant history, so compaction stays on.
  compaction: boolean;
  // Fixer: multiple read-only tool calls per model turn (tool-batch.ts).
  fixerParallelReads: boolean;
  // Fixer: run_code Docker exploration tool (read-only mount, no network).
  fixerRunCode: boolean;
  // Reproducer: run_steps sequential batch action tool.
  reproducerRunSteps: boolean;
  // Reproducer: bounded page-delta digests appended to goto/click/fill results.
  reproducerActionDeltas: boolean;
  // Reproducer: prior-attempt warm start after a failed one-shot/memory replay.
  reproducerWarmStart: boolean;
};

export const DEFAULT_EFFICIENCY_POLICY: EfficiencyPolicy = {
  promptCacheMode: "conversation",
  compaction: true,
  fixerParallelReads: true,
  fixerRunCode: true,
  reproducerRunSteps: true,
  reproducerActionDeltas: true,
  reproducerWarmStart: true,
};

// Environment kill switches, documented in one place (alongside
// SHERLOCK_DEEP_INVESTIGATION). Every boolean switch accepts "true"/"false";
// SHERLOCK_PROMPT_CACHE accepts "off" | "system_and_tools" | "conversation".
export const EFFICIENCY_ENV_SWITCHES = {
  promptCacheMode: "SHERLOCK_PROMPT_CACHE",
  compaction: "SHERLOCK_COMPACTION",
  fixerParallelReads: "SHERLOCK_FIXER_PARALLEL_READS",
  fixerRunCode: "SHERLOCK_FIXER_RUN_CODE",
  reproducerRunSteps: "SHERLOCK_REPRODUCER_RUN_STEPS",
  reproducerActionDeltas: "SHERLOCK_REPRODUCER_ACTION_DELTAS",
  reproducerWarmStart: "SHERLOCK_REPRODUCER_WARM_START",
} as const;

const PROMPT_CACHE_MODES: ReadonlySet<string> = new Set([
  "off",
  "system_and_tools",
  "conversation",
]);

function resolveBoolean(
  name: string,
  raw: string | undefined,
  fallback: boolean,
  warn: (message: string) => void,
): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = raw.trim().toLowerCase();

  if (value === "true") return true;
  if (value === "false") return false;

  warn(
    `Unknown ${name} value "${raw}"; falling back to the default (${fallback}).`,
  );
  return fallback;
}

export function resolveEfficiencyPolicy(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): EfficiencyPolicy {
  const defaults = DEFAULT_EFFICIENCY_POLICY;

  let promptCacheMode: PromptCacheMode = defaults.promptCacheMode;
  const rawCacheMode = env[EFFICIENCY_ENV_SWITCHES.promptCacheMode];

  if (rawCacheMode !== undefined && rawCacheMode.trim() !== "") {
    const value = rawCacheMode.trim();

    if (PROMPT_CACHE_MODES.has(value)) {
      promptCacheMode = value as PromptCacheMode;
    } else {
      warn(
        `Unknown ${EFFICIENCY_ENV_SWITCHES.promptCacheMode} value "${rawCacheMode}"; falling back to "${defaults.promptCacheMode}".`,
      );
    }
  }

  const policy: EfficiencyPolicy = {
    promptCacheMode,
    compaction: resolveBoolean(
      EFFICIENCY_ENV_SWITCHES.compaction,
      env[EFFICIENCY_ENV_SWITCHES.compaction],
      defaults.compaction,
      warn,
    ),
    fixerParallelReads: resolveBoolean(
      EFFICIENCY_ENV_SWITCHES.fixerParallelReads,
      env[EFFICIENCY_ENV_SWITCHES.fixerParallelReads],
      defaults.fixerParallelReads,
      warn,
    ),
    fixerRunCode: resolveBoolean(
      EFFICIENCY_ENV_SWITCHES.fixerRunCode,
      env[EFFICIENCY_ENV_SWITCHES.fixerRunCode],
      defaults.fixerRunCode,
      warn,
    ),
    reproducerRunSteps: resolveBoolean(
      EFFICIENCY_ENV_SWITCHES.reproducerRunSteps,
      env[EFFICIENCY_ENV_SWITCHES.reproducerRunSteps],
      defaults.reproducerRunSteps,
      warn,
    ),
    reproducerActionDeltas: resolveBoolean(
      EFFICIENCY_ENV_SWITCHES.reproducerActionDeltas,
      env[EFFICIENCY_ENV_SWITCHES.reproducerActionDeltas],
      defaults.reproducerActionDeltas,
      warn,
    ),
    reproducerWarmStart: resolveBoolean(
      EFFICIENCY_ENV_SWITCHES.reproducerWarmStart,
      env[EFFICIENCY_ENV_SWITCHES.reproducerWarmStart],
      defaults.reproducerWarmStart,
      warn,
    ),
  };

  return Object.freeze(policy);
}
