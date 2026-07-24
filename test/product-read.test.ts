import { describe, expect, test } from "vitest";
import {
  membershipAllows,
  reduceTimeline,
} from "../backend/services/product-read.js";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("dashboard timeline projection", () => {
  test("advances prior steps when a later stage becomes active", () => {
    const timeline = reduceTimeline(
      [
        {
          id: 1,
          stage_key: "open_preview",
          stage_status: "completed",
          message: "Repository preview opened.",
          occurred_at: "2026-07-23T00:00:01.000Z",
        },
        {
          id: 2,
          stage_key: "reproduce",
          stage_status: "active",
          message: "Reproducing the reported issue.",
          occurred_at: "2026-07-23T00:00:02.000Z",
        },
        {
          id: 3,
          stage_key: "diagnose",
          stage_status: "active",
          message: "Diagnosing the root cause.",
          occurred_at: "2026-07-23T00:00:03.000Z",
        },
      ],
      "active",
      false,
    );

    expect(timeline.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(timeline[2].message).toBe("Diagnosing the root cause.");
  });

  test("marks fix, verification, and PR stages skipped for a completed no-fix outcome", () => {
    const timeline = reduceTimeline(
      [
        {
          id: 1,
          stage_key: "reproduce",
          stage_status: "completed",
          message: "Reproduction completed.",
          occurred_at: "2026-07-23T00:00:02.000Z",
        },
        {
          id: 2,
          stage_key: "diagnose",
          stage_status: "completed",
          message: "Diagnosis completed.",
          occurred_at: "2026-07-23T00:00:03.000Z",
        },
      ],
      "completed",
      false,
    );

    expect(timeline.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  test("marks the active stage failed and all later stages skipped", () => {
    const timeline = reduceTimeline(
      [
        {
          id: 1,
          stage_key: "open_preview",
          stage_status: "completed",
          message: null,
          occurred_at: "2026-07-23T00:00:01.000Z",
        },
        {
          id: 2,
          stage_key: "reproduce",
          stage_status: "active",
          message: null,
          occurred_at: "2026-07-23T00:00:02.000Z",
        },
      ],
      "failed",
      false,
    );

    expect(timeline.map((step) => step.status)).toEqual([
      "completed",
      "failed",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  test("projects a setup failure even when no stage event was active", () => {
    const timeline = reduceTimeline([], "failed", false);

    expect(timeline.map((step) => step.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });
});

describe("investigation repository authorization", () => {
  function client(repositoryStatus: "active" | "removed" | null) {
    const rows: Record<string, unknown> = {
      user_installations: { installation_id: "987" },
      github_installations: { status: "active" },
      installation_repositories:
        repositoryStatus === null ? null : { status: repositoryStatus },
    };
    return {
      from(table: string) {
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          async maybeSingle() {
            return { data: rows[table] ?? null, error: null };
          },
        };
        return builder;
      },
    } as unknown as SupabaseClient;
  }

  test("requires an active repository for every new investigation row", async () => {
    await expect(
      membershipAllows(client("active"), "user-a", "987", "555"),
    ).resolves.toBe(true);
    await expect(
      membershipAllows(client("removed"), "user-a", "987", "555"),
    ).resolves.toBe(false);
    await expect(
      membershipAllows(client(null), "user-a", "987", "555"),
    ).resolves.toBe(false);
  });

  test("keeps legacy rows without repository ids installation-scoped", async () => {
    await expect(
      membershipAllows(client(null), "user-a", "987", null),
    ).resolves.toBe(true);
  });
});
