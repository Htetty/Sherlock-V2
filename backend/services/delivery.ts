// GitHub delivery of a finished investigation, separated from investigation
// execution so it can be retried on its own.
//
// Execution (clone, reproduction, model calls, patching, verification) happens
// once, inside the pipeline. Everything GitHub-facing that comes after a
// terminal execution result — pushing the fix branch, creating/reusing the
// pull request, posting the terminal issue comment — is driven from a durable
// DeliveryState record persisted under artifacts/<investigationId>/. A
// delivery retry therefore needs only this record plus a freshly minted
// installation token; it never reruns cloning, target startup, reproduction,
// Anthropic calls, patch generation, regression testing, or repository
// validation.
//
// Idempotency contract (per investigation):
//   - at most one Sherlock branch: the recorded/derived branch name is looked
//     up on GitHub before any create;
//   - at most one pull request: all PR states are reconciled for the exact
//     repository, head, and base before any create;
//   - at most one terminal issue comment: every terminal comment embeds an
//     HTML marker, and the issue's comments are checked for that marker
//     before posting.
//
// No credentials or customer text are stored in delivery-state.json. PR text,
// terminal-comment material, and post-patch source bytes live in separate
// mode-0600, content-addressed raw artifacts. The JSON state contains only
// bounded identities, hashes, relative references, and delivery statuses.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  mkdtemp,
  readdir,
  lstat,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  getArtifactsRoot,
  isFixAttemptId,
  isInvestigationId,
} from "./artifacts.js";
import {
  buildCommitMessage,
  buildFixBranchName,
  buildPullRequestBody,
  buildPullRequestTitle,
  checkPullRequestPreconditions,
  isForbiddenPullRequestPath,
  SHERLOCK_AUTHOR_EMAIL,
  SHERLOCK_AUTHOR_NAME,
  type PullRequestInput,
  type PullRequestResult,
} from "./pull-request.js";
import {
  formatPullRequestComment,
  formatResultComment,
  redactSecrets,
  type InvestigationSummary,
} from "./report.js";
import {
  safeRepoUrl,
  type InvestigationStateEvent,
  type InvestigationStateEventInput,
  type InvestigationStateStore,
} from "./investigation-state-store.js";
import { validateRepositoryIdentity } from "./repo-auth.js";

// --- Delivery state model ---------------------------------------------------

// Pull-request delivery status, kept separate from both the execution outcome
// and the patch-verification outcome:
//   not_applicable — no verified fix, nothing to deliver
//   pending        — verified fix whose branch/PR delivery has not finished
//   created        — Sherlock created the pull request
//   reused         — an existing open Sherlock pull request was safely reused
//   failed         — delivery failed permanently (reason recorded)
export type DeliveryPullRequestStatus =
  | "not_applicable"
  | "pending"
  | "created"
  | "reused"
  | "merged"
  | "blocked"
  | "failed";

export type DeliveryCommentStatus = "pending" | "posted" | "failed";

export type DeliveryFile = {
  path: string;
  // Null represents a verified deletion. GitHub's tree API deletes a path
  // when the entry sha is null.
  contents: string | null;
  mode: "100644" | "100755";
};

export type DeliveryFileIdentity = {
  path: string;
  mode: "100644" | "100755";
  contentSha256: string | null;
};

export type DeliveryArtifactReference = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type PullRequestRetryPayload = {
  version: 1;
  investigationId: string;
  title: string;
  body: string;
  commitMessage: string;
  files: DeliveryFile[];
};

export type TerminalCommentPayload = {
  version: 1;
  investigationId: string;
  summary: InvestigationSummary;
  analysisComment: string | null;
  fixComment: string | null;
};

// Everything needed to recreate the fix branch and pull request through the
// GitHub API when the local workspace (and its git commit) no longer exists.
// Captured from the verified workspace before it is cleaned up; text and
// source bytes live only in the protected raw payload referenced here.
export type PullRequestRetryPlan = {
  branch: string;
  sourceCommit: string;
  baseBranch: string;
  expectedTreeSha: string;
  files: DeliveryFileIdentity[];
  payload: DeliveryArtifactReference;
};

export type DeliveryState = {
  version: 2;
  investigationId: string;
  tenantId: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  // Terminal execution outcome of the pipeline (verified_fix, reproduced,
  // not_reproduced, plan_failed, environment_failed, execution_failed).
  executionOutcome: string;
  // Patch verification outcome, independent of any GitHub delivery.
  fixVerified: boolean;
  fixAttemptId: string | null;
  pullRequest: {
    status: DeliveryPullRequestStatus;
    // Branch push status: true once the fix branch exists on GitHub.
    branchPushed: boolean;
    branch: string | null;
    number: number | null;
    url: string | null;
    reason: string | null;
  };
  retryPlan: PullRequestRetryPlan | null;
  terminalPayload: DeliveryArtifactReference;
  terminalComment: {
    status: DeliveryCommentStatus;
    postedAt: string | null;
    reason: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type TerminalFailureCategory =
  | "repository"
  | "infrastructure"
  | "preflight"
  | "worker";

export type TerminalFailureRecord = {
  version: 1;
  investigationId: string;
  tenantId: string;
  repoOwner: string;
  repoName: string;
  category: TerminalFailureCategory;
  stage: string;
  terminalAt: string;
  retentionEligibleAt: string;
};

const MAX_DELIVERY_ERROR_CHARS = 2_000;
const MAX_DELIVERY_TEXT_CHARS = 20_000;
const MAX_RETRY_PLAN_FILES = 50;
const MAX_DELIVERY_STATE_BYTES = 128 * 1024;
const MAX_DELIVERY_PAYLOAD_BYTES = 3 * 1024 * 1024;
export const DELIVERY_LOCK_TTL_MS = 20_000;
export const DELIVERY_LOCK_HEARTBEAT_MS = 5_000;
const execFileAsync = promisify(execFile);
const DELIVERY_OUTCOMES = new Set([
  "reproduced",
  "not_reproduced",
  "plan_failed",
  "environment_failed",
  "execution_failed",
  "verified_fix",
]);
const DELIVERY_STAGES = new Set([
  "queued",
  "running",
  "reproducing",
  "fixing",
  "verifying",
  "preparing_delivery",
  "delivering",
  "completed",
  "failed",
]);
const PULL_REQUEST_FAILED_REASON =
  "GitHub pull-request delivery failed permanently.";
const PULL_REQUEST_BLOCKED_REASON =
  "The matching pull request is closed without being merged; Sherlock will not create a replacement.";
const TERMINAL_COMMENT_FAILED_REASON =
  "GitHub terminal-comment delivery failed permanently.";

export function isDeliveryComplete(state: DeliveryState): boolean {
  return (
    state.terminalComment.status === "posted" &&
    state.pullRequest.status !== "pending"
  );
}

// Terminal means no further delivery attempt will change the state: either
// everything was delivered, or the terminal comment failed permanently.
export function isDeliveryTerminal(state: DeliveryState): boolean {
  return isDeliveryComplete(state) || state.terminalComment.status === "failed";
}

// A fix counts as fully delivered only when the patch was verified, the
// branch was pushed, the pull request was created or safely reused, AND the
// terminal issue comment was posted.
export function isFixFullyDelivered(state: DeliveryState): boolean {
  return (
    state.fixVerified &&
    state.pullRequest.branchPushed &&
    (state.pullRequest.status === "created" ||
      state.pullRequest.status === "reused" ||
      state.pullRequest.status === "merged") &&
    state.terminalComment.status === "posted"
  );
}

// --- Building the initial state ---------------------------------------------

export type DeliveryStateInput = {
  investigationId: string;
  tenantId: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueTitle: string;
  outcome: string;
  summary: InvestigationSummary;
  fixVerified: boolean;
  fixAttemptId: string | null;
  analysisComment: string | null;
  fixComment: string | null;
  // The in-pipeline pull-request result (null when the PR flow never ran or
  // threw before producing one).
  pullRequest: PullRequestResult | null;
  retryPlan: PullRequestRetryPlan | null;
};

export async function buildDeliveryState(
  input: DeliveryStateInput,
  store: DeliveryStateStore,
): Promise<DeliveryState> {
  validateRepositoryIdentity(input.repoOwner, input.repoName);
  if (
    !isInvestigationId(input.investigationId) ||
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0 ||
    input.tenantId !== `tenant-gh-${input.installationId}` ||
    !Number.isSafeInteger(input.issueNumber) ||
    input.issueNumber <= 0 ||
    !DELIVERY_OUTCOMES.has(input.outcome) ||
    (input.fixAttemptId !== null && !isFixAttemptId(input.fixAttemptId))
  ) {
    throw new Error("Delivery input contains invalid metadata.");
  }
  const at = new Date().toISOString();
  const retryPlan = sanitizeRetryPlan(input.retryPlan);
  const pullRequest = mapPipelinePullRequest({ ...input, retryPlan });
  const terminalPayload = await store.persistPayload(
    input.investigationId,
    "terminal",
    {
      version: 1,
      investigationId: input.investigationId,
      summary: input.summary,
      analysisComment: input.analysisComment,
      fixComment: input.fixComment,
    } satisfies TerminalCommentPayload,
  );

  return {
    version: 2,
    investigationId: input.investigationId,
    tenantId: input.tenantId,
    installationId: input.installationId,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    issueNumber: input.issueNumber,
    executionOutcome: input.outcome,
    fixVerified: input.fixVerified,
    fixAttemptId: input.fixAttemptId,
    pullRequest,
    // The retry plan is only needed while PR delivery is unfinished.
    retryPlan: pullRequest.status === "pending" ? retryPlan : null,
    terminalPayload,
    terminalComment: { status: "pending", postedAt: null, reason: null },
    createdAt: at,
    updatedAt: at,
  };
}

function boundedSafeText(value: string, maxChars: number): string {
  return redactSecrets(value).slice(0, maxChars);
}

function safeDeliveryFilePath(filePath: string): boolean {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.length > 500 ||
    filePath.includes("\0") ||
    path.isAbsolute(filePath) ||
    isForbiddenPullRequestPath(filePath)
  ) {
    return false;
  }

  const normalized = path.posix.normalize(filePath);
  return (
    normalized === filePath &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function safeBranchName(branch: string | null): string | null {
  if (!branch) return null;
  if (
    branch.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock")
  ) {
    return null;
  }
  return branch;
}

function canonicalPullRequestUrl(
  owner: string,
  repo: string,
  number: number | null,
): string | null {
  return number !== null && Number.isSafeInteger(number) && number > 0
    ? `https://github.com/${owner}/${repo}/pull/${number}`
    : null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const DELIVERY_PAYLOAD_DIRECTORY = "protected-delivery";

function sanitizeArtifactReference(
  reference: DeliveryArtifactReference,
): DeliveryArtifactReference | null {
  if (
    !reference ||
    typeof reference.path !== "string" ||
    path.posix.normalize(reference.path) !== reference.path ||
    !reference.path.startsWith(`${DELIVERY_PAYLOAD_DIRECTORY}/`) ||
    path.posix.isAbsolute(reference.path) ||
    reference.path.includes("\0") ||
    !SHA256_PATTERN.test(reference.sha256) ||
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes <= 0 ||
    reference.sizeBytes > MAX_DELIVERY_PAYLOAD_BYTES
  ) {
    return null;
  }
  return { ...reference };
}

function sanitizeRetryPlan(
  plan: PullRequestRetryPlan | null,
): PullRequestRetryPlan | null {
  if (!plan || plan.files.length === 0 || plan.files.length > MAX_RETRY_PLAN_FILES) {
    return null;
  }

  const seen = new Set<string>();
  const files: DeliveryFileIdentity[] = [];

  for (const file of plan.files) {
    if (
      !safeDeliveryFilePath(file.path) ||
      seen.has(file.path) ||
      (file.mode !== "100644" && file.mode !== "100755")
    ) {
      return null;
    }
    seen.add(file.path);

    if (
      file.contentSha256 !== null &&
      !SHA256_PATTERN.test(file.contentSha256)
    ) {
      return null;
    }

    files.push({
      path: file.path,
      mode: file.mode,
      contentSha256: file.contentSha256,
    });
  }

  const payload = sanitizeArtifactReference(plan.payload);
  if (
    !GIT_SHA_PATTERN.test(plan.sourceCommit) ||
    !GIT_SHA_PATTERN.test(plan.expectedTreeSha) ||
    !safeBranchName(plan.baseBranch) ||
    !payload
  ) {
    return null;
  }

  const branch = safeBranchName(plan.branch);
  if (!branch) {
    return null;
  }

  return {
    branch,
    sourceCommit: plan.sourceCommit,
    baseBranch: plan.baseBranch,
    expectedTreeSha: plan.expectedTreeSha,
    files,
    payload,
  };
}

function mapPipelinePullRequest(
  input: DeliveryStateInput,
): DeliveryState["pullRequest"] {
  const none = {
    branch: null as string | null,
    number: null as number | null,
    url: null as string | null,
    reason: null as string | null,
  };

  if (!input.fixVerified) {
    return { ...none, status: "not_applicable", branchPushed: false };
  }

  const result = input.pullRequest;

  if (!result) {
    // The PR flow threw before producing a result; retry through the API
    // when a plan was captured, otherwise record a truthful failure.
    return input.retryPlan
      ? { ...none, status: "pending", branchPushed: false }
      : {
          ...none,
          status: "failed",
          branchPushed: false,
          reason: PULL_REQUEST_FAILED_REASON,
        };
  }

  const common = {
    branch: safeBranchName(result.branch),
    number:
      result.pullRequestNumber !== null &&
      Number.isSafeInteger(result.pullRequestNumber) &&
      result.pullRequestNumber > 0
        ? result.pullRequestNumber
        : null,
    url: canonicalPullRequestUrl(
      input.repoOwner,
      input.repoName,
      result.pullRequestNumber,
    ),
    // Pipeline exception text is deliberately not copied into durable state.
    reason: null as string | null,
  };

  switch (result.status) {
    case "created":
      return { ...common, status: "created", branchPushed: true };
    case "already_exists":
      return { ...common, status: "reused", branchPushed: true };
    case "pull_request_failed":
      // Branch push succeeded; only the PR API call remains.
      return { ...common, status: "pending", branchPushed: true };
    case "branch_creation_failed":
    case "commit_failed":
    case "push_failed":
      return input.retryPlan
        ? { ...common, status: "pending", branchPushed: false }
        : {
            ...common,
            status: "failed",
            branchPushed: false,
            reason: PULL_REQUEST_FAILED_REASON,
          };
    case "precondition_failed":
      // Verification preconditions failed; a PR must not be created at all.
      return {
        ...common,
        status: "failed",
        branchPushed: false,
        reason: PULL_REQUEST_FAILED_REASON,
      };
  }
}

// --- Retry-plan capture (runs while the verified workspace still exists) ----

const MAX_RETRY_PLAN_FILE_BYTES = 512 * 1024;
const MAX_RETRY_PLAN_TOTAL_BYTES = 2 * 1024 * 1024;

// Capture everything a workspace-less delivery retry needs. Returns null
// (with the reason logged by the caller) when the plan cannot be captured
// safely; delivery then reports a truthful permanent PR failure instead of
// guessing.
export async function capturePullRequestRetryPlan(
  input: PullRequestInput,
  payloadStore: Pick<DeliveryStateStore, "persistPayload"> =
    createFileDeliveryStateStore(),
): Promise<PullRequestRetryPlan | null> {
  const preconditionError = await checkPullRequestPreconditions(input);
  if (preconditionError) {
    return null;
  }

  if (
    input.fixAttempt.changedFiles.length > MAX_RETRY_PLAN_FILES ||
    new Set(input.fixAttempt.changedFiles).size !==
      input.fixAttempt.changedFiles.length
  ) {
    return null;
  }

  const repoRoot = path.resolve(input.repoPath);
  const files: DeliveryFile[] = [];
  let totalBytes = 0;

  for (const filePath of input.fixAttempt.changedFiles) {
    // Same gates the commit flow enforces: no secret-shaped paths, and no
    // path that escapes the workspace.
    if (!safeDeliveryFilePath(filePath)) {
      return null;
    }

    const resolved = path.resolve(repoRoot, filePath);

    if (!resolved.startsWith(repoRoot + path.sep)) {
      return null;
    }

    let info;
    try {
      info = await lstat(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // checkPullRequestPreconditions already proved this path is an
        // approved dirty path, so absence here is a verified deletion.
        files.push({ path: filePath, contents: null, mode: "100644" });
        continue;
      }
      throw error;
    }

    if (!info.isFile() || info.size > MAX_RETRY_PLAN_FILE_BYTES) {
      return null;
    }

    totalBytes += info.size;

    if (totalBytes > MAX_RETRY_PLAN_TOTAL_BYTES) {
      return null;
    }

    const contents = await readFile(resolved, "utf8");

    files.push({
      path: filePath,
      contents,
      mode: (info.mode & 0o111) !== 0 ? "100755" : "100644",
    });
  }

  if (files.length === 0) {
    return null;
  }

  const branch = buildFixBranchName({
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    fixAttemptId: input.fixAttempt.fixAttemptId,
  });
  const expectedTreeSha = await expectedTreeForWorkspace(
    repoRoot,
    input.fixAttempt.sourceCommit,
    input.fixAttempt.changedFiles,
  );
  const payload = await payloadStore.persistPayload(
    input.investigationId,
    "retry",
    {
      version: 1,
      investigationId: input.investigationId,
      title: buildPullRequestTitle(input),
      body: await buildPullRequestBody(input),
      commitMessage: buildCommitMessage(input),
      files,
    } satisfies PullRequestRetryPayload,
  );

  return sanitizeRetryPlan({
    branch,
    sourceCommit: input.fixAttempt.sourceCommit,
    baseBranch: input.baseBranch,
    expectedTreeSha,
    files: files.map((file) => ({
      path: file.path,
      mode: file.mode,
      contentSha256:
        file.contents === null ? null : sha256(Buffer.from(file.contents, "utf8")),
    })),
    payload,
  });
}

async function expectedTreeForWorkspace(
  repoRoot: string,
  sourceCommit: string,
  changedFiles: string[],
): Promise<string> {
  const temporary = await mkdtemp(path.join(tmpdir(), "sherlock-delivery-index-"));
  const indexFile = path.join(temporary, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await execFileAsync("git", ["read-tree", sourceCommit], {
      cwd: repoRoot,
      env,
      timeout: 60_000,
    });
    await execFileAsync("git", ["add", "--all", "--", ...changedFiles], {
      cwd: repoRoot,
      env,
      timeout: 60_000,
    });
    const { stdout } = await execFileAsync("git", ["write-tree"], {
      cwd: repoRoot,
      env,
      timeout: 60_000,
    });
    const tree = stdout.trim();
    if (!GIT_SHA_PATTERN.test(tree)) {
      throw new Error("Git produced an invalid delivery tree identity.");
    }
    return tree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// --- Durable state store -----------------------------------------------------

export type DeliveryStateStore = {
  load(investigationId: string): Promise<DeliveryState | null>;
  save(state: DeliveryState): Promise<void>;
  loadTerminalFailure(
    investigationId: string,
  ): Promise<TerminalFailureRecord | null>;
  saveTerminalFailure(record: TerminalFailureRecord): Promise<void>;
  persistPayload(
    investigationId: string,
    kind: "retry" | "terminal",
    payload: unknown,
  ): Promise<DeliveryArtifactReference>;
  loadPayload(
    investigationId: string,
    reference: DeliveryArtifactReference,
  ): Promise<unknown>;
  // Serializes the full reconcile/check/create/save sequence for one
  // investigation. This closes the check-then-create race between duplicate
  // or stalled BullMQ deliveries.
  withLock<T>(
    investigationId: string,
    operation: (lease: DeliveryLockLease) => Promise<T>,
  ): Promise<T>;
};

export const DELIVERY_STATE_FILE = "delivery-state.json";
export const TERMINAL_FAILURE_FILE = "terminal-failure.json";

export type DeliveryLockLease = {
  token: string;
  renew(): Promise<void>;
  assertOwned(): Promise<void>;
};

export class DeliveryLockBusyError extends Error {
  readonly code = "EDELIVERYLOCKED";
}

export class DeliveryLockLostError extends Error {
  readonly code = "EDELIVERYLOCKLOST";
}

function normalizeDeliveryState(value: unknown): DeliveryState {
  if (!value || typeof value !== "object") {
    throw new Error("Delivery state is not an object.");
  }

  const state = structuredClone(value) as DeliveryState;
  if (
    state.version !== 2 ||
    !isInvestigationId(state.investigationId) ||
    typeof state.tenantId !== "string" ||
    !Number.isSafeInteger(state.installationId) ||
    state.installationId <= 0 ||
    state.tenantId !== `tenant-gh-${state.installationId}` ||
    !Number.isSafeInteger(state.issueNumber) ||
    state.issueNumber <= 0 ||
    typeof state.executionOutcome !== "string" ||
    !DELIVERY_OUTCOMES.has(state.executionOutcome) ||
    typeof state.fixVerified !== "boolean" ||
    (state.fixAttemptId !== null && !isFixAttemptId(state.fixAttemptId)) ||
    typeof state.createdAt !== "string" ||
    !Number.isFinite(Date.parse(state.createdAt)) ||
    typeof state.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(state.updatedAt)) ||
    !state.pullRequest ||
    (state.pullRequest.number !== null &&
      (!Number.isSafeInteger(state.pullRequest.number) ||
        state.pullRequest.number <= 0)) ||
    !sanitizeArtifactReference(state.terminalPayload) ||
    !state.terminalComment ||
    (state.terminalComment.postedAt !== null &&
      (typeof state.terminalComment.postedAt !== "string" ||
        !Number.isFinite(Date.parse(state.terminalComment.postedAt))))
  ) {
    throw new Error("Delivery state has an invalid shape.");
  }

  validateRepositoryIdentity(state.repoOwner, state.repoName);

  const pullRequestStatuses = new Set<DeliveryPullRequestStatus>([
    "not_applicable",
    "pending",
    "created",
    "reused",
    "merged",
    "blocked",
    "failed",
  ]);
  const commentStatuses = new Set<DeliveryCommentStatus>([
    "pending",
    "posted",
    "failed",
  ]);

  if (
    !pullRequestStatuses.has(state.pullRequest.status) ||
    typeof state.pullRequest.branchPushed !== "boolean" ||
    !commentStatuses.has(state.terminalComment.status)
  ) {
    throw new Error("Delivery state has an invalid status.");
  }

  const branch = safeBranchName(state.pullRequest.branch);
  if (state.pullRequest.branch !== null && !branch) {
    throw new Error("Delivery state contains an unsafe branch name.");
  }
  state.pullRequest.branch = branch;
  state.pullRequest.url = canonicalPullRequestUrl(
    state.repoOwner,
    state.repoName,
    state.pullRequest.number,
  );
  state.pullRequest.reason =
    state.pullRequest.status === "blocked"
      ? PULL_REQUEST_BLOCKED_REASON
      : state.pullRequest.status === "failed"
        ? PULL_REQUEST_FAILED_REASON
        : null;
  state.terminalComment.reason =
    state.terminalComment.status === "failed"
      ? TERMINAL_COMMENT_FAILED_REASON
      : null;
  state.terminalPayload = sanitizeArtifactReference(state.terminalPayload)!;

  if (state.retryPlan) {
    const plan = sanitizeRetryPlan(state.retryPlan);
    if (!plan) {
      throw new Error("Delivery state contains an unsafe retry plan.");
    }
    state.retryPlan = plan;
  }

  const jsonBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  if (jsonBytes > MAX_DELIVERY_STATE_BYTES) {
    throw new Error("Delivery state exceeds the size limit.");
  }

  return state;
}

function normalizeTerminalFailure(value: unknown): TerminalFailureRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Terminal failure is not an object.");
  }
  const record = structuredClone(value) as TerminalFailureRecord;
  const categories = new Set<TerminalFailureCategory>([
    "repository",
    "infrastructure",
    "preflight",
    "worker",
  ]);
  if (
    record.version !== 1 ||
    !isInvestigationId(record.investigationId) ||
    typeof record.tenantId !== "string" ||
    !/^tenant-gh-[1-9][0-9]*$/.test(record.tenantId) ||
    !categories.has(record.category) ||
    typeof record.stage !== "string" ||
    !DELIVERY_STAGES.has(record.stage) ||
    !Number.isFinite(Date.parse(record.terminalAt)) ||
    !Number.isFinite(Date.parse(record.retentionEligibleAt))
  ) {
    throw new Error("Terminal failure has an invalid shape.");
  }
  validateRepositoryIdentity(record.repoOwner, record.repoName);
  return record;
}

// One JSON file per investigation under the artifacts root, next to the other
// per-investigation artifacts. Same durability class as the pull-request
// result file the PR flow already relies on for retries.
export function createFileDeliveryStateStore(
  rootDir: string = getArtifactsRoot(),
  lockOptions: {
    ttlMs?: number;
    heartbeatMs?: number;
    now?: () => number;
  } = {},
): DeliveryStateStore {
  const resolvedRoot = path.resolve(rootDir);
  const lockTtlMs = lockOptions.ttlMs ?? DELIVERY_LOCK_TTL_MS;
  const lockHeartbeatMs =
    lockOptions.heartbeatMs ?? DELIVERY_LOCK_HEARTBEAT_MS;
  const now = lockOptions.now ?? Date.now;
  // Locks live outside investigation directories so retention cleanup can
  // remove artifacts/<id>/ while still holding the same lock delivery uses.
  // A lock inside the deletion target would disappear mid-critical-section
  // and permit a concurrent delivery retry to recreate state underneath it.
  const lockRoot = path.join(resolvedRoot, "_delivery-locks");
  const dirFor = (investigationId: string) => {
    if (!isInvestigationId(investigationId)) {
      throw new Error("Refusing delivery-state path for unsafe investigation id.");
    }

    const dir = path.resolve(resolvedRoot, investigationId);
    if (!dir.startsWith(resolvedRoot + path.sep)) {
      throw new Error("Delivery-state path escaped the artifacts root.");
    }
    return dir;
  };

  const ensureDir = async (investigationId: string) => {
    const dir = dirFor(investigationId);
    await mkdir(dir, { recursive: true });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Refusing a non-directory delivery-state location.");
    }
    return dir;
  };

  const ensureLockRoot = async () => {
    await mkdir(lockRoot, { recursive: true });
    const info = await lstat(lockRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Refusing a non-directory delivery-lock location.");
    }
  };

  const readRecord = async <T>(
    investigationId: string,
    fileName: string,
    maxBytes: number,
    normalize: (value: unknown) => T,
  ): Promise<T | null> => {
    try {
      const dir = dirFor(investigationId);
      const dirInfo = await lstat(dir);
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
        throw new Error("Refusing a non-directory delivery-state location.");
      }
      const file = path.join(dir, fileName);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
        throw new Error("Refusing an unsafe delivery record.");
      }
      const raw = await readFile(file, "utf8");
      if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        throw new Error("Delivery record exceeds the size limit.");
      }
      return normalize(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const writeRecord = async (
    investigationId: string,
    fileName: string,
    value: unknown,
  ) => {
    const dir = await ensureDir(investigationId);
    const destination = path.join(dir, fileName);
    const temporary = path.join(dir, `.${fileName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };

  const claimLock = async (lockDir: string, token: string) => {
    const preparedDir = `${lockDir}.claim-${token}`;
    await mkdir(preparedDir);
    const preparedOwner = path.join(preparedDir, "owner");
    let handle;
    try {
      await writeFile(preparedOwner, token, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      handle = await open(preparedOwner, "r+");
      // The fully initialized lease becomes visible in one namespace change;
      // contenders can never observe or delete a half-created owner record.
      await rename(preparedDir, lockDir);
      return handle;
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(preparedDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  };

  return {
    async load(investigationId) {
      const state = await readRecord(
        investigationId,
        DELIVERY_STATE_FILE,
        MAX_DELIVERY_STATE_BYTES,
        normalizeDeliveryState,
      );
      return state?.investigationId === investigationId ? state : null;
    },
    async save(state) {
      const normalized = normalizeDeliveryState(state);
      await writeRecord(
        normalized.investigationId,
        DELIVERY_STATE_FILE,
        normalized,
      );
    },
    async loadTerminalFailure(investigationId) {
      const failure = await readRecord(
        investigationId,
        TERMINAL_FAILURE_FILE,
        16 * 1024,
        normalizeTerminalFailure,
      );
      return failure?.investigationId === investigationId ? failure : null;
    },
    async saveTerminalFailure(record) {
      const normalized = normalizeTerminalFailure(record);
      await writeRecord(
        normalized.investigationId,
        TERMINAL_FAILURE_FILE,
        normalized,
      );
    },
    async persistPayload(investigationId, kind, payload) {
      if (!isInvestigationId(investigationId)) {
        throw new Error("Refusing a protected payload for an unsafe investigation id.");
      }
      const raw = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
      if (raw.length <= 1 || raw.length > MAX_DELIVERY_PAYLOAD_BYTES) {
        throw new Error("Protected delivery payload exceeds the size limit.");
      }
      const digest = sha256(raw);
      const reference = {
        path: `${DELIVERY_PAYLOAD_DIRECTORY}/${kind}-${digest}.json`,
        sha256: digest,
        sizeBytes: raw.length,
      } satisfies DeliveryArtifactReference;
      const dir = await ensureDir(investigationId);
      const payloadDir = path.join(dir, DELIVERY_PAYLOAD_DIRECTORY);
      await mkdir(payloadDir, { recursive: true, mode: 0o700 });
      const payloadDirInfo = await lstat(payloadDir);
      if (!payloadDirInfo.isDirectory() || payloadDirInfo.isSymbolicLink()) {
        throw new Error("Refusing an unsafe protected delivery directory.");
      }
      const destination = path.join(dir, ...reference.path.split("/"));
      try {
        await writeFile(destination, raw, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(destination);
        if (sha256(existing) !== digest || existing.length !== raw.length) {
          throw new Error("Existing protected delivery payload failed integrity verification.");
        }
      }
      return reference;
    },
    async loadPayload(investigationId, reference) {
      const safeReference = sanitizeArtifactReference(reference);
      if (!safeReference) {
        throw new Error("Protected delivery artifact reference is unsafe.");
      }
      const dir = dirFor(investigationId);
      const payloadDir = path.join(dir, DELIVERY_PAYLOAD_DIRECTORY);
      const [dirInfo, payloadDirInfo] = await Promise.all([
        lstat(dir),
        lstat(payloadDir),
      ]);
      if (
        !dirInfo.isDirectory() ||
        dirInfo.isSymbolicLink() ||
        !payloadDirInfo.isDirectory() ||
        payloadDirInfo.isSymbolicLink()
      ) {
        throw new Error("Protected delivery artifact directory is unsafe.");
      }
      const target = path.resolve(dir, ...safeReference.path.split("/"));
      if (!target.startsWith(path.resolve(dir) + path.sep)) {
        throw new Error("Protected delivery artifact escaped its investigation directory.");
      }
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== safeReference.sizeBytes) {
        throw new Error("Protected delivery artifact is unsafe or changed.");
      }
      const raw = await readFile(target);
      if (sha256(raw) !== safeReference.sha256) {
        throw new Error("Protected delivery artifact failed integrity verification.");
      }
      return JSON.parse(raw.toString("utf8")) as unknown;
    },
    async withLock(investigationId, operation) {
      if (!isInvestigationId(investigationId)) {
        throw new Error("Refusing delivery lock for unsafe investigation id.");
      }
      await ensureLockRoot();
      const lockDir = path.join(lockRoot, `${investigationId}.lock`);
      const ownerFile = path.join(lockDir, "owner");
      const lockOwner = randomUUID();
      let ownerHandle;

      try {
        ownerHandle = await claimLock(lockDir, lockOwner);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" &&
          (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
        ) {
          throw error;
        }

        const observedOwner = await stat(ownerFile).catch(() => null);
        if (
          !observedOwner ||
          now() - observedOwner.mtimeMs <= lockTtlMs
        ) {
          throw new DeliveryLockBusyError(
            "Another delivery attempt is already reconciling this investigation.",
          );
        }
        const staleDir = `${lockDir}.stale-${randomUUID()}`;
        try {
          await rename(lockDir, staleDir);
          ownerHandle = await claimLock(lockDir, lockOwner);
        } catch {
          await ownerHandle?.close().catch(() => {});
          throw new DeliveryLockBusyError(
            "Another delivery attempt acquired the reconciliation lock.",
          );
        }
      }

      if (!ownerHandle) throw new DeliveryLockBusyError("Delivery lock unavailable.");
      const acquiredHandle = ownerHandle;

      // Remove the fixed lock path only after proving that it still resolves
      // to this lease's inode and token. The post-rename proof prevents a
      // path-replacement race from deleting a newer owner's generation.
      const removeOwnedPath = async (label: string): Promise<boolean> => {
        const generationDir = `${lockDir}.${label}-${lockOwner}`;
        try {
          const [currentInfo, handleInfo, currentOwner] = await Promise.all([
            lstat(ownerFile),
            acquiredHandle.stat(),
            readFile(ownerFile, "utf8"),
          ]);
          if (
            currentInfo.dev !== handleInfo.dev ||
            currentInfo.ino !== handleInfo.ino ||
            currentOwner !== lockOwner
          ) {
            return false;
          }
          await rename(lockDir, generationDir);
          const [movedInfo, movedOwner] = await Promise.all([
            lstat(path.join(generationDir, "owner")),
            readFile(path.join(generationDir, "owner"), "utf8"),
          ]);
          if (
            movedInfo.dev === handleInfo.dev &&
            movedInfo.ino === handleInfo.ino &&
            movedOwner === lockOwner
          ) {
            await rm(generationDir, { recursive: true, force: true });
            return true;
          }
          await rename(generationDir, lockDir).catch(() => {});
        } catch {
          // Missing or replaced lock: never delete an unproven owner.
        }
        return false;
      };

      // A contender can win the narrow path-vacancy race after a stale
      // generation is renamed. It must reconcile the visible stale generation
      // before doing work: a freshly renewed old owner is restored and fences
      // this contender; only a truly expired generation is removed.
      try {
        const stalePrefix = `${investigationId}.lock.stale-`;
        const staleEntries = (await readdir(lockRoot)).filter((entry) =>
          entry.startsWith(stalePrefix),
        );
        if (staleEntries.length > 8) {
          throw new DeliveryLockBusyError("Delivery lock recovery is ambiguous.");
        }
        for (const entry of staleEntries) {
          const staleDir = path.join(lockRoot, entry);
          const staleOwner = await stat(path.join(staleDir, "owner")).catch(
            () => null,
          );
          if (staleOwner && now() - staleOwner.mtimeMs <= lockTtlMs) {
            if (await removeOwnedPath("yield")) {
              await rename(staleDir, lockDir).catch(() => {});
            }
            throw new DeliveryLockBusyError(
              "The previous delivery owner renewed during stale recovery.",
            );
          }
          await rm(staleDir, { recursive: true, force: true });
        }
      } catch (error) {
        await removeOwnedPath("recovery-failed");
        await acquiredHandle.close().catch(() => {});
        if (error instanceof DeliveryLockBusyError) throw error;
        throw new DeliveryLockBusyError("Delivery lock recovery is ambiguous.");
      }

      let ownershipLost: Error | null = null;
      const assertOwned = async () => {
        if (ownershipLost) throw ownershipLost;
        const handleInfo = await acquiredHandle.stat();
        const buffer = Buffer.alloc(Buffer.byteLength(lockOwner, "utf8"));
        const { bytesRead } = await acquiredHandle.read(
          buffer,
          0,
          buffer.length,
          0,
        );
        if (bytesRead !== buffer.length || buffer.toString("utf8") !== lockOwner) {
          ownershipLost = new DeliveryLockLostError("Delivery lock ownership was lost.");
          throw ownershipLost;
        }
        const instant = new Date(now());
        await acquiredHandle.utimes(instant, instant);
        const pathInfo = await lstat(ownerFile).catch(() => null);
        const currentOwner = await readFile(ownerFile, "utf8").catch(() => null);
        if (
          !pathInfo ||
          pathInfo.dev !== handleInfo.dev ||
          pathInfo.ino !== handleInfo.ino ||
          currentOwner !== lockOwner
        ) {
          ownershipLost = new DeliveryLockLostError("Delivery lock ownership was lost.");
          throw ownershipLost;
        }
      };
      const lease: DeliveryLockLease = {
        token: lockOwner,
        renew: assertOwned,
        assertOwned,
      };
      let pendingHeartbeat = Promise.resolve();
      const heartbeat =
        lockHeartbeatMs > 0
          ? setInterval(() => {
              pendingHeartbeat = pendingHeartbeat
                .then(assertOwned)
                .catch((error: unknown) => {
                  ownershipLost =
                    error instanceof Error
                      ? error
                      : new DeliveryLockLostError("Delivery lock ownership was lost.");
                });
            }, lockHeartbeatMs)
          : null;
      heartbeat?.unref();

      try {
        await assertOwned();
        return await operation(lease);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await pendingHeartbeat.catch(() => {});
        await removeOwnedPath("release");
        await acquiredHandle.close().catch(() => {});
      }
    },
  };
}

const inMemoryDeliveryPayloads = new Map<string, Buffer>();

export function createInMemoryDeliveryStateStore(): DeliveryStateStore & {
  snapshot(): DeliveryState[];
} {
  const states = new Map<string, DeliveryState>();
  const failures = new Map<string, TerminalFailureRecord>();
  const locks = new Map<string, Promise<void>>();

  return {
    async load(investigationId) {
      const state = states.get(investigationId);
      return state ? (structuredClone(state) as DeliveryState) : null;
    },
    async save(state) {
      const normalized = normalizeDeliveryState(state);
      states.set(
        normalized.investigationId,
        structuredClone(normalized) as DeliveryState,
      );
    },
    async loadTerminalFailure(investigationId) {
      const failure = failures.get(investigationId);
      return failure ? structuredClone(failure) : null;
    },
    async saveTerminalFailure(record) {
      const normalized = normalizeTerminalFailure(record);
      failures.set(normalized.investigationId, structuredClone(normalized));
    },
    async persistPayload(investigationId, kind, payload) {
      if (!isInvestigationId(investigationId)) throw new Error("Unsafe investigation id.");
      const raw = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
      const digest = sha256(raw);
      const reference = {
        path: `${DELIVERY_PAYLOAD_DIRECTORY}/${kind}-${digest}.json`,
        sha256: digest,
        sizeBytes: raw.length,
      } satisfies DeliveryArtifactReference;
      inMemoryDeliveryPayloads.set(`${investigationId}:${reference.path}`, raw);
      return reference;
    },
    async loadPayload(investigationId, reference) {
      const safe = sanitizeArtifactReference(reference);
      if (!safe) throw new Error("Unsafe protected delivery artifact reference.");
      const raw = inMemoryDeliveryPayloads.get(`${investigationId}:${safe.path}`);
      if (
        !raw ||
        raw.length !== safe.sizeBytes ||
        sha256(raw) !== safe.sha256
      ) {
        throw new Error("Protected delivery artifact failed integrity verification.");
      }
      return JSON.parse(raw.toString("utf8")) as unknown;
    },
    async withLock(investigationId, operation) {
      const previous = locks.get(investigationId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      locks.set(investigationId, tail);

      await previous;
      let owned = true;
      const lease: DeliveryLockLease = {
        token: randomUUID(),
        async renew() {
          if (!owned) throw new DeliveryLockLostError("Delivery lock ownership was lost.");
        },
        async assertOwned() {
          if (!owned) throw new DeliveryLockLostError("Delivery lock ownership was lost.");
        },
      };
      try {
        return await operation(lease);
      } finally {
        owned = false;
        release();
        if (locks.get(investigationId) === tail) {
          locks.delete(investigationId);
        }
      }
    },
    snapshot() {
      return [...states.values()];
    },
  };
}

// --- Terminal comment --------------------------------------------------------

// Hidden marker embedded in every terminal comment so a delivery retry can
// detect an already-posted comment on GitHub instead of posting a duplicate.
export function terminalCommentMarker(investigationId: string): string {
  return `<!-- sherlock-terminal-comment:${investigationId} -->`;
}

export async function findTerminalCommentPaginated(input: {
  marker: string;
  listPage: (
    page: number,
    perPage: number,
  ) => Promise<Array<{ body?: string | null }>>;
  assertOwnership: () => Promise<void>;
  maxPages?: number;
}): Promise<boolean> {
  const perPage = 100;
  const maxPages = input.maxPages ?? 20;
  for (let page = 1; page <= maxPages; page += 1) {
    await input.assertOwnership();
    const comments = await input.listPage(page, perPage);
    if (
      !Array.isArray(comments) ||
      comments.length > perPage ||
      comments.some(
        (comment) =>
          !comment ||
          (comment.body !== null &&
            comment.body !== undefined &&
            typeof comment.body !== "string"),
      )
    ) {
      throw Object.assign(new Error("GitHub comment reconciliation was ambiguous."), {
        status: 502,
      });
    }
    if (
      comments.some(
        (comment) =>
          typeof comment.body === "string" &&
          comment.body.includes(input.marker),
      )
    ) {
      return true;
    }
    if (comments.length < perPage) return false;
  }
  throw Object.assign(
    new Error("GitHub comment history exceeded the bounded reconciliation scan."),
    { status: 503 },
  );
}

// Build the terminal comment from the CURRENT delivery state, so the posted
// text always tells the truth about what was actually delivered: a fix is
// only presented with a pull request when that pull request really exists.
export function buildTerminalComment(
  state: DeliveryState,
  payload: TerminalCommentPayload,
): string {
  const summary: InvestigationSummary = state.fixVerified
    ? { ...payload.summary, pullRequestStatus: summaryPullRequestStatus(state) }
    : payload.summary;

  const pullRequestSection =
    state.fixVerified && state.fixAttemptId
      ? formatPullRequestComment({
          investigationId: state.investigationId,
          fixAttemptId: state.fixAttemptId,
          status: pullRequestCommentStatus(state),
          pullRequestNumber: state.pullRequest.number,
          pullRequestUrl: state.pullRequest.url,
          branch: state.pullRequest.branch,
          reason: state.pullRequest.reason,
        })
      : null;

  const sections = [
    payload.analysisComment,
    payload.fixComment,
    pullRequestSection,
  ].filter((section): section is string => Boolean(section));

  const body =
    sections.length > 0
      ? `${formatResultComment(summary)}\n\n---\n\n${sections.join("\n\n---\n\n")}`
      : formatResultComment(summary);

  return `${body}\n\n${terminalCommentMarker(state.investigationId)}`;
}

function summaryPullRequestStatus(state: DeliveryState): string {
  switch (state.pullRequest.status) {
    case "created":
      return "created";
    case "reused":
      return "already_exists";
    case "merged":
      return "already_merged";
    case "blocked":
      return "delivery_blocked";
    case "failed":
      return "delivery_failed";
    case "pending":
      return "delivery_pending";
    case "not_applicable":
      return "not_attempted";
  }
}

function pullRequestCommentStatus(state: DeliveryState): string {
  switch (state.pullRequest.status) {
    case "created":
      return "created";
    case "reused":
      return "already_exists";
    case "merged":
      return "already_exists";
    case "blocked":
      return "delivery_failed";
    case "failed":
      return state.pullRequest.branchPushed && state.pullRequest.branch
        ? "pull_request_failed"
        : "delivery_failed";
    default:
      return "delivery_pending";
  }
}

// --- GitHub client -----------------------------------------------------------

// The pull-request REST surface plus the Git Data operations a workspace-less
// push retry needs. Tests inject a mock; production uses the fetch client.
export type DeliveryPullRequest = {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
};

export type DeliveryGitHubClient = {
  // Resolves the branch head and commit identity, or null when the branch does
  // not exist. Commit metadata proves an existing branch was created for this
  // exact investigation/fix attempt before it is reused.
  getBranch: (branch: string) => Promise<{
    sha: string;
    treeSha: string;
    parentShas: string[];
  } | null>;
  findPullRequests: (input: {
    head: string;
    base: string;
    assertOwnership: () => Promise<void>;
  }) => Promise<{
    matches: DeliveryPullRequest[];
    conflictingBase: boolean;
  }>;
  // Recreates the fix commit through the Git Data API (blobs -> tree ->
  // commit -> ref) on top of the recorded source commit.
  createBranchWithCommit: (input: {
    branch: string;
    baseCommitSha: string;
    message: string;
    files: DeliveryFile[];
    expectedTreeSha: string;
    assertOwnership: () => Promise<void>;
  }) => Promise<{ commitSha: string; treeSha: string }>;
  createPullRequest: (input: {
    title: string;
    head: string;
    base: string;
    body: string;
    assertOwnership: () => Promise<void>;
  }) => Promise<{ number: number; url: string }>;
};

export function createDeliveryGitHubRestClient(options: {
  token: string;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
}): DeliveryGitHubClient {
  validateRepositoryIdentity(options.owner, options.repo);
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const repoUrl = `${apiBaseUrl}/repos/${options.owner}/${options.repo}`;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const request = async <T>(
    method: string,
    url: string,
    body?: unknown,
    assertOwnership?: () => Promise<void>,
  ): Promise<T> => {
    await assertOwnership?.();
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw Object.assign(
        new Error(
          `GitHub ${method} request failed: ${response.status} ${response.statusText}`,
        ),
        { status: response.status },
      );
    }

    return (await response.json()) as T;
  };

  return {
    getBranch: async (branch) => {
      const response = await fetch(
        `${repoUrl}/git/ref/heads/${encodeURIComponent(branch)}`,
        {
          headers,
        },
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw Object.assign(
          new Error(
            `GitHub branch lookup failed: ${response.status} ${response.statusText}`,
          ),
          { status: response.status },
        );
      }

      const data = (await response.json()) as { object?: { sha?: string } };

      if (!data.object?.sha || !GIT_SHA_PATTERN.test(data.object.sha)) {
        throw Object.assign(new Error("GitHub branch lookup was ambiguous."), {
          status: 502,
        });
      }

      const commit = await request<{
        tree?: { sha?: string };
        parents?: { sha?: string }[];
      }>("GET", `${repoUrl}/git/commits/${data.object.sha}`);

      if (
        !commit.tree?.sha ||
        !GIT_SHA_PATTERN.test(commit.tree.sha) ||
        !Array.isArray(commit.parents) ||
        commit.parents.some(
          (parent) => !parent?.sha || !GIT_SHA_PATTERN.test(parent.sha),
        )
      ) {
        throw Object.assign(new Error("GitHub branch commit has no tree identity."), {
          status: 502,
        });
      }

      return {
        sha: data.object.sha,
        treeSha: commit.tree.sha,
        parentShas: commit.parents.map((parent) => parent.sha!),
      };
    },
    findPullRequests: async ({ head, base, assertOwnership }) => {
      const matches: DeliveryPullRequest[] = [];
      let conflictingBase = false;
      const maxPages = 10;
      for (let page = 1; page <= maxPages; page += 1) {
        const url = new URL(`${repoUrl}/pulls`);
        url.searchParams.set("state", "all");
        url.searchParams.set("head", head);
        url.searchParams.set("per_page", "100");
        url.searchParams.set("page", String(page));
        const pulls = await request<Array<{
          number?: number;
          html_url?: string;
          state?: string;
          merged_at?: string | null;
          head?: { ref?: string; repo?: { full_name?: string } | null };
          base?: { ref?: string; repo?: { full_name?: string } | null };
        }>>("GET", url.toString(), undefined, assertOwnership);
        if (!Array.isArray(pulls) || pulls.length > 100) {
          throw Object.assign(new Error("GitHub PR reconciliation was ambiguous."), {
            status: 502,
          });
        }
        const expectedHeadRef = head.slice(head.indexOf(":") + 1);
        const expectedRepo = `${options.owner}/${options.repo}`.toLowerCase();
        for (const pull of pulls) {
          const exactHead =
            pull.head?.ref === expectedHeadRef &&
            pull.head.repo?.full_name?.toLowerCase() === expectedRepo;
          if (!exactHead) continue;
          const exactBase =
            pull.base?.ref === base &&
            pull.base.repo?.full_name?.toLowerCase() === expectedRepo;
          if (!exactBase) {
            conflictingBase = true;
            continue;
          }
          if (
            !Number.isSafeInteger(pull.number) ||
            pull.number! <= 0 ||
            (pull.merged_at !== null &&
              pull.merged_at !== undefined &&
              typeof pull.merged_at !== "string") ||
            (pull.state === "open" && pull.merged_at != null) ||
            (pull.state !== "open" && pull.state !== "closed")
          ) {
            throw Object.assign(new Error("GitHub PR reconciliation was ambiguous."), {
              status: 502,
            });
          }
          matches.push({
            number: pull.number!,
            url: canonicalPullRequestUrl(
              options.owner,
              options.repo,
              pull.number!,
            )!,
            state: pull.state,
            merged: pull.merged_at != null,
          });
        }
        if (pulls.length < 100) return { matches, conflictingBase };
      }
      throw Object.assign(
        new Error("GitHub PR history exceeded the bounded reconciliation scan."),
        { status: 503 },
      );
    },
    createBranchWithCommit: async ({
      branch,
      baseCommitSha,
      message,
      files,
      expectedTreeSha,
      assertOwnership,
    }) => {
      const baseCommit = await request<{ tree?: { sha?: string } }>(
        "GET",
        `${repoUrl}/git/commits/${baseCommitSha}`,
        undefined,
        assertOwnership,
      );
      if (!baseCommit.tree?.sha || !GIT_SHA_PATTERN.test(baseCommit.tree.sha)) {
        throw Object.assign(new Error("GitHub base commit response was ambiguous."), {
          status: 502,
        });
      }

      const treeEntries = [] as {
        path: string;
        mode: string;
        type: "blob";
        sha: string | null;
      }[];

      for (const file of files) {
        if (file.contents === null) {
          treeEntries.push({
            path: file.path,
            mode: file.mode,
            type: "blob",
            sha: null,
          });
          continue;
        }

        const blob = await request<{ sha: string }>(
          "POST",
          `${repoUrl}/git/blobs`,
          { content: file.contents, encoding: "utf-8" },
          assertOwnership,
        );
        if (!blob.sha || !GIT_SHA_PATTERN.test(blob.sha)) {
          throw Object.assign(new Error("GitHub blob response was ambiguous."), {
            status: 502,
          });
        }
        treeEntries.push({
          path: file.path,
          mode: file.mode,
          type: "blob",
          sha: blob.sha,
        });
      }

      const tree = await request<{ sha: string }>("POST", `${repoUrl}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree: treeEntries,
      }, assertOwnership);

      if (!tree.sha || !GIT_SHA_PATTERN.test(tree.sha)) {
        throw Object.assign(new Error("GitHub tree response was ambiguous."), {
          status: 502,
        });
      }
      if (tree.sha !== expectedTreeSha) {
        throw new Error("GitHub constructed a tree different from the verified delivery tree.");
      }

      const commit = await request<{ sha: string }>(
        "POST",
        `${repoUrl}/git/commits`,
        {
          message,
          tree: tree.sha,
          parents: [baseCommitSha],
          author: {
            name: SHERLOCK_AUTHOR_NAME,
            email: SHERLOCK_AUTHOR_EMAIL,
            date: new Date().toISOString(),
          },
        },
        assertOwnership,
      );
      if (!commit.sha || !GIT_SHA_PATTERN.test(commit.sha)) {
        throw Object.assign(new Error("GitHub commit response was ambiguous."), {
          status: 502,
        });
      }

      await request("POST", `${repoUrl}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      }, assertOwnership);

      return { commitSha: commit.sha, treeSha: tree.sha };
    },
    createPullRequest: async ({
      title,
      head,
      base,
      body,
      assertOwnership,
    }) => {
      const created = await request<{ number?: number; html_url?: string }>(
        "POST",
        `${repoUrl}/pulls`,
        { title, head, base, body },
        assertOwnership,
      );
      if (!Number.isSafeInteger(created.number) || created.number! <= 0) {
        throw Object.assign(new Error("GitHub PR creation response was ambiguous."), {
          status: 502,
        });
      }
      return {
        number: created.number!,
        url: canonicalPullRequestUrl(
          options.owner,
          options.repo,
          created.number!,
        )!,
      };
    },
  };
}

// --- Delivery executor -------------------------------------------------------

// Thrown (with an already-redacted message) when a delivery step failed
// transiently and another attempt is allowed. Typed so the queue layer never
// has to re-classify a message that has lost its status code.
export class DeliveryRetryableError extends Error {
  readonly retryable = true;
}

export type DeliveryExecutorDeps = {
  deliveryStore: DeliveryStateStore;
  // Best-effort lifecycle store; failures never fail delivery.
  stateStore?: InvestigationStateStore;
  // Mints a short-lived installation token; only called when pull-request
  // delivery still has GitHub work to do. Never persisted anywhere.
  getInstallationToken: (
    installationId: number,
  ) => Promise<{ token: string } | null>;
  createGitHubClient: (input: {
    token: string;
    owner: string;
    repo: string;
  }) => DeliveryGitHubClient;
  postIssueComment: (input: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
    assertOwnership: () => Promise<void>;
  }) => Promise<void>;
  // True when the issue already carries a comment containing the marker.
  findTerminalComment: (input: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    marker: string;
    assertOwnership: () => Promise<void>;
  }) => Promise<boolean>;
  // Retry classifier injected by the queue layer (kept out of this module so
  // services never depend on queue code).
  isRetryableError: (error: unknown) => boolean;
  log?: (message: string) => void;
};

export type DeliveryRunResult = {
  state: DeliveryState;
  complete: boolean;
};

// One idempotent delivery attempt. Ordering matters: the pull-request state
// is reconciled FIRST so the terminal comment (posted last, exactly once)
// describes the final delivery truth. Retryable failures always leave the
// durable state pending, including on the queue's final configured attempt.
export async function runDeliveryFromState(
  initial: DeliveryState,
  deps: DeliveryExecutorDeps,
  options: { isFinalAttempt: boolean },
): Promise<DeliveryRunResult> {
  // Queue exhaustion controls scheduling, not truth: a retryable GitHub or
  // lock ambiguity must never be converted into a permanent delivery result.
  void options.isFinalAttempt;
  try {
    return await deps.deliveryStore.withLock(
      initial.investigationId,
      async (lease) => {
        let latest: DeliveryState | null;
        try {
          latest = await deps.deliveryStore.load(initial.investigationId);
        } catch (error) {
          throw new DeliveryRetryableError(retryableDeliveryMessage(error));
        }

        return runDeliveryUnlocked(latest ?? initial, deps, lease);
      },
    );
  } catch (error) {
    if (
      error instanceof DeliveryLockBusyError ||
      error instanceof DeliveryLockLostError
    ) {
      throw new DeliveryRetryableError(retryableDeliveryMessage(error));
    }
    throw error;
  }
}

async function runDeliveryUnlocked(
  initial: DeliveryState,
  deps: DeliveryExecutorDeps,
  lease: DeliveryLockLease,
): Promise<DeliveryRunResult> {
  const log = deps.log ?? (() => {});
  const state = structuredClone(initial) as DeliveryState;
  const terminalPayloadForMetadata = await loadTerminalCommentPayload(
    deps.deliveryStore,
    state,
  ).catch(() => null);
  const originalOutcome =
    terminalPayloadForMetadata?.summary.originalOutcome ?? null;

  const recordState = async (event: InvestigationStateEventInput) => {
    try {
      await deps.stateStore?.record({
        ...event,
        investigationId: state.investigationId,
        at: new Date().toISOString(),
      } as InvestigationStateEvent);
    } catch (error) {
      log(
        `[${state.investigationId}] Delivery state-store write failed ("${event.type}"); continuing: ${safeMessage(error)}`,
      );
    }
  };

  const saveState = async () => {
    await lease.assertOwned();
    state.updatedAt = new Date().toISOString();
    await deps.deliveryStore.save(state);
  };

  // Identity heal: re-record tenant/installation/repo identity so a state
  // backend that was down during execution still ends up with a complete
  // record. The reducer keeps the original createdAt.
  await recordState({
    type: "created",
    tenantId: state.tenantId,
    installationId: state.installationId,
    repoOwner: state.repoOwner,
    repoName: state.repoName,
    repoUrl: safeRepoUrl(state.repoOwner, state.repoName),
    issueNumber: state.issueNumber,
  });

  if (isDeliveryTerminal(state)) {
    // A duplicate/restarted delivery is also the recovery path for a
    // lifecycle/Supabase outage. Re-fold the complete local snapshot without
    // touching GitHub so the best-effort index can heal later.
    await recordState({
      type: "pull_request",
      status: state.pullRequest.status,
      number: state.pullRequest.number,
      url: state.pullRequest.url,
      branch: state.pullRequest.branch,
    });
    await recordState({
      type: "terminal_comment",
      status: state.terminalComment.status === "posted" ? "posted" : "failed",
      ...(state.terminalComment.reason
        ? { error: state.terminalComment.reason }
        : {}),
    });
    await recordState({
      type: "final_outcome",
      outcome: state.executionOutcome,
      originalOutcome,
      pullRequestStatus: summaryPullRequestStatus(state),
      error: null,
    });
    return { state, complete: isDeliveryComplete(state) };
  }

  // --- Pull-request delivery (branch push + PR create/reuse) ---------------
  if (state.fixVerified && state.pullRequest.status === "pending") {
    try {
      await lease.assertOwned();
      const auth = await deps.getInstallationToken(state.installationId);

      if (!auth) {
        throw new Error(
          "Installation token minting returned no token for delivery.",
        );
      }

      const github = deps.createGitHubClient({
        token: auth.token,
        owner: state.repoOwner,
        repo: state.repoName,
      });

      await reconcilePullRequest(state, github, deps.deliveryStore, lease, log);
      await saveState();
      await recordState({
        type: "pull_request",
        status: state.pullRequest.status,
        number: state.pullRequest.number,
        url: state.pullRequest.url,
        branch: state.pullRequest.branch,
      });
    } catch (error) {
      if (error instanceof DeliveryLockLostError) {
        throw new DeliveryRetryableError(retryableDeliveryMessage(error));
      }
      if (deps.isRetryableError(error)) {
        await saveState().catch(() => {});
        throw new DeliveryRetryableError(retryableDeliveryMessage(error));
      }

      state.pullRequest.status = "failed";
      state.pullRequest.reason = PULL_REQUEST_FAILED_REASON;
      log(
        `[${state.investigationId}] Pull-request delivery failed permanently: ${state.pullRequest.reason}`,
      );
      await saveState();
      await recordState({
        type: "pull_request",
        status: "failed",
        number: state.pullRequest.number,
        url: state.pullRequest.url,
        branch: state.pullRequest.branch,
      });
    }
  }

  // --- Terminal issue comment (exactly once, always last) ------------------
  if (state.terminalComment.status !== "posted") {
    try {
      const marker = terminalCommentMarker(state.investigationId);
      const alreadyPosted = await deps.findTerminalComment({
        installationId: state.installationId,
        owner: state.repoOwner,
        repo: state.repoName,
        issueNumber: state.issueNumber,
        marker,
        assertOwnership: lease.assertOwned,
      });

      if (alreadyPosted) {
        log(
          `[${state.investigationId}] Terminal comment already exists on the issue; not posting a duplicate.`,
        );
      } else {
        const terminalPayload = await loadTerminalCommentPayload(
          deps.deliveryStore,
          state,
        );
        await lease.assertOwned();
        await deps.postIssueComment({
          installationId: state.installationId,
          owner: state.repoOwner,
          repo: state.repoName,
          issueNumber: state.issueNumber,
          body: buildTerminalComment(state, terminalPayload),
          assertOwnership: lease.assertOwned,
        });
      }

      state.terminalComment = {
        status: "posted",
        postedAt: new Date().toISOString(),
        reason: null,
      };
      await saveState();
      await recordState({ type: "terminal_comment", status: "posted" });
    } catch (error) {
      if (error instanceof DeliveryLockLostError) {
        throw new DeliveryRetryableError(retryableDeliveryMessage(error));
      }
      if (deps.isRetryableError(error)) {
        throw new DeliveryRetryableError(retryableDeliveryMessage(error));
      }

      state.terminalComment = {
        status: "failed",
        postedAt: null,
        reason: TERMINAL_COMMENT_FAILED_REASON,
      };
      log(
        `[${state.investigationId}] Terminal comment delivery failed permanently: ${state.terminalComment.reason}`,
      );
      await saveState();
      await recordState({
        type: "terminal_comment",
        status: "failed",
        error: state.terminalComment.reason,
      });
    }
  }

  // Refresh the terminal snapshot so the folded record carries the delivery
  // truth (original outcome and current pull-request status). error is null
  // here on purpose: execution errors were already appended once.
  await recordState({
    type: "final_outcome",
    outcome: state.executionOutcome,
    originalOutcome,
    pullRequestStatus: summaryPullRequestStatus(state),
    error: null,
  });

  return { state, complete: isDeliveryComplete(state) };
}

// Reconcile the pull request against GitHub: inspect before creating, reuse
// what already exists, and only create what is genuinely missing.
async function reconcilePullRequest(
  state: DeliveryState,
  github: DeliveryGitHubClient,
  store: DeliveryStateStore,
  lease: DeliveryLockLease,
  log: (message: string) => void,
): Promise<void> {
  const plan = state.retryPlan;
  const branch = state.pullRequest.branch ?? plan?.branch ?? null;

  if (!branch) {
    throw new Error(
      "No fix branch is recorded and none can be derived; pull-request delivery cannot proceed.",
    );
  }

  state.pullRequest.branch = branch;
  // A persisted "pushed" bit is only a hint. Every attempt proves the remote
  // branch tree again before it may authorize PR reconciliation.
  state.pullRequest.branchPushed = false;

  await lease.assertOwned();
  const existingBranch = await github.getBranch(branch);

  if (existingBranch) {
    if (
      !plan ||
      existingBranch.treeSha !== plan.expectedTreeSha ||
      existingBranch.parentShas.length !== 1 ||
      existingBranch.parentShas[0] !== plan.sourceCommit
    ) {
      throw new Error(
        `The existing branch ${branch} does not match this investigation's verified tree; refusing to reuse it.`,
      );
    }
    log(
      `[${state.investigationId}] Matching fix branch ${branch} already exists on GitHub; reusing it.`,
    );
  } else {
    if (!plan) {
      throw new Error(
        `The fix branch ${branch} is absent and no protected retry plan is available.`,
      );
    }
    const payload = await loadPullRequestRetryPayload(store, state, plan);
    const { commitSha, treeSha } = await github.createBranchWithCommit({
      branch,
      baseCommitSha: plan.sourceCommit,
      message: payload.commitMessage,
      files: payload.files,
      expectedTreeSha: plan.expectedTreeSha,
      assertOwnership: lease.assertOwned,
    });
    if (treeSha !== plan.expectedTreeSha) {
      throw new Error("Created branch did not return the verified tree identity.");
    }
    log(
      `[${state.investigationId}] Recreated fix branch ${branch} at ${commitSha} through the GitHub API.`,
    );
  }
  state.pullRequest.branchPushed = true;

  if (!plan) {
    throw new Error("No protected pull-request retry metadata is available.");
  }
  const head = `${state.repoOwner}:${branch}`;
  const reconciliation = await github.findPullRequests({
    head,
    base: plan.baseBranch,
    assertOwnership: lease.assertOwned,
  });

  if (reconciliation.matches.length > 1) {
    throw Object.assign(
      new Error("Multiple matching Sherlock pull requests make delivery ambiguous."),
      { status: 503 },
    );
  }
  const existing = reconciliation.matches[0];
  if (existing) {
    state.pullRequest.number = existing.number;
    state.pullRequest.url = existing.url;
    state.pullRequest.reason = null;
    if (existing.merged) {
      state.pullRequest.status = "merged";
    } else if (existing.state === "open") {
      state.pullRequest.status = "reused";
    } else {
      state.pullRequest.status = "blocked";
      state.pullRequest.reason = PULL_REQUEST_BLOCKED_REASON;
    }
    return;
  }

  if (reconciliation.conflictingBase) {
    throw new Error(
      "A pull request for the Sherlock branch targets a different base; refusing to create or reuse another pull request.",
    );
  }

  const payload = await loadPullRequestRetryPayload(store, state, plan);
  const created = await github.createPullRequest({
    title: payload.title,
    head: branch,
    base: plan.baseBranch,
    body: payload.body,
    assertOwnership: lease.assertOwned,
  });

  state.pullRequest.status = "created";
  state.pullRequest.number = created.number;
  state.pullRequest.url = created.url;
  state.pullRequest.reason = null;
}

async function loadPullRequestRetryPayload(
  store: DeliveryStateStore,
  state: DeliveryState,
  plan: PullRequestRetryPlan,
): Promise<PullRequestRetryPayload> {
  const value = (await store.loadPayload(
    state.investigationId,
    plan.payload,
  )) as Partial<PullRequestRetryPayload>;
  if (
    !value ||
    value.version !== 1 ||
    value.investigationId !== state.investigationId ||
    typeof value.title !== "string" ||
    value.title.length > 500 ||
    typeof value.body !== "string" ||
    value.body.length > MAX_DELIVERY_TEXT_CHARS ||
    typeof value.commitMessage !== "string" ||
    value.commitMessage.length > 2_000 ||
    !Array.isArray(value.files) ||
    value.files.length !== plan.files.length
  ) {
    throw new Error("Protected pull-request payload has an invalid shape.");
  }
  const files = value.files as DeliveryFile[];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const identity = plan.files[index];
    if (
      !file ||
      file.path !== identity.path ||
      file.mode !== identity.mode ||
      (file.contents !== null && typeof file.contents !== "string") ||
      (file.contents === null
        ? identity.contentSha256 !== null
        : sha256(Buffer.from(file.contents, "utf8")) !== identity.contentSha256)
    ) {
      throw new Error("Protected pull-request payload does not match its file identities.");
    }
  }
  return value as PullRequestRetryPayload;
}

async function loadTerminalCommentPayload(
  store: DeliveryStateStore,
  state: DeliveryState,
): Promise<TerminalCommentPayload> {
  const value = (await store.loadPayload(
    state.investigationId,
    state.terminalPayload,
  )) as Partial<TerminalCommentPayload>;
  if (
    !value ||
    value.version !== 1 ||
    value.investigationId !== state.investigationId ||
    !value.summary ||
    typeof value.summary !== "object" ||
    (value.analysisComment !== null && typeof value.analysisComment !== "string") ||
    (value.fixComment !== null && typeof value.fixComment !== "string")
  ) {
    throw new Error("Protected terminal-comment payload has an invalid shape.");
  }
  return value as TerminalCommentPayload;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeMessage(error: unknown): string {
  return boundedSafeText(
    error instanceof Error ? error.message : String(error),
    MAX_DELIVERY_ERROR_CHARS,
  );
}

function retryableDeliveryMessage(error: unknown): string {
  return error instanceof DeliveryLockBusyError ||
    error instanceof DeliveryLockLostError
    ? "Delivery lock ownership is temporarily unavailable."
    : "Delivery reconciliation is temporarily unavailable.";
}
