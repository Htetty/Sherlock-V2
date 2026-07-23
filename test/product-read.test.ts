import { describe, expect, test } from "vitest";
import { reduceTimeline } from "../backend/services/product-read.js";

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
});
