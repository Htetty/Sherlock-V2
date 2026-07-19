// Generated regression tests: one focused test per fix attempt that must
// FAIL on the original source (for the intended behavioral assertion) and
// PASS on the patched source, with byte-identical content in both runs.
//
// This module must stay free of Claude/Anthropic imports: proposals arrive
// through an injected generator, and everything here is validation,
// classification, hashing, and restricted-container execution.

import { createHash } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildTargetEnv,
  getSandboxAddressing,
  getSandboxNetworkPolicy,
  runContainerCommand,
  type ContainerCommandResult,
  type ContainerNetwork,
  type DockerAdapter,
  type SandboxNetworkPolicy,
} from "./container.js";
import type { ReproductionPlan } from "./plan.js";
import type { ReproductionResult } from "./playwright.js";
import { redactSecrets } from "./report.js";

export const REGRESSION_PROPOSAL_VERSION = 1;

// Node-only in this branch: a plain ESM script executed as `node <file>`,
// using node:assert for its assertions. Assertion failures surface as
// ERR_ASSERTION, which is what separates behavioral failure from broken
// test code.
export const SUPPORTED_RUNNERS = ["node"] as const;

export type RegressionRunner = (typeof SUPPORTED_RUNNERS)[number];

export type RegressionTestProposal = {
  version: number;
  testName: string;
  purpose: string;
  relativePath: string;
  runner: RegressionRunner;
  contents: string;
  expectedPrePatchFailure: string;
  expectedPostPatchBehavior: string;
};

export type PrePatchClassification =
  | "failed_as_expected"
  | "unexpectedly_passed"
  | "invalid_test"
  | "timed_out"
  | "execution_failed";

export type PostPatchClassification =
  | "passed"
  | "failed"
  | "timed_out"
  | "execution_failed";

// Aggregate contract:
// - proven: failed_as_expected before, passed after, identical hash
// - blocked: a valid generated test exists but its contract failed
//   (unexpectedly passed, post-patch failed/timed out/crashed, hash mismatch)
// - unavailable: no generator, or no structurally valid + diagnostic test
//   could be produced within the bounded attempts — neutral, never a pass
export type RegressionAggregate = "proven" | "blocked" | "unavailable";

export type RegressionTestSummary = {
  status: RegressionAggregate;
  testName: string | null;
  relativePath: string | null;
  runner: RegressionRunner | null;
  sha256: string | null;
  prePatch: PrePatchClassification | null;
  postPatch: PostPatchClassification | null;
  hashMatched: boolean | null;
  generationAttempts: number;
  reason: string | null;
};

const MAX_TEST_CHARS = 20_000;
const MAX_NAME_CHARS = 80;
const TEST_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/;
const TEST_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;

const DEFAULT_REGRESSION_TIMEOUT_MS = 30_000;

export function getRegressionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SHERLOCK_REGRESSION_TIMEOUT_MS);

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REGRESSION_TIMEOUT_MS;
}

// Content patterns that are never acceptable in a generated test: shell or
// child-process execution, dynamic code construction, environment dumping,
// and network targets other than the sandbox application URL provided via
// SHERLOCK_TARGET_URL.
// The final behavioral assertion must carry this marker in its message.
// Classification only accepts a pre-patch failure as behavioral proof when
// the process failed on an assertion AND the output contains this exact
// marker text — a setup failure (wrong route, 404, missing fixture) that
// trips a different assertion is an invalid test, not proof of the bug.
export const REGRESSION_FAILURE_MARKER_PREFIX = "REGRESSION_EXPECTED_FAILURE:";

// Exactly one stable marker prefix must exist in the test contents. Compare
// the prefix rather than the complete JavaScript string literal: generated
// assertion messages may contain escaped quotes or backslashes whose source
// representation differs from the runtime text printed by Node.
export function extractRegressionFailureMarker(contents: string): string | null {
  const matches = contents.match(/REGRESSION_EXPECTED_FAILURE:/g) ?? [];

  if (matches.length !== 1) {
    return null;
  }

  return REGRESSION_FAILURE_MARKER_PREFIX;
}

const BANNED_CONTENT_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /child_process|execSync|spawnSync|\bspawn\s*\(|\bexecFile\b/, label: "child-process execution" },
  { pattern: /\beval\s*\(/, label: "eval" },
  { pattern: /new\s+Function\s*\(/, label: "dynamic Function construction" },
  { pattern: /\bworker_threads\b/, label: "worker threads" },
  { pattern: /\bnode:vm\b|require\(["']vm["']\)/, label: "vm module" },
  { pattern: /JSON\.stringify\s*\(\s*process\.env\s*\)/, label: "environment dumping" },
  { pattern: /Object\.(entries|keys|values)\s*\(\s*process\.env\s*\)/, label: "environment dumping" },
  { pattern: /https?:\/\/(?!localhost|127\.0\.0\.1|host\.docker\.internal)/i, label: "external network target" },
];

export type ProposalValidation =
  | { ok: true; proposal: RegressionTestProposal }
  | { ok: false; errors: string[] };

export function validateRegressionProposalShape(value: unknown): ProposalValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["Regression test proposal must be a JSON object."] };
  }

  const proposal = value as Record<string, unknown>;
  const errors: string[] = [];

  if (proposal.version !== REGRESSION_PROPOSAL_VERSION) {
    errors.push(`Proposal version must be ${REGRESSION_PROPOSAL_VERSION}.`);
  }

  if (
    typeof proposal.testName !== "string" ||
    !TEST_NAME_PATTERN.test(proposal.testName) ||
    proposal.testName.length > MAX_NAME_CHARS
  ) {
    errors.push("testName must be a short kebab-case slug.");
  }

  if (typeof proposal.purpose !== "string" || !proposal.purpose) {
    errors.push("purpose must be a non-empty string.");
  }

  if (typeof proposal.relativePath !== "string" || !isSafeTestPath(proposal.relativePath)) {
    errors.push(
      'relativePath must be a plain repository-root file name ending in ".mjs" with no directories, traversal, or absolute paths.',
    );
  }

  if (!SUPPORTED_RUNNERS.includes(proposal.runner as RegressionRunner)) {
    errors.push(`runner must be one of: ${SUPPORTED_RUNNERS.join(", ")}.`);
  }

  if (typeof proposal.contents !== "string" || !proposal.contents.trim()) {
    errors.push("contents must be a non-empty string.");
  } else {
    if (proposal.contents.length > MAX_TEST_CHARS) {
      errors.push(`contents exceeds the ${MAX_TEST_CHARS}-character limit.`);
    }

    if (!/\bassert\b/.test(proposal.contents)) {
      errors.push("contents must include a deterministic node:assert assertion.");
    }

    if (extractRegressionFailureMarker(proposal.contents) === null) {
      errors.push(
        `contents must include exactly one "${REGRESSION_FAILURE_MARKER_PREFIX} …" message on the final behavioral assertion (and only there), so a setup failure can never be mistaken for behavioral proof.`,
      );
    }

    for (const { pattern, label } of BANNED_CONTENT_PATTERNS) {
      if (pattern.test(proposal.contents)) {
        errors.push(`contents contains a banned construct: ${label}.`);
      }
    }
  }

  if (
    typeof proposal.expectedPrePatchFailure !== "string" ||
    !proposal.expectedPrePatchFailure
  ) {
    errors.push("expectedPrePatchFailure must be a non-empty string.");
  }

  if (
    typeof proposal.expectedPostPatchBehavior !== "string" ||
    !proposal.expectedPostPatchBehavior
  ) {
    errors.push("expectedPostPatchBehavior must be a non-empty string.");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, proposal: proposal as unknown as RegressionTestProposal };
}

function isSafeTestPath(relativePath: string): boolean {
  // Repository-root single file only: no separators means no traversal, no
  // symlinked parent directories, and no collisions outside the root.
  return (
    TEST_PATH_PATTERN.test(relativePath) &&
    !relativePath.includes("/") &&
    !relativePath.includes("\\") &&
    !relativePath.includes("..")
  );
}

// Filesystem-facing safety: the target must not already exist (a generated
// test must never overwrite repository files) and must resolve inside the
// repository root.
export async function validateRegressionProposalSafety(
  proposal: RegressionTestProposal,
  repoPath: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  const repoRoot = path.resolve(repoPath);
  const absolutePath = path.resolve(repoRoot, proposal.relativePath);

  if (absolutePath !== path.join(repoRoot, proposal.relativePath)) {
    errors.push("relativePath escapes the repository workspace.");
  }

  try {
    await lstat(absolutePath);
    errors.push(`A file already exists at ${proposal.relativePath}; generated tests must never overwrite repository files.`);
  } catch {
    // Not existing is the required state.
  }

  return { ok: errors.length === 0, errors };
}

export function hashTestContents(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

// Writes the exact proposal bytes and confirms what landed on disk hashes to
// the expected value; returns a remover that must run on every path.
export async function materializeTest(
  repoPath: string,
  proposal: RegressionTestProposal,
  expectedSha256: string,
): Promise<{ ok: boolean; remove: () => Promise<void> }> {
  const absolutePath = path.join(path.resolve(repoPath), proposal.relativePath);
  await writeFile(absolutePath, proposal.contents, "utf8");

  const written = await readFile(absolutePath, "utf8");
  const ok = hashTestContents(written) === expectedSha256;

  return {
    ok,
    remove: async () => {
      await rm(absolutePath, { force: true });
    },
  };
}

// Markers emitted by Node itself, used to separate a behavioral assertion
// failure from broken test code. These are runtime-defined error codes, not
// arbitrary message matching of Sherlock's own errors.
const ASSERTION_MARKERS = [/ERR_ASSERTION/, /AssertionError/];
const INVALID_TEST_MARKERS = [
  /SyntaxError/,
  /ERR_MODULE_NOT_FOUND/,
  /MODULE_NOT_FOUND/,
  /Cannot find module/,
  /Cannot find package/,
  /ReferenceError/,
];

export function classifyPrePatchRun(
  run: {
    exitCode: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
  expectedFailureMarker: string,
): PrePatchClassification {
  if (run.timedOut) {
    return "timed_out";
  }

  if (run.exitCode === 0) {
    return "unexpectedly_passed";
  }

  const output = `${run.stdout}\n${run.stderr}`;
  const assertionFailed = ASSERTION_MARKERS.some((marker) => marker.test(output));

  // Behavioral proof requires BOTH: an assertion failure AND the exact
  // expected behavioral marker in the output. An assertion that failed
  // without the marker is a setup/fixture failure (e.g. a wrong route
  // returning 404) — an invalid test, eligible for the one refinement.
  if (assertionFailed && output.includes(expectedFailureMarker)) {
    return "failed_as_expected";
  }

  if (assertionFailed || INVALID_TEST_MARKERS.some((marker) => marker.test(output))) {
    return "invalid_test";
  }

  // Launch failures and unrelated crashes are never regression proof.
  return "execution_failed";
}

export function classifyPostPatchRun(run: {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): PostPatchClassification {
  if (run.timedOut) {
    return "timed_out";
  }

  if (run.exitCode === 0) {
    return "passed";
  }

  const output = `${run.stdout}\n${run.stderr}`;

  if (ASSERTION_MARKERS.some((marker) => marker.test(output))) {
    return "failed";
  }

  return "execution_failed";
}

// The sandbox application URL as seen from inside a sibling container under
// HOST addressing: localhost would be the test container itself, so the
// Docker host gateway name is substituted. The only network target a
// generated test may use. (Under network addressing the URL already names
// the app container and is used unchanged — see runRegressionTest.)
export function rewriteTargetUrlForContainer(baseUrl: string): string {
  return baseUrl.replace(/localhost|127\.0\.0\.1/, "host.docker.internal");
}

function sandboxNetworkFromEnv(): string | null {
  const addressing = getSandboxAddressing();

  return addressing.mode === "network" ? addressing.network : null;
}

// The running app container, identified so a strict-policy regression
// container can join its network namespace instead of having any network
// path of its own.
export type AppNetworkTarget = {
  containerName: string;
  internalPort: number;
};

export async function runRegressionTest(
  docker: DockerAdapter,
  options: {
    repoPath: string;
    relativePath: string;
    targetUrl?: string | null;
    appNetwork?: AppNetworkTarget | null;
    networkPolicy?: SandboxNetworkPolicy;
    // Shared sandbox network of a containerized worker (see SandboxAddressing
    // in container.ts); null = host addressing. Defaults from the environment.
    sandboxNetwork?: string | null;
    timeoutMs?: number;
  },
): Promise<ContainerCommandResult> {
  const policy = options.networkPolicy ?? getSandboxNetworkPolicy();
  const sandboxNetwork =
    options.sandboxNetwork !== undefined
      ? options.sandboxNetwork
      : sandboxNetworkFromEnv();

  let network: ContainerNetwork | undefined;
  let addHostGateway = false;
  let targetUrlForTest: string | null = null;

  if (!options.targetUrl) {
    // No app access needed: under strict there is no network at all.
    network = policy === "strict" ? "none" : undefined;
  } else if (policy === "strict" && options.appNetwork) {
    // Strict with a known app container: join ITS network namespace. The
    // test reaches the app at localhost:<internal port> and has no network
    // path beyond the app container's own boundary — no bridge, no
    // host gateway, no internet of its own.
    network = { joinContainer: options.appNetwork.containerName };
    targetUrlForTest = `http://localhost:${options.appNetwork.internalPort}`;
  } else if (sandboxNetwork) {
    // Permissive (or fallback) under network addressing: the target URL's
    // hostname is the app container's name on the shared sandbox network, so
    // the test container attaches to that same network and uses the URL
    // as-is — a host-gateway alias could never resolve a container name.
    network = { attachNetwork: sandboxNetwork };
    targetUrlForTest = options.targetUrl;

    if (policy === "strict") {
      console.warn(
        "Regression test needs app access but no app container was identified; falling back to the shared sandbox network.",
      );
    }
  } else {
    // Permissive, or strict without an identified app container (e.g. tests
    // injecting a bespoke restart): previous behavior — default bridge with
    // the host-gateway alias. Documented fallback, not silent.
    addHostGateway = true;
    targetUrlForTest = rewriteTargetUrlForContainer(options.targetUrl);

    if (policy === "strict") {
      console.warn(
        "Regression test needs app access but no app container was identified; falling back to host-gateway networking.",
      );
    }
  }

  return runContainerCommand(docker, {
    purpose: "regression",
    workspacePath: options.repoPath,
    env: buildTargetEnv({
      extra: {
        CI: "true",
        ...(targetUrlForTest ? { SHERLOCK_TARGET_URL: targetUrlForTest } : {}),
      },
    }),
    command: ["node", options.relativePath],
    timeoutMs: options.timeoutMs ?? getRegressionTimeoutMs(),
    addHostGateway,
    network,
  });
}

export type RegressionGenerationInput = {
  issueTitle: string;
  issueBody: string;
  plan: ReproductionPlan;
  reproductionResult: ReproductionResult;
  fixProposal: unknown;
  sourceFiles: { path: string; contents: string }[];
};

const MAX_REGRESSION_API_RESPONSES = 8;
const MAX_REGRESSION_API_BODY_CHARS = 2_000;
const MAX_REGRESSION_SOURCE_CHARS = 32_000;
const MAX_REGRESSION_SOURCE_FILE_CHARS = 12_000;

function redactJsonSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactJsonSecrets(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        /key|token|secret|password|passwd|credential|authorization|auth/i.test(key)
          ? "[REDACTED]"
          : redactJsonSecrets(item, depth + 1),
      ]),
  );
}

function redactApiBody(body: string): string {
  try {
    return JSON.stringify(redactJsonSecrets(JSON.parse(body)));
  } catch {
    return redactSecrets(body);
  }
}

function formatRegressionApiEvidence(result: ReproductionResult): string {
  const responses = (result.apiResponses ?? []).slice(-MAX_REGRESSION_API_RESPONSES);
  if (responses.length === 0) return "(no response bodies were captured)";

  return responses
    .map((response) => {
      const safeBody = redactApiBody(response.body ?? "");
      const body = safeBody.length > MAX_REGRESSION_API_BODY_CHARS
        ? `${safeBody.slice(0, MAX_REGRESSION_API_BODY_CHARS)}\n[RESPONSE BODY EVIDENCE TRUNCATED]`
        : safeBody;
      return `${response.method} ${response.url} -> ${response.status} ${response.statusText}\n${body}`;
    })
    .join("\n\n");
}

function proposalFilePaths(value: unknown): Set<string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Set();
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) return new Set();
  return new Set(
    files
      .map((file) =>
        file && typeof file === "object" && typeof (file as { path?: unknown }).path === "string"
          ? (file as { path: string }).path
          : null,
      )
      .filter((file): file is string => file !== null),
  );
}

function regressionSearchTerms(input: RegressionGenerationInput): string[] {
  const text = [
    input.issueTitle,
    input.issueBody,
    JSON.stringify(input.plan),
    JSON.stringify(input.fixProposal),
  ].join(" ");
  return [...new Set(text.match(/[A-Za-z0-9][A-Za-z0-9_-]{4,}/g) ?? [])]
    .sort((a, b) => b.length - a.length)
    .slice(0, 40);
}

function sourceExcerpt(contents: string, terms: string[]): string {
  if (contents.length <= MAX_REGRESSION_SOURCE_FILE_CHARS) return contents;

  const lines = contents.split("\n");
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(lines.length, 35); index += 1) selected.add(index);

  for (let index = 0; index < lines.length; index += 1) {
    if (!terms.some((term) => lines[index].toLowerCase().includes(term.toLowerCase()))) continue;
    for (let line = Math.max(0, index - 8); line <= Math.min(lines.length - 1, index + 12); line += 1) {
      selected.add(line);
    }
  }

  const rendered = [...selected]
    .sort((a, b) => a - b)
    .map((index) => `${index + 1}: ${lines[index]}`)
    .join("\n");
  return rendered.length > MAX_REGRESSION_SOURCE_FILE_CHARS
    ? `${rendered.slice(0, MAX_REGRESSION_SOURCE_FILE_CHARS)}\n[SOURCE EVIDENCE TRUNCATED]`
    : rendered;
}

function formatRegressionSourceEvidence(input: RegressionGenerationInput): string {
  const changedPaths = proposalFilePaths(input.fixProposal);
  const terms = regressionSearchTerms(input);
  const ordered = [...input.sourceFiles].sort((left, right) =>
    Number(changedPaths.has(right.path)) - Number(changedPaths.has(left.path)),
  );
  let remaining = MAX_REGRESSION_SOURCE_CHARS;
  const sections: string[] = [];

  for (const file of ordered.slice(0, 8)) {
    if (remaining <= 0) break;
    const excerpt = sourceExcerpt(file.contents, terms);
    const bounded = excerpt.slice(0, remaining);
    sections.push(`--- ${file.path} ---\n${bounded}`);
    remaining -= bounded.length;
  }

  return sections.join("\n\n") || "(no selected source files found)";
}

// Prompt for the structured test proposal. Lives here (Claude-free) so the
// generation rules are unit-testable; claude.ts only sends it.
export function buildRegressionTestPrompt(
  input: RegressionGenerationInput,
  feedback: string | null,
): string {
  return `
You are writing ONE focused regression test for a bug that Sherlock has deterministically reproduced and is about to patch.

Return ONLY valid JSON (no markdown, no fences) with this exact shape:
{
  "version": 1,
  "testName": "kebab-case-slug-describing-the-bug",
  "purpose": "one sentence",
  "relativePath": "sherlock-regression.test.mjs",
  "runner": "node",
  "contents": "…complete ESM test file…",
  "expectedPrePatchFailure": "one sentence: which assertion fails on the buggy source",
  "expectedPostPatchBehavior": "one sentence: what passes after the fix"
}

Test rules:
- The file is executed as \`node <relativePath>\` from the repository root inside a sandbox container.
- Use ONLY \`import assert from "node:assert/strict"\` for assertions; the test must exit nonzero via a failing assertion on the buggy behavior and exit 0 once fixed.
- Use ONLY routes, paths, selectors, and actions that appear in the verified reproduction plan below or verbatim in the provided source files. NEVER invent, guess, or abbreviate an endpoint: if the plan calls POST /tasks/archive-completed, the test must call POST /tasks/archive-completed, not /tasks/archive.
- The FINAL behavioral assertion — the one that demonstrates the bug — must carry a message that starts with "${REGRESSION_FAILURE_MARKER_PREFIX}" followed by the expectedPrePatchFailure text. Use this marker on exactly ONE assertion and nowhere else. Example:
  assert.ok(condition, "${REGRESSION_FAILURE_MARKER_PREFIX} archived completed task reappeared after archive-completed");
- Setup steps (creating fixtures, calling endpoints) must use plain assertions WITHOUT that marker, so a setup failure is never mistaken for the behavioral failure.
- Capture IDs from the resources the test itself creates (parse the response bodies) instead of assuming fixed IDs, unless the verified reproduction plan itself proves fixed IDs.
- Prefer proving the FINAL observable resource or user-visible state over polling background-job metadata. Do not parse or poll a job identifier unless its exact response field AND type are explicitly shown in the captured API response evidence or relevant source below. If the final state can be polled using a unique fixture token, do that instead and avoid the job ID entirely.
- Never guess a JSON response shape. When a setup assertion depends on a response body, include a bounded diagnostic containing only its top-level keys and value TYPES (never secret/user values) so a rejected first attempt can be corrected safely.
- Test ONLY the reproduced behavioral assertion; no broad suites, no unrelated checks.
- Write one deterministic test whose exact bytes can run unchanged before and after the patch; do not branch on source version, patch state, or run phase.
- The relativePath must be a single new file at the repository root ending in ".mjs".
- If the check requires calling the running application, use fetch against \`process.env.SHERLOCK_TARGET_URL\` (the sandbox app). No other network access.
- Reading repository source files relatively is allowed when asserting on behavior is impossible.
- NEVER use child_process, eval, new Function, worker threads, vm, or dump process.env.
- Keep it under 100 lines and fully deterministic.
- If an action starts asynchronous work, poll for the ACTUAL behavioral completion condition or a verified terminal job state. A poll must not stop merely because a response exists, returns JSON, has a property, has a numeric count, or has a successful HTTP status; those are readiness checks, not proof that the behavior under test completed.
- Stop polling as soon as the expected post-patch behavior is observed. Use a monotonic deadline or bounded attempts with at most 5_000 ms total polling and intervals no longer than 250 ms, unless the verified reproduction proves a longer interval is necessary.
- Never use an unbounded loop or a fixed multi-second sleep when the behavioral condition can be polled. If the condition remains wrong through the deadline or a verified terminal failure state is reached, make exactly ONE final behavioral assertion carrying the required failure marker.
- The pre-patch run must fail only after the bounded wait confirms the behavior remains wrong. The post-patch run must pass as soon as the correct behavior appears.

Illustrative polling shape (adapt the behavioral predicate using only trusted routes and identifiers; do not copy or invent endpoints):
  async function pollUntil(predicate, timeoutMs = 5_000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
      lastValue = await readCurrentState();
      if (predicate(lastValue)) return { matched: true, lastValue };
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    lastValue = await readCurrentState();
    return { matched: predicate(lastValue), lastValue };
  }
  const result = await pollUntil(
    (body) => !JSON.stringify(body).includes(taskTitle),
  );
  assert.ok(
    result.matched,
    "${REGRESSION_FAILURE_MARKER_PREFIX} archived task remained visible",
  );

Bug context:
Issue: ${input.issueTitle}
${input.issueBody}

Reproduction plan (verified to reproduce the bug — the ONLY trusted source of routes and actions):
${JSON.stringify(input.plan, null, 2)}

Observed failure: ${input.reproductionResult.outcomeReason}
Failed assertion: ${JSON.stringify(input.reproductionResult.assertion)}

Captured same-origin API response evidence (bounded and secret-redacted; trusted for response fields/types):
${formatRegressionApiEvidence(input.reproductionResult)}

Proposed patch (about to be applied; the test must fail BEFORE it and pass AFTER it):
${JSON.stringify(input.fixProposal, null, 2)}

Relevant source files:
${formatRegressionSourceEvidence(input)}
${feedback ? `\nYour previous proposal was rejected: ${feedback}\nReturn a corrected proposal as bare JSON.` : ""}
`;
}

const PRE_PATCH_LABELS: Record<PrePatchClassification, string> = {
  failed_as_expected: "failed as expected",
  unexpectedly_passed: "unexpectedly passed",
  invalid_test: "invalid test",
  timed_out: "timed out",
  execution_failed: "execution failed",
};

const POST_PATCH_LABELS: Record<PostPatchClassification, string> = {
  passed: "passed",
  failed: "failed",
  timed_out: "timed out",
  execution_failed: "execution failed",
};

// Truthful GitHub comment lines for the regression block.
export function formatRegressionCommentLines(
  summary: RegressionTestSummary,
): string[] {
  if (summary.status === "unavailable" || summary.prePatch === null) {
    return [
      "Status: not available",
      `Reason: ${summary.reason ?? "no safe supported test form could be generated"}`,
    ];
  }

  const lines = [
    `Test: ${summary.testName ?? "(unnamed)"}`,
    `Before patch: ${PRE_PATCH_LABELS[summary.prePatch]}`,
  ];

  if (summary.postPatch !== null) {
    lines.push(`After patch: ${POST_PATCH_LABELS[summary.postPatch]}`);
  }

  if (summary.hashMatched !== null) {
    lines.push(`Identical test: ${summary.hashMatched ? "yes" : "no"}`);
  }

  return lines;
}
