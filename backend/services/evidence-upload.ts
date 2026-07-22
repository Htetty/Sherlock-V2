// Replay-evidence hosting (docs/FABLE_REPLAY_EVIDENCE_PROMPT.md, Phase 3).
//
// Uploads the comparison media produced by replay-evidence.ts to a public
// Supabase Storage bucket so the GitHub comment can embed the GIF and link
// the mp4. GitHub has no API for comment attachments, so external hosting is
// the only bot-compatible way to show media inline.
//
// Rules honored here:
//   - Automatic when the worker already has Supabase credentials.
//   - Public hosting: evidence from both public and private repositories is
//     uploaded because GitHub cannot embed authenticated Storage objects.
//     Object paths carry an unguessable random token and never an investigation id.
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

export type EvidenceUploadConfig = {
  supabaseUrl: string | null;
  serviceRoleKey: string | null;
};

export const EVIDENCE_BUCKET = "sherlock-evidence";

// Single hard cap on any uploaded object; replay-evidence.ts enforces the
// tighter per-format caps before this is ever reached.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function resolveEvidenceUploadConfig(
  env: NodeJS.ProcessEnv = process.env,
): EvidenceUploadConfig {
  return {
    supabaseUrl: env.SUPABASE_URL?.replace(/\/+$/, "") ?? null,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? null,
  };
}

// --- Public upload policy ----------------------------------------------------
//
// Uploading replay media to the public bucket is opt-in. The default (and any
// invalid/missing configuration) is `disabled`: media is still recorded and
// kept locally, but nothing leaves the worker. `allowlist` mode uploads only
// for repositories whose exact normalized "owner/repo" identity appears in
// SHERLOCK_PUBLIC_REPLAY_ALLOWLIST (comma-separated, case-insensitive, no
// wildcards). Existing already-published objects and URLs are unaffected.

export type PublicReplayUploadMode = "disabled" | "allowlist";

export type PublicReplayUploadPolicy = {
  mode: PublicReplayUploadMode;
  // Normalized (lowercased, trimmed) "owner/repo" entries. Empty when disabled.
  allowlist: ReadonlySet<string>;
};

// Conservative repository-identity shape; anything else (wildcards, slashes in
// the owner, traversal characters) fails normalization and never matches.
const ALLOWLIST_ENTRY_PATTERN =
  /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}\/[a-z0-9._-]{1,100}$/;

export function normalizeRepositoryIdentity(
  owner: string | null | undefined,
  repo: string | null | undefined,
): string | null {
  if (typeof owner !== "string" || typeof repo !== "string") {
    return null;
  }

  const normalized = `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;

  return ALLOWLIST_ENTRY_PATTERN.test(normalized) ? normalized : null;
}

export function resolvePublicReplayUploadPolicy(
  env: NodeJS.ProcessEnv = process.env,
): PublicReplayUploadPolicy {
  // Fail closed: anything but the exact string "allowlist" is disabled.
  if (env.SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE !== "allowlist") {
    return { mode: "disabled", allowlist: new Set() };
  }

  const allowlist = new Set<string>();

  for (const rawEntry of (env.SHERLOCK_PUBLIC_REPLAY_ALLOWLIST ?? "").split(",")) {
    const entry = rawEntry.trim().toLowerCase();

    // Only exact, well-formed owner/repo identities are honored; malformed
    // entries (wildcards included) are dropped rather than loosely matched.
    if (entry !== "" && ALLOWLIST_ENTRY_PATTERN.test(entry)) {
      allowlist.add(entry);
    }
  }

  return { mode: "allowlist", allowlist };
}

export function isPublicReplayUploadAllowed(
  policy: PublicReplayUploadPolicy,
  repositoryOwner: string | null | undefined,
  repositoryName: string | null | undefined,
): boolean {
  if (policy.mode !== "allowlist") {
    return false;
  }

  // No repository identity means no upload — never guess.
  const identity = normalizeRepositoryIdentity(repositoryOwner, repositoryName);

  return identity !== null && policy.allowlist.has(identity);
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
    const supabaseUrl = config.supabaseUrl;
    const serviceRoleKey = config.serviceRoleKey;
    if (!supabaseUrl || !serviceRoleKey) {
      notes.push(`Uploading ${path.basename(filePath)} skipped: Supabase is not configured.`);
      return null;
    }

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
      `${supabaseUrl}/storage/v1/object/${EVIDENCE_BUCKET}/${objectPath}`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
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
    return `${supabaseUrl}/storage/v1/object/public/${EVIDENCE_BUCKET}/${objectPath}`;
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
  // Repository identity used ONLY by the public-upload allowlist policy.
  // When absent, allowlist mode never uploads (no identity, no upload).
  repositoryOwner?: string | null;
  repositoryName?: string | null;
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
      .writeJson("evidence-upload.json", { mode: "supabase", status, notes, urls })
      .catch(() => {});
  };

  try {
    if (input.failingVideo === null) {
      notes.push("No reproduction video was recorded; nothing to upload.");
      await writeArtifact("skipped_no_video", null);
      return null;
    }

    // Public upload is opt-in (disabled by default; exact allowlist only).
    // Skipping here is a policy decision, never a failure: local media stays
    // on disk and the GitHub report simply omits public replay links.
    const policy = resolvePublicReplayUploadPolicy(input.env ?? process.env);

    if (
      !isPublicReplayUploadAllowed(
        policy,
        input.repositoryOwner ?? null,
        input.repositoryName ?? null,
      )
    ) {
      notes.push(
        policy.mode === "disabled"
          ? "Public replay upload is disabled (SHERLOCK_PUBLIC_REPLAY_UPLOAD_MODE)."
          : "Repository is not on the public replay upload allowlist.",
      );
      await writeArtifact("skipped_policy", null);
      log("Replay evidence upload skipped by the public-upload policy.");
      return null;
    }

    if (!config.supabaseUrl || !config.serviceRoleKey) {
      notes.push(
        "Replay evidence upload requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
      await writeArtifact("skipped_misconfigured", null);
      log("Replay evidence upload skipped: Supabase is not configured.");
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
