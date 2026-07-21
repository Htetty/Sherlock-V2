// Replay-evidence hosting (docs/FABLE_REPLAY_EVIDENCE_PROMPT.md, Phase 3).
//
// Uploads the comparison media produced by replay-evidence.ts to a public
// Supabase Storage bucket so the GitHub comment can embed the GIF and link
// the mp4. GitHub has no API for comment attachments, so external hosting is
// the only bot-compatible way to show media inline.
//
// Rules honored here:
//   - Off by default: SHERLOCK_EVIDENCE_UPLOAD=supabase enables it.
//   - Privacy: repository visibility must be an explicit `false` (public) to
//     upload, unless SHERLOCK_EVIDENCE_UPLOAD_PRIVATE_REPOS=true. Unknown
//     visibility is treated as private. Object paths carry an unguessable
//     random token and never an investigation id.
//   - Failures degrade to "no evidence in the comment", never to a failed
//     investigation or delivery.
//   - The service-role key stays server-side (worker), like the state store.

import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactStore } from "./artifacts.js";
import {
  buildReplayEvidenceMedia,
  type FfmpegRunner,
} from "./replay-evidence.js";

export type EvidenceUploadMode = "off" | "supabase";

export type EvidenceUploadConfig = {
  mode: EvidenceUploadMode;
  supabaseUrl: string | null;
  serviceRoleKey: string | null;
  bucket: string;
  allowPrivateRepos: boolean;
};

// Single hard cap on any uploaded object; replay-evidence.ts enforces the
// tighter per-format caps before this is ever reached.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function resolveEvidenceUploadConfig(
  env: NodeJS.ProcessEnv = process.env,
): EvidenceUploadConfig {
  const mode: EvidenceUploadMode =
    env.SHERLOCK_EVIDENCE_UPLOAD === "supabase" ? "supabase" : "off";

  return {
    mode,
    supabaseUrl: env.SUPABASE_URL?.replace(/\/+$/, "") ?? null,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? null,
    bucket: env.SHERLOCK_EVIDENCE_BUCKET ?? "sherlock-evidence",
    allowPrivateRepos: env.SHERLOCK_EVIDENCE_UPLOAD_PRIVATE_REPOS === "true",
  };
}

// URLs delivered into the report payload. Only ever built from Sherlock's own
// upload responses — never from model output.
export type ReplayEvidenceUrls = {
  // Public URL of the embeddable GIF (side-by-side when a passing run
  // exists), or null.
  gifUrl: string | null;
  // Public URL of the side-by-side comparison mp4, or null.
  videoUrl: string | null;
};

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const CONTENT_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

async function uploadFile(
  config: EvidenceUploadConfig,
  objectPath: string,
  filePath: string,
  fetchImpl: FetchLike,
  notes: string[],
): Promise<string | null> {
  try {
    const info = await stat(filePath);

    if (info.size === 0 || info.size > MAX_UPLOAD_BYTES) {
      notes.push(
        `Skipped uploading ${path.basename(filePath)}: size ${info.size} bytes is outside bounds.`,
      );
      return null;
    }

    const body = await readFile(filePath);
    const contentType =
      CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
      "application/octet-stream";
    const response = await fetchImpl(
      `${config.supabaseUrl}/storage/v1/object/${config.bucket}/${objectPath}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.serviceRoleKey}`,
          "content-type": contentType,
          "x-upsert": "false",
        },
        body,
      },
    );

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      notes.push(
        `Uploading ${path.basename(filePath)} failed with status ${response.status}: ${detail}`,
      );
      return null;
    }

    notes.push(`Uploaded ${path.basename(filePath)} (${info.size} bytes).`);
    return `${config.supabaseUrl}/storage/v1/object/public/${config.bucket}/${objectPath}`;
  } catch (error) {
    notes.push(
      `Uploading ${path.basename(filePath)} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export type PrepareReplayEvidenceInput = {
  // The investigation's main artifact store (evidence-upload.json target and
  // the base for the evidence/ output directory).
  store: ArtifactStore;
  // Store-relative reference to the failing reproduction video, or null.
  failingVideo: string | null;
  // Absolute fix-attempt dir plus attempt-relative post-patch video ref, or
  // nulls when there is no verified fix.
  fixAttemptDir: string | null;
  passingVideo: string | null;
  // Repository visibility: explicit false = public. Anything else is treated
  // as private.
  repoIsPrivate: boolean | null;
  log?: (message: string) => void;
  // Injectable for tests.
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  ffmpegRunner?: FfmpegRunner;
  randomToken?: () => string;
};

// Builds comparison media from the recorded runs and uploads it. Returns the
// public URLs for the report, or null when the feature is off, evidence is
// unavailable, or anything failed. Never throws.
export async function prepareReplayEvidence(
  input: PrepareReplayEvidenceInput,
): Promise<ReplayEvidenceUrls | null> {
  const log = input.log ?? (() => {});
  const config = resolveEvidenceUploadConfig(input.env ?? process.env);
  const notes: string[] = [];

  const writeArtifact = async (
    status: string,
    urls: ReplayEvidenceUrls | null,
  ) => {
    await input.store
      .writeJson("evidence-upload.json", { mode: config.mode, status, notes, urls })
      .catch(() => {});
  };

  try {
    if (config.mode === "off") {
      return null;
    }

    if (input.failingVideo === null) {
      notes.push("No reproduction video was recorded; nothing to upload.");
      await writeArtifact("skipped_no_video", null);
      return null;
    }

    if (!config.supabaseUrl || !config.serviceRoleKey) {
      notes.push(
        "SHERLOCK_EVIDENCE_UPLOAD=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
      await writeArtifact("skipped_misconfigured", null);
      log("Replay evidence upload skipped: Supabase is not configured.");
      return null;
    }

    if (input.repoIsPrivate !== false && !config.allowPrivateRepos) {
      notes.push(
        "Repository visibility is private or unknown and SHERLOCK_EVIDENCE_UPLOAD_PRIVATE_REPOS is not enabled.",
      );
      await writeArtifact("skipped_private_repository", null);
      log("Replay evidence upload skipped: repository is not known to be public.");
      return null;
    }

    const media = await buildReplayEvidenceMedia({
      failingVideo: path.join(input.store.dir, input.failingVideo),
      passingVideo:
        input.fixAttemptDir !== null && input.passingVideo !== null
          ? path.join(input.fixAttemptDir, input.passingVideo)
          : null,
      outDir: path.join(input.store.dir, "evidence"),
      run: input.ffmpegRunner,
    });
    notes.push(...media.notes);

    if (media.gif === null && media.mp4 === null) {
      await writeArtifact("skipped_no_media", null);
      log("Replay evidence upload skipped: no comparison media was produced.");
      return null;
    }

    // Unguessable prefix; deliberately NOT the investigation id (internal ids
    // never appear in public URLs).
    const prefix = (input.randomToken ?? (() => randomBytes(24).toString("hex")))();
    const fetchImpl = input.fetchImpl ?? (fetch as unknown as FetchLike);

    const urls: ReplayEvidenceUrls = {
      gifUrl:
        media.gif !== null
          ? await uploadFile(config, `${prefix}/evidence.gif`, media.gif, fetchImpl, notes)
          : null,
      videoUrl:
        media.mp4 !== null
          ? await uploadFile(config, `${prefix}/evidence.mp4`, media.mp4, fetchImpl, notes)
          : null,
    };

    if (urls.gifUrl === null && urls.videoUrl === null) {
      await writeArtifact("upload_failed", null);
      log("Replay evidence upload failed; the comment ships without evidence.");
      return null;
    }

    await writeArtifact("uploaded", urls);
    log("Replay evidence uploaded.");
    return urls;
  } catch (error) {
    notes.push(
      `Replay evidence preparation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await writeArtifact("failed", null);
    log("Replay evidence preparation failed; continuing without evidence.");
    return null;
  }
}
