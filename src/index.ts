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
import {
  registerInstallationEvents,
  type InstallationEventDeps,
} from "./installation-events.js";
import type { InstallationLifecycleDeps } from "../backend/services/github-installations.js";
import {
  createProductDataStoreFromEnv,
  type ProductDataStore,
  type ProductInvestigationClaim,
} from "../backend/services/product-data.js";
import { toGitHubIdString } from "../backend/services/github-installations.js";
import { redactSecrets } from "../backend/services/report.js";

const UNAUTHORIZED_COMMENT =
  "Sherlock investigations can only be started by users with write access or higher on this repository.";

const PERMISSION_CHECK_FAILED_COMMENT =
  "Sherlock could not verify repository permissions right now, so this investigation was not started. Please try again in a few minutes.";

const RATE_LIMITED_COMMENT =
  "Sherlock has received too many investigation requests for this installation. Please try again later.";
const DASHBOARD_CLAIM_DEADLINE_MS = 5_000;

async function withDashboardClaimDeadline<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Dashboard command persistence timed out.")),
          DASHBOARD_CLAIM_DEADLINE_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  installationEvents?: InstallationEventDeps;
  productData?: ProductDataStore | null;
};

// Default installation-lifecycle persistence: Supabase service-role stores,
// created lazily on the first installation event. Returns null (handlers skip
// with a warning) when Supabase is not configured, so local bot development
// and the investigation flow never depend on the product database.
function createDefaultInstallationEventDeps(): InstallationEventDeps {
  let cached: Promise<InstallationLifecycleDeps | null> | null = null;

  return {
    getLifecycleDeps: () => {
      cached ??= (async () => {
        const { missingSupabaseServiceEnv, getSupabaseServiceRoleClient } =
          await import("../backend/services/supabase-clients.js");

        if (missingSupabaseServiceEnv().length > 0) {
          return null;
        }

        const supabase = await getSupabaseServiceRoleClient();
        const { createSupabaseInstallationDataStore } = await import(
          "../backend/services/github-installations.js"
        );
        const { createSupabaseProfileStore } = await import(
          "../backend/services/github-identity.js"
        );

        return {
          store: createSupabaseInstallationDataStore(
            supabase as unknown as Parameters<
              typeof createSupabaseInstallationDataStore
            >[0],
          ),
          profiles: createSupabaseProfileStore(
            supabase as unknown as Parameters<typeof createSupabaseProfileStore>[0],
          ),
        };
      })();

      return cached;
    },
  };
}

// Dependencies are injectable so webhook tests run without Redis or the
// real GitHub API; production lazily connects on the first command.
export const createSherlockApp =
  (deps: SherlockAppDeps = {}) =>
  (app: Probot) => {
    let queue = deps.queue ?? null;
    let rateLimiter = deps.rateLimiter ?? null;
    const getRepositoryRole = deps.getRepositoryRole ?? defaultGetRepositoryRole;
    let productDataPromise: Promise<ProductDataStore | null> | null = null;
    const getProductData = () => {
      if (deps.productData !== undefined) {
        return Promise.resolve(deps.productData);
      }
      // Tests must never discover developer-machine credentials through
      // dotenv and accidentally contact a live project. Product persistence
      // remains explicitly injectable in integration tests.
      if (process.env.NODE_ENV === "test") {
        return Promise.resolve(null);
      }
      productDataPromise ??= createProductDataStoreFromEnv();
      return productDataPromise;
    };

    const getQueue = () => {
      queue ??= createInvestigationQueueAdapter();
      return queue;
    };

    // Installation lifecycle persistence (dashboard onboarding). Registered
    // first but fully independent of the investigation flow below: these
    // handlers listen to different events and never run for issue comments.
    registerInstallationEvents(
      app,
      deps.installationEvents ?? createDefaultInstallationEventDeps(),
    );

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
      const repositoryId = toGitHubIdString(context.payload.repository.id);
      const issueId = toGitHubIdString(context.payload.issue.id);
      const triggeringCommentId = toGitHubIdString(comment.id);
      const actorId = toGitHubIdString(comment.user?.id);

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
      let durableEnqueue:
        | {
            productData: ProductDataStore;
            installationId: string;
            triggeringCommentId: string;
            investigationId: string;
          }
        | null = null;
      let effectiveInvestigationId = investigationId;
      const { jobId, deduplicated, rateLimited } = await getQueue().add(jobPayload, {
        onClaim: async () => {
          let productData: ProductDataStore | null = null;
          try {
            productData = await getProductData();
          } catch (error) {
            console.error(
              `Dashboard persistence unavailable before command claim; the existing queue path will continue: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            );
          }
          if (
            productData &&
            (!repositoryId || !issueId || !triggeringCommentId || !actorId)
          ) {
            console.error(
              "GitHub returned an invalid numeric identity; continuing through the existing queue path without a dashboard projection.",
            );
            productData = null;
          }

          // A durable claim that previously survived a queue/ack failure must
          // be resumed without consuming (or being rejected by) a second
          // rate-limit slot. New commands still pass the rate limiter before
          // they create any durable command row.
          if (productData) {
            const currentProductData = productData;
            let existing: ProductInvestigationClaim | null = null;
            try {
              existing = await withDashboardClaimDeadline(() =>
                currentProductData.findInvestigationCommand({
                  installationId: String(installationId),
                  triggeringCommentId: triggeringCommentId!,
                }),
              );
            } catch (error) {
              console.error(
                `Dashboard command lookup unavailable; the existing queue path will continue: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
              );
              productData = null;
            }
            if (existing) {
              if (!existing.shouldEnqueue) return "duplicate";
              if (!existing.jobPayload) {
                throw new Error(
                  "A pending durable investigation command returned no queue payload.",
                );
              }
              durableEnqueue = {
                productData: currentProductData,
                installationId: String(installationId),
                triggeringCommentId: triggeringCommentId!,
                investigationId: existing.investigationId,
              };
              effectiveInvestigationId = existing.investigationId;
              return { decision: "allow", payload: existing.jobPayload };
            }
          }

          const decision =
            await getRateLimiter().checkAndConsumeInvestigationRateLimit(tenantId);
          if (!decision.allowed) return "rate_limited";
          if (!productData) return "allow";
          if (!repositoryId || !issueId || !triggeringCommentId || !actorId) {
            throw new Error(
              "GitHub returned an invalid numeric identity; durable investigation creation was refused.",
            );
          }

          let claim;
          try {
            claim = await withDashboardClaimDeadline(() =>
              productData.createInvestigation({
                investigationId,
                tenantId,
                installationId: String(installationId),
                repositoryId,
                repositoryOwner: owner,
                repositoryName: repo,
                repositoryFullName: context.payload.repository.full_name,
                repositoryPrivate: context.payload.repository.private,
                githubIssueId: issueId,
                issueNumber: context.payload.issue.number,
                issueTitle: context.payload.issue.title,
                issueUrl: context.payload.issue.html_url,
                triggeringCommentId,
                triggeredBy: username,
                triggeredByGithubUserId: actorId,
                sourceRef: context.payload.repository.default_branch ?? null,
                createdAt: new Date().toISOString(),
                jobPayload,
              }),
            );
          } catch (error) {
            console.error(
              `Dashboard command creation unavailable; the existing queue path will continue: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            );
            return "allow";
          }

          if (!claim.shouldEnqueue) return "duplicate";
          if (!claim.jobPayload) {
            throw new Error(
              "A pending durable investigation command returned no queue payload.",
            );
          }

          durableEnqueue = {
            productData,
            installationId: String(installationId),
            triggeringCommentId,
            investigationId: claim.investigationId,
          };
          effectiveInvestigationId = claim.investigationId;
          return { decision: "allow", payload: claim.jobPayload };
        },
        onEnqueued: async (queuedJobId) => {
          const enqueue = durableEnqueue;
          if (!enqueue) return;
          await withDashboardClaimDeadline(() =>
            enqueue.productData.markInvestigationEnqueued({
              installationId: enqueue.installationId,
              triggeringCommentId: enqueue.triggeringCommentId,
              investigationId: enqueue.investigationId,
              queueJobId: queuedJobId,
            }),
          );
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
        `[${effectiveInvestigationId}] Queued investigation job ${jobId}.`,
      );

      // The visible queued text carries no investigation id; the id lives
      // only in the hidden delivery marker, which terminal delivery uses to
      // find and update this exact comment.
      await postComment(
        [
          renderQueuedIssueReport(),
          deliveryCommentMarker(effectiveInvestigationId),
        ].join("\n\n"),
      );
    });
  };

export default createSherlockApp();
