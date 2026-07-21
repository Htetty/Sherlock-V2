// GitHub webhook handler. On an exact "/sherlock investigate" command from
// an authorized (write/maintain/admin) non-bot user it creates the
// investigation id, enqueues a job in Redis, and posts a "queued" comment —
// the pipeline itself runs in the separate BullMQ worker (backend/worker.ts).

import { Probot } from "probot";
import { createInvestigationId } from "../backend/services/artifacts.js";
import { deliveryCommentMarker } from "../backend/services/delivery.js";
import { renderQueuedIssueReport } from "../backend/services/issue-report-renderer.js";
import {
  createInvestigationQueueAdapter,
  createRedisConnection,
  deriveTenantIdFromInstallation,
  type InvestigationJobPayload,
  type InvestigationQueueAdapter,
} from "../backend/queue/investigation-queue.js";
import {
  asScriptRunner,
  createInvestigationRateLimiter,
  type InvestigationRateLimiter,
} from "../backend/services/rate-limit.js";
import {
  isAuthorizedRole,
  isBotUser,
  parseSherlockCommand,
  type RepositoryRole,
} from "./command-gate.js";

const UNAUTHORIZED_COMMENT =
  "Sherlock investigations can only be started by users with write access or higher on this repository.";

const PERMISSION_CHECK_FAILED_COMMENT =
  "Sherlock could not verify repository permissions right now, so this investigation was not started. Please try again in a few minutes.";

const RATE_LIMITED_COMMENT =
  "Sherlock has received too many investigation requests for this installation. Please try again later.";

// Minimal octokit surface the gate needs; keeps the permission lookup
// injectable for tests.
type PermissionOctokit = {
  rest: {
    repos: {
      getCollaboratorPermissionLevel: (params: {
        owner: string;
        repo: string;
        username: string;
      }) => Promise<{ data: { permission?: string; role_name?: string } }>;
    };
  };
};

export type GetRepositoryRole = (
  octokit: PermissionOctokit,
  params: { owner: string; repo: string; username: string },
) => Promise<RepositoryRole>;

// Always resolved through the installation-authenticated API — permission
// data in the webhook payload itself is never trusted. Works for both
// organization and personal repositories.
const defaultGetRepositoryRole: GetRepositoryRole = async (octokit, params) => {
  const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel(params);

  return { roleName: data.role_name ?? null, permission: data.permission ?? null };
};

export type SherlockAppDeps = {
  queue?: InvestigationQueueAdapter;
  getRepositoryRole?: GetRepositoryRole;
  rateLimiter?: InvestigationRateLimiter;
};

// Dependencies are injectable so webhook tests run without Redis or the
// real GitHub API; production lazily connects on the first command.
export const createSherlockApp =
  (deps: SherlockAppDeps = {}) =>
  (app: Probot) => {
    let queue = deps.queue ?? null;
    let rateLimiter = deps.rateLimiter ?? null;
    const getRepositoryRole = deps.getRepositoryRole ?? defaultGetRepositoryRole;

    const getQueue = () => {
      queue ??= createInvestigationQueueAdapter();
      return queue;
    };

    // Redis-backed limiter shared across all backend/worker processes; its
    // decisions are logged inside the service (tenant key, count, limit).
    const getRateLimiter = () => {
      if (!rateLimiter) {
        let redis: ReturnType<typeof asScriptRunner> | null = null;
        rateLimiter = createInvestigationRateLimiter(
          () => (redis ??= asScriptRunner(createRedisConnection())),
        );
      }

      return rateLimiter;
    };

    app.on("issue_comment.created", async (context) => {
      const comment = context.payload.comment;

      // Bots (including Sherlock's own comments) never trigger commands.
      if (isBotUser(comment.user)) {
        return;
      }

      // Only the exact command counts; prose mentioning "investigate" is
      // ignored silently.
      if (parseSherlockCommand(comment.body) === null) {
        return;
      }

      const installationId = context.payload.installation?.id;

      if (!installationId) {
        console.warn(
          "Ignoring investigate command without an installation id; the worker cannot authenticate without one.",
        );
        return;
      }

      const owner = context.payload.repository.owner.login;
      const repo = context.payload.repository.name;
      const username = comment.user?.login;

      if (!username) {
        console.warn(
          `Ignoring investigate command on ${owner}/${repo}#${context.payload.issue.number}: comment has no author login to authorize.`,
        );
        return;
      }

      const postComment = (body: string) =>
        context.octokit.rest.issues.createComment(context.issue({ body }));

      // Authorization happens before any investigation id or job exists.
      let role: RepositoryRole;

      try {
        role = await getRepositoryRole(context.octokit as PermissionOctokit, {
          owner,
          repo,
          username,
        });
      } catch (error) {
        // Log locally (sanitized), tell the user something safe, enqueue
        // nothing.
        console.error(
          `Permission check failed for ${username} on ${owner}/${repo}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        await postComment(PERMISSION_CHECK_FAILED_COMMENT);
        return;
      }

      if (!isAuthorizedRole(role)) {
        console.log(
          `Rejected investigate command from ${username} on ${owner}/${repo} (insufficient repository permission).`,
        );
        await postComment(UNAUTHORIZED_COMMENT);
        return;
      }

      const investigationId = createInvestigationId();
      const tenantId = deriveTenantIdFromInstallation(installationId);

      // Non-secret payload only: the worker mints its own installation
      // token from the GitHub App credentials.
      const jobPayload: InvestigationJobPayload = {
        investigationId,
        tenantId,
        installationId,
        repositoryOwner: owner,
        repositoryName: repo,
        repositoryUrl: context.payload.repository.html_url,
        defaultBranch: context.payload.repository.default_branch,
        issueNumber: context.payload.issue.number,
        issueTitle: context.payload.issue.title,
        issueBody: context.payload.issue.body ?? "",
        issueUrl: context.payload.issue.html_url,
        triggeringCommentId: comment.id,
        triggerComment: comment.body,
        triggeredBy: username,
        sourceRef: context.payload.repository.default_branch ?? null,
        deliveryId: context.id ?? null,
      };

      // The queue atomically claims this command before invoking onClaim.
      // Thus only an authorized claim winner (never a deduplicated
      // redelivery) consumes a rate-limit slot.
      const { jobId, deduplicated, rateLimited } = await getQueue().add(jobPayload, {
        onClaim: async () => {
          const decision =
            await getRateLimiter().checkAndConsumeInvestigationRateLimit(tenantId);

          return decision.allowed;
        },
      });

      if (deduplicated) {
        // Redelivered webhook for the same comment: the original job (and
        // its queued comment) already exist.
        console.log(
          `[${investigationId}] Duplicate delivery for job ${jobId}; not enqueueing again.`,
        );
        return;
      }

      if (rateLimited) {
        console.warn(
          `Rate limit reached for installation ${installationId}; not enqueueing.`,
        );
        await postComment(RATE_LIMITED_COMMENT);
        return;
      }

      console.log(
        `[${investigationId}] Queued investigation job ${jobId}.`,
      );

      // The visible queued text carries no investigation id; the id lives
      // only in the hidden delivery marker, which terminal delivery uses to
      // find and update this exact comment.
      await postComment(
        [
          renderQueuedIssueReport(),
          deliveryCommentMarker(investigationId),
        ].join("\n\n"),
      );
    });
  };

export default createSherlockApp();
