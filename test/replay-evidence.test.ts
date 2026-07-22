// Replay evidence (docs/FABLE_REPLAY_EVIDENCE_PROMPT.md): comparison media
// construction, flag-gated upload, and report rendering. Everything here runs
// without a browser, ffmpeg, or network — runners and fetch are injected.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createArtifactStore,
  createInvestigationId,
} from "../backend/services/artifacts.js";
import {
  buildReplayEvidenceMedia,
  buildSideBySideGifArgs,
  buildSideBySideMp4Args,
  buildSingleGifArgs,
  MAX_GIF_BYTES,
} from "../backend/services/replay-evidence.js";
import {
  prepareReplayEvidence,
  resolveEvidenceUploadConfig,
} from "../backend/services/evidence-upload.js";
import {
  buildInvestigationReportData,
  canonicalEvidenceUrl,
  normalizeInvestigationReportData,
  renderIssueReport,
} from "../backend/services/issue-report-renderer.js";
import type { InvestigationSummary } from "../backend/services/report.js";

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "sherlock-replay-evidence-"));
  const investigationId = createInvestigationId();
  return createArtifactStore(investigationId, path.join(dir, investigationId));
}

// --- ffmpeg argument construction -------------------------------------------------

describe("replay evidence media", () => {
  test("side-by-side args reference both clips, tail seeking, and bounded outputs", () => {
    const mp4 = buildSideBySideMp4Args("/a/run.webm", "/b/post-patch.webm", "/out/evidence.mp4");
    expect(mp4).toContain("/a/run.webm");
    expect(mp4).toContain("/b/post-patch.webm");
    expect(mp4).toContain("-sseof");
    expect(mp4[mp4.length - 1]).toBe("/out/evidence.mp4");
    expect(mp4.join(" ")).toContain("hstack");

    const gif = buildSideBySideGifArgs("/a/run.webm", "/b/post-patch.webm", "/out/evidence.gif");
    expect(gif.join(" ")).toContain("palettegen");
    expect(gif.join(" ")).toContain("hstack");

    const single = buildSingleGifArgs("/a/run.webm", "/out/evidence.gif");
    expect(single.join(" ")).not.toContain("hstack");
    expect(single).toContain("/a/run.webm");
  });

  test("degrades to nulls when ffmpeg is unavailable", async () => {
    const media = await buildReplayEvidenceMedia({
      failingVideo: "/a/run.webm",
      passingVideo: "/b/post-patch.webm",
      outDir: path.join(tmpdir(), "never-created"),
      run: async () => {
        throw new Error("ffmpeg: command not found");
      },
    });

    expect(media.mp4).toBeNull();
    expect(media.gif).toBeNull();
    expect(media.notes.join(" ")).toContain("ffmpeg is not available");
  });

  test("discards outputs that exceed the byte caps", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "sherlock-evidence-caps-"));
    const media = await buildReplayEvidenceMedia({
      failingVideo: "/a/run.webm",
      passingVideo: null,
      outDir,
      run: async (command, args) => {
        if (args.length === 1) return; // -version probe
        // "Encode" a GIF that busts the cap.
        await writeFile(args[args.length - 1], Buffer.alloc(MAX_GIF_BYTES + 1));
      },
    });

    expect(media.gif).toBeNull();
    expect(media.notes.join(" ")).toContain("exceeded");
  });
});

// --- Upload configuration and privacy gating ---------------------------------------

describe("evidence upload", () => {
  test("uses the existing Supabase configuration without a feature flag", () => {
    expect(resolveEvidenceUploadConfig({})).toEqual({
      supabaseUrl: null,
      serviceRoleKey: null,
    });
    expect(resolveEvidenceUploadConfig({
      SUPABASE_URL: "https://example.supabase.co/",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    })).toEqual({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "test-key",
    });
  });

  test("records a diagnostic when Supabase credentials are unavailable", async () => {
    const store = await makeStore();
    const urls = await prepareReplayEvidence({
      store,
      failingVideo: "videos/run.webm",
      fixAttemptDir: null,
      passingVideo: null,
      env: {},
    });

    expect(urls).toBeNull();
    const artifact = JSON.parse(
      await readFile(path.join(store.dir, "evidence-upload.json"), "utf8"),
    ) as { status: string };
    expect(artifact.status).toBe("skipped_misconfigured");
  });

  test("uploads media and returns public URLs without internal ids", async () => {
    const store = await makeStore();
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];

    // Fake ffmpeg writes non-empty outputs.
    const urls = await prepareReplayEvidence({
      store,
      failingVideo: "videos/run.webm",
      fixAttemptDir: "/attempt",
      passingVideo: "videos/post-patch.webm",
      env: {
        SUPABASE_URL: "https://example.supabase.co/",
        SUPABASE_SERVICE_ROLE_KEY: "test-key",
      },
      ffmpegRunner: async (command, args) => {
        if (args.length === 1) return;
        await writeFile(args[args.length - 1], "media");
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, headers: init.headers });
        return { ok: true, status: 200, text: async () => "" };
      },
      randomToken: () => "deadbeef",
    });

    expect(urls).toEqual({
      gifUrl:
        "https://example.supabase.co/storage/v1/object/public/sherlock-evidence/deadbeef/evidence.gif",
      videoUrl:
        "https://example.supabase.co/storage/v1/object/public/sherlock-evidence/deadbeef/evidence.mp4",
    });
    expect(requests.every(({ url }) => !url.includes(store.investigationId))).toBe(true);
    expect(requests.every(({ headers }) => headers.apikey === "test-key")).toBe(true);

    const artifact = JSON.parse(
      await readFile(path.join(store.dir, "evidence-upload.json"), "utf8"),
    ) as { status: string; urls: { gifUrl: string } };
    expect(artifact.status).toBe("uploaded");
    expect(artifact.urls.gifUrl).toContain("deadbeef");
  });

  test("degrades to null when every upload fails", async () => {
    const store = await makeStore();
    const urls = await prepareReplayEvidence({
      store,
      failingVideo: "videos/run.webm",
      fixAttemptDir: null,
      passingVideo: null,
      env: {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-key",
      },
      ffmpegRunner: async (command, args) => {
        if (args.length === 1) return;
        await writeFile(args[args.length - 1], "media");
      },
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
    });

    expect(urls).toBeNull();
  });
});

// --- Report rendering ---------------------------------------------------------------

const verifiedSummary: InvestigationSummary = {
  investigationId: "inv_TESTTESTTEST",
  outcome: "verified_fix",
  originalOutcome: "reproduced",
  verification: "verified",
};

function verifiedReport(replayEvidence: { gifUrl: string | null; videoUrl: string | null } | null) {
  return buildInvestigationReportData({
    summary: verifiedSummary,
    fixAttempt: {
      outcome: "verified",
      reason: "ok",
      rootCause: "The handler returned 500 for unknown users.",
      summary: "Return 401 for unknown credentials.",
      changedFiles: ["src/login.ts"],
      checks: [],
      postPatchOutcome: "not_reproduced",
      repositoryValidation: null,
      regressionTest: null,
    },
    replayEvidence,
  });
}

describe("replay evidence rendering", () => {
  test("canonicalEvidenceUrl accepts https hosts and rejects unsafe URLs", () => {
    expect(
      canonicalEvidenceUrl("https://example.supabase.co/storage/v1/object/public/b/t/e.gif"),
    ).toContain("https://example.supabase.co/");
    expect(canonicalEvidenceUrl("http://example.com/e.gif")).toBeNull();
    expect(canonicalEvidenceUrl("https://localhost/e.gif")).toBeNull();
    expect(canonicalEvidenceUrl("https://127.0.0.1/e.gif")).toBeNull();
    expect(canonicalEvidenceUrl("https://user:pw@example.com/e.gif")).toBeNull();
    expect(canonicalEvidenceUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalEvidenceUrl("https://example.com/a).![x](y")).toBeNull();
    expect(canonicalEvidenceUrl(null)).toBeNull();
  });

  test("renders the comparison section for a verified fix", () => {
    const report = verifiedReport({
      gifUrl: "https://example.supabase.co/storage/v1/object/public/b/t/evidence.gif",
      videoUrl: "https://example.supabase.co/storage/v1/object/public/b/t/evidence.mp4",
    });
    const rendered = renderIssueReport(report, { status: "created", url: null });

    expect(rendered).toContain("### Replay evidence");
    expect(rendered).toContain("failing before the fix");
    expect(rendered).toContain("![Sherlock replay evidence](https://example.supabase.co/");
    expect(rendered).toContain("[Watch the full comparison video](https://example.supabase.co/");
  });

  test("omits the section entirely when evidence is absent or invalid", () => {
    expect(renderIssueReport(verifiedReport(null), null)).not.toContain("Replay evidence");
    expect(
      renderIssueReport(verifiedReport({ gifUrl: "http://evil", videoUrl: null }), null),
    ).not.toContain("Replay evidence");
  });

  test("normalization tolerates absent field, validates present ones", () => {
    const withEvidence = verifiedReport({
      gifUrl: "https://example.supabase.co/e.gif",
      videoUrl: null,
    });
    const normalized = normalizeInvestigationReportData(
      JSON.parse(JSON.stringify(withEvidence)),
    );
    expect(normalized.replayEvidence?.gifUrl).toBe("https://example.supabase.co/e.gif");

    // Legacy payload with no replayEvidence key at all.
    const legacy = JSON.parse(JSON.stringify(verifiedReport(null))) as Record<string, unknown>;
    delete legacy.replayEvidence;
    expect(normalizeInvestigationReportData(legacy).replayEvidence ?? null).toBeNull();

    // Invalid URLs are dropped rather than fatal.
    const junk = JSON.parse(JSON.stringify(withEvidence)) as {
      replayEvidence: { gifUrl: string; videoUrl: null };
    };
    junk.replayEvidence.gifUrl = "http://localhost:3000/e.gif";
    expect(normalizeInvestigationReportData(junk).replayEvidence ?? null).toBeNull();

    // Grossly malformed shapes are rejected.
    const bad = JSON.parse(JSON.stringify(withEvidence)) as Record<string, unknown>;
    bad.replayEvidence = { gifUrl: 7 };
    expect(() => normalizeInvestigationReportData(bad)).toThrow();
  });
});
