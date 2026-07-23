-- Recovery and rollout hardening for the dashboard data platform.
--
-- Investigation commands are permanent idempotency/outbox records. They are
-- deliberately not foreign-keyed to investigation_states: product retention
-- may delete a finished investigation, but the originating GitHub comment
-- must never become eligible to execute again.

create table public.investigation_commands (
  id uuid primary key default gen_random_uuid(),
  installation_id text not null
    check (installation_id ~ '^[0-9]+$'),
  triggering_comment_id text not null
    check (triggering_comment_id ~ '^[0-9]+$'),
  investigation_id text not null
    check (investigation_id ~ '^inv_[0-9A-Z]{10,}$'),
  queue_job_id text,
  queue_status text not null default 'pending'
    check (queue_status in ('pending', 'enqueued')),
  job_payload jsonb,
  last_enqueue_attempt_at timestamptz,
  enqueued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (installation_id, triggering_comment_id),
  unique (investigation_id),
  constraint investigation_commands_pending_payload
    check (
      (queue_status = 'pending' and jsonb_typeof(job_payload) = 'object')
      or (queue_status = 'enqueued' and job_payload is null)
    )
);

create index investigation_commands_pending_idx
  on public.investigation_commands (created_at, id)
  where queue_status = 'pending';

alter table public.investigation_commands enable row level security;

create trigger investigation_commands_touch_updated_at
  before update on public.investigation_commands
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- Existing dashboard rows already passed through the old queue path. Preserve
-- them as permanent enqueued claims before retention can remove the parent.
insert into public.investigation_commands (
  installation_id,
  triggering_comment_id,
  investigation_id,
  queue_status,
  job_payload,
  enqueued_at,
  created_at
)
select
  installation_id,
  triggering_comment_id,
  investigation_id,
  'enqueued',
  null,
  coalesce(started_at, created_at, inserted_at, now()),
  coalesce(created_at, inserted_at, now())
from public.investigation_states
where installation_id is not null
  and triggering_comment_id is not null
on conflict do nothing;

-- Add this only after the legacy backfill. NOT VALID exempts rows that
-- already exist when the constraint is added, but would still reject orphaned
-- rows inserted after it. Reconciliation creates the missing parents before
-- the guarded validation function certifies the constraint.
alter table public.investigation_commands
  add constraint investigation_commands_installation_id_fkey
    foreign key (installation_id)
    references public.github_installations (installation_id)
    not valid;

-- Atomically create the permanent command, canonical investigation projection,
-- and initial lifecycle event. A concurrent/redelivered command receives the
-- original public id and either resumes its pending enqueue or is classified
-- as an already-enqueued duplicate.
create or replace function public.claim_dashboard_investigation(
  p_installation_id text,
  p_triggering_comment_id text,
  p_investigation_id text,
  p_job_payload jsonb,
  p_repository jsonb,
  p_state jsonb,
  p_event jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_command public.investigation_commands%rowtype;
  v_internal_id uuid;
begin
  insert into public.investigation_commands (
    installation_id,
    triggering_comment_id,
    investigation_id,
    queue_status,
    job_payload
  )
  values (
    p_installation_id,
    p_triggering_comment_id,
    p_investigation_id,
    'pending',
    p_job_payload
  )
  on conflict (installation_id, triggering_comment_id) do nothing
  returning * into v_command;

  if v_command.id is null then
    select *
      into v_command
      from public.investigation_commands
     where installation_id = p_installation_id
       and triggering_comment_id = p_triggering_comment_id;

    if v_command.id is null then
      raise exception
        'Investigation id already belongs to a different webhook command';
    end if;

    return jsonb_build_object(
      'created', false,
      'investigation_id', v_command.investigation_id,
      'should_enqueue', v_command.queue_status = 'pending',
      'job_payload', v_command.job_payload
    );
  end if;

  -- Only a genuinely new, verified webhook command may refresh repository
  -- membership. A delayed redelivery of an old command must not reactivate a
  -- repository that a later installation event marked removed.
  insert into public.installation_repositories (
    installation_id,
    repository_id,
    owner_login,
    name,
    full_name,
    private,
    status,
    removed_at
  )
  values (
    p_installation_id,
    p_repository->>'repository_id',
    p_repository->>'owner_login',
    p_repository->>'name',
    p_repository->>'full_name',
    (p_repository->>'private')::boolean,
    'active',
    null
  )
  on conflict (installation_id, repository_id) do update
  set
    owner_login = excluded.owner_login,
    name = excluded.name,
    full_name = excluded.full_name,
    private = excluded.private,
    status = 'active',
    removed_at = null;

  insert into public.investigation_states (
    investigation_id,
    tenant_id,
    installation_id,
    repository_id,
    github_issue_id,
    triggering_comment_id,
    triggered_by_github_user_id,
    repo_owner,
    repo_name,
    issue_number,
    issue_title,
    issue_url,
    source_commit_sha,
    status,
    stage,
    outcome,
    created_at,
    started_at,
    updated_at,
    finished_at,
    record,
    retention_expires_at
  )
  values (
    p_investigation_id,
    p_state->>'tenant_id',
    p_installation_id,
    p_state->>'repository_id',
    p_state->>'github_issue_id',
    p_triggering_comment_id,
    p_state->>'triggered_by_github_user_id',
    p_state->>'repo_owner',
    p_state->>'repo_name',
    (p_state->>'issue_number')::integer,
    p_state->>'issue_title',
    p_state->>'issue_url',
    p_state->>'source_commit_sha',
    p_state->>'status',
    p_state->>'stage',
    nullif(p_state->>'outcome', ''),
    (p_state->>'created_at')::timestamptz,
    (p_state->>'started_at')::timestamptz,
    (p_state->>'updated_at')::timestamptz,
    nullif(p_state->>'finished_at', '')::timestamptz,
    p_state->'record',
    (p_state->>'retention_expires_at')::timestamptz
  )
  returning id into v_internal_id;

  insert into public.investigation_events (
    investigation_id,
    event_type,
    stage_key,
    stage_status,
    message,
    occurred_at,
    dedupe_key,
    details
  )
  values (
    v_internal_id,
    'created',
    'open_preview',
    'active',
    'Investigation queued.',
    (p_event->>'occurred_at')::timestamptz,
    'created',
    p_event->'details'
  );

  return jsonb_build_object(
    'created', true,
    'investigation_id', p_investigation_id,
    'should_enqueue', true,
    'job_payload', p_job_payload
  );
end;
$$;

revoke execute on function public.claim_dashboard_investigation(
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) from public, anon, authenticated;
grant execute on function public.claim_dashboard_investigation(
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) to service_role;

create or replace function public.mark_dashboard_investigation_enqueued(
  p_installation_id text,
  p_triggering_comment_id text,
  p_investigation_id text,
  p_queue_job_id text
)
returns boolean
language plpgsql
as $$
declare
  v_updated integer;
begin
  update public.investigation_commands
     set queue_status = 'enqueued',
         queue_job_id = p_queue_job_id,
         job_payload = null,
         last_enqueue_attempt_at = now(),
         enqueued_at = coalesce(enqueued_at, now())
   where installation_id = p_installation_id
     and triggering_comment_id = p_triggering_comment_id
     and investigation_id = p_investigation_id;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke execute on function public.mark_dashboard_investigation_enqueued(
  text,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.mark_dashboard_investigation_enqueued(
  text,
  text,
  text,
  text
) to service_role;

-- Read-only reconciliation audit plus a guarded validator. The validator will
-- not certify either NOT VALID foreign key while any legacy row is unmatched.
create or replace function public.dashboard_data_reconciliation_status()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'missing_installations',
    (
      select count(*)
        from public.investigation_states s
        left join public.github_installations i
          on i.installation_id = s.installation_id
       where s.installation_id is not null
         and i.installation_id is null
    ),
    'missing_repositories',
    (
      select count(*)
        from public.investigation_states s
        left join public.installation_repositories r
          on r.installation_id = s.installation_id
         and r.repository_id = s.repository_id
       where s.installation_id is not null
         and s.repository_id is not null
         and r.repository_id is null
    ),
    'missing_command_installations',
    (
      select count(*)
        from public.investigation_commands c
        left join public.github_installations i
          on i.installation_id = c.installation_id
       where i.installation_id is null
    ),
    'pending_enqueues',
    (
      select count(*)
        from public.investigation_commands
       where queue_status = 'pending'
    )
  );
$$;

revoke execute on function public.dashboard_data_reconciliation_status()
  from public, anon, authenticated;
grant execute on function public.dashboard_data_reconciliation_status()
  to service_role;

create or replace function public.validate_dashboard_data_foreign_keys()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status jsonb;
begin
  v_status := public.dashboard_data_reconciliation_status();
  if (v_status->>'missing_installations')::bigint <> 0
     or (v_status->>'missing_repositories')::bigint <> 0
     or (v_status->>'missing_command_installations')::bigint <> 0 then
    raise exception
      'Dashboard foreign keys cannot be validated before reconciliation: %',
      v_status;
  end if;

  alter table public.investigation_states
    validate constraint investigation_states_installation_id_fkey;
  alter table public.investigation_states
    validate constraint investigation_states_installation_repository_fkey;
  alter table public.investigation_commands
    validate constraint investigation_commands_installation_id_fkey;
end;
$$;

revoke execute on function public.validate_dashboard_data_foreign_keys()
  from public, anon, authenticated;
grant execute on function public.validate_dashboard_data_foreign_keys()
  to service_role;
