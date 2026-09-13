-- =============================================================================
-- Ingestion: engagement events, the import queue, and the SQL half of the
-- loader. Parsing and row validation happen in the `process-imports` Edge
-- Function (supabase/functions/_shared/ingest); these functions do the
-- idempotent, brand-scoped writes and keep the run's counters honest.
-- =============================================================================

create table public.engagement_events (
  id bigint generated always as identity primary key,
  brand_id uuid not null references public.brands (id),
  source text not null check (source in ('seed', 'provider')),
  event_id text not null,
  contact_id bigint not null,
  campaign_id bigint,
  send_id uuid,
  type text not null check (type in ('delivered', 'open', 'click', 'bounce', 'unsubscribe', 'complaint')),
  channel text not null check (channel in ('email', 'sms')),
  occurred_at timestamptz not null,
  import_run_id bigint,
  received_at timestamptz not null default now(),
  unique (brand_id, source, event_id),
  foreign key (brand_id, contact_id) references public.contacts (brand_id, id),
  foreign key (brand_id, campaign_id) references public.campaigns (brand_id, id)
);
create index engagement_events_campaign_idx on public.engagement_events (brand_id, campaign_id, type, contact_id);
create index engagement_events_contact_idx on public.engagement_events (brand_id, contact_id);
create index engagement_events_send_idx on public.engagement_events (send_id) where send_id is not null;

alter table public.engagement_events enable row level security;
alter table public.engagement_events force row level security;
create policy engagement_events_select_own_brand on public.engagement_events
  for select to authenticated using (brand_id = (select private.current_brand_id()));
grant select on public.engagement_events to authenticated;

-- Contactability follows what actually happened, whatever path inserted the
-- event. Signals only move earlier, so arrival order cannot un-unsubscribe
-- anyone. Unsubscribes and complaints on any channel are treated as a
-- marketing opt-out from the brand; only email bounces make email unreachable.
create or replace function private.apply_contact_signals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.contacts c
  set unsubscribed_at = least(c.unsubscribed_at, s.unsubscribed_at),
      complained_at = least(c.complained_at, s.complained_at),
      bounced_at = least(c.bounced_at, s.bounced_at),
      updated_at = now()
  from (
    select n.brand_id, n.contact_id,
      min(n.occurred_at) filter (where n.type = 'unsubscribe') as unsubscribed_at,
      min(n.occurred_at) filter (where n.type = 'complaint') as complained_at,
      min(n.occurred_at) filter (where n.type = 'bounce' and n.channel = 'email') as bounced_at
    from new_rows n
    where n.type in ('unsubscribe', 'complaint', 'bounce')
    group by n.brand_id, n.contact_id
  ) s
  where c.brand_id = s.brand_id
    and c.id = s.contact_id
    and (
      s.unsubscribed_at < coalesce(c.unsubscribed_at, 'infinity')
      or s.complained_at < coalesce(c.complained_at, 'infinity')
      or s.bounced_at < coalesce(c.bounced_at, 'infinity')
    );
  return null;
end;
$$;

create trigger engagement_events_apply_signals
  after insert on public.engagement_events
  referencing new table as new_rows
  for each statement execute function private.apply_contact_signals();

-- -----------------------------------------------------------------------------
-- Storage bucket for uploads: `<brand_id>/<uuid>-<file name>`
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('imports', 'imports', false, 52428800)
on conflict (id) do nothing;

create policy imports_owner_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'imports'
    and (storage.foldername(name))[1] = (select private.current_brand_id())::text
    and (select private.current_member_role()) = 'owner'
  );

create policy imports_member_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'imports'
    and (storage.foldername(name))[1] = (select private.current_brand_id())::text
  );

-- -----------------------------------------------------------------------------
-- Queue an uploaded file (owners only)
-- -----------------------------------------------------------------------------
create or replace function public.request_import(p_storage_path text, p_file_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand uuid := private.require_owner();
  v_id bigint;
begin
  if p_storage_path is null or split_part(p_storage_path, '/', 1) <> v_brand::text then
    raise exception 'The file must be uploaded into your own brand folder.' using errcode = '22023';
  end if;
  if p_file_name is null or length(btrim(p_file_name)) = 0 or length(p_file_name) > 255 then
    raise exception 'A file name is required.' using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'imports' and o.name = p_storage_path) then
    raise exception 'Uploaded file not found.' using errcode = '22023';
  end if;

  insert into public.import_runs (brand_id, file_name, storage_path, requested_by)
  values (v_brand, btrim(p_file_name), p_storage_path, (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.request_import(text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Worker-side functions (service role only)
-- -----------------------------------------------------------------------------
create or replace function public.claim_import_run()
returns public.import_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.import_runs;
begin
  select * into v_run
  from public.import_runs r
  where r.status = 'queued'
     or (r.status = 'processing' and r.locked_at < now() - interval '3 minutes')
  order by r.created_at
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.import_runs
  set status = 'processing', locked_at = now(), started_at = coalesce(started_at, now())
  where id = v_run.id
  returning * into v_run;
  return v_run;
end;
$$;

create or replace function public.update_import_progress(
  p_run_id bigint, p_kind text, p_rows_total integer, p_cursor_row integer
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.import_runs
  set kind = coalesce(p_kind, kind),
      rows_total = p_rows_total,
      cursor_row = p_cursor_row,
      rows_processed = p_cursor_row,
      locked_at = now()
  where id = p_run_id;
$$;

create or replace function public.record_import_issues(p_run_id bigint, p_issues jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand uuid;
begin
  select brand_id into v_brand from public.import_runs where id = p_run_id;
  if v_brand is null or p_issues is null or jsonb_array_length(p_issues) = 0 then
    return;
  end if;

  insert into public.import_issues (brand_id, import_run_id, row_number, severity, reason_code, message, raw)
  select v_brand, p_run_id, i.row_number, i.severity, i.reason_code, i.message, left(i.raw, 2000)
  from jsonb_to_recordset(p_issues) as i(row_number integer, severity text, reason_code text, message text, raw text);

  update public.import_runs r
  set rows_rejected = r.rows_rejected + (select count(*) from jsonb_array_elements(p_issues) e where e ->> 'severity' = 'rejected'),
      rows_warned = r.rows_warned + (select count(distinct (e ->> 'row_number')) from jsonb_array_elements(p_issues) e where e ->> 'severity' = 'warning')
  where r.id = p_run_id;
end;
$$;

create or replace function public.finish_import_run(p_run_id bigint, p_status text, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.import_runs;
  v_final text := p_status;
  v_message text := p_message;
begin
  select * into v_run from public.import_runs where id = p_run_id;

  if v_run.kind = 'campaigns' and p_status = 'completed' then
    -- Resolve parent references inside the brand only; anything else is reported.
    update public.campaigns c
    set parent_campaign_id = p.id
    from public.campaigns p
    where c.brand_id = v_run.brand_id
      and p.brand_id = c.brand_id
      and p.external_id = c.parent_external_id
      and c.parent_campaign_id is distinct from p.id;

    insert into public.import_issues (brand_id, import_run_id, row_number, severity, reason_code, message, raw)
    select c.brand_id, p_run_id, null, 'warning', 'unknown_parent_campaign',
      format('Campaign %s references parent %s, which is not a campaign of this brand. The link was not stored.',
             c.external_id, c.parent_external_id),
      null
    from public.campaigns c
    where c.brand_id = v_run.brand_id
      and c.last_import_run_id = p_run_id
      and c.parent_external_id is not null
      and c.parent_campaign_id is null;
  end if;

  -- A file where nothing belonged to this brand stored nothing: say so.
  if p_status = 'completed' and v_run.rows_total > 0
     and v_run.rows_inserted + v_run.rows_updated + v_run.rows_unchanged = 0 then
    v_final := 'refused';
    v_message := coalesce(p_message, 'No row in this file could be loaded for your brand. Nothing was stored.');
  end if;

  update public.import_runs
  set status = v_final, status_message = v_message, finished_at = now(), locked_at = null,
      rows_processed = case when v_final = 'completed' then rows_total else rows_processed end
  where id = p_run_id;
end;
$$;

-- Contacts: upsert by (brand, external_id). Identical rows are left untouched,
-- so loading the same export twice reports them as unchanged, not new.
create or replace function public.ingest_contacts(p_run_id bigint, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_total integer := jsonb_array_length(p_rows);
begin
  select brand_id into v_brand from public.import_runs where id = p_run_id;
  if v_brand is null then
    raise exception 'Unknown import run %', p_run_id;
  end if;

  drop table if exists _rows;
  create temp table _rows on commit drop as
  select * from jsonb_to_recordset(p_rows) as r(
    row_number integer, external_id text, full_name text, email text, phone text, country text,
    city text, status text, consent_marketing boolean, signup_at timestamptz, deleted_at timestamptz,
    suppressed_until timestamptz, notes text, row_hash text
  );

  -- Same id seen earlier in this run with different content: last row wins, say so.
  insert into public.import_issues (brand_id, import_run_id, row_number, severity, reason_code, message, raw)
  select v_brand, p_run_id, r.row_number, 'warning', 'duplicate_external_id',
    format('Customer %s appears more than once in this file with different details; the later row was kept.', r.external_id),
    null
  from _rows r
  join public.contacts c on c.brand_id = v_brand and c.external_id = r.external_id
  where c.last_import_run_id = p_run_id and c.row_hash <> r.row_hash;

  with up as (
    insert into public.contacts as c (
      brand_id, external_id, full_name, email, phone, country, city, status, consent_marketing,
      signup_at, deleted_at, suppressed_until, notes, row_hash, last_import_run_id
    )
    select v_brand, r.external_id, r.full_name, r.email, r.phone, r.country, r.city, r.status,
      coalesce(r.consent_marketing, false), r.signup_at, r.deleted_at, r.suppressed_until, r.notes,
      r.row_hash, p_run_id
    from _rows r
    on conflict (brand_id, external_id) do update
    set full_name = excluded.full_name, email = excluded.email, phone = excluded.phone,
        country = excluded.country, city = excluded.city, status = excluded.status,
        consent_marketing = excluded.consent_marketing, signup_at = excluded.signup_at,
        deleted_at = excluded.deleted_at, suppressed_until = excluded.suppressed_until,
        notes = excluded.notes, row_hash = excluded.row_hash,
        last_import_run_id = excluded.last_import_run_id, updated_at = now()
    where c.row_hash is distinct from excluded.row_hash
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_inserted, v_updated
  from up;

  update public.import_runs
  set rows_inserted = rows_inserted + v_inserted,
      rows_updated = rows_updated + v_updated,
      rows_unchanged = rows_unchanged + (v_total - v_inserted - v_updated)
  where id = p_run_id;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'unchanged', v_total - v_inserted - v_updated);
end;
$$;

create or replace function public.ingest_campaigns(p_run_id bigint, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_total integer := jsonb_array_length(p_rows);
begin
  select brand_id into v_brand from public.import_runs where id = p_run_id;
  if v_brand is null then
    raise exception 'Unknown import run %', p_run_id;
  end if;

  drop table if exists _rows;
  create temp table _rows on commit drop as
  select * from jsonb_to_recordset(p_rows) as r(
    row_number integer, external_id text, name text, channel text, target_country text,
    reported_sent integer, reported_delivered integer, reported_bounced integer, reported_opens integer,
    reported_clicks integer, spend numeric, sent_at timestamptz, send_local_time text,
    parent_external_id text, row_hash text
  );

  insert into public.import_issues (brand_id, import_run_id, row_number, severity, reason_code, message, raw)
  select v_brand, p_run_id, r.row_number, 'warning', 'duplicate_external_id',
    format('Campaign %s appears more than once in this file with different details; the later row was kept.', r.external_id),
    null
  from _rows r
  join public.campaigns c on c.brand_id = v_brand and c.external_id = r.external_id
  where c.last_import_run_id = p_run_id and c.row_hash <> r.row_hash;

  with up as (
    insert into public.campaigns as c (
      brand_id, external_id, name, channel, target_country, reported_sent, reported_delivered,
      reported_bounced, reported_opens, reported_clicks, spend, sent_at, send_local_time,
      parent_external_id, row_hash, last_import_run_id
    )
    select v_brand, r.external_id, r.name, r.channel, r.target_country, r.reported_sent,
      r.reported_delivered, r.reported_bounced, r.reported_opens, r.reported_clicks, r.spend,
      r.sent_at, r.send_local_time, r.parent_external_id, r.row_hash, p_run_id
    from _rows r
    on conflict (brand_id, external_id) do update
    set name = excluded.name, channel = excluded.channel, target_country = excluded.target_country,
        reported_sent = excluded.reported_sent, reported_delivered = excluded.reported_delivered,
        reported_bounced = excluded.reported_bounced, reported_opens = excluded.reported_opens,
        reported_clicks = excluded.reported_clicks, spend = excluded.spend, sent_at = excluded.sent_at,
        send_local_time = excluded.send_local_time, parent_external_id = excluded.parent_external_id,
        parent_campaign_id = null, row_hash = excluded.row_hash,
        last_import_run_id = excluded.last_import_run_id, updated_at = now()
    where c.row_hash is distinct from excluded.row_hash
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_inserted, v_updated
  from up;

  update public.import_runs
  set rows_inserted = rows_inserted + v_inserted,
      rows_updated = rows_updated + v_updated,
      rows_unchanged = rows_unchanged + (v_total - v_inserted - v_updated)
  where id = p_run_id;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'unchanged', v_total - v_inserted - v_updated);
end;
$$;

-- Events from an export: only events whose customer AND campaign exist in this
-- brand are stored. Duplicate event ids are counted once.
create or replace function public.ingest_events(p_run_id bigint, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand uuid;
  v_inserted integer := 0;
  v_rejected integer := 0;
  v_total integer := jsonb_array_length(p_rows);
begin
  select brand_id into v_brand from public.import_runs where id = p_run_id;
  if v_brand is null then
    raise exception 'Unknown import run %', p_run_id;
  end if;

  drop table if exists _rows;
  create temp table _rows on commit drop as
  select r.*, c.id as contact_id, cp.id as campaign_id
  from jsonb_to_recordset(p_rows) as r(
    row_number integer, event_id text, contact_external_id text, campaign_external_id text,
    type text, channel text, occurred_at timestamptz, raw text
  )
  left join public.contacts c on c.brand_id = v_brand and c.external_id = r.contact_external_id
  left join public.campaigns cp on cp.brand_id = v_brand and cp.external_id = r.campaign_external_id;

  insert into public.import_issues (brand_id, import_run_id, row_number, severity, reason_code, message, raw)
  select v_brand, p_run_id, r.row_number, 'rejected',
    case when r.campaign_id is null then 'unknown_campaign' else 'unknown_contact' end,
    case when r.campaign_id is null
      then format('Event %s is for campaign %s, which is not a campaign of this brand.', r.event_id, r.campaign_external_id)
      else format('Event %s is for customer %s, who is not a customer of this brand.', r.event_id, r.contact_external_id)
    end,
    r.raw
  from _rows r
  where r.contact_id is null or r.campaign_id is null;
  get diagnostics v_rejected = row_count;

  insert into public.engagement_events (brand_id, source, event_id, contact_id, campaign_id, type, channel, occurred_at, import_run_id)
  select v_brand, 'seed', r.event_id, r.contact_id, r.campaign_id, r.type, r.channel, r.occurred_at, p_run_id
  from _rows r
  where r.contact_id is not null and r.campaign_id is not null
  on conflict (brand_id, source, event_id) do nothing;
  get diagnostics v_inserted = row_count;

  update public.import_runs
  set rows_inserted = rows_inserted + v_inserted,
      rows_unchanged = rows_unchanged + (v_total - v_inserted - v_rejected),
      rows_rejected = rows_rejected + v_rejected
  where id = p_run_id;

  return jsonb_build_object('inserted', v_inserted, 'rejected', v_rejected, 'unchanged', v_total - v_inserted - v_rejected);
end;
$$;

create or replace function public.ingest_send_log(p_run_id bigint, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_rejected integer := 0;
  v_total integer := jsonb_array_length(p_rows);
begin
  select brand_id into v_brand from public.import_runs where id = p_run_id;
  if v_brand is null then
    raise exception 'Unknown import run %', p_run_id;
  end if;

  drop table if exists _rows;
  create temp table _rows on commit drop as
  select distinct on (r.batch_key) r.*, cp.id as campaign_id
  from jsonb_to_recordset(p_rows) as r(
    row_number integer, batch_key text, campaign_external_id text, queued_at timestamptz,
    recipient_count integer, status text, raw text
  )
  left join public.campaigns cp on cp.brand_id = v_brand and cp.external_id = r.campaign_external_id
  order by r.batch_key, r.row_number desc;

  insert into public.import_issues (brand_id, import_run_id, row_number, severity, reason_code, message, raw)
  select v_brand, p_run_id, r.row_number, 'rejected', 'unknown_campaign',
    format('Send %s is for campaign %s, which is not a campaign of this brand.', r.batch_key, r.campaign_external_id),
    r.raw
  from _rows r where r.campaign_id is null;
  get diagnostics v_rejected = row_count;

  with up as (
    insert into public.historical_sends as h (brand_id, batch_key, campaign_id, queued_at, recipient_count, status, last_import_run_id)
    select v_brand, r.batch_key, r.campaign_id, r.queued_at, r.recipient_count, r.status, p_run_id
    from _rows r where r.campaign_id is not null
    on conflict (brand_id, batch_key) do update
    set campaign_id = excluded.campaign_id, queued_at = excluded.queued_at,
        recipient_count = excluded.recipient_count, status = excluded.status,
        last_import_run_id = excluded.last_import_run_id
    where (h.campaign_id, h.queued_at, h.recipient_count, h.status)
      is distinct from (excluded.campaign_id, excluded.queued_at, excluded.recipient_count, excluded.status)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted) into v_inserted, v_updated from up;

  update public.import_runs
  set rows_inserted = rows_inserted + v_inserted,
      rows_updated = rows_updated + v_updated,
      rows_unchanged = rows_unchanged + (v_total - v_inserted - v_updated - v_rejected),
      rows_rejected = rows_rejected + v_rejected
  where id = p_run_id;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'rejected', v_rejected);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'claim_import_run()',
    'update_import_progress(bigint, text, integer, integer)',
    'record_import_issues(bigint, jsonb)',
    'finish_import_run(bigint, text, text)',
    'ingest_contacts(bigint, jsonb)',
    'ingest_campaigns(bigint, jsonb)',
    'ingest_events(bigint, jsonb)',
    'ingest_send_log(bigint, jsonb)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
