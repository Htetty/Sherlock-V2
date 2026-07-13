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
//   - at most one pull request: an open PR for the head branch is reused;
//   - at most one terminal issue comment: every terminal comment embeds an
//     HTML marker, and the issue's comments are checked for that marker
//     before posting.
//
// No secrets: the state file contains ids, statuses, already-redacted comment
// text, and post-patch source file contents (the same material the artifact
// store already persists). Installation tokens are minted per attempt and are
// never written to Redis or durable state.

import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { getArtifactsRoot, isInvestigationId } from "./artifacts.js";
import {
  buildCommitMessage,
  buildFixBranchName,
  buildPullRequestBody,
  buildPullRequestTitle,
  checkPullRequestPreconditions,
  createGitHubRestClient,
  isForbiddenPullRequestPath,
  SHERLOCK_AUTHOR_EMAIL,
  SHERLOCK_AUTHOR_NAME,
  type GitHubClient,
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
  | "failed";

export type DeliveryCommentStatus = "pending" | "posted" | "failed";

export type DeliveryFile = {
  path: string;
  // Null represents a verified deletion. GitHub's tree API deletes a path
  // when the entry sha is null.
  contents: string | null;
  mode: "100644" | "100755";
};

// Everything needed to recreate the fix branch and pull request through the
// GitHub API when the local workspace (and its git commit) no longer exists.
// Captured from the verified workspace before it is cleaned up; all text
// fields are already redacted by the pull-request builders.
export type PullRequestRetryPlan = {
  branch: string | null;
  title: string;
  body: string;
  commitMessage: string;
  sourceCommit: string;
  baseBranch: string;
  files: DeliveryFile[];
};

export type DeliveryState = {
  version: 1;
  investigationId: string;
  tenantId: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueTitle: string;
  // Terminal execution outcome of the pipeline (verified_fix, reproduced,
  // not_reproduced, plan_failed, environment_failed, execution_failed).
  executionOutcome: string;
  // Patch verification outcome, independent of any GitHub delivery.
  fixVerified: boolean;
  fixAttemptId: string | null;
  summary: InvestigationSummary;
  analysisComment: string | null;
  fixComment: string | null;
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
  terminalComment: {
    status: DeliveryCommentStatus;
    postedAt: string | null;
    reason: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

const MAX_DELIVERY_ERROR_CHARS = 2_000;
const MAX_DELIVERY_TEXT_CHARS = 20_000;
const MAX_DELIVERY_TITLE_CHARS = 500;
const MAX_RETRY_PLAN_FILES = 50;
const MAX_DELIVERY_STATE_BYTES = 3 * 1024 * 1024;
const DELIVERY_LOCK_STALE_MS = 10 * 60_000;
const DELIVERY_LOCK_HEARTBEAT_MS = 30_000;

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
      state.pullRequest.status === "reused") &&
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

export function buildDeliveryState(input: DeliveryStateInput): DeliveryState {
  const at = new Date().toISOString();
  const retryPlan = sanitizeRetryPlan(input.retryPlan);
  const pullRequest = mapPipelinePullRequest({ ...input, retryPlan });

  return {
    version: 1,
    investigationId: input.investigationId,
    tenantId: boundedSafeText(input.tenantId, 200),
    installationId: input.installationId,
    repoOwner: boundedSafeText(input.repoOwner, 100),
    repoName: boundedSafeText(input.repoName, 100),
    issueNumber: input.issueNumber,
    issueTitle: boundedSafeText(input.issueTitle, MAX_DELIVERY_TITLE_CHARS),
    executionOutcome: boundedSafeText(input.outcome, 100),
    fixVerified: input.fixVerified,
    fixAttemptId: input.fixAttemptId
      ? boundedSafeText(input.fixAttemptId, 200)
      : null,
    summary: sanitizeSummary(input.summary),
    analysisComment: input.analysisComment
      ? boundedSafeText(input.analysisComment, MAX_DELIVERY_TEXT_CHARS)
      : null,
    fixComment: input.fixComment
      ? boundedSafeText(input.fixComment, MAX_DELIVERY_TEXT_CHARS)
      : null,
    pullRequest,
    // The retry plan is only needed while PR delivery is unfinished.
    retryPlan: pullRequest.status === "pending" ? retryPlan : null,
    terminalComment: { status: "pending", postedAt: null, reason: null },
    createdAt: at,
    updatedAt: at,
  };
}

function sanitizeSummary(summary: InvestigationSummary): InvestigationSummary {
  return {
    investigationId: boundedSafeText(summary.investigationId, 200),
    outcome: summary.outcome,
    ...(summary.observed != null
      ? { observed: boundedSafeText(summary.observed, 2_000) }
      : {}),
    ...(summary.expected != null
      ? { expected: boundedSafeText(summary.expected, 2_000) }
      : {}),
    ...(summary.stage != null
      ? { stage: boundedSafeText(summary.stage, 200) }
      : {}),
    ...(summary.error != null
      ? { error: boundedSafeText(summary.error, MAX_DELIVERY_ERROR_CHARS) }
      : {}),
    ...(summary.planErrors
      ? {
          planErrors: summary.planErrors
            .slice(0, 10)
            .map((error) => boundedSafeText(error, 1_000)),
        }
      : {}),
    ...(summary.reproductionMode != null
      ? { reproductionMode: boundedSafeText(summary.reproductionMode, 100) }
      : {}),
    ...(summary.originalOutcome != null
      ? { originalOutcome: boundedSafeText(summary.originalOutcome, 100) }
      : {}),
    ...(summary.verification != null
      ? { verification: boundedSafeText(summary.verification, 100) }
      : {}),
    ...(summary.pullRequestStatus != null
      ? { pullRequestStatus: boundedSafeText(summary.pullRequestStatus, 100) }
      : {}),
    ...(summary.evidence ? { evidence: { ...summary.evidence } } : {}),
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

// Delivery state may contain verified source text so a branch can be rebuilt
// after the workspace is gone. Refuse a retry plan if that text itself looks
// like credential material; never redact source bytes and accidentally push a
// patch different from the one that passed verification.
function containsCredentialMaterial(contents: string): boolean {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /\b(?:api[_-]?key|token|secret|password|passwd|credential|authorization|webhook[_-]?secret)\b\s*[:=]\s*["'`][^"'`\r\n]{4,}["'`]/i,
    /\b(?:sk-|ghp_|gho_|ghs_|github_pat_|xox[a-z]-)[A-Za-z0-9_-]{8,}/,
    /\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:[^@\s]+@/i,
  ].some((pattern) => pattern.test(contents));
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

function sanitizeRetryPlan(
  plan: PullRequestRetryPlan | null,
): PullRequestRetryPlan | null {
  if (!plan || plan.files.length === 0 || plan.files.length > MAX_RETRY_PLAN_FILES) {
    return null;
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const files: DeliveryFile[] = [];

  for (const file of plan.files) {
    if (
      !safeDeliveryFilePath(file.path) ||
      seen.has(file.path) ||
      (file.mode !== "100644" && file.mode !== "100755")
    ) {
      return null;
    }
    seen.add(file.path);

    if (file.contents !== null) {
      const bytes = Buffer.byteLength(file.contents, "utf8");
      if (
        bytes > MAX_RETRY_PLAN_FILE_BYTES ||
        containsCredentialMaterial(file.contents)
      ) {
        return null;
      }
      totalBytes += bytes;
    }

    if (totalBytes > MAX_RETRY_PLAN_TOTAL_BYTES) {
      return null;
    }

    files.push({ path: file.path, contents: file.contents, mode: file.mode });
  }

  if (
    !/^[0-9a-f]{7,64}$/i.test(plan.sourceCommit) ||
    !safeBranchName(plan.baseBranch)
  ) {
    return null;
  }

  const branch = safeBranchName(plan.branch);
  if (plan.branch !== null && !branch) {
    return null;
  }

  return {
    branch,
    title: boundedSafeText(plan.title, 120),
    body: boundedSafeText(plan.body, MAX_DELIVERY_TEXT_CHARS),
    commitMessage: boundedSafeText(plan.commitMessage, 2_000),
    sourceCommit: plan.sourceCommit,
    baseBranch: plan.baseBranch,
    files,
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
          reason: "The pull-request flow failed before producing a result.",
        };
  }

  const common = {
    branch: safeBranchName(result.branch),
    number: result.pullRequestNumber,
    url: result.pullRequestUrl
      ? boundedSafeText(result.pullRequestUrl, 2_000)
      : null,
    reason: result.reason
      ? boundedSafeText(result.reason, MAX_DELIVERY_ERROR_CHARS)
      : null,
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
        : { ...common, status: "failed", branchPushed: false };
    case "precondition_failed":
      // Verification preconditions failed; a PR must not be created at all.
      return { ...common, status: "failed", branchPushed: false };
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
    if (containsCredentialMaterial(contents)) {
      return null;
    }

    files.push({
      path: filePath,
      contents,
      mode: (info.mode & 0o111) !== 0 ? "100755" : "100644",
    });
  }

  if (files.length === 0) {
    return null;
  }

  return sanitizeRetryPlan({
    // Filled in after the in-pipeline PR flow chooses the real branch name;
    // a retry without one derives the deterministic name instead.
    branch: null,
    title: buildPullRequestTitle(input),
    body: await buildPullRequestBody(input),
    commitMessage: buildCommitMessage(input),
    sourceCommit: input.fixAttempt.sourceCommit,
    baseBranch: input.baseBranch,
    files,
  });
}

// --- Durable state store -----------------------------------------------------

export type DeliveryStateStore = {
  load(investigationId: string): Promise<DeliveryState | null>;
  save(state: DeliveryState): Promise<void>;
  // Serializes the full reconcile/check/create/save sequence for one
  // investigation. This closes the check-then-create race between duplicate
  // or stalled BullMQ deliveries.
  withLock<T>(investigationId: string, operation: () => Promise<T>): Promise<T>;
};

export const DELIVERY_STATE_FILE = "delivery-state.json";

class DeliveryLockBusyError extends Error {
  readonly code = "EDELIVERYLOCKED";
}

function normalizeDeliveryState(value: unknown): DeliveryState {
  if (!value || typeof value !== "object") {
    throw new Error("Delivery state is not an object.");
  }

  const state = structuredClone(value) as DeliveryState;
  if (
    state.version !== 1 ||
    !isInvestigationId(state.investigationId) ||
    typeof state.tenantId !== "string" ||
    state.tenantId.length === 0 ||
    state.tenantId.length > 200 ||
    !Number.isSafeInteger(state.installationId) ||
    state.installationId <= 0 ||
    !Number.isSafeInteger(state.issueNumber) ||
    state.issueNumber <= 0 ||
    typeof state.issueTitle !== "string" ||
    typeof state.executionOutcome !== "string" ||
    typeof state.fixVerified !== "boolean" ||
    typeof state.createdAt !== "string" ||
    !Number.isFinite(Date.parse(state.createdAt)) ||
    typeof state.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(state.updatedAt)) ||
    !state.pullRequest ||
    !state.terminalComment
  ) {
    throw new Error("Delivery state has an invalid shape.");
  }

  validateRepositoryIdentity(state.repoOwner, state.repoName);

  const pullRequestStatuses = new Set<DeliveryPullRequestStatus>([
    "not_applicable",
    "pending",
    "created",
    "reused",
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
  state.pullRequest.reason = state.pullRequest.reason
    ? boundedSafeText(state.pullRequest.reason, MAX_DELIVERY_ERROR_CHARS)
    : null;
  state.terminalComment.reason = state.terminalComment.reason
    ? boundedSafeText(state.terminalComment.reason, MAX_DELIVERY_ERROR_CHARS)
    : null;
  state.issueTitle = boundedSafeText(state.issueTitle, MAX_DELIVERY_TITLE_CHARS);
  state.executionOutcome = boundedSafeText(state.executionOutcome, 100);
  state.summary = sanitizeSummary(state.summary);
  state.analysisComment = state.analysisComment
    ? boundedSafeText(state.analysisComment, MAX_DELIVERY_TEXT_CHARS)
    : null;
  state.fixComment = state.fixComment
    ? boundedSafeText(state.fixComment, MAX_DELIVERY_TEXT_CHARS)
    : null;

  if (state.retryPlan) {
    const plan = sanitizeRetryPlan(state.retryPlan);
    if (
      !plan ||
      !plan.commitMessage.includes(
        `Sherlock-Investigation: ${state.investigationId}`,
      ) ||
      (state.fixAttemptId !== null &&
        !plan.commitMessage.includes(
          `Sherlock-Fix-Attempt: ${state.fixAttemptId}`,
        ))
    ) {
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

// One JSON file per investigation under the artifacts root, next to the other
// per-investigation artifacts. Same durability class as the pull-request
// result file the PR flow already relies on for retries.
export function createFileDeliveryStateStore(
  rootDir: string = getArtifactsRoot(),
): DeliveryStateStore {
  const resolvedRoot = path.resolve(rootDir);
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

  return {
    async load(investigationId) {
      try {
        const dir = dirFor(investigationId);
        const dirInfo = await lstat(dir);
        if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
          throw new Error("Refusing a non-directory delivery-state location.");
        }
        const stateFile = path.join(
          dir,
          DELIVERY_STATE_FILE,
        );
        const info = await lstat(stateFile);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error("Refusing a non-file delivery-state record.");
        }
        const raw = await readFile(
          stateFile,
          "utf8",
        );
        if (Buffer.byteLength(raw, "utf8") > MAX_DELIVERY_STATE_BYTES) {
          throw new Error("Delivery state exceeds the size limit.");
        }
        const state = normalizeDeliveryState(JSON.parse(raw));

        return state.investigationId === investigationId ? state : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async save(state) {
      const normalized = normalizeDeliveryState(state);
      const dir = await ensureDir(normalized.investigationId);
      const destination = path.join(dir, DELIVERY_STATE_FILE);
      const temporary = path.join(
        dir,
        `.${DELIVERY_STATE_FILE}.${randomUUID()}.tmp`,
      );

      try {
        await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
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
    },
    async withLock(investigationId, operation) {
      if (!isInvestigationId(investigationId)) {
        throw new Error("Refusing delivery lock for unsafe investigation id.");
      }
      await ensureLockRoot();
      const lockDir = path.join(lockRoot, `${investigationId}.lock`);
      const ownerFile = path.join(lockDir, "owner");
      const lockOwner = randomUUID();

      try {
        await mkdir(lockDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        const lockInfo = await stat(lockDir).catch(() => null);
        if (!lockInfo || Date.now() - lockInfo.mtimeMs <= DELIVERY_LOCK_STALE_MS) {
          throw new DeliveryLockBusyError(
            "Another delivery attempt is already reconciling this investigation.",
          );
        }

        // Atomically move the stale lease out of the way. A concurrent
        // contender can win this rename; in that case this attempt retries
        // through the queue instead of deleting anyone else's live lock.
        const staleDir = `${lockDir}.stale-${randomUUID()}`;
        try {
          await rename(lockDir, staleDir);
          await unlink(path.join(staleDir, "owner")).catch(() => {});
          await rmdir(staleDir);
          await mkdir(lockDir);
        } catch {
          throw new DeliveryLockBusyError(
            "Another delivery attempt acquired the reconciliation lock.",
          );
        }
      }

      try {
        await writeFile(ownerFile, lockOwner, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        await rmdir(lockDir).catch(() => {});
        throw error;
      }

      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockDir, now, now).catch(() => {});
      }, DELIVERY_LOCK_HEARTBEAT_MS);
      heartbeat.unref();

      try {
        return await operation();
      } finally {
        clearInterval(heartbeat);
        const currentOwner = await readFile(ownerFile, "utf8").catch(() => null);
        if (currentOwner === lockOwner) {
          await unlink(ownerFile).catch(() => {});
          await rmdir(lockDir).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
    },
  };
}

export function createInMemoryDeliveryStateStore(): DeliveryStateStore & {
  snapshot(): DeliveryState[];
} {
  const states = new Map<string, DeliveryState>();
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
    async withLock(investigationId, operation) {
      const previous = locks.get(investigationId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      locks.set(investigationId, tail);

      await previous;
      try {
        return await operation();
      } finally {
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

// Build the terminal comment from the CURRENT delivery state, so the posted
// text always tells the truth about what was actually delivered: a fix is
// only presented with a pull request when that pull request really exists.
export function buildTerminalComment(state: DeliveryState): string {
  const summary: InvestigationSummary = state.fixVerified
    ? { ...state.summary, pullRequestStatus: summaryPullRequestStatus(state) }
    : state.summary;

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
    state.analysisComment,
    state.fixComment,
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
export type DeliveryGitHubClient = GitHubClient & {
  // Resolves the branch head and commit identity, or null when the branch does
  // not exist. Commit metadata proves an existing branch was created for this
  // exact investigation/fix attempt before it is reused.
  getBranch: (branch: string) => Promise<{
    sha: string;
    message: string;
    parentShas: string[];
  } | null>;
  // Recreates the fix commit through the Git Data API (blobs -> tree ->
  // commit -> ref) on top of the recorded source commit.
  createBranchWithCommit: (input: {
    branch: string;
    baseCommitSha: string;
    message: string;
    files: DeliveryFile[];
  }) => Promise<{ commitSha: string }>;
};

export function createDeliveryGitHubRestClient(options: {
  token: string;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
}): DeliveryGitHubClient {
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
  ): Promise<T> => {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(
        new Error(
          `GitHub ${method} ${url.slice(apiBaseUrl.length)} failed: ${response.status} ${response.statusText} ${detail.slice(0, 300)}`,
        ),
        { status: response.status },
      );
    }

    return (await response.json()) as T;
  };

  return {
    ...createGitHubRestClient(options),
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

      if (!data.object?.sha) {
        return null;
      }

      const commit = await request<{
        message?: string;
        parents?: { sha?: string }[];
      }>("GET", `${repoUrl}/git/commits/${data.object.sha}`);

      return {
        sha: data.object.sha,
        message: commit.message ?? "",
        parentShas: (commit.parents ?? [])
          .map((parent) => parent.sha)
          .filter((sha): sha is string => typeof sha === "string"),
      };
    },
    createBranchWithCommit: async ({ branch, baseCommitSha, message, files }) => {
      const baseCommit = await request<{ tree: { sha: string } }>(
        "GET",
        `${repoUrl}/git/commits/${baseCommitSha}`,
      );

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
        );
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
      });

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
      );

      await request("POST", `${repoUrl}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });

      return { commitSha: commit.sha };
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
  }) => Promise<void>;
  // True when the issue already carries a comment containing the marker.
  findTerminalComment: (input: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    marker: string;
    createdAfter: string;
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
// describes the final delivery truth. Throws a redacted error when a step
// failed transiently and another attempt is allowed; otherwise records the
// truthful terminal state and returns.
export async function runDeliveryFromState(
  initial: DeliveryState,
  deps: DeliveryExecutorDeps,
  options: { isFinalAttempt: boolean },
): Promise<DeliveryRunResult> {
  try {
    return await deps.deliveryStore.withLock(
      initial.investigationId,
      async () => {
        let latest: DeliveryState | null;
        try {
          latest = await deps.deliveryStore.load(initial.investigationId);
        } catch (error) {
          throw new DeliveryRetryableError(safeMessage(error));
        }

        return runDeliveryUnlocked(latest ?? initial, deps, options);
      },
    );
  } catch (error) {
    if (error instanceof DeliveryLockBusyError) {
      throw new DeliveryRetryableError(safeMessage(error));
    }
    throw error;
  }
}

async function runDeliveryUnlocked(
  initial: DeliveryState,
  deps: DeliveryExecutorDeps,
  options: { isFinalAttempt: boolean },
): Promise<DeliveryRunResult> {
  const log = deps.log ?? (() => {});
  const state = structuredClone(initial) as DeliveryState;

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
    issueTitle: state.issueTitle,
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
      originalOutcome: state.summary.originalOutcome ?? null,
      pullRequestStatus: summaryPullRequestStatus(state),
      error: null,
    });
    return { state, complete: isDeliveryComplete(state) };
  }

  // --- Pull-request delivery (branch push + PR create/reuse) ---------------
  if (state.fixVerified && state.pullRequest.status === "pending") {
    try {
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

      await reconcilePullRequest(state, github, log);
      await saveState();
      await recordState({
        type: "pull_request",
        status: state.pullRequest.status,
        number: state.pullRequest.number,
        url: state.pullRequest.url,
        branch: state.pullRequest.branch,
      });
    } catch (error) {
      if (deps.isRetryableError(error) && !options.isFinalAttempt) {
        await saveState().catch(() => {});
        throw new DeliveryRetryableError(safeMessage(error));
      }

      state.pullRequest.status = "failed";
      state.pullRequest.reason = safeMessage(error);
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
        createdAfter: state.createdAt,
      });

      if (alreadyPosted) {
        log(
          `[${state.investigationId}] Terminal comment already exists on the issue; not posting a duplicate.`,
        );
      } else {
        await deps.postIssueComment({
          installationId: state.installationId,
          owner: state.repoOwner,
          repo: state.repoName,
          issueNumber: state.issueNumber,
          body: buildTerminalComment(state),
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
      if (deps.isRetryableError(error) && !options.isFinalAttempt) {
        throw new DeliveryRetryableError(safeMessage(error));
      }

      state.terminalComment = {
        status: "failed",
        postedAt: null,
        reason: safeMessage(error),
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
    originalOutcome: state.summary.originalOutcome ?? null,
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
  log: (message: string) => void,
): Promise<void> {
  const plan = state.retryPlan;
  const branch =
    state.pullRequest.branch ??
    plan?.branch ??
    (state.fixAttemptId
      ? buildFixBranchName({
          issueNumber: state.issueNumber,
          issueTitle: state.issueTitle,
          fixAttemptId: state.fixAttemptId,
        })
      : null);

  if (!branch) {
    throw new Error(
      "No fix branch is recorded and none can be derived; pull-request delivery cannot proceed.",
    );
  }

  state.pullRequest.branch = branch;

  if (!state.pullRequest.branchPushed) {
    const existingBranch = await github.getBranch(branch);

    if (existingBranch) {
      if (
        !plan ||
        existingBranch.message.trim() !== plan.commitMessage.trim() ||
        existingBranch.parentShas[0] !== plan.sourceCommit
      ) {
        throw new Error(
          `The existing branch ${branch} does not match this investigation's verified fix; refusing to reuse it.`,
        );
      }
      log(
        `[${state.investigationId}] Matching fix branch ${branch} already exists on GitHub; reusing it.`,
      );
    } else {
      if (!plan) {
        throw new Error(
          `The fix branch ${branch} was never pushed and no retry plan was persisted.`,
        );
      }

      const { commitSha } = await github.createBranchWithCommit({
        branch,
        baseCommitSha: plan.sourceCommit,
        message: plan.commitMessage,
        files: plan.files,
      });
      log(
        `[${state.investigationId}] Recreated fix branch ${branch} at ${commitSha} through the GitHub API.`,
      );
    }

    state.pullRequest.branchPushed = true;
  }

  const head = `${state.repoOwner}:${branch}`;
  const existing = await github.findOpenPullRequest(head);

  if (existing) {
    state.pullRequest.status = "reused";
    state.pullRequest.number = existing.number;
    state.pullRequest.url = existing.url;
    state.pullRequest.reason = null;
    return;
  }

  if (!plan) {
    throw new Error(
      "The fix branch exists but no pull request is open, and no retry plan was persisted to create one.",
    );
  }

  const created = await github.createPullRequest({
    title: plan.title,
    head: branch,
    base: plan.baseBranch,
    body: plan.body,
  });

  state.pullRequest.status = "created";
  state.pullRequest.number = created.number;
  state.pullRequest.url = created.url;
  state.pullRequest.reason = null;
}

function safeMessage(error: unknown): string {
  return boundedSafeText(
    error instanceof Error ? error.message : String(error),
    MAX_DELIVERY_ERROR_CHARS,
  );
}
