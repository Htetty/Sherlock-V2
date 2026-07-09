-- Investigation state store: one folded, redacted aggregate row per
-- investigation. Written ONLY by the Sherlock backend/worker using the
-- Supabase service role key (never exposed to browser/client code).
--
-- The `record` JSONB column holds the folded InvestigationStateRecord that the
-- reducer produces (already redacted). It never contains issue bodies, trigger
-- comment bodies, installation tokens, environment variables, raw webhook
-- payloads, or raw event logs. The scalar columns are duplicated out of that
-- record purely for dashboard listing/filtering.
--
-- Row Level Security is ENABLED with NO policies: anon and authenticated roles
-- can neither read nor write. The backend service role bypasses RLS. Do NOT
-- add a public anon read policy here — dashboard reads will arrive later
-- through a backend API or explicit, scoped policies.

create table if not exists public.investigation_states (
  investigation_id text primary key
    check (investigation_id ~ '^inv_[0-9A-Z]{10,}$'),
  tenant_id text,
  installation_id bigint,
  repo_owner text,
  repo_name text,
  issue_number integer,
  status text not null check (status in ('running', 'finished')),
  stage text,
  outcome text,
  created_at timestamptz,
  updated_at timestamptz not null,
  finished_at timestamptz,
  record jsonb not null,
  inserted_at timestamptz not null default now(),
  db_updated_at timestamptz not null default now()
);

create index if not exists investigation_states_updated_at_idx
  on public.investigation_states (updated_at desc);

create index if not exists investigation_states_status_updated_at_idx
  on public.investigation_states (status, updated_at desc);

create index if not exists investigation_states_repo_updated_at_idx
  on public.investigation_states (repo_owner, repo_name, updated_at desc);

create index if not exists investigation_states_tenant_updated_at_idx
  on public.investigation_states (tenant_id, updated_at desc);

-- Keep db_updated_at accurate on every update, independent of client input.
create or replace function public.investigation_states_touch_db_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.db_updated_at := now();
  return new;
end;
$$;

drop trigger if exists investigation_states_touch
  on public.investigation_states;

create trigger investigation_states_touch
  before update on public.investigation_states
  for each row
  execute function public.investigation_states_touch_db_updated_at();

-- RLS on, no policies. The backend/worker uses the service role key (bypasses
-- RLS); every other role is denied by default.
alter table public.investigation_states enable row level security;
