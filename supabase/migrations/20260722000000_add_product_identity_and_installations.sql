-- Sherlock SaaS identity and GitHub App installation domain (additive).
--
-- Written ONLY by the Sherlock backend using the service role key. Row Level
-- Security is ENABLED on every table with NO client policies: anon and
-- authenticated roles can neither read nor write anything here. Do NOT add
-- public/anon/authenticated read policies — the backend API is the only
-- access path and it enforces membership scoping itself.
--
-- GitHub numeric ids are stored as text with digit-only constraints so they
-- are never coerced through a lossy JavaScript number.
--
-- This migration is additive: it does not modify investigation_states, the
-- replay-evidence bucket, or any earlier migration.

-- Shared updated_at touch trigger for the product tables. Uniquely named so
-- it can never collide with the existing investigation_states trigger
-- function (which touches db_updated_at and is left untouched).
create or replace function public.sherlock_product_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.sherlock_product_touch_updated_at()
  from public, anon, authenticated;

-- --- profiles ---------------------------------------------------------------
-- One row per Supabase auth user; keyed by auth.users(id). The immutable
-- GitHub identity key is github_user_id; login/avatar are mutable snapshots.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  github_user_id text not null unique
    check (github_user_id ~ '^[0-9]+$'),
  github_login text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- --- github_installations ---------------------------------------------------
-- Snapshot of each GitHub App installation. Rows are never deleted: GitHub
-- removing an installation marks status = 'deleted' and sets deleted_at.

create table if not exists public.github_installations (
  installation_id text primary key
    check (installation_id ~ '^[0-9]+$'),
  account_id text not null
    check (account_id ~ '^[0-9]+$'),
  account_login text not null,
  account_type text not null
    check (account_type in ('User', 'Organization')),
  account_avatar_url text,
  repository_selection text not null
    check (repository_selection in ('all', 'selected')),
  status text not null
    check (status in ('active', 'suspended', 'deleted')),
  permissions jsonb not null default '{}'::jsonb,
  created_by_github_user_id text
    check (created_by_github_user_id is null or created_by_github_user_id ~ '^[0-9]+$'),
  suspended_at timestamptz,
  deleted_at timestamptz,
  last_github_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists github_installations_account_id_idx
  on public.github_installations (account_id);

create index if not exists github_installations_status_idx
  on public.github_installations (status);

alter table public.github_installations enable row level security;

drop trigger if exists github_installations_touch_updated_at
  on public.github_installations;
create trigger github_installations_touch_updated_at
  before update on public.github_installations
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- --- user_installations -----------------------------------------------------
-- Verified user ↔ installation membership. This milestone only ever creates
-- installer membership from verified ownership; organization members do NOT
-- get automatic rows.

create table if not exists public.user_installations (
  user_id uuid not null references public.profiles (id) on delete cascade,
  installation_id text not null
    references public.github_installations (installation_id),
  relationship text not null default 'installer'
    check (relationship in ('installer')),
  verification_method text not null
    check (verification_method in ('personal_account_match', 'installation_webhook_sender')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, installation_id)
);

create index if not exists user_installations_installation_id_idx
  on public.user_installations (installation_id);

alter table public.user_installations enable row level security;

drop trigger if exists user_installations_touch_updated_at
  on public.user_installations;
create trigger user_installations_touch_updated_at
  before update on public.user_installations
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- --- installation_repositories ----------------------------------------------
-- Repository snapshots per installation. Removed repositories are marked, not
-- deleted, so history stays intact.

create table if not exists public.installation_repositories (
  installation_id text not null
    references public.github_installations (installation_id),
  repository_id text not null
    check (repository_id ~ '^[0-9]+$'),
  owner_login text not null,
  name text not null,
  full_name text not null,
  private boolean not null,
  status text not null
    check (status in ('active', 'removed')),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (installation_id, repository_id)
);

create index if not exists installation_repositories_installation_status_idx
  on public.installation_repositories (installation_id, status);

alter table public.installation_repositories enable row level security;

drop trigger if exists installation_repositories_touch_updated_at
  on public.installation_repositories;
create trigger installation_repositories_touch_updated_at
  before update on public.installation_repositories
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- --- github_installation_nonces ---------------------------------------------
-- One-time installation-onboarding state. Binds an authenticated user to a
-- later GitHub setup callback without any cross-domain browser cookie. Only
-- the SHA-256 hash of the state is ever stored; the raw value never persists.

create table if not exists public.github_installation_nonces (
  id uuid primary key default gen_random_uuid(),
  nonce_hash text not null unique,
  user_id uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  installation_id text
    check (installation_id is null or installation_id ~ '^[0-9]+$'),
  claim_status text not null default 'unclaimed'
    check (claim_status in ('unclaimed', 'pending_webhook', 'verified', 'rejected', 'expired', 'superseded')),
  verification_method text
    check (verification_method is null
           or verification_method in ('personal_account_match', 'installation_webhook_sender')),
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists github_installation_nonces_user_id_idx
  on public.github_installation_nonces (user_id);

create index if not exists github_installation_nonces_installation_id_idx
  on public.github_installation_nonces (installation_id);

create index if not exists github_installation_nonces_expires_at_idx
  on public.github_installation_nonces (expires_at);

-- Pending organization claims are looked up by installation id when the
-- installation.created webhook arrives.
create index if not exists github_installation_nonces_pending_idx
  on public.github_installation_nonces (installation_id)
  where claim_status = 'pending_webhook';

alter table public.github_installation_nonces enable row level security;

drop trigger if exists github_installation_nonces_touch_updated_at
  on public.github_installation_nonces;
create trigger github_installation_nonces_touch_updated_at
  before update on public.github_installation_nonces
  for each row
  execute function public.sherlock_product_touch_updated_at();

-- --- Atomic nonce consumption ------------------------------------------------
-- Exactly-once semantics under concurrent callbacks: the UPDATE ... WHERE
-- consumed_at IS NULL is atomic, so of two racing calls only one receives the
-- row; the loser sees 'not_found' (indistinguishable from an unknown hash on
-- purpose). Expired and superseded nonces are consumed but reported as such.
-- Service-role only: execute is revoked from client roles below.

create or replace function public.consume_github_installation_nonce(p_nonce_hash text)
returns jsonb
language plpgsql
as $$
declare
  v_nonce public.github_installation_nonces%rowtype;
begin
  update public.github_installation_nonces
     set consumed_at = now()
   where nonce_hash = p_nonce_hash
     and consumed_at is null
  returning * into v_nonce;

  if v_nonce.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_nonce.claim_status = 'superseded' then
    return jsonb_build_object('outcome', 'superseded');
  end if;

  if v_nonce.expires_at <= now() then
    update public.github_installation_nonces
       set claim_status = 'expired'
     where id = v_nonce.id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  return jsonb_build_object('outcome', 'consumed', 'nonce', to_jsonb(v_nonce));
end;
$$;

revoke execute on function public.consume_github_installation_nonce(text)
  from public, anon, authenticated;
