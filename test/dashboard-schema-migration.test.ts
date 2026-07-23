import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "supabase/migrations/20260723000000_create_dashboard_data_platform.sql",
);
const hardeningMigrationPath = path.resolve(
  "supabase/migrations/20260723010000_harden_dashboard_recovery.sql",
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

  it("uses bounded migration locks and restores session defaults", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("set lock_timeout = '10s'");
    expect(sql).toContain("set statement_timeout = '30min'");
    expect(sql).toContain("reset lock_timeout");
    expect(sql).toContain("reset statement_timeout");
  });

  it("keeps webhook idempotency after investigation retention cleanup", async () => {
    const sql = await readFile(hardeningMigrationPath, "utf8");

    expect(sql).toContain("create table public.investigation_commands");
    expect(sql).toContain("unique (installation_id, triggering_comment_id)");
    expect(sql).toContain("unique (investigation_id)");
    expect(sql).not.toMatch(
      /investigation_commands[\s\S]{0,500}references public\.investigation_states/,
    );
    expect(sql).toContain("alter table public.investigation_commands enable row level security");
    expect(sql).not.toContain("create policy");
  });

  it("backfills legacy commands before adding the NOT VALID foreign key", async () => {
    const sql = await readFile(hardeningMigrationPath, "utf8");
    const backfill = sql.indexOf("insert into public.investigation_commands");
    const foreignKey = sql.indexOf(
      "add constraint investigation_commands_installation_id_fkey",
    );

    expect(backfill).toBeGreaterThan(-1);
    expect(foreignKey).toBeGreaterThan(backfill);
    expect(sql).toContain("not valid");
    expect(sql).toContain("dashboard_data_reconciliation_status");
    expect(sql).toContain("validate_dashboard_data_foreign_keys");
  });

  it("claims the command, investigation, and initial event in one RPC transaction", async () => {
    const sql = await readFile(hardeningMigrationPath, "utf8");
    const claim = sql.slice(
      sql.indexOf("create or replace function public.claim_dashboard_investigation"),
      sql.indexOf(
        "create or replace function public.mark_dashboard_investigation_enqueued",
      ),
    );

    expect(claim).toContain("insert into public.investigation_commands");
    expect(claim).toContain("insert into public.investigation_states");
    expect(claim).toContain("insert into public.investigation_events");
    expect(claim.indexOf("if v_command.id is null")).toBeLessThan(
      claim.indexOf("insert into public.installation_repositories"),
    );
    expect(sql).toContain(
      "grant execute on function public.claim_dashboard_investigation",
    );
    expect(sql).toContain(
      "grant execute on function public.mark_dashboard_investigation_enqueued",
    );
    expect(sql).toMatch(
      /validate_dashboard_data_foreign_keys\(\)[\s\S]*security definer[\s\S]*set search_path = pg_catalog, public[\s\S]*set lock_timeout = '10s'/,
    );
    expect(sql).toContain(
      "grant execute on function public.validate_dashboard_data_foreign_keys()",
    );
  });
});
