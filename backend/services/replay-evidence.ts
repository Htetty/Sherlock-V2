// Replay evidence media (docs/FABLE_REPLAY_EVIDENCE_PROMPT.md, Phase 2).
//
// Turns the two Playwright recordings that already exist — the reproduction
// run where the bug fails and the post-fix verification run where the exact
// saved plan passes — into a side-by-side comparison mp4 and a bounded GIF
// suitable for embedding in a GitHub comment.
//
// Hard rules honored here:
//   - Pure media transformation: no new execution path, no model calls, no
//     network. Inputs are the webm files the plan executor harvested.
//   - Every ffmpeg invocation uses argument arrays (no shell interpolation),
//     a bounded runtime, and bounded output sizes.
//   - Failures degrade: a missing ffmpeg or a failed encode returns nulls and
//     notes; it must never fail the investigation.

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_GIF_BYTES = 8 * 1024 * 1024;
export const MAX_MP4_BYTES = 50 * 1024 * 1024;
// The failure/assertion moment is at the END of a run, so clips are taken
// from the tail of each recording.
export const CLIP_TAIL_SECONDS = 20;
const GIF_FPS = 8;
const GIF_TOTAL_WIDTH = 960;
const SINGLE_GIF_WIDTH = 480;
const PANEL_HEIGHT_MP4 = 480;
const PANEL_HEIGHT_GIF = 360;
const FFMPEG_TIMEOUT_MS = 120_000;

export type FfmpegRunner = (command: string, args: string[]) => Promise<void>;

const defaultRunner: FfmpegRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error) => (error ? reject(error) : resolve()),
    );
  });

export async function isFfmpegAvailable(
  run: FfmpegRunner = defaultRunner,
): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

// Side-by-side mp4: reproduction (fails) on the left, post-fix verification
// (passes) on the right. No burned-in text: font availability varies across
// hosts, and the comment copy labels the sides instead.
export function buildSideBySideMp4Args(
  failingVideo: string,
  passingVideo: string,
  outFile: string,
): string[] {
  return [
    "-y",
    "-nostdin",
    "-sseof",
    `-${CLIP_TAIL_SECONDS}`,
    "-i",
    failingVideo,
    "-sseof",
    `-${CLIP_TAIL_SECONDS}`,
    "-i",
    passingVideo,
    "-filter_complex",
    `[0:v]scale=-2:${PANEL_HEIGHT_MP4},setsar=1[l];[1:v]scale=-2:${PANEL_HEIGHT_MP4},setsar=1[r];[l][r]hstack=inputs=2[v]`,
    "-map",
    "[v]",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outFile,
  ];
}

export function buildSideBySideGifArgs(
  failingVideo: string,
  passingVideo: string,
  outFile: string,
): string[] {
  return [
    "-y",
    "-nostdin",
    "-sseof",
    `-${CLIP_TAIL_SECONDS}`,
    "-i",
    failingVideo,
    "-sseof",
    `-${CLIP_TAIL_SECONDS}`,
    "-i",
    passingVideo,
    "-filter_complex",
    `[0:v]scale=-2:${PANEL_HEIGHT_GIF},setsar=1[l];[1:v]scale=-2:${PANEL_HEIGHT_GIF},setsar=1[r];[l][r]hstack=inputs=2,fps=${GIF_FPS},scale=${GIF_TOTAL_WIDTH}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    outFile,
  ];
}

// Reproduce-only investigations have no passing run; a lone failing clip
// still shows the bug happening.
export function buildSingleGifArgs(failingVideo: string, outFile: string): string[] {
  return [
    "-y",
    "-nostdin",
    "-sseof",
    `-${CLIP_TAIL_SECONDS}`,
    "-i",
    failingVideo,
    "-filter_complex",
    `[0:v]fps=${GIF_FPS},scale=${SINGLE_GIF_WIDTH}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    outFile,
  ];
}

export type ReplayEvidenceMedia = {
  // Absolute path to the side-by-side comparison mp4, or null.
  mp4: string | null;
  // Absolute path to the bounded GIF (side-by-side when a passing run
  // exists, single-panel otherwise), or null.
  gif: string | null;
  // Human-readable, bounded diagnostics for the evidence artifact. Never
  // rendered publicly.
  notes: string[];
};

export type BuildReplayEvidenceInput = {
  // Absolute path to the reproduction recording (the failing run).
  failingVideo: string;
  // Absolute path to the post-fix verification recording, or null for
  // reproduce-only evidence.
  passingVideo: string | null;
  // Directory that receives evidence.mp4 / evidence.gif.
  outDir: string;
  run?: FfmpegRunner;
};

export async function buildReplayEvidenceMedia(
  input: BuildReplayEvidenceInput,
): Promise<ReplayEvidenceMedia> {
  const run = input.run ?? defaultRunner;
  const notes: string[] = [];
  const media: ReplayEvidenceMedia = { mp4: null, gif: null, notes };

  if (!(await isFfmpegAvailable(run))) {
    notes.push("ffmpeg is not available; no comparison media was produced.");
    return media;
  }

  try {
    await mkdir(input.outDir, { recursive: true });
  } catch (error) {
    notes.push(`Could not create the evidence directory: ${message(error)}`);
    return media;
  }

  const mp4Path = path.join(input.outDir, "evidence.mp4");
  const gifPath = path.join(input.outDir, "evidence.gif");

  if (input.passingVideo !== null) {
    media.mp4 = await encodeBounded(
      run,
      buildSideBySideMp4Args(input.failingVideo, input.passingVideo, mp4Path),
      mp4Path,
      MAX_MP4_BYTES,
      "comparison mp4",
      notes,
    );
    media.gif = await encodeBounded(
      run,
      buildSideBySideGifArgs(input.failingVideo, input.passingVideo, gifPath),
      gifPath,
      MAX_GIF_BYTES,
      "comparison GIF",
      notes,
    );
  } else {
    media.gif = await encodeBounded(
      run,
      buildSingleGifArgs(input.failingVideo, gifPath),
      gifPath,
      MAX_GIF_BYTES,
      "reproduction GIF",
      notes,
    );
  }

  return media;
}

async function encodeBounded(
  run: FfmpegRunner,
  args: string[],
  outFile: string,
  maxBytes: number,
  label: string,
  notes: string[],
): Promise<string | null> {
  try {
    await run("ffmpeg", args);
  } catch (error) {
    notes.push(`Encoding the ${label} failed: ${message(error)}`);
    await rm(outFile, { force: true }).catch(() => {});
    return null;
  }

  try {
    const info = await stat(outFile);

    if (info.size === 0) {
      notes.push(`The ${label} was empty and was discarded.`);
      await rm(outFile, { force: true }).catch(() => {});
      return null;
    }

    if (info.size > maxBytes) {
      notes.push(
        `The ${label} exceeded the ${Math.round(maxBytes / (1024 * 1024))} MB cap (${info.size} bytes) and was discarded.`,
      );
      await rm(outFile, { force: true }).catch(() => {});
      return null;
    }

    notes.push(`The ${label} was produced (${info.size} bytes).`);
    return outFile;
  } catch (error) {
    notes.push(`The ${label} could not be inspected: ${message(error)}`);
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
