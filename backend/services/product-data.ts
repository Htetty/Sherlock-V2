import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DeliveryArtifactReference,
  DeliveryState,
  DeliveryStateStore,
  TerminalFailureRecord,
} from "./delivery.js";
import {
  applyEvent,
  type InvestigationStateEvent,
  type InvestigationStateRecord,
  type InvestigationStateStore,
} from "./investigation-state-store.js";
import type { InvestigationPipelineResult } from "./investigation.js";
import { redactSecrets } from "./report.js";
import {
  getSupabaseServiceRoleClient,
  missingSupabaseServiceEnv,
} from "./supabase-clients.js";

export const PRIVATE_ARTIFACT_BUCKET = "sherlock-artifacts";
const RESULT_RETENTION_DAYS = 90;
const MEDIA_RETENTION_DAYS = 30;
const MAX_DIFF_PREVIEW_BYTES = 256 * 1024;
const MAX_EVENT_MESSAGE_CHARS = 2_000;

export type ProductInvestigationCreateInput = {
  investigationId: string;
  tenantId: string;
  installationId: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  githubIssueId: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  triggeringCommentId: string;
  triggeredBy: string;
  triggeredByGithubUserId: string;
  sourceRef: string | null;
  createdAt: string;
};

export type ProductInvestigationClaim =
  | { created: true; investigationId: string }
  | { created: false; investigationId: string };

export interface ProductDataStore extends InvestigationStateStore {
  createInvestigation(
    input: ProductInvestigationCreateInput,
  ): Promise<ProductInvestigationClaim>;
  persistResult(result: InvestigationPipelineResult): Promise<void>;
  saveDeliveryState(state: DeliveryState): Promise<void>;
  loadDeliveryState(investigationId: string): Promise<DeliveryState | null>;
  saveTerminalFailure(record: TerminalFailureRecord): Promise<void>;
  loadTerminalFailure(
    investigationId: string,
  ): Promise<TerminalFailureRecord | null>;
  persistDeliveryPayload(
    investigationId: string,
    kind: "retry" | "terminal",
    reference: DeliveryArtifactReference,
    payload: unknown,
  ): Promise<void>;
  loadDeliveryPayload(
    investigationId: string,
    reference: DeliveryArtifactReference,
  ): Promise<unknown>;
  recordDeliveryAttempt(
    investigationId: string,
    attemptCount: number,
    nextRetryAt: string | null,
  ): Promise<void>;
  cleanupExpired(
    now?: Date,
  ): Promise<{ mediaObjects: number; investigations: number; nonces: number }>;
}

type InvestigationRow = {
  id: string;
  investigation_id: string;
  record: InvestigationStateRecord;
};

type EventProjection = {
  stageKey: string | null;
  stageStatus: string | null;
  message: string | null;
  dedupeKey: string | null;
};

function safeText(value: string, maxChars = MAX_EVENT_MESSAGE_CHARS): string {
  return redactSecrets(value).slice(0, maxChars);
}

function sanitizeJson(value: unknown): unknown {
  if (typeof value === "string") return safeText(value, 20_000);
  if (Array.isArray(value)) return value.slice(0, 200).map(sanitizeJson);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 200)
      .map(([key, entry]) => [key, sanitizeJson(entry)]),
  );
}

function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 24 * 60 * 60 * 1_000).toISOString();
}

function projectionForEvent(event: InvestigationStateEvent): EventProjection {
  switch (event.type) {
    case "created":
      return {
        stageKey: "open_preview",
        stageStatus: "active",
        message: "Investigation queued.",
        dedupeKey: "created",
      };
    case "stage_changed":
      switch (event.stage) {
        case "queued":
          return {
            stageKey: "open_preview",
            stageStatus: "active",
            message: "Investigation queued.",
            dedupeKey: "stage:queued",
          };
        case "running":
          return {
            stageKey: "open_preview",
            stageStatus: "completed",
            message: "Repository preview opened.",
            dedupeKey: "stage:running",
          };
        case "reproducing":
          return {
            stageKey: "reproduce",
            stageStatus: "active",
            message: "Reproducing the reported issue.",
            dedupeKey: "stage:reproducing",
          };
        case "fixing":
          return {
            stageKey: "apply_fix",
            stageStatus: "active",
            message: "Applying the smallest verified fix.",
            dedupeKey: "stage:fixing",
          };
        case "verifying":
          return {
            stageKey: "verify",
            stageStatus: "active",
            message: "Verifying the fix and regression proof.",
            dedupeKey: "stage:verifying",
          };
        case "preparing_delivery":
        case "delivering":
          return {
            stageKey: "open_pr",
            stageStatus: "active",
            message:
              event.stage === "delivering"
                ? "Delivering the pull request and issue report."
                : "Preparing verified delivery.",
            dedupeKey: `stage:${event.stage}`,
          };
        case "completed":
          return {
            stageKey: "open_pr",
            stageStatus: "completed",
            message: "Investigation delivery completed.",
            dedupeKey: "stage:completed",
          };
        case "failed":
          return {
            stageKey: null,
            stageStatus: "failed",
            message: "Investigation failed.",
            dedupeKey: "stage:failed",
          };
      }
      break;
    case "reproduction":
      return {
        stageKey: event.outcome === "reproduced" ? "diagnose" : "reproduce",
        stageStatus: event.outcome === "reproduced" ? "active" : "failed",
        message:
          event.outcome === "reproduced"
            ? "Failure reproduced; diagnosing the root cause."
            : `Reproduction finished with outcome ${safeText(event.outcome, 100)}.`,
        dedupeKey: `reproduction:${event.outcome}`,
      };
    case "fixer_attempts":
      return {
        stageKey: "apply_fix",
        stageStatus:
          event.status === "verified"
            ? "completed"
            : event.attempts > 0
              ? "active"
              : "skipped",
        message:
          event.status === "verified"
            ? "Fix applied."
            : `${event.attempts} fix attempt${event.attempts === 1 ? "" : "s"} evaluated.`,
        dedupeKey: `fixer:${event.status ?? "none"}:${event.attempts}`,
      };
    case "repository_validation":
      return {
        stageKey: "verify",
        stageStatus: event.aggregate === "passed" ? "completed" : "active",
        message: `Repository validation ${safeText(event.aggregate, 100)}.`,
        dedupeKey: `repository-validation:${event.aggregate}`,
      };
    case "regression_proof":
      return {
        stageKey: "verify",
        stageStatus: event.status === "proven" ? "completed" : "failed",
        message:
          event.status === "proven"
            ? "Regression proof passed."
            : `Regression proof ${safeText(event.status, 100)}.`,
        dedupeKey: `regression:${event.status}`,
      };
    case "pull_request":
      return {
        stageKey: "open_pr",
        stageStatus:
          event.status === "created" ||
          event.status === "reused" ||
          event.status === "merged"
            ? "completed"
            : event.status === "failed" || event.status === "blocked"
              ? "failed"
              : event.status === "not_applicable"
                ? "skipped"
                : "active",
        message:
          event.status === "created"
            ? "Pull request opened."
            : `Pull request ${safeText(event.status, 100)}.`,
        dedupeKey: `pull-request:${event.status}:${event.number ?? "none"}`,
      };
    case "final_outcome":
      return {
        stageKey: null,
        stageStatus: null,
        message: `Investigation finished with outcome ${safeText(event.outcome, 100)}.`,
        dedupeKey: `final:${event.outcome}`,
      };
    case "terminal_comment":
      return {
        stageKey: "open_pr",
        stageStatus: event.status === "posted" ? "completed" : "failed",
        message:
          event.status === "posted"
            ? "Issue report posted."
            : "Issue report delivery failed.",
        dedupeKey: `terminal-comment:${event.status}`,
      };
    case "error":
      return {
        stageKey: null,
        stageStatus: event.retryable ? "active" : "failed",
        message: safeText(event.message),
        dedupeKey: null,
      };
  }

  return {
    stageKey: null,
    stageStatus: null,
    message: null,
    dedupeKey: null,
  };
}

function stateRow(record: InvestigationStateRecord) {
  return {
    investigation_id: record.investigationId,
    tenant_id: record.tenantId ?? null,
    installation_id:
      record.installationId === undefined ? null : String(record.installationId),
    repo_owner: record.repoOwner ?? null,
    repo_name: record.repoName ?? null,
    issue_number: record.issueNumber ?? null,
    issue_title: record.issueTitle ?? null,
    issue_url: record.issueUrl ?? null,
    source_commit_sha: record.commit ?? null,
    status: record.status,
    stage: record.stage,
    outcome: record.outcome,
    created_at: record.createdAt,
    started_at: record.createdAt,
    updated_at: record.updatedAt,
    finished_at: record.finishedAt,
    record,
    retention_expires_at: addDays(
      record.finishedAt ?? record.createdAt ?? record.updatedAt,
      RESULT_RETENTION_DAYS,
    ),
  };
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Preview(value: Buffer, maxBytes: number): string {
  if (value.byteLength <= maxBytes) return value.toString("utf8");
  return value.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

function mimeTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".patch":
    case ".diff":
      return "text/x-diff";
    default:
      return "application/octet-stream";
  }
}

function resolveArtifact(baseDir: string, reference: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, reference);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Artifact reference escaped its investigation directory.");
  }
  return resolved;
}

async function readOptionalArtifact(
  baseDir: string,
  reference: string | null | undefined,
): Promise<{ path: string; body: Buffer } | null> {
  if (!reference) return null;
  const artifactPath = path.isAbsolute(reference)
    ? resolveArtifact(baseDir, path.relative(baseDir, reference))
    : resolveArtifact(baseDir, reference);
  try {
    return { path: artifactPath, body: await readFile(artifactPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function createSupabaseProductDataStore(
  supabase: SupabaseClient,
): ProductDataStore {
  const deliveryTitles = new Map<string, string>();
  const findRow = async (investigationId: string): Promise<InvestigationRow | null> => {
    const { data, error } = await supabase
      .from("investigation_states")
      .select("id, investigation_id, record")
      .eq("investigation_id", investigationId)
      .maybeSingle();
    if (error) {
      throw new Error(`Investigation read failed: ${error.message}`);
    }
    return data as InvestigationRow | null;
  };

  const upload = async (
    internalId: string,
    category: string,
    fileName: string,
    body: Buffer,
    contentType: string,
  ) => {
    const digest = checksum(body);
    const safeName = path.posix.basename(fileName).replace(/[^A-Za-z0-9._-]/g, "_");
    const objectPath = `${internalId}/${category}/${digest}-${safeName}`;
    const { error } = await supabase.storage
      .from(PRIVATE_ARTIFACT_BUCKET)
      .upload(objectPath, body, { contentType, upsert: true });
    if (error) throw new Error(`Private artifact upload failed: ${error.message}`);
    return {
      bucket: PRIVATE_ARTIFACT_BUCKET,
      objectPath,
      sha256: digest,
      byteSize: body.byteLength,
    };
  };

  const appendEvent = async (
    row: InvestigationRow,
    event: InvestigationStateEvent,
  ) => {
    const projection = projectionForEvent(event);
    const { error } = await supabase.from("investigation_events").insert({
      investigation_id: row.id,
      event_type: event.type,
      stage_key: projection.stageKey,
      stage_status: projection.stageStatus,
      message: projection.message,
      occurred_at: event.at,
      dedupe_key: projection.dedupeKey,
      details: sanitizeJson(event),
    });
    if (error && !isUniqueViolation(error)) {
      throw new Error(`Investigation event write failed: ${error.message}`);
    }
  };

  const upsertMedia = async (value: Record<string, unknown>) => {
    const { error } = await supabase
      .from("investigation_media")
      .upsert(value, { onConflict: "investigation_id,phase,kind,ordinal" });
    if (error) throw new Error(`Investigation media write failed: ${error.message}`);
  };

  const persistMediaFile = async (input: {
    internalId: string;
    phase: "before" | "after" | "comparison";
    kind: "video" | "screenshot" | "poster";
    ordinal: number;
    title: string;
    file: { path: string; body: Buffer } | null;
    capturedAt: string | null;
  }) => {
    if (!input.file) {
      await upsertMedia({
        investigation_id: input.internalId,
        phase: input.phase,
        kind: input.kind,
        status: "unavailable",
        ordinal: input.ordinal,
        title: input.title,
        bucket: null,
        object_path: null,
        mime_type: null,
        byte_size: null,
        sha256: null,
        captured_at: input.capturedAt,
        error: null,
        retention_expires_at: addDays(
          input.capturedAt ?? new Date().toISOString(),
          MEDIA_RETENTION_DAYS,
        ),
      });
      return;
    }

    try {
      const stored = await upload(
        input.internalId,
        `media/${input.phase}/${input.kind}`,
        path.basename(input.file.path),
        input.file.body,
        mimeTypeFor(input.file.path),
      );
      await upsertMedia({
        investigation_id: input.internalId,
        phase: input.phase,
        kind: input.kind,
        status: "ready",
        ordinal: input.ordinal,
        title: input.title,
        bucket: stored.bucket,
        object_path: stored.objectPath,
        mime_type: mimeTypeFor(input.file.path),
        byte_size: stored.byteSize,
        sha256: stored.sha256,
        captured_at: input.capturedAt,
        error: null,
        retention_expires_at: addDays(
          input.capturedAt ?? new Date().toISOString(),
          MEDIA_RETENTION_DAYS,
        ),
      });
    } catch (error) {
      await upsertMedia({
        investigation_id: input.internalId,
        phase: input.phase,
        kind: input.kind,
        status: "error",
        ordinal: input.ordinal,
        title: input.title,
        bucket: null,
        object_path: null,
        mime_type: null,
        byte_size: null,
        sha256: null,
        captured_at: input.capturedAt,
        error: safeText(error instanceof Error ? error.message : String(error)),
        retention_expires_at: addDays(
          input.capturedAt ?? new Date().toISOString(),
          MEDIA_RETENTION_DAYS,
        ),
      });
    }
  };

  const deliveryObjectPath = (
    internalId: string,
    kind: "retry" | "terminal",
    sha256: string,
  ) => `${internalId}/delivery/${kind}/${sha256}.json`;

  return {
    async createInvestigation(input) {
      const createdEvent: InvestigationStateEvent = {
        type: "created",
        investigationId: input.investigationId,
        at: input.createdAt,
        tenantId: input.tenantId,
        installationId: Number(input.installationId),
        repoOwner: input.repositoryOwner,
        repoName: input.repositoryName,
        repoUrl: `https://github.com/${input.repositoryFullName}`,
        issueNumber: input.issueNumber,
        issueTitle: input.issueTitle,
        issueUrl: input.issueUrl,
        triggeredBy: input.triggeredBy,
      };
      const record = applyEvent(null, createdEvent);

      const repositoryWrite = await supabase
        .from("installation_repositories")
        .upsert(
          {
            installation_id: input.installationId,
            repository_id: input.repositoryId,
            owner_login: input.repositoryOwner,
            name: input.repositoryName,
            full_name: input.repositoryFullName,
            private: input.repositoryPrivate,
            status: "active",
            removed_at: null,
          },
          { onConflict: "installation_id,repository_id" },
        );
      if (repositoryWrite.error) {
        throw new Error(
          `Investigation repository snapshot failed: ${repositoryWrite.error.message}`,
        );
      }

      const { data, error } = await supabase
        .from("investigation_states")
        .insert({
          ...stateRow(record),
          repository_id: input.repositoryId,
          github_issue_id: input.githubIssueId,
          triggering_comment_id: input.triggeringCommentId,
          triggered_by_github_user_id: input.triggeredByGithubUserId,
          issue_title: safeText(input.issueTitle),
          issue_url: input.issueUrl,
          source_commit_sha: input.sourceRef,
        })
        .select("id, investigation_id, record")
        .single();

      if (error) {
        if (!isUniqueViolation(error)) {
          throw new Error(`Investigation creation failed: ${error.message}`);
        }
        const existing = await supabase
          .from("investigation_states")
          .select("investigation_id")
          .eq("installation_id", input.installationId)
          .eq("triggering_comment_id", input.triggeringCommentId)
          .maybeSingle();
        if (existing.error || !existing.data) {
          throw new Error(
            `Investigation duplicate resolution failed: ${
              existing.error?.message ?? "existing row was not found"
            }`,
          );
        }
        return {
          created: false,
          investigationId: String(existing.data.investigation_id),
        };
      }

      const row = data as InvestigationRow;
      await appendEvent(row, createdEvent);
      return { created: true, investigationId: input.investigationId };
    },

    async record(event) {
      let row = await findRow(event.investigationId);
      const record = applyEvent(row?.record ?? null, event);
      const { data, error } = await supabase
        .from("investigation_states")
        .upsert(stateRow(record), { onConflict: "investigation_id" })
        .select("id, investigation_id, record")
        .single();
      if (error) {
        throw new Error(`Investigation state write failed: ${error.message}`);
      }
      row = data as InvestigationRow;
      await appendEvent(row, event);
    },

    async get(investigationId) {
      return (await findRow(investigationId))?.record ?? null;
    },

    async list() {
      const { data, error } = await supabase
        .from("investigation_states")
        .select("record")
        .order("updated_at", { ascending: false });
      if (error) throw new Error(`Investigation list failed: ${error.message}`);
      return (data ?? []).map((entry) => entry.record as InvestigationStateRecord);
    },

    async persistResult(result) {
      const row = await findRow(result.investigationId);
      if (!row) throw new Error("Cannot persist a result for an unknown investigation.");

      const fix = result.fixAttempt ?? null;
      const diffFile = fix
        ? await readOptionalArtifact(fix.attemptDir, "git-diff.patch")
        : null;
      const storedDiff = diffFile
        ? await upload(
            row.id,
            "diff",
            "git-diff.patch",
            diffFile.body,
            "text/x-diff",
          )
        : null;
      const diffPreview = diffFile
        ? utf8Preview(diffFile.body, MAX_DIFF_PREVIEW_BYTES)
        : null;

      const { error } = await supabase.from("investigation_results").upsert({
        investigation_id: row.id,
        report_version: 1,
        summary: fix?.summary ? safeText(fix.summary, 10_000) : null,
        root_cause: fix?.rootCause ? safeText(fix.rootCause, 20_000) : null,
        fix_outcome: fix?.outcome ?? null,
        fix_reason: fix?.reason ? safeText(fix.reason, 10_000) : null,
        changed_files: fix?.changedFiles?.slice(0, 200) ?? [],
        verified_fix_attempt_id:
          fix?.outcome === "verified" ? fix.fixAttemptId : null,
        source_commit_sha: fix?.sourceCommit ?? null,
        diff_preview: diffPreview,
        diff_truncated:
          diffFile !== null && diffFile.body.byteLength > MAX_DIFF_PREVIEW_BYTES,
        diff_sha256: storedDiff?.sha256 ?? null,
        diff_size_bytes: storedDiff?.byteSize ?? null,
        diff_bucket: storedDiff?.bucket ?? null,
        diff_object_path: storedDiff?.objectPath ?? null,
        report: sanitizeJson(result.report ?? { summary: result.summary }),
      });
      if (error) throw new Error(`Investigation result write failed: ${error.message}`);

      const beforeBase = result.artifactsDir ?? "";
      const beforeVideo = beforeBase
        ? await readOptionalArtifact(beforeBase, result.result?.video)
        : null;
      await persistMediaFile({
        internalId: row.id,
        phase: "before",
        kind: "video",
        ordinal: 0,
        title: "Before fix",
        file: beforeVideo,
        capturedAt: result.result?.finishedAt ?? null,
      });

      const beforeScreenshots = result.result?.screenshots ?? [];
      if (beforeScreenshots.length === 0) {
        await persistMediaFile({
          internalId: row.id,
          phase: "before",
          kind: "screenshot",
          ordinal: 0,
          title: "Before capture",
          file: null,
          capturedAt: result.result?.finishedAt ?? null,
        });
      } else {
        for (const [index, reference] of beforeScreenshots.entries()) {
          await persistMediaFile({
            internalId: row.id,
            phase: "before",
            kind: "screenshot",
            ordinal: index,
            title: `Before capture ${index + 1}`,
            file: await readOptionalArtifact(beforeBase, reference),
            capturedAt: result.result?.finishedAt ?? null,
          });
        }
      }

      const afterVideo =
        fix?.outcome === "verified"
          ? await readOptionalArtifact(fix.attemptDir, fix.postPatchVideo)
          : null;
      await persistMediaFile({
        internalId: row.id,
        phase: "after",
        kind: "video",
        ordinal: 0,
        title: "After fix",
        file: afterVideo,
        capturedAt: fix?.finishedAt ?? null,
      });

      let afterScreenshots: string[] = [];
      if (fix?.outcome === "verified") {
        const postPatch = await readOptionalArtifact(
          fix.attemptDir,
          "post-patch-reproduction-result.json",
        );
        if (postPatch) {
          try {
            const parsed = JSON.parse(postPatch.body.toString("utf8")) as {
              screenshots?: unknown;
            };
            if (
              Array.isArray(parsed.screenshots) &&
              parsed.screenshots.every((item) => typeof item === "string")
            ) {
              afterScreenshots = parsed.screenshots;
            }
          } catch {
            afterScreenshots = [];
          }
        }
      }

      if (afterScreenshots.length === 0) {
        await persistMediaFile({
          internalId: row.id,
          phase: "after",
          kind: "screenshot",
          ordinal: 0,
          title: "After capture",
          file: null,
          capturedAt: fix?.finishedAt ?? null,
        });
      } else {
        for (const [index, reference] of afterScreenshots.entries()) {
          await persistMediaFile({
            internalId: row.id,
            phase: "after",
            kind: "screenshot",
            ordinal: index,
            title: `After capture ${index + 1}`,
            file: await readOptionalArtifact(fix?.attemptDir ?? "", reference),
            capturedAt: fix?.finishedAt ?? null,
          });
        }
      }
    },

    async saveDeliveryState(state) {
      const row = await findRow(state.investigationId);
      if (!row) throw new Error("Cannot persist delivery for unknown investigation.");
      const existingDelivery = await supabase
        .from("investigation_deliveries")
        .select("pr_title")
        .eq("investigation_id", row.id)
        .maybeSingle();
      if (existingDelivery.error) {
        throw new Error(
          `Delivery title read failed: ${existingDelivery.error.message}`,
        );
      }
      const retryPath = state.retryPlan
        ? deliveryObjectPath(row.id, "retry", state.retryPlan.payload.sha256)
        : null;
      const terminalPath = deliveryObjectPath(
        row.id,
        "terminal",
        state.terminalPayload.sha256,
      );
      const { error } = await supabase.from("investigation_deliveries").upsert({
        investigation_id: row.id,
        execution_outcome: state.executionOutcome,
        fix_verified: state.fixVerified,
        fix_attempt_id: state.fixAttemptId,
        pr_status: state.pullRequest.status,
        branch_pushed: state.pullRequest.branchPushed,
        branch: state.pullRequest.branch,
        base_branch: state.retryPlan?.baseBranch ?? null,
        pr_number: state.pullRequest.number,
        pr_title:
          deliveryTitles.get(state.investigationId) ??
          existingDelivery.data?.pr_title ??
          null,
        pr_url: state.pullRequest.url,
        pr_reason: state.pullRequest.reason,
        retry_payload_bucket: retryPath ? PRIVATE_ARTIFACT_BUCKET : null,
        retry_payload_path: retryPath,
        retry_payload_sha256: state.retryPlan?.payload.sha256 ?? null,
        terminal_payload_bucket: PRIVATE_ARTIFACT_BUCKET,
        terminal_payload_path: terminalPath,
        terminal_payload_sha256: state.terminalPayload.sha256,
        terminal_comment_status: state.terminalComment.status,
        terminal_comment_id:
          state.terminalComment.id === null ||
          state.terminalComment.id === undefined
            ? null
            : String(state.terminalComment.id),
        terminal_create_attempted_at:
          state.terminalComment.createAttemptedAt ?? null,
        terminal_posted_at: state.terminalComment.postedAt,
        terminal_reason: state.terminalComment.reason,
        state: sanitizeJson(state),
        terminal_failure: null,
      });
      if (error) throw new Error(`Delivery state write failed: ${error.message}`);
    },

    async loadDeliveryState(investigationId) {
      const row = await findRow(investigationId);
      if (!row) return null;
      const { data, error } = await supabase
        .from("investigation_deliveries")
        .select("state")
        .eq("investigation_id", row.id)
        .maybeSingle();
      if (error) throw new Error(`Delivery state read failed: ${error.message}`);
      return data?.state ? (data.state as DeliveryState) : null;
    },

    async saveTerminalFailure(record) {
      const row = await findRow(record.investigationId);
      if (!row) throw new Error("Cannot persist failure for unknown investigation.");
      const { error } = await supabase.from("investigation_deliveries").upsert({
        investigation_id: row.id,
        execution_outcome: "failed",
        fix_verified: false,
        pr_status: "not_applicable",
        branch_pushed: false,
        terminal_comment_status: "failed",
        terminal_reason: safeText(record.stage, 500),
        state: null,
        terminal_failure: sanitizeJson(record),
      });
      if (error) throw new Error(`Terminal failure write failed: ${error.message}`);
    },

    async loadTerminalFailure(investigationId) {
      const row = await findRow(investigationId);
      if (!row) return null;
      const { data, error } = await supabase
        .from("investigation_deliveries")
        .select("terminal_failure")
        .eq("investigation_id", row.id)
        .maybeSingle();
      if (error) throw new Error(`Terminal failure read failed: ${error.message}`);
      return data?.terminal_failure
        ? (data.terminal_failure as TerminalFailureRecord)
        : null;
    },

    async persistDeliveryPayload(investigationId, kind, reference, payload) {
      const row = await findRow(investigationId);
      if (!row) throw new Error("Cannot persist payload for unknown investigation.");
      const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
      if (
        checksum(body) !== reference.sha256 ||
        body.byteLength !== reference.sizeBytes
      ) {
        throw new Error("Delivery payload reference did not match its content.");
      }
      const objectPath = deliveryObjectPath(row.id, kind, reference.sha256);
      const { error } = await supabase.storage
        .from(PRIVATE_ARTIFACT_BUCKET)
        .upload(objectPath, body, {
          contentType: "application/json",
          upsert: true,
        });
      if (error) throw new Error(`Delivery payload upload failed: ${error.message}`);
      if (
        kind === "retry" &&
        payload &&
        typeof payload === "object" &&
        typeof (payload as { title?: unknown }).title === "string"
      ) {
        deliveryTitles.set(
          investigationId,
          safeText((payload as { title: string }).title, 500),
        );
      }
    },

    async loadDeliveryPayload(investigationId, reference) {
      const row = await findRow(investigationId);
      if (!row) throw new Error("Cannot load payload for unknown investigation.");
      const { data, error } = await supabase
        .from("investigation_deliveries")
        .select(
          "retry_payload_path,retry_payload_sha256,terminal_payload_path,terminal_payload_sha256",
        )
        .eq("investigation_id", row.id)
        .maybeSingle();
      if (error || !data) {
        throw new Error(
          `Delivery payload metadata read failed: ${error?.message ?? "not found"}`,
        );
      }
      const objectPath =
        data.retry_payload_sha256 === reference.sha256
          ? data.retry_payload_path
          : data.terminal_payload_sha256 === reference.sha256
            ? data.terminal_payload_path
            : null;
      if (!objectPath) throw new Error("Delivery payload reference was not found.");
      const downloaded = await supabase.storage
        .from(PRIVATE_ARTIFACT_BUCKET)
        .download(objectPath);
      if (downloaded.error) {
        throw new Error(`Delivery payload download failed: ${downloaded.error.message}`);
      }
      const body = Buffer.from(await downloaded.data.arrayBuffer());
      if (
        checksum(body) !== reference.sha256 ||
        body.byteLength !== reference.sizeBytes
      ) {
        throw new Error("Downloaded delivery payload failed integrity verification.");
      }
      return JSON.parse(body.toString("utf8")) as unknown;
    },

    async recordDeliveryAttempt(investigationId, attemptCount, nextRetryAt) {
      const row = await findRow(investigationId);
      if (!row) throw new Error("Cannot record delivery for unknown investigation.");
      const { error } = await supabase
        .from("investigation_deliveries")
        .update({
          attempt_count: attemptCount,
          last_attempt_at: new Date().toISOString(),
          next_retry_at: nextRetryAt,
        })
        .eq("investigation_id", row.id);
      if (error) throw new Error(`Delivery attempt write failed: ${error.message}`);
    },

    async cleanupExpired(now = new Date()) {
      const nowIso = now.toISOString();
      let mediaObjects = 0;
      let investigations = 0;

      const expiredMedia = await supabase
        .from("investigation_media")
        .select("id,bucket,object_path")
        .is("deleted_at", null)
        .lt("retention_expires_at", nowIso);
      if (expiredMedia.error) {
        throw new Error(`Expired media read failed: ${expiredMedia.error.message}`);
      }

      for (const media of expiredMedia.data ?? []) {
        if (media.bucket && media.object_path) {
          const removed = await supabase.storage
            .from(media.bucket)
            .remove([media.object_path]);
          if (removed.error) {
            throw new Error(`Expired media deletion failed: ${removed.error.message}`);
          }
          mediaObjects += 1;
        }
        const marked = await supabase
          .from("investigation_media")
          .update({
            status: "unavailable",
            bucket: null,
            object_path: null,
            deleted_at: nowIso,
          })
          .eq("id", media.id);
        if (marked.error) {
          throw new Error(`Expired media mark failed: ${marked.error.message}`);
        }
      }

      const expiredInvestigations = await supabase
        .from("investigation_states")
        .select("id")
        .eq("status", "finished")
        .lt("retention_expires_at", nowIso);
      if (expiredInvestigations.error) {
        throw new Error(
          `Expired investigation read failed: ${expiredInvestigations.error.message}`,
        );
      }

      for (const investigation of expiredInvestigations.data ?? []) {
        const [result, media, delivery] = await Promise.all([
          supabase
            .from("investigation_results")
            .select("diff_bucket,diff_object_path")
            .eq("investigation_id", investigation.id)
            .maybeSingle(),
          supabase
            .from("investigation_media")
            .select("bucket,object_path")
            .eq("investigation_id", investigation.id),
          supabase
            .from("investigation_deliveries")
            .select(
              "retry_payload_bucket,retry_payload_path,terminal_payload_bucket,terminal_payload_path",
            )
            .eq("investigation_id", investigation.id)
            .maybeSingle(),
        ]);
        if (result.error || media.error || delivery.error) {
          throw new Error(
            `Expired investigation artifact read failed: ${
              result.error?.message ??
              media.error?.message ??
              delivery.error?.message
            }`,
          );
        }

        const objects = [
          result.data?.diff_bucket && result.data.diff_object_path
            ? [result.data.diff_bucket, result.data.diff_object_path]
            : null,
          ...(media.data ?? []).map((entry) =>
            entry.bucket && entry.object_path
              ? [entry.bucket, entry.object_path]
              : null,
          ),
          delivery.data?.retry_payload_bucket &&
          delivery.data.retry_payload_path
            ? [
                delivery.data.retry_payload_bucket,
                delivery.data.retry_payload_path,
              ]
            : null,
          delivery.data?.terminal_payload_bucket &&
          delivery.data.terminal_payload_path
            ? [
                delivery.data.terminal_payload_bucket,
                delivery.data.terminal_payload_path,
              ]
            : null,
        ].filter((entry): entry is [string, string] => entry !== null);

        const byBucket = new Map<string, string[]>();
        for (const [bucket, objectPath] of objects) {
          const paths = byBucket.get(bucket) ?? [];
          paths.push(objectPath);
          byBucket.set(bucket, paths);
        }
        for (const [bucket, paths] of byBucket) {
          const removed = await supabase.storage.from(bucket).remove(paths);
          if (removed.error) {
            throw new Error(
              `Expired investigation object deletion failed: ${removed.error.message}`,
            );
          }
        }

        const deleted = await supabase
          .from("investigation_states")
          .delete()
          .eq("id", investigation.id);
        if (deleted.error) {
          throw new Error(
            `Expired investigation deletion failed: ${deleted.error.message}`,
          );
        }
        investigations += 1;
      }

      const nonceCutoff = new Date(
        now.getTime() - 24 * 60 * 60 * 1_000,
      ).toISOString();
      const deletedNonces = await supabase
        .from("github_installation_nonces")
        .delete({ count: "exact" })
        .lt("expires_at", nonceCutoff);
      if (deletedNonces.error) {
        throw new Error(`Expired nonce deletion failed: ${deletedNonces.error.message}`);
      }

      return {
        mediaObjects,
        investigations,
        nonces: deletedNonces.count ?? 0,
      };
    },
  };
}

export async function createProductDataStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProductDataStore | null> {
  if (missingSupabaseServiceEnv(env).length > 0) return null;
  return createSupabaseProductDataStore(
    await getSupabaseServiceRoleClient(env),
  );
}

export function createInMemoryProductDataStore(): ProductDataStore & {
  snapshot(): {
    investigations: InvestigationStateRecord[];
    events: InvestigationStateEvent[];
    results: InvestigationPipelineResult[];
    deliveries: DeliveryState[];
  };
} {
  const investigations = new Map<string, InvestigationStateRecord>();
  const triggerClaims = new Map<string, string>();
  const events: InvestigationStateEvent[] = [];
  const results = new Map<string, InvestigationPipelineResult>();
  const deliveries = new Map<string, DeliveryState>();
  const failures = new Map<string, TerminalFailureRecord>();
  const payloads = new Map<string, Buffer>();

  const record = async (event: InvestigationStateEvent) => {
    investigations.set(
      event.investigationId,
      applyEvent(investigations.get(event.investigationId) ?? null, event),
    );
    events.push(structuredClone(event));
  };

  return {
    async createInvestigation(input) {
      const key = `${input.installationId}:${input.triggeringCommentId}`;
      const existing = triggerClaims.get(key);
      if (existing) return { created: false, investigationId: existing };
      triggerClaims.set(key, input.investigationId);
      await record({
        type: "created",
        investigationId: input.investigationId,
        at: input.createdAt,
        tenantId: input.tenantId,
        installationId: Number(input.installationId),
        repoOwner: input.repositoryOwner,
        repoName: input.repositoryName,
        repoUrl: `https://github.com/${input.repositoryFullName}`,
        issueNumber: input.issueNumber,
        issueTitle: input.issueTitle,
        issueUrl: input.issueUrl,
        triggeredBy: input.triggeredBy,
      });
      return { created: true, investigationId: input.investigationId };
    },
    record,
    async get(investigationId) {
      return investigations.get(investigationId) ?? null;
    },
    async list() {
      return [...investigations.values()];
    },
    async persistResult(result) {
      results.set(
        result.investigationId,
        structuredClone(result) as InvestigationPipelineResult,
      );
    },
    async saveDeliveryState(state) {
      deliveries.set(
        state.investigationId,
        structuredClone(state) as DeliveryState,
      );
    },
    async loadDeliveryState(investigationId) {
      const state = deliveries.get(investigationId);
      return state ? (structuredClone(state) as DeliveryState) : null;
    },
    async saveTerminalFailure(failure) {
      failures.set(
        failure.investigationId,
        structuredClone(failure) as TerminalFailureRecord,
      );
    },
    async loadTerminalFailure(investigationId) {
      const failure = failures.get(investigationId);
      return failure
        ? (structuredClone(failure) as TerminalFailureRecord)
        : null;
    },
    async persistDeliveryPayload(investigationId, kind, reference, payload) {
      const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
      if (
        body.byteLength !== reference.sizeBytes ||
        checksum(body) !== reference.sha256
      ) {
        throw new Error("Delivery payload reference did not match its content.");
      }
      payloads.set(
        `${investigationId}:${kind}:${reference.sha256}`,
        body,
      );
    },
    async loadDeliveryPayload(investigationId, reference) {
      const body =
        payloads.get(`${investigationId}:retry:${reference.sha256}`) ??
        payloads.get(`${investigationId}:terminal:${reference.sha256}`);
      if (!body) throw new Error("Delivery payload was not found.");
      if (
        body.byteLength !== reference.sizeBytes ||
        checksum(body) !== reference.sha256
      ) {
        throw new Error("Delivery payload failed integrity verification.");
      }
      return JSON.parse(body.toString("utf8")) as unknown;
    },
    async recordDeliveryAttempt() {
      // The in-memory adapter exposes delivery state recovery; attempt
      // counters are a database projection and need no separate map here.
    },
    async cleanupExpired() {
      return { mediaObjects: 0, investigations: 0, nonces: 0 };
    },
    snapshot() {
      return {
        investigations: [...investigations.values()].map((value) =>
          structuredClone(value),
        ),
        events: events.map((value) => structuredClone(value)),
        results: [...results.values()].map(
          (value) => structuredClone(value) as InvestigationPipelineResult,
        ),
        deliveries: [...deliveries.values()].map(
          (value) => structuredClone(value) as DeliveryState,
        ),
      };
    },
  };
}

export function createProductBackedDeliveryStateStore(
  local: DeliveryStateStore,
  product: ProductDataStore,
): DeliveryStateStore {
  const persistPayloadTracked = async (
    investigationId: string,
    kind: "retry" | "terminal",
    payload: unknown,
  ) => {
    const tracked = await local.persistPayloadTracked(
      investigationId,
      kind,
      payload,
    );
    await product.persistDeliveryPayload(
      investigationId,
      kind,
      tracked.reference,
      payload,
    );
    return tracked;
  };

  return {
    async load(investigationId) {
      const localState = await local.load(investigationId);
      return localState ?? product.loadDeliveryState(investigationId);
    },
    async save(state) {
      await local.save(state);
      await product.saveDeliveryState(state);
    },
    async loadTerminalFailure(investigationId) {
      return (
        (await local.loadTerminalFailure(investigationId)) ??
        (await product.loadTerminalFailure(investigationId))
      );
    },
    async saveTerminalFailure(record) {
      await local.saveTerminalFailure(record);
      await product.saveTerminalFailure(record);
    },
    async persistPayload(investigationId, kind, payload) {
      const tracked = await persistPayloadTracked(investigationId, kind, payload);
      return tracked.reference;
    },
    persistPayloadTracked,
    async loadPayload(investigationId, reference) {
      try {
        return await local.loadPayload(investigationId, reference);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          const message = error instanceof Error ? error.message : String(error);
          if (!/not found|ENOENT/i.test(message)) throw error;
        }
        return product.loadDeliveryPayload(investigationId, reference);
      }
    },
    withLock(investigationId, operation) {
      return local.withLock(investigationId, operation);
    },
  };
}

export async function artifactExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
