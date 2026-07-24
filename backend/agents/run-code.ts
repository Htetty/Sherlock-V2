// Fixer run_code tool (fable/16): read-only programmatic exploration.
//
// The model writes one shell script that greps/finds/filters inside a
// controlled explorer container and prints a single bounded JSON document —
// replacing many separate model turns with one. Security model:
//
// - Docker ONLY (backend/services/container.ts). Generated code never runs
//   through host/worker exec/spawn/unshare, and there is no weaker fallback:
//   if Docker or the explorer image is unavailable, the tool fails closed
//   with a structured error.
// - The repository is mounted READ-ONLY at /app (cwd /app). The :ro mount is
//   the security boundary — not git rollback, which cannot reliably remove
//   untracked or staged changes.
// - --network=none, dropped capabilities, no-new-privileges, non-root user,
//   read-only container root, bounded writable /tmp, CPU/memory/PID limits.
// - The script travels over container stdin and the shell is invoked with an
//   argv array (["/bin/sh","-s"]). It is never interpolated into a host
//   shell command, Docker command string, or filename.
// - Environment: PATH and HOME=/tmp only. No tokens, no process.env
//   passthrough.
//
// Output contract: stdout must be one JSON document with summary, queriesRun,
// filesConsidered, filesExamined, evidence entries (path, startLine, endLine,
// excerpt, reason), and uncertainties. Paths/ranges are validated and every
// field is bounded. Unsupported prose or malformed JSON is a structured tool
// error carrying a raw-artifact handle — never a successful exploration.

import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import {
  realDockerAdapter,
  runContainerCommand,
  type DockerAdapter,
} from "../services/container.js";
import { truncateWithMarker } from "../services/bounded-text.js";

export const RUN_CODE_LIMITS = {
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 120,
  // Model-facing combined stdout+stderr cap.
  maxOutputBytes: 32 * 1024,
  maxScriptBytes: 16 * 1024,
  // Validated-result field bounds.
  maxSummaryBytes: 2_048,
  maxEvidenceEntries: 20,
  maxExcerptBytes: 2_048,
  maxReasonBytes: 400,
  maxListEntries: 50,
  maxListEntryBytes: 300,
};

// The controlled explorer image: POSIX shell, git, ripgrep, and basic text
// processing. Never the arbitrary target image — its binaries are untrusted
// and unpinned. The identifier is persisted with every run_code artifact.
export function getExplorerImage(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHERLOCK_EXPLORER_IMAGE?.trim() || "sherlock-explorer:latest";
}

// Non-root user for the explorer container. A numeric uid:gid works even
// when the image defines no named user.
export function getExplorerUser(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHERLOCK_EXPLORER_USER?.trim() || "1000:1000";
}

export type RunCodeEvidenceEntry = {
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  reason: string;
};

export type RunCodeValidatedResult = {
  summary: string;
  queriesRun: string[];
  filesConsidered: string[];
  filesExamined: string[];
  evidence: RunCodeEvidenceEntry[];
  uncertainties: string[];
};

export type RunCodeOutcome = {
  // True only when the container ran AND its output passed validation.
  ok: boolean;
  // Model-facing result: the normalized JSON on success, a structured error
  // otherwise (including the raw-artifact handle).
  resultText: string;
  // Full raw combined output for artifacts (container-level bound applies).
  rawOutput: string;
  exitCode: number | null;
  timedOut: boolean;
  imageId: string;
  sanitizedCommand: string | null;
  // Ran but the printed output failed the JSON/evidence contract.
  invalidResult: boolean;
};

export function parseRunCodeTimeout(timeoutSeconds: unknown): number {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return RUN_CODE_LIMITS.defaultTimeoutSeconds;
  }

  return Math.min(
    RUN_CODE_LIMITS.maxTimeoutSeconds,
    Math.max(1, Math.floor(timeoutSeconds)),
  );
}

// --- Result validation ----------------------------------------------------------

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return truncateUtf8(value.trim(), maxBytes);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  return `${buffer.toString("utf8").replace(/�+$/, "")}…`;
}

function boundedStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .slice(0, RUN_CODE_LIMITS.maxListEntries)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => truncateUtf8(entry.trim(), RUN_CODE_LIMITS.maxListEntryBytes));
}

function isSafeRelativePath(candidate: string): boolean {
  if (path.isAbsolute(candidate)) {
    return false;
  }

  const normalized = path.normalize(candidate);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

export function validateRunCodeOutput(
  stdout: string,
): { ok: true; result: RunCodeValidatedResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let parsed: unknown = null;
  const trimmed = stdout.trim();

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Tolerate leading/trailing script noise around ONE JSON object.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");

    if (first >= 0 && last > first) {
      try {
        parsed = JSON.parse(trimmed.slice(first, last + 1));
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ["stdout is not a JSON object matching the run_code result contract"],
    };
  }

  const raw = parsed as Record<string, unknown>;

  const summary = boundedString(raw.summary, RUN_CODE_LIMITS.maxSummaryBytes);
  if (summary === null) errors.push("summary must be a non-empty string");

  const queriesRun = boundedStringList(raw.queriesRun);
  if (queriesRun === null) errors.push("queriesRun must be an array of strings");

  const filesConsidered = boundedStringList(raw.filesConsidered);
  if (filesConsidered === null) errors.push("filesConsidered must be an array of strings");

  const filesExamined = boundedStringList(raw.filesExamined);
  if (filesExamined === null) errors.push("filesExamined must be an array of strings");

  const uncertainties = boundedStringList(raw.uncertainties);
  if (uncertainties === null) errors.push("uncertainties must be an array of strings");

  const evidence: RunCodeEvidenceEntry[] = [];

  if (!Array.isArray(raw.evidence)) {
    errors.push("evidence must be an array");
  } else {
    for (const [index, entry] of raw.evidence
      .slice(0, RUN_CODE_LIMITS.maxEvidenceEntries)
      .entries()) {
      if (entry === null || typeof entry !== "object") {
        errors.push(`evidence[${index}] must be an object`);
        continue;
      }

      const item = entry as Record<string, unknown>;
      const entryPath = typeof item.path === "string" ? item.path.trim() : "";
      const startLine = item.startLine;
      const endLine = item.endLine;
      const excerpt = boundedString(item.excerpt, RUN_CODE_LIMITS.maxExcerptBytes);
      const reason = boundedString(item.reason, RUN_CODE_LIMITS.maxReasonBytes);

      if (!entryPath || !isSafeRelativePath(entryPath)) {
        errors.push(
          `evidence[${index}].path must be a repo-relative path that stays inside the repository`,
        );
        continue;
      }

      if (
        typeof startLine !== "number" ||
        typeof endLine !== "number" ||
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine
      ) {
        errors.push(
          `evidence[${index}] startLine/endLine must be positive integers with endLine >= startLine`,
        );
        continue;
      }

      if (excerpt === null || reason === null) {
        errors.push(`evidence[${index}] excerpt and reason must be non-empty strings`);
        continue;
      }

      evidence.push({
        path: path.normalize(entryPath).split(path.sep).join("/"),
        startLine,
        endLine,
        excerpt,
        reason,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    result: {
      summary: summary!,
      queriesRun: queriesRun!,
      filesConsidered: filesConsidered!,
      filesExamined: filesExamined!,
      evidence,
      uncertainties: uncertainties!,
    },
  };
}

export async function validateRunCodeEvidence(
  repoPath: string,
  result: RunCodeValidatedResult,
): Promise<{ ok: true; result: RunCodeValidatedResult } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  let repoRoot: string;

  try {
    repoRoot = await realpath(repoPath);
  } catch {
    return { ok: false, errors: ["repository root is unavailable for evidence validation"] };
  }

  const insideRepo = (candidate: string) =>
    candidate === repoRoot || candidate.startsWith(`${repoRoot}${path.sep}`);

  for (const [index, entry] of result.evidence.entries()) {
    const lexicalPath = path.resolve(repoRoot, entry.path);

    if (!insideRepo(lexicalPath)) {
      errors.push(`evidence[${index}].path resolves outside the repository`);
      continue;
    }

    let resolvedPath: string;
    let contents: string;

    try {
      resolvedPath = await realpath(lexicalPath);
      if (!insideRepo(resolvedPath)) {
        errors.push(`evidence[${index}].path follows a symlink outside the repository`);
        continue;
      }
      contents = await readFile(resolvedPath, "utf8");
    } catch {
      errors.push(`evidence[${index}].path does not name a readable repository file`);
      continue;
    }

    const lines = contents.split(/\r?\n/);
    if (entry.endLine > lines.length) {
      errors.push(
        `evidence[${index}] line range ${entry.startLine}-${entry.endLine} exceeds the file's ${lines.length} lines`,
      );
      continue;
    }

    const citedText = lines.slice(entry.startLine - 1, entry.endLine).join("\n");
    if (!citedText.includes(entry.excerpt)) {
      errors.push(`evidence[${index}].excerpt does not match the cited file range`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, result };
}

// --- Execution --------------------------------------------------------------------

export type ExecuteRunCodeArgs = {
  repoPath: string;
  script: unknown;
  timeoutSeconds?: unknown;
  // The artifact file name where the raw output will be persisted; embedded
  // in error results so a human can inspect what the script actually printed.
  rawArtifactHandle: string;
  docker?: DockerAdapter;
  env?: NodeJS.ProcessEnv;
};

export async function executeRunCode(args: ExecuteRunCodeArgs): Promise<RunCodeOutcome> {
  const docker = args.docker ?? realDockerAdapter;
  const env = args.env ?? process.env;
  const imageId = getExplorerImage(env);

  const failClosed = (reason: string): RunCodeOutcome => ({
    ok: false,
    resultText: `run_code unavailable: ${reason} This tool fails closed — use read_file/read_many/grep/get_graph_neighbors instead.`,
    rawOutput: "",
    exitCode: null,
    timedOut: false,
    imageId,
    sanitizedCommand: null,
    invalidResult: false,
  });

  if (typeof args.script !== "string" || args.script.trim() === "") {
    return {
      ...failClosed(""),
      resultText: "run_code requires a non-empty string script.",
    };
  }

  if (Buffer.byteLength(args.script, "utf8") > RUN_CODE_LIMITS.maxScriptBytes) {
    return {
      ...failClosed(""),
      resultText: `run_code script exceeds ${RUN_CODE_LIMITS.maxScriptBytes} bytes. Print distilled conclusions, not raw file dumps.`,
    };
  }

  if (!(await docker.isAvailable())) {
    return failClosed("Docker is not available on this worker.");
  }

  const timeoutSeconds = parseRunCodeTimeout(args.timeoutSeconds);

  const run = await runContainerCommand(docker, {
    purpose: "run-code",
    workspacePath: args.repoPath,
    workspaceReadOnly: true,
    image: imageId,
    user: getExplorerUser(env),
    network: "none",
    // Stripped environment: PATH and a writable HOME only. Never the worker's
    // process.env.
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp",
      // The production worker clones as root while this container deliberately
      // runs non-root. Mark only the read-only mount as safe so git inspection
      // works without weakening ownership checks globally.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/app",
    },
    command: ["/bin/sh", "-s"],
    stdinData: args.script,
    timeoutMs: timeoutSeconds * 1_000,
  });

  const rawOutput = [run.stdout, run.stderr].filter(Boolean).join("\n--- stderr ---\n");

  if (run.timedOut) {
    return {
      ok: false,
      resultText: `run_code timed out after ${timeoutSeconds}s and was killed. Narrow the script (raw output preserved at ${args.rawArtifactHandle}).`,
      rawOutput,
      exitCode: run.exitCode,
      timedOut: true,
      imageId,
      sanitizedCommand: run.sanitizedCommand,
      invalidResult: false,
    };
  }

  // No failed script is evidence. Docker startup errors get the more specific
  // unavailable message; every other nonzero/null exit is a structured tool
  // failure even when stdout happens to contain valid-looking JSON.
  if (run.exitCode === 125 || run.exitCode === 127) {
    return {
      ok: false,
      resultText: `run_code unavailable: the explorer container could not start (exit ${run.exitCode}; image "${imageId}"). This tool fails closed — use read_file/read_many/grep/get_graph_neighbors instead.`,
      rawOutput,
      exitCode: run.exitCode,
      timedOut: false,
      imageId,
      sanitizedCommand: run.sanitizedCommand,
      invalidResult: false,
    };
  }

  if (run.exitCode !== 0) {
    return {
      ok: false,
      resultText: `run_code script failed with exit ${run.exitCode ?? "unknown"}; its partial output was not accepted as evidence (raw output preserved at ${args.rawArtifactHandle}).`,
      rawOutput,
      exitCode: run.exitCode,
      timedOut: false,
      imageId,
      sanitizedCommand: run.sanitizedCommand,
      invalidResult: true,
    };
  }

  const validation = validateRunCodeOutput(run.stdout);

  if (!validation.ok) {
    return {
      ok: false,
      resultText: [
        `run_code output rejected: ${validation.errors.join("; ")}.`,
        `Your script must print exactly one JSON object: {"summary", "queriesRun", "filesConsidered", "filesExamined", "evidence": [{"path","startLine","endLine","excerpt","reason"}], "uncertainties"}.`,
        `Raw output preserved at ${args.rawArtifactHandle}.`,
        `Exit code: ${run.exitCode}.`,
      ].join("\n"),
      rawOutput,
      exitCode: run.exitCode,
      timedOut: false,
      imageId,
      sanitizedCommand: run.sanitizedCommand,
      invalidResult: true,
    };
  }

  const evidenceValidation = await validateRunCodeEvidence(args.repoPath, validation.result);

  if (!evidenceValidation.ok) {
    return {
      ok: false,
      resultText: [
        `run_code evidence rejected: ${evidenceValidation.errors.join("; ")}.`,
        `Every citation must name an existing repository file, stay inside the repository after symlink resolution, use a real line range, and quote text from that range.`,
        `Raw output preserved at ${args.rawArtifactHandle}.`,
      ].join("\n"),
      rawOutput,
      exitCode: run.exitCode,
      timedOut: false,
      imageId,
      sanitizedCommand: run.sanitizedCommand,
      invalidResult: true,
    };
  }

  const normalized = JSON.stringify(evidenceValidation.result, null, 2);

  return {
    ok: true,
    resultText: truncateWithMarker(
      normalized,
      RUN_CODE_LIMITS.maxOutputBytes,
      "RUN_CODE OUTPUT TRUNCATED",
    ),
    rawOutput,
    exitCode: run.exitCode,
    timedOut: false,
    imageId,
    sanitizedCommand: run.sanitizedCommand,
    invalidResult: false,
  };
}
