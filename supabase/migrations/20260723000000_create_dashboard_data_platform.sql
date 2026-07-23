-- Durable dashboard data platform.
--
-- This migration turns investigation_states into the canonical, authorized
-- investigation projection while retaining its existing public inv_* key and
-- folded JSON record. Rich lifecycle, result, media, and delivery data live in
-- normalized child tables. Browser roles remain denied: all access flows
-- through the authenticated backend service.

-- --- Canonical investigation identity ----------------------------------------

alter table public.investigation_states
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists repository_id text,
  add column if not exists github_issue_id text,
  add column if not exists triggering_comment_id text,
  add column if not exists triggered_by_github_user_id text,
  add column if not exists issue_title text,
  add column if not exists issue_url text,
  add column if not exists source_commit_sha text,
  add column if not exists started_at timestamptz,
  add column if not exists version bigint not null default 1,
  add column if not exists retention_expires_at timestamptz;

update public.investigation_states
   set id = gen_random_uuid()
 where id is null;

alter table public.investigation_states
  alter column id set not null;

-- GitHub ids are decimal strings everywhere else in the product schema.
alter table public.investigation_states
  alter column installation_id type text
  using installation_id::text;

alter table public.investigation_states
  drop constraint if exists investigation_states_installation_id_digits,
  add constraint investigation_states_installation_id_digits
    check (installation_id is null or installation_id ~ '^[0-9]+$'),
  drop constraint if exists investigation_states_repository_id_digits,
  add constraint investigation_states_repository_id_digits
    check (repository_id is null or repository_id ~ '^[0-9]+$'),
  drop constraint if exists investigation_states_github_issue_id_digits,
  add constraint investigation_states_github_issue_id_digits
    check (github_issue_id is null or github_issue_id ~ '^[0-9]+$'),
  drop constraint if exists investigation_states_trigger_comment_id_digits,
  add constraint investigation_states_trigger_comment_id_digits
    check (triggering_comment_id is null or triggering_comment_id ~ '^[0-9]+$'),
  drop constraint if exists investigation_states_trigger_actor_id_digits,
  add constraint investigation_states_trigger_actor_id_digits
    check (
      triggered_by_github_user_id is null
      or triggered_by_github_user_id ~ '^[0-9]+$'
    );

alter table public.investigation_states
  drop constraint investigation_states_pkey,
  add constraint investigation_states_pkey primary key (id),
  add constraint investigation_states_investigation_id_key
    unique (investigation_id);

-- NOT VALID permits legacy aggregate rows that predate installation and
-- repository snapshots. PostgreSQL still enforces these constraints for every
-- new or changed row. Operators may validate after reconciliation/backfill.
alter table public.investigation_states
  add constraint investigation_states_installation_id_fkey
    foreign key (installation_id)
    references public.github_installations (installation_id)
    not valid,
  add constraint investigation_states_installation_repository_fkey
    foreign key (installation_id, repository_id)
    references public.installation_repositories (installation_id, repository_id)
    not valid;

create unique index if not exists investigation_states_trigger_comment_key
  on public.investigation_states (installation_id, triggering_comment_id)
  where installation_id is not null and triggering_comment_id is not null;

create index if not exists investigation_states_repository_issue_idx
  on public.investigation_states
    (repository_id, issue_number, created_at desc);

create index if not exists investigation_states_installation_status_idx
  on public.investigation_states
    (installation_id, status, updated_at desc);

create index if not exists investigation_states_installation_repo_issue_idx
  on public.investigation_states
    (installation_id, repository_id, issue_number, created_at desc);

-- Advance an optimistic-read version whenever the aggregate changes.
create or replace function public.investigation_states_touch_db_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.db_updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;

-- --- Append-only lifecycle events --------------------------------------------

create table public.investigation_events (
  id bigint generated always as identity primary key,
  investigation_id uuid not null
    references public.investigation_states (id) on delete cascade,
  event_type text not null
    check (
      event_type in (
        'created',
        'stage_changed',
        'reproduction',
        'fixer_attempts',
        'repository_validation',
        'regression_proof',
        'pull_request',
        'final_outcome',
        'terminal_comment',
        'error'
      )
    ),
  stage_key text
    check (
      stage_key is null
      or stage_key in (
        'open_preview',
        'reproduce',
        'diagnose',
        'apply_fix',
        'verify',
        'open_pr'
      )
    ),
  stage_status text
    check (
      stage_status is null
      or stage_status in ('pending', 'active', 'completed', 'failed', 'skipped')
    ),
  message text,
  occurred_at timestamptz not null,
  dedupe_key text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index investigation_events_dedupe_idx
  on public.investigation_events (investigation_id, dedupe_key)
  where dedupe_key is not null;

create index investigation_events_investigation_id_idx
  on public.investigation_events (investigation_id, id);

create index investigation_events_occurred_at_idx
  on public.investigation_events (investigation_id, occurred_at);

alter table public.investigation_events enable row level security;

-- --- Terminal result and exact diff metadata ---------------------------------

create table public.investigation_results (
  investigation_id uuid primary key
    references public.investigation_states (id) on delete cascade,
  report_version integer not null default 1
    check (report_version > 0),
  summary text,
  root_cause text,
  fix_outcome text,
  fix_reason text,
  changed_files text[] not null default '{}'::text[],
  verified_fix_attempt_id text,
  source_commit_sha text,
  diff_preview text,
  diff_truncated boolean not null default false,
  diff_sha256 text,
  diff_size_bytes bigint
    check (diff_size_bytes is null or diff_size_bytes >= 0),
  diff_bucket text,
  diff_object_path text,
  report jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint investigation_results_diff_preview_limit
    check (diff_preview is null or octet_length(diff_preview) <= 262144),
  constraint investigation_results_diff_object_pair
    check (
      (diff_bucket is null and diff_object_path is null)
      or (diff_bucket is not null and diff_object_path is not null)
    )
);

alter table public.investigation_results enable row level security;

create trigger investigation_results_touch_updated_at
  before update on public.investigation_results
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- --- Replay, screenshot, and poster metadata ---------------------------------

create table public.investigation_media (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null
    references public.investigation_states (id) on delete cascade,
  phase text not null
    check (phase in ('before', 'after', 'comparison')),
  kind text not null
    check (kind in ('video', 'screenshot', 'poster')),
  status text not null
    check (status in ('pending', 'ready', 'unavailable', 'error')),
  ordinal integer not null default 0
    check (ordinal >= 0),
  title text,
  bucket text,
  object_path text,
  mime_type text,
  byte_size bigint
    check (byte_size is null or byte_size >= 0),
  width integer
    check (width is null or width > 0),
  height integer
    check (height is null or height > 0),
  duration_ms integer
    check (duration_ms is null or duration_ms >= 0),
  sha256 text,
  captured_at timestamptz,
  error text,
  retention_expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint investigation_media_object_pair
    check (
      (bucket is null and object_path is null)
      or (bucket is not null and object_path is not null)
    ),
  unique (investigation_id, phase, kind, ordinal)
);

create index investigation_media_investigation_phase_idx
  on public.investigation_media (investigation_id, phase, ordinal);

create index investigation_media_retention_idx
  on public.investigation_media (retention_expires_at)
  where deleted_at is null and retention_expires_at is not null;

alter table public.investigation_media enable row level security;

create trigger investigation_media_touch_updated_at
  before update on public.investigation_media
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- --- Durable GitHub PR/comment delivery recovery -----------------------------

create table public.investigation_deliveries (
  investigation_id uuid primary key
    references public.investigation_states (id) on delete cascade,
  execution_outcome text,
  fix_verified boolean not null default false,
  fix_attempt_id text,
  pr_status text not null default 'not_applicable'
    check (
      pr_status in (
        'not_applicable',
        'pending',
        'created',
        'reused',
        'merged',
        'blocked',
        'failed'
      )
    ),
  branch_pushed boolean not null default false,
  branch text,
  base_branch text,
  github_pull_request_id text
    check (
      github_pull_request_id is null
      or github_pull_request_id ~ '^[0-9]+$'
    ),
  pr_number integer,
  pr_title text,
  pr_url text,
  pr_reason text,
  retry_payload_bucket text,
  retry_payload_path text,
  retry_payload_sha256 text,
  terminal_payload_bucket text,
  terminal_payload_path text,
  terminal_payload_sha256 text,
  terminal_comment_status text not null default 'pending'
    check (terminal_comment_status in ('pending', 'posted', 'failed')),
  terminal_comment_id text
    check (terminal_comment_id is null or terminal_comment_id ~ '^[0-9]+$'),
  terminal_create_attempted_at timestamptz,
  terminal_posted_at timestamptz,
  terminal_reason text,
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  state jsonb,
  terminal_failure jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint investigation_deliveries_retry_object_pair
    check (
      (retry_payload_bucket is null and retry_payload_path is null)
      or (retry_payload_bucket is not null and retry_payload_path is not null)
    ),
  constraint investigation_deliveries_terminal_object_pair
    check (
      (terminal_payload_bucket is null and terminal_payload_path is null)
      or (
        terminal_payload_bucket is not null
        and terminal_payload_path is not null
      )
    )
);

create index investigation_deliveries_retry_idx
  on public.investigation_deliveries (next_retry_at)
  where next_retry_at is not null;

alter table public.investigation_deliveries enable row level security;

create trigger investigation_deliveries_touch_updated_at
  before update on public.investigation_deliveries
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- --- Private artifact storage -------------------------------------------------

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'sherlock-artifacts',
  'sherlock-artifacts',
  false,
  209715200,
  array[
    'application/json',
    'application/octet-stream',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'text/x-diff',
    'video/mp4',
    'video/webm'
  ]::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Service-role only. No storage.objects policies are intentionally created.
