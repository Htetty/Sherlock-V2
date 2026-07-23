import type { SupabaseClient } from "@supabase/supabase-js";
import { PRIVATE_ARTIFACT_BUCKET } from "./product-data.js";

export type DashboardInvestigationStatus = "active" | "completed" | "failed";
export type DashboardTimelineStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "skipped";

export type DashboardInvestigation = {
  id: string;
  issueTitle: string;
  status: DashboardInvestigationStatus;
  error: string | null;
  updatedAt: string;
  version: number;
  timeline: Array<{
    id:
      | "open_preview"
      | "reproduce"
      | "diagnose"
      | "apply_fix"
      | "verify"
      | "open_pr";
    label: string;
    status: DashboardTimelineStatus;
    message: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  evidence: {
    before: DashboardPhaseEvidence;
    after: DashboardPhaseEvidence;
  };
  fix: {
    summary: string;
    diff: string;
    diffTruncated: boolean;
  } | null;
  pullRequest:
    | { url: string; title: string }
    | { error: string }
    | null;
};

export type DashboardPhaseEvidence = {
  replay: {
    status: "pending" | "available" | "unavailable" | "error";
    videoUrl?: string;
    posterUrl?: string;
    error?: string;
  };
  screenshots: Array<{
    id: string;
    title: string;
    status: "pending" | "ready" | "unavailable" | "error";
    url?: string;
    error?: string;
  }>;
};

export type IssueInvestigationLookup = {
  investigationId: string;
  status: DashboardInvestigationStatus;
  statusUrl: string;
};

export interface ProductReadStore {
  findIssueInvestigation(input: {
    userId: string;
    installationId: string;
    repositoryId: string;
    issueNumber: number;
  }): Promise<IssueInvestigationLookup | null>;
  getInvestigation(
    userId: string,
    investigationId: string,
  ): Promise<DashboardInvestigation | null>;
  getInvestigationDiff(
    userId: string,
    investigationId: string,
  ): Promise<{ diff: string; diffTruncated: boolean } | null>;
}

type StateRow = {
  id: string;
  investigation_id: string;
  installation_id: string | null;
  issue_title: string | null;
  status: "running" | "finished";
  stage: string | null;
  outcome: string | null;
  updated_at: string;
  version: number | string;
  record: {
    issueTitle?: string;
    errors?: Array<{
      at: string;
      stage: string | null;
      message: string;
      retryable?: boolean;
    }>;
    fixer?: { verifiedFixAttemptId?: string | null } | null;
  };
};

type EventRow = {
  id: number;
  stage_key: DashboardInvestigation["timeline"][number]["id"] | null;
  stage_status: DashboardTimelineStatus | null;
  message: string | null;
  occurred_at: string;
};

type MediaRow = {
  id: string;
  phase: "before" | "after" | "comparison";
  kind: "video" | "screenshot" | "poster";
  status: "pending" | "ready" | "unavailable" | "error";
  ordinal: number;
  title: string | null;
  bucket: string | null;
  object_path: string | null;
  error: string | null;
};

type ResultRow = {
  summary: string | null;
  diff_preview: string | null;
  diff_truncated: boolean;
  diff_bucket: string | null;
  diff_object_path: string | null;
  diff_size_bytes: number | null;
  report: {
    fixSummary?: string | null;
  } | null;
};

type DeliveryRow = {
  pr_status: string;
  pr_title: string | null;
  pr_url: string | null;
  pr_reason: string | null;
  terminal_comment_status: string;
  terminal_reason: string | null;
};

const timelineTemplate: DashboardInvestigation["timeline"] = [
  {
    id: "open_preview",
    label: "Open repository preview",
    status: "pending",
    message: "Waiting to open the repository.",
    startedAt: null,
    finishedAt: null,
  },
  {
    id: "reproduce",
    label: "Reproduce reported issue",
    status: "pending",
    message: "Waiting to reproduce the issue.",
    startedAt: null,
    finishedAt: null,
  },
  {
    id: "diagnose",
    label: "Diagnose root cause",
    status: "pending",
    message: "Waiting for diagnosis.",
    startedAt: null,
    finishedAt: null,
  },
  {
    id: "apply_fix",
    label: "Apply fix",
    status: "pending",
    message: "Waiting for a fix.",
    startedAt: null,
    finishedAt: null,
  },
  {
    id: "verify",
    label: "Verify fix",
    status: "pending",
    message: "Waiting for verification.",
    startedAt: null,
    finishedAt: null,
  },
  {
    id: "open_pr",
    label: "Open pull request",
    status: "pending",
    message: "Waiting for delivery.",
    startedAt: null,
    finishedAt: null,
  },
];

function dashboardStatus(row: Pick<StateRow, "status" | "outcome">) {
  if (row.status === "running") return "active" as const;
  if (
    row.outcome === "verified_fix" ||
    row.outcome === "reproduced" ||
    row.outcome === "not_reproduced"
  ) {
    return "completed" as const;
  }
  return "failed" as const;
}

export function reduceTimeline(
  events: EventRow[],
  status: DashboardInvestigationStatus,
  verifiedFix: boolean,
): DashboardInvestigation["timeline"] {
  const timeline = timelineTemplate.map((item) => ({ ...item }));
  const position = new Map(timeline.map((item, index) => [item.id, index]));

  for (const event of events) {
    if (!event.stage_key || !event.stage_status) continue;
    const index = position.get(event.stage_key);
    if (index === undefined) continue;

    if (
      event.stage_status === "active" ||
      event.stage_status === "completed" ||
      event.stage_status === "failed"
    ) {
      for (let prior = 0; prior < index; prior += 1) {
        if (
          timeline[prior].status === "pending" ||
          timeline[prior].status === "active"
        ) {
          timeline[prior].status = "completed";
          timeline[prior].finishedAt ??= event.occurred_at;
        }
      }
    }

    const item = timeline[index];
    if (event.stage_status === "active") {
      for (const candidate of timeline) {
        if (candidate.status === "active" && candidate.id !== item.id) {
          candidate.status = "completed";
          candidate.finishedAt ??= event.occurred_at;
        }
      }
      item.startedAt ??= event.occurred_at;
    }
    if (
      event.stage_status === "completed" ||
      event.stage_status === "failed" ||
      event.stage_status === "skipped"
    ) {
      item.startedAt ??= event.occurred_at;
      item.finishedAt = event.occurred_at;
    }
    item.status = event.stage_status;
    if (event.message) item.message = event.message;
  }

  if (status === "completed") {
    for (const item of timeline) {
      if (item.status === "active") item.status = "completed";
    }
    if (!verifiedFix) {
      for (const key of ["apply_fix", "verify", "open_pr"] as const) {
        const item = timeline[position.get(key)!];
        if (item.status === "pending" || item.status === "active") {
          item.status = "skipped";
          item.message = "Not required for this investigation outcome.";
        }
      }
    }
  } else if (status === "failed") {
    let activeIndex = -1;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      if (
        timeline[index].status === "active" ||
        timeline[index].status === "failed"
      ) {
        activeIndex = index;
        break;
      }
    }
    if (activeIndex >= 0) {
      timeline[activeIndex].status = "failed";
      for (let index = activeIndex + 1; index < timeline.length; index += 1) {
        if (timeline[index].status === "pending") {
          timeline[index].status = "skipped";
          timeline[index].message = "Skipped after the investigation failed.";
        }
      }
    }
  }

  return timeline;
}

async function membershipAllows(
  supabase: SupabaseClient,
  userId: string,
  installationId: string | null,
): Promise<boolean> {
  if (!installationId) return false;
  const [membership, installation] = await Promise.all([
    supabase
      .from("user_installations")
      .select("installation_id")
      .eq("user_id", userId)
      .eq("installation_id", installationId)
      .maybeSingle(),
    supabase
      .from("github_installations")
      .select("status")
      .eq("installation_id", installationId)
      .maybeSingle(),
  ]);
  if (membership.error || installation.error) {
    throw new Error(
      `Investigation authorization failed: ${
        membership.error?.message ?? installation.error?.message
      }`,
    );
  }
  return Boolean(membership.data && installation.data?.status === "active");
}

async function signedObjectUrl(
  supabase: SupabaseClient,
  row: Pick<MediaRow, "status" | "bucket" | "object_path">,
): Promise<string | undefined> {
  if (row.status !== "ready" || !row.bucket || !row.object_path) {
    return undefined;
  }
  const { data, error } = await supabase.storage
    .from(row.bucket)
    .createSignedUrl(row.object_path, 300);
  if (error) throw new Error(`Artifact signing failed: ${error.message}`);
  return data.signedUrl;
}

async function phaseEvidence(
  supabase: SupabaseClient,
  rows: MediaRow[],
  phase: "before" | "after",
): Promise<DashboardPhaseEvidence> {
  const phaseRows = rows.filter((row) => row.phase === phase);
  const video = phaseRows.find((row) => row.kind === "video");
  const poster = phaseRows.find((row) => row.kind === "poster");
  const [videoUrl, posterUrl] = await Promise.all([
    video ? signedObjectUrl(supabase, video) : undefined,
    poster ? signedObjectUrl(supabase, poster) : undefined,
  ]);

  const replay: DashboardPhaseEvidence["replay"] = video
    ? {
        status:
          video.status === "ready"
            ? "available"
            : video.status === "pending"
              ? "pending"
              : video.status,
        ...(videoUrl ? { videoUrl } : {}),
        ...(posterUrl ? { posterUrl } : {}),
        ...(video.error ? { error: video.error } : {}),
      }
    : { status: "unavailable" };

  const screenshots = await Promise.all(
    phaseRows
      .filter((row) => row.kind === "screenshot")
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(async (row) => {
        const url = await signedObjectUrl(supabase, row);
        return {
          id: row.id,
          title: row.title ?? `${phase === "before" ? "Before" : "After"} capture`,
          status: row.status,
          ...(url ? { url } : {}),
          ...(row.error ? { error: row.error } : {}),
        };
      }),
  );

  return { replay, screenshots };
}

export function createSupabaseProductReadStore(
  supabase: SupabaseClient,
): ProductReadStore {
  const readState = async (investigationId: string): Promise<StateRow | null> => {
    const { data, error } = await supabase
      .from("investigation_states")
      .select(
        "id,investigation_id,installation_id,issue_title,status,stage,outcome,updated_at,version,record",
      )
      .eq("investigation_id", investigationId)
      .maybeSingle();
    if (error) throw new Error(`Investigation read failed: ${error.message}`);
    return data as StateRow | null;
  };

  const authorizedState = async (userId: string, investigationId: string) => {
    const row = await readState(investigationId);
    if (!row || !(await membershipAllows(supabase, userId, row.installation_id))) {
      return null;
    }
    return row;
  };

  return {
    async findIssueInvestigation(input) {
      if (
        !(await membershipAllows(supabase, input.userId, input.installationId))
      ) {
        return null;
      }
      const { data, error } = await supabase
        .from("investigation_states")
        .select("investigation_id,status,outcome")
        .eq("installation_id", input.installationId)
        .eq("repository_id", input.repositoryId)
        .eq("issue_number", input.issueNumber)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw new Error(`Issue investigation lookup failed: ${error.message}`);
      }
      if (!data) return null;
      const investigationId = String(data.investigation_id);
      return {
        investigationId,
        status: dashboardStatus(data as StateRow),
        statusUrl: `/investigations/${encodeURIComponent(investigationId)}`,
      };
    },

    async getInvestigation(userId, investigationId) {
      const row = await authorizedState(userId, investigationId);
      if (!row) return null;
      const [eventsResult, resultResult, mediaResult, deliveryResult] =
        await Promise.all([
          supabase
            .from("investigation_events")
            .select("id,stage_key,stage_status,message,occurred_at")
            .eq("investigation_id", row.id)
            .order("id", { ascending: true }),
          supabase
            .from("investigation_results")
            .select(
              "summary,diff_preview,diff_truncated,diff_bucket,diff_object_path,diff_size_bytes,report",
            )
            .eq("investigation_id", row.id)
            .maybeSingle(),
          supabase
            .from("investigation_media")
            .select(
              "id,phase,kind,status,ordinal,title,bucket,object_path,error",
            )
            .eq("investigation_id", row.id)
            .is("deleted_at", null),
          supabase
            .from("investigation_deliveries")
            .select(
              "pr_status,pr_title,pr_url,pr_reason,terminal_comment_status,terminal_reason",
            )
            .eq("investigation_id", row.id)
            .maybeSingle(),
        ]);
      const dependencyError =
        eventsResult.error ??
        resultResult.error ??
        mediaResult.error ??
        deliveryResult.error;
      if (dependencyError) {
        throw new Error(`Investigation detail read failed: ${dependencyError.message}`);
      }

      const result = resultResult.data as ResultRow | null;
      const delivery = deliveryResult.data as DeliveryRow | null;
      const status = dashboardStatus(row);
      const events = (eventsResult.data ?? []) as EventRow[];
      const media = (mediaResult.data ?? []) as MediaRow[];
      const [before, after] = await Promise.all([
        phaseEvidence(supabase, media, "before"),
        phaseEvidence(supabase, media, "after"),
      ]);
      const verifiedFix = Boolean(
        row.record?.fixer?.verifiedFixAttemptId,
      );
      const lastError = [...(row.record?.errors ?? [])]
        .reverse()
        .find((error) => !error.retryable);

      let pullRequest: DashboardInvestigation["pullRequest"] = null;
      if (
        delivery?.pr_url &&
        ["created", "reused", "merged"].includes(delivery.pr_status)
      ) {
        pullRequest = {
          url: delivery.pr_url,
          title: delivery.pr_title ?? `Fix ${row.issue_title ?? "reported issue"}`,
        };
      } else if (
        delivery &&
        ["failed", "blocked"].includes(delivery.pr_status)
      ) {
        pullRequest = {
          error: delivery.pr_reason ?? "Pull request delivery failed.",
        };
      }

      const summary = result?.summary ?? result?.report?.fixSummary ?? null;

      return {
        id: row.investigation_id,
        issueTitle: row.issue_title ?? row.record?.issueTitle ?? "GitHub issue",
        status,
        error:
          lastError?.message ??
          delivery?.terminal_reason ??
          (pullRequest && "error" in pullRequest ? pullRequest.error : null),
        updatedAt: row.updated_at,
        version: Number(row.version),
        timeline: reduceTimeline(events, status, verifiedFix),
        evidence: { before, after },
        fix:
          summary || result?.diff_preview
            ? {
                summary: summary ?? "Sherlock produced a verified code change.",
                diff: result?.diff_preview ?? "",
                diffTruncated: result?.diff_truncated ?? false,
              }
            : null,
        pullRequest,
      };
    },

    async getInvestigationDiff(userId, investigationId) {
      const row = await authorizedState(userId, investigationId);
      if (!row) return null;
      const { data, error } = await supabase
        .from("investigation_results")
        .select(
          "diff_preview,diff_truncated,diff_bucket,diff_object_path,diff_size_bytes",
        )
        .eq("investigation_id", row.id)
        .maybeSingle();
      if (error) throw new Error(`Investigation diff read failed: ${error.message}`);
      if (!data) return { diff: "", diffTruncated: false };

      const result = data as ResultRow;
      const maximumInlineBytes = 2 * 1024 * 1024;
      if (
        !result.diff_bucket ||
        !result.diff_object_path ||
        (result.diff_size_bytes ?? 0) > maximumInlineBytes
      ) {
        return {
          diff: result.diff_preview ?? "",
          diffTruncated: result.diff_truncated,
        };
      }
      const downloaded = await supabase.storage
        .from(result.diff_bucket || PRIVATE_ARTIFACT_BUCKET)
        .download(result.diff_object_path);
      if (downloaded.error) {
        throw new Error(`Investigation diff download failed: ${downloaded.error.message}`);
      }
      const body = Buffer.from(await downloaded.data.arrayBuffer());
      if (body.byteLength > maximumInlineBytes) {
        return {
          diff: result.diff_preview ?? "",
          diffTruncated: true,
        };
      }
      return { diff: body.toString("utf8"), diffTruncated: false };
    },
  };
}
