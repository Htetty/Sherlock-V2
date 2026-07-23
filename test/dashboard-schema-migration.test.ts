import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "supabase/migrations/20260723000000_create_dashboard_data_platform.sql",
);

describe("dashboard data platform migration", () => {
  it("defines the canonical investigation projection and required child tables", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("add column if not exists id uuid");
    expect(sql).toContain("alter column installation_id type text");
    expect(sql).toContain("investigation_states_trigger_comment_key");
    expect(sql).toContain("create table public.investigation_events");
    expect(sql).toContain("create table public.investigation_results");
    expect(sql).toContain("create table public.investigation_media");
    expect(sql).toContain("create table public.investigation_deliveries");
  });

  it("keeps application tables private and creates a private artifact bucket", async () => {
    const sql = await readFile(migrationPath, "utf8");

    for (const table of [
      "investigation_events",
      "investigation_results",
      "investigation_media",
      "investigation_deliveries",
    ]) {
      expect(sql).toContain(
        `alter table public.${table} enable row level security`,
      );
    }

    expect(sql).toMatch(
      /'sherlock-artifacts',\s*'sherlock-artifacts',\s*false,/s,
    );
    expect(sql).not.toContain("create policy");
  });

  it("uses string GitHub ids and internal UUID foreign keys", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("repository_id text");
    expect(sql).toContain("github_issue_id text");
    expect(sql).toContain("triggering_comment_id text");
    expect(sql).toContain("triggered_by_github_user_id text");
    expect(sql).toContain(
      "references public.investigation_states (id) on delete cascade",
    );
  });
});
