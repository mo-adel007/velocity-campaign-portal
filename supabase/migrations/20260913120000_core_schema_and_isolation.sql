-- =============================================================================
-- Core schema, brand isolation and access control.
--
-- THE DATA-ISOLATION GUARANTEE LIVES HERE:
--   * every brand-owned table carries `brand_id not null`
--   * RLS is ENABLED and FORCED on every one of them
--   * the only read policy is `brand_id = (select private.current_brand_id())`,
--     where current_brand_id() resolves the caller's single brand membership
--   * no table grants anything to `anon`; `authenticated` gets SELECT only —
--     every write goes through a SECURITY DEFINER function that re-checks role
--   * cross-brand references are impossible at the FK level: child tables
--     reference (brand_id, id) composite keys, so a Karoo row cannot point at
--     a Kilele row even through the service role.
-- tests/isolation.test.ts fails if any of this is removed or a new brand table
-- is added without it.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Brands and membership
-- -----------------------------------------------------------------------------
create table public.brands (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z]+$'),
  name text not null,
  country_code char(2) not null,
  timezone text not null,
  created_at timestamptz not null default now()
);

insert into public.brands (code, name, country_code, timezone) values
  ('KILELE', 'Kilele Rides', 'KE', 'Africa/Nairobi'),
  ('KAROO', 'Karoo Coaches', 'ZA', 'Africa/Johannesburg'),
  ('MARRAKECH', 'Marrakech Express', 'MA', 'Africa/Casablanca');

-- Who may exist as a user at all. Not exposed through the API.
create table private.allowed_users (
  email text primary key check (email = lower(btrim(email))),
  brand_id uuid not null references public.brands (id),
  role text not null check (role in ('owner', 'analyst'))
);

-- One brand per user (primary key on user_id).
create table public.brand_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  brand_id uuid not null references public.brands (id),
  role text not null check (role in ('owner', 'analyst')),
  email text not null,
  created_at timestamptz not null default now()
);
create index brand_members_brand_id_idx on public.brand_members (brand_id);

create or replace function private.current_brand_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.brand_id from public.brand_members m where m.user_id = (select auth.uid());
$$;

create or replace function private.current_member_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.brand_members m where m.user_id = (select auth.uid());
$$;

-- Raises unless the caller is an owner; returns their brand.
create or replace function private.require_owner()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_brand uuid;
begin
  select m.brand_id into v_brand
  from public.brand_members m
  where m.user_id = (select auth.uid()) and m.role = 'owner';
  if v_brand is null then
    raise exception 'Only brand owners can do this.' using errcode = '42501';
  end if;
  return v_brand;
end;
$$;

grant usage on schema private to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.current_brand_id() to authenticated;
grant execute on function private.current_member_role() to authenticated;
grant execute on function private.require_owner() to authenticated;

-- Membership is created from the allowlist when an auth user is created.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.brand_members (user_id, brand_id, role, email)
  select new.id, a.brand_id, a.role, a.email
  from private.allowed_users a
  where a.email = lower(btrim(new.email))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- Before-user-created auth hook: refuses anyone not on the allowlist, for
-- every sign-in method (password, Google, magic link). Nobody else gets an
-- account at all.
create or replace function private.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(event -> 'user' ->> 'email'));
begin
  if v_email is null or not exists (select 1 from private.allowed_users a where a.email = v_email) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'This account is not authorised for the Velocity campaign portal.'
      )
    );
  end if;
  return '{}'::jsonb;
end;
$$;

grant usage on schema private to supabase_auth_admin;
grant execute on function private.hook_before_user_created(jsonb) to supabase_auth_admin;
grant select on private.allowed_users to supabase_auth_admin;
revoke execute on function private.hook_before_user_created(jsonb) from authenticated, anon, public;

-- -----------------------------------------------------------------------------
-- Imports
-- -----------------------------------------------------------------------------
create table public.import_runs (
  id bigint generated always as identity primary key,
  brand_id uuid not null references public.brands (id),
  kind text check (kind in ('contacts', 'campaigns', 'events', 'send_log')),
  file_name text not null,
  storage_path text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'refused', 'failed')),
  status_message text,
  requested_by uuid references auth.users (id),
  rows_total integer not null default 0,
  rows_processed integer not null default 0,
  rows_inserted integer not null default 0,
  rows_updated integer not null default 0,
  rows_unchanged integer not null default 0,
  rows_rejected integer not null default 0,
  rows_warned integer not null default 0,
  cursor_row integer not null default 0,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (brand_id, id)
);
create index import_runs_brand_created_idx on public.import_runs (brand_id, created_at desc);
create index import_runs_queue_idx on public.import_runs (status, created_at) where status in ('queued', 'processing');

create table public.import_issues (
  id bigint generated always as identity primary key,
  brand_id uuid not null,
  import_run_id bigint not null,
  row_number integer,
  severity text not null check (severity in ('rejected', 'warning')),
  reason_code text not null,
  message text not null,
  raw text,
  created_at timestamptz not null default now(),
  foreign key (brand_id, import_run_id) references public.import_runs (brand_id, id) on delete cascade
);
create index import_issues_run_idx on public.import_issues (import_run_id, severity, row_number);
create index import_issues_brand_idx on public.import_issues (brand_id);

-- -----------------------------------------------------------------------------
-- Contacts
-- -----------------------------------------------------------------------------
create table public.contacts (
  id bigint generated always as identity primary key,
  brand_id uuid not null references public.brands (id),
  external_id text not null check (external_id <> ''),
  full_name text,
  email text check (email is null or email = lower(btrim(email))),
  phone text,
  country char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  city text,
  status text not null check (status in ('active', 'pending', 'unsubscribed', 'bounced')),
  consent_marketing boolean not null default false,
  signup_at timestamptz,
  deleted_at timestamptz,
  suppressed_until timestamptz,
  notes text,
  -- Signals learned from engagement events (seed log or provider). Monotonic:
  -- once set they are only ever moved earlier, never cleared by a later open.
  unsubscribed_at timestamptz,
  complained_at timestamptz,
  bounced_at timestamptz,
  row_hash text not null,
  last_import_run_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, external_id),
  unique (brand_id, id)
);
create index contacts_brand_signup_idx on public.contacts (brand_id, signup_at);
create index contacts_brand_email_idx on public.contacts (brand_id, email);
create index contacts_brand_name_idx on public.contacts (brand_id, full_name, id);
create index contacts_email_trgm_idx on public.contacts using gin (email extensions.gin_trgm_ops);
create index contacts_name_trgm_idx on public.contacts using gin (full_name extensions.gin_trgm_ops);

-- Why a contact cannot be emailed, or null if contactable. Mutually exclusive
-- and ordered, so the dashboard breakdown always sums to the total.
create or replace function public.contact_block_reason(c public.contacts)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when c.deleted_at is not null then 'deleted'
    when c.email is null then 'invalid_email'
    when c.complained_at is not null then 'complained'
    when c.unsubscribed_at is not null or c.status = 'unsubscribed' then 'unsubscribed'
    when c.bounced_at is not null or c.status = 'bounced' then 'bounced'
    when not c.consent_marketing then 'no_consent'
    when c.status = 'pending' then 'pending'
    when c.suppressed_until is not null and c.suppressed_until > now() then 'suppressed'
    else null
  end;
$$;

-- -----------------------------------------------------------------------------
-- Campaigns and history
-- -----------------------------------------------------------------------------
create table public.campaigns (
  id bigint generated always as identity primary key,
  brand_id uuid not null references public.brands (id),
  external_id text not null check (external_id <> ''),
  name text not null,
  channel text not null check (channel in ('email', 'sms')),
  target_country char(2) check (target_country is null or target_country ~ '^[A-Z]{2}$'),
  reported_sent integer check (reported_sent >= 0),
  reported_delivered integer check (reported_delivered >= 0),
  reported_bounced integer check (reported_bounced >= 0),
  reported_opens integer check (reported_opens >= 0),
  reported_clicks integer check (reported_clicks >= 0),
  spend numeric(12, 2) check (spend >= 0),
  sent_at timestamptz,
  send_local_time text,
  parent_external_id text,
  parent_campaign_id bigint,
  row_hash text not null,
  last_import_run_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, external_id),
  unique (brand_id, id),
  foreign key (brand_id, parent_campaign_id) references public.campaigns (brand_id, id)
);
create index campaigns_parent_idx on public.campaigns (brand_id, parent_campaign_id);

create table public.historical_sends (
  id bigint generated always as identity primary key,
  brand_id uuid not null references public.brands (id),
  batch_key text not null,
  campaign_id bigint,
  queued_at timestamptz,
  recipient_count integer check (recipient_count >= 0),
  status text,
  last_import_run_id bigint,
  unique (brand_id, batch_key),
  foreign key (brand_id, campaign_id) references public.campaigns (brand_id, id)
);
create index historical_sends_campaign_idx on public.historical_sends (brand_id, campaign_id);

-- -----------------------------------------------------------------------------
-- Enable and FORCE RLS; brand-scoped read policy on every brand table.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, public;

alter table public.brands enable row level security;
alter table public.brands force row level security;
create policy brands_select_own on public.brands
  for select to authenticated
  using (id = (select private.current_brand_id()));
grant select on public.brands to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'brand_members', 'import_runs', 'import_issues', 'contacts', 'campaigns', 'historical_sends'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (brand_id = (select private.current_brand_id()))',
      t || '_select_own_brand', t
    );
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end;
$$;

grant execute on function public.contact_block_reason(public.contacts) to authenticated;
