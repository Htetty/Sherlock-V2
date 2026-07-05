// GitHub webhook handler. On "/sherlock investigate" it only creates the
// investigation id, enqueues a job in Redis, and posts a "queued" comment —
// the pipeline itself runs in the separate BullMQ worker (backend/worker.ts).

import { Probot } from "probot";
import { createInvestigationId } from "../backend/services/artifacts.js";
import {
  createInvestigationQueueAdapter,
  deriveTenantIdFromInstallation,
  type InvestigationJobPayload,
  type InvestigationQueueAdapter,
} from "../backend/queue/investigation-queue.js";

// The queue is injectable so webhook tests run without Redis; production
// lazily connects on the first investigation command.
export const createSherlockApp =
  (injectedQueue?: InvestigationQueueAdapter) => (app: Probot) => {
    let queue = injectedQueue ?? null;

    const getQueue = () => {
      queue ??= createInvestigationQueueAdapter();
      return queue;
    };

    app.on("issue_comment.created", async (context) => {
      const commentBody = context.payload.comment.body.toLowerCase();

      if (!commentBody.includes("investigate")) {
        return;
      }

      const installationId = context.payload.installation?.id;

      if (!installationId) {
        console.warn(
          "Ignoring investigate command without an installation id; the worker cannot authenticate without one.",
        );
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
        repositoryOwner: context.payload.repository.owner.login,
        repositoryName: context.payload.repository.name,
        repositoryUrl: context.payload.repository.html_url,
        defaultBranch: context.payload.repository.default_branch,
        issueNumber: context.payload.issue.number,
        issueTitle: context.payload.issue.title,
        issueBody: context.payload.issue.body ?? "",
        issueUrl: context.payload.issue.html_url,
        triggeringCommentId: context.payload.comment.id,
        triggerComment: context.payload.comment.body,
        triggeredBy: context.payload.comment.user?.login ?? "unknown",
        sourceRef: context.payload.repository.default_branch ?? null,
        deliveryId: context.id ?? null,
      };

      const { jobId, deduplicated } = await getQueue().add(jobPayload);

      if (deduplicated) {
        // Redelivered webhook for the same comment: the original job (and
        // its queued comment) already exist.
        console.log(
          `[${investigationId}] Duplicate delivery for job ${jobId}; not enqueueing again.`,
        );
        return;
      }

      console.log(
        `[${investigationId}] Queued investigation job ${jobId} (tenant ${tenantId}).`,
      );

      await context.octokit.rest.issues.createComment(
        context.issue({
          body: [
            "Investigation queued.",
            "",
            `Investigation: ${investigationId}`,
            "Sherlock will post results on this issue when the investigation completes.",
          ].join("\n"),
        }),
      );
    });
  };

export default createSherlockApp();
