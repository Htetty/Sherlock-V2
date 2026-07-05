// Structured fix proposal schema and patch safety validation.
// This module must stay free of Claude/Anthropic imports so fix attempts can
// be validated and applied without any Claude dependency.

import { readFile, lstat } from "node:fs/promises";
import path from "node:path";

export const FIX_PROPOSAL_VERSION = 1;

export type FileEdit = {
  oldText: string;
  newText: string;
};

export type FileChange = {
  path: string;
  edits: FileEdit[];
};

export type FixProposal = {
  version: number;
  summary: string;
  rootCause: string;
  confidence: number;
  files: FileChange[];
  relevantTests: string[];
  risk: "low" | "medium" | "high";
  assumptions: string[];
};

export type ProposalValidationResult =
  | { ok: true; proposal: FixProposal }
  | { ok: false; errors: string[] };

export const PATCH_LIMITS = {
  maxChangedFiles: 5,
  maxChangedLines: 300,
};

// Conservative defaults. Deployment and secret-bearing files are never
// patchable; lockfiles are excluded because dependency changes are out of
// scope for a minimal fix.
const PROTECTED_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "app.yml",
]);

const PROTECTED_EXTENSIONS = [".pem", ".key"];

const SAFE_TEST_COMMAND = /^(npm|npx|node)(\s+[A-Za-z0-9_@./:=,\- ]+)?$/;

export type ProposalExtractionResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

// Extracts the top-level JSON object from a raw model response. Accepts the
// bare object or one wrapped in a fenced code block; rejects prose, arrays,
// primitives, and double-encoded JSON strings.
export function extractFixProposalJson(rawText: string): ProposalExtractionResult {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = (fenced ? fenced[1] : trimmed).trim();

  if (!candidate.startsWith("{")) {
    // Recovery for the common "reasoning prose, then the object" failure.
    // Deliberately NOT applied to arrays ("[") or JSON-encoded strings ('"')
    // - those are format violations, not prose, and stay rejected.
    const recoverable =
      !candidate.startsWith("[") && !candidate.startsWith('"')
        ? findBalancedObject(candidate)
        : null;

    if (recoverable === null) {
      return {
        ok: false,
        error:
          'Response must be a single top-level JSON object starting with "{" — not prose, an array, a primitive, or a JSON-encoded string.',
      };
    }

    candidate = recoverable;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      error: `Response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Parsed JSON must be a top-level object, not an array or primitive.",
    };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}

// Finds the first balanced top-level {...} in text, respecting JSON string
// literals and escapes. Returns null when no balanced object exists.
function findBalancedObject(text: string): string | null {
  const start = text.indexOf("{");

  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

export type ProposalAttempt = {
  rawText: string;
  error: string | null;
};

export type ProposalRequestResult = {
  proposal: Record<string, unknown> | null;
  attempts: ProposalAttempt[];
  parseError: string | null;
};

// Asks the model for a proposal and, if the response is not a valid JSON
// object, retries exactly once passing the extraction error back so the
// model can correct its output format. Pure orchestration: the model call is
// injected, so this stays testable without any Claude dependency.
export async function requestValidProposal(
  callModel: (retryError: string | null) => Promise<string>,
): Promise<ProposalRequestResult> {
  const attempts: ProposalAttempt[] = [];
  let lastError: string | null = null;

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    const rawText = await callModel(lastError);
    const extracted = extractFixProposalJson(rawText);

    if (extracted.ok) {
      attempts.push({ rawText, error: null });
      return { proposal: extracted.value, attempts, parseError: null };
    }

    lastError = extracted.error;
    attempts.push({ rawText, error: extracted.error });
  }

  return { proposal: null, attempts, parseError: lastError };
}

// Structural validation of the proposal JSON shape.
export function validateFixProposalShape(value: unknown): ProposalValidationResult {
  const errors: string[] = [];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["Fix proposal must be a JSON object."] };
  }

  const proposal = value as Record<string, unknown>;

  if (proposal.version !== FIX_PROPOSAL_VERSION) {
    errors.push(
      `Proposal version must be ${FIX_PROPOSAL_VERSION}, got ${JSON.stringify(proposal.version)}.`,
    );
  }

  if (typeof proposal.summary !== "string" || !proposal.summary) {
    errors.push("Proposal summary must be a non-empty string.");
  }

  if (typeof proposal.rootCause !== "string" || !proposal.rootCause) {
    errors.push("Proposal rootCause must be a non-empty string.");
  }

  if (
    typeof proposal.confidence !== "number" ||
    proposal.confidence < 0 ||
    proposal.confidence > 1
  ) {
    errors.push("Proposal confidence must be a number between 0 and 1.");
  }

  if (proposal.risk !== "low" && proposal.risk !== "medium" && proposal.risk !== "high") {
    errors.push('Proposal risk must be "low", "medium", or "high".');
  }

  if (
    !Array.isArray(proposal.assumptions) ||
    proposal.assumptions.some((item) => typeof item !== "string")
  ) {
    errors.push("Proposal assumptions must be an array of strings.");
  }

  if (
    !Array.isArray(proposal.relevantTests) ||
    proposal.relevantTests.some((item) => typeof item !== "string")
  ) {
    errors.push("Proposal relevantTests must be an array of strings.");
  } else {
    for (const command of proposal.relevantTests as string[]) {
      if (!SAFE_TEST_COMMAND.test(command.trim())) {
        errors.push(
          `Test command ${JSON.stringify(command)} is not allowed. Only plain npm/npx/node commands without shell operators are accepted.`,
        );
      }
    }
  }

  if (!Array.isArray(proposal.files) || proposal.files.length === 0) {
    errors.push("Proposal files must be a non-empty array.");
  } else {
    proposal.files.forEach((file, index) => {
      errors.push(...validateFileChangeShape(file, index));
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, proposal: proposal as unknown as FixProposal };
}

function validateFileChangeShape(value: unknown, index: number): string[] {
  const label = `File change ${index + 1}`;

  if (!value || typeof value !== "object") {
    return [`${label} must be an object.`];
  }

  const change = value as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof change.path !== "string" || !change.path) {
    errors.push(`${label} must have a non-empty string path.`);
  }

  if (!Array.isArray(change.edits) || change.edits.length === 0) {
    errors.push(`${label} must have a non-empty edits array.`);
    return errors;
  }

  change.edits.forEach((edit, editIndex) => {
    if (!edit || typeof edit !== "object") {
      errors.push(`${label} edit ${editIndex + 1} must be an object.`);
      return;
    }

    const { oldText, newText } = edit as Record<string, unknown>;

    if (typeof oldText !== "string" || !oldText) {
      errors.push(`${label} edit ${editIndex + 1} must have non-empty string oldText.`);
    }

    if (typeof newText !== "string") {
      errors.push(`${label} edit ${editIndex + 1} must have string newText.`);
    }

    if (typeof oldText === "string" && typeof newText === "string" && oldText === newText) {
      errors.push(`${label} edit ${editIndex + 1} is empty (oldText equals newText).`);
    }
  });

  return errors;
}

// Safety validation against the actual workspace: path escapes, protected
// files, size limits, and that every edit matches the checked-out content
// exactly once.
export async function validatePatchSafety(
  proposal: FixProposal,
  repoPath: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  if (proposal.files.length > PATCH_LIMITS.maxChangedFiles) {
    errors.push(
      `Proposal changes ${proposal.files.length} files; maximum is ${PATCH_LIMITS.maxChangedFiles}.`,
    );
  }

  let changedLines = 0;
  const seenPaths = new Set<string>();
  const repoRoot = path.resolve(repoPath);

  for (const file of proposal.files) {
    if (seenPaths.has(file.path)) {
      errors.push(`Duplicate file path in proposal: ${file.path}.`);
      continue;
    }

    seenPaths.add(file.path);

    const pathError = validateWorkspacePath(file.path, repoRoot);

    if (pathError) {
      errors.push(pathError);
      continue;
    }

    const absolutePath = path.resolve(repoRoot, file.path);
    let contents: string;

    try {
      const info = await lstat(absolutePath);

      if (info.isSymbolicLink() || !info.isFile()) {
        errors.push(`Path ${file.path} is not a regular file.`);
        continue;
      }

      contents = await readFile(absolutePath, "utf8");
    } catch {
      errors.push(`Path ${file.path} does not exist in the workspace. Creating new files is not supported.`);
      continue;
    }

    if (contents.includes("\0")) {
      errors.push(`Path ${file.path} appears to be binary; binary changes are not supported.`);
      continue;
    }

    // Apply edits in memory to verify each one matches exactly once.
    let patched = contents;

    for (const [editIndex, edit] of file.edits.entries()) {
      const occurrences = countOccurrences(patched, edit.oldText);

      if (occurrences === 0) {
        errors.push(
          `Edit ${editIndex + 1} of ${file.path} does not match the checked-out file content.`,
        );
        continue;
      }

      if (occurrences > 1) {
        errors.push(
          `Edit ${editIndex + 1} of ${file.path} matches ${occurrences} locations; edits must be unique.`,
        );
        continue;
      }

      patched = patched.replace(edit.oldText, edit.newText);
      changedLines += countLines(edit.oldText) + countLines(edit.newText);
    }
  }

  if (changedLines > PATCH_LIMITS.maxChangedLines) {
    errors.push(
      `Proposal changes ${changedLines} lines; maximum is ${PATCH_LIMITS.maxChangedLines}.`,
    );
  }

  return { ok: errors.length === 0, errors };
}

function validateWorkspacePath(filePath: string, repoRoot: string): string | null {
  if (path.isAbsolute(filePath)) {
    return `Path ${filePath} is absolute; only workspace-relative paths are allowed.`;
  }

  const normalized = path.normalize(filePath);

  if (normalized.startsWith("..")) {
    return `Path ${filePath} escapes the repository workspace.`;
  }

  const resolved = path.resolve(repoRoot, normalized);

  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) {
    return `Path ${filePath} escapes the repository workspace.`;
  }

  const segments = normalized.split(path.sep);

  if (segments.includes(".git")) {
    return `Path ${filePath} touches the .git directory.`;
  }

  const basename = path.basename(normalized).toLowerCase();

  if (basename.startsWith(".env")) {
    return `Path ${filePath} is a protected environment file.`;
  }

  if (PROTECTED_EXTENSIONS.some((extension) => basename.endsWith(extension))) {
    return `Path ${filePath} is a protected credential file.`;
  }

  if (PROTECTED_BASENAMES.has(basename)) {
    return `Path ${filePath} is protected (lockfile or deployment configuration).`;
  }

  if (normalized.startsWith(path.join(".github", "workflows"))) {
    return `Path ${filePath} is a protected GitHub workflow file.`;
  }

  return null;
}

function countOccurrences(text: string, search: string) {
  let count = 0;
  let position = text.indexOf(search);

  while (position !== -1) {
    count += 1;
    position = text.indexOf(search, position + search.length);
  }

  return count;
}

function countLines(text: string) {
  return text.split("\n").length;
}

// Human-readable rendering of the intended edits, saved as proposed.patch.
export function renderProposedPatch(proposal: FixProposal) {
  return proposal.files
    .map((file) => {
      const hunks = file.edits
        .map((edit, index) => {
          const removed = edit.oldText
            .split("\n")
            .map((line) => `- ${line}`)
            .join("\n");
          const added = edit.newText
            .split("\n")
            .map((line) => `+ ${line}`)
            .join("\n");

          return `@@ edit ${index + 1} @@\n${removed}\n${added}`;
        })
        .join("\n");

      return `--- a/${file.path}\n+++ b/${file.path}\n${hunks}`;
    })
    .join("\n\n");
}
