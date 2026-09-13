-- =============================================================================
-- Email sends: preview, immutable approval, frozen recipients, single flight,
-- and the SQL half of the dispatch worker.
--
-- Guarantees:
--   * an approval (approver, time, audience rule, counts, recipient snapshot)
--     can never change or be deleted — triggers refuse it for every role;
--   * at most one in-flight send per campaign (partial unique index), and
--     concurrent confirms queue on the campaign row, so the second is told a
--     send is already in progress;
--   * recipients are deduplicated by email at approval ("N customers → M
--     addresses") and split into fixed chunks; each chunk has one provider
--     Idempotency-Key for life;
--   * late ineligibility (unsubscribe, bounce, changed email …) is decided once,
--     when a chunk is first claimed, and stored before the provider is called.
--     A retry re-sends exactly that stored list, so the provider's replay of the
--     key always matches what we recorded;
--   * a chunk that keeps failing ends as failed, with the reason on every
--     recipient, instead of holding the campaign in flight forever.
-- Custom SQLSTATEs for the app: VC403 not allowed, VC404 not found,
-- VC409 send in progress, VC422 cannot be sent as requested.
-- =============================================================================

create table public.sends (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id),
  campaign_id bigint not null,
  status text not null default 'dispatching' check (status in ('dispatching', 'completed')),
  -- No FK to auth.users: the approval must outlive the account that gave it.
  approved_by uuid not null,
  approved_by_email text not null,
  approved_at timestamptz not null default now(),
  audience_rule text not null,
  target_country char(2),
  customers_count integer not null check (customers_count > 0),
  addresses_count integer not null check (addresses_count > 0 and addresses_count <= customers_count),
  chunk_size integer not null check (chunk_size > 0),
  finished_at timestamptz,
  unique (brand_id, id),
  foreign key (brand_id, campaign_id) references public.campaigns (brand_id, id)
);
create unique index sends_one_in_flight_idx on public.sends (brand_id, campaign_id) where status = 'dispatching';
create index sends_campaign_idx on public.sends (brand_id, campaign_id, approved_at desc);

create table public.send_chunks (
  brand_id uuid not null,
  send_id uuid not null,
  chunk_no integer not null check (chunk_no >= 0),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  idempotency_key text not null unique,
  batch_id text unique,
  attempts integer not null default 0,
  locked_at timestamptz,
  last_error text,
  sent_at timestamptz,
  primary key (send_id, chunk_no),
  foreign key (brand_id, send_id) references public.sends (brand_id, id)
);
create index send_chunks_brand_idx on public.send_chunks (brand_id, send_id);
create index send_chunks_queue_idx on public.send_chunks (status) where status in ('pending', 'sending');

create table public.send_recipients (
  id bigint generated always as identity primary key,
  brand_id uuid not null,
  send_id uuid not null,
  chunk_no integer not null,
  email text not null,
  -- Every approved customer behind this address; recipient_id is what the provider sees.
  contact_ids bigint[] not null check (cardinality(contact_ids) > 0),
  recipient_id text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'suppressed', 'failed')),
  reason text,
  updated_at timestamptz not null default now(),
  unique (send_id, email),
  unique (send_id, recipient_id),
  foreign key (brand_id, send_id) references public.sends (brand_id, id),
  foreign key (send_id, chunk_no) references public.send_chunks (send_id, chunk_no)
);
create index send_recipients_brand_idx on public.send_recipients (brand_id, send_id, status);
create index send_recipients_chunk_idx on public.send_recipients (send_id, chunk_no, status);

do $$
declare
  t text;
begin
  foreach t in array array['sends', 'send_chunks', 'send_recipients'] loop
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

-- -----------------------------------------------------------------------------
-- Immutability of approvals
-- -----------------------------------------------------------------------------
create or replace function private.refuse_approval_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Approved sends are permanent and cannot be deleted.' using errcode = 'VC403';
  end if;
  -- Nested per table: PL/pgSQL resolves every field in an expression, even behind a false AND.
  case tg_table_name
    when 'sends' then
      if (
        new.brand_id, new.campaign_id, new.approved_by, new.approved_by_email, new.approved_at, new.audience_rule,
        new.target_country, new.customers_count, new.addresses_count, new.chunk_size
      ) is distinct from (
        old.brand_id, old.campaign_id, old.approved_by, old.approved_by_email, old.approved_at, old.audience_rule,
        old.target_country, old.customers_count, old.addresses_count, old.chunk_size
      ) then
        raise exception 'An approval cannot be changed.' using errcode = 'VC403';
      end if;
    when 'send_chunks' then
      if (new.brand_id, new.send_id, new.chunk_no, new.idempotency_key)
          is distinct from (old.brand_id, old.send_id, old.chunk_no, old.idempotency_key) then
        raise exception 'A send chunk cannot be reassigned.' using errcode = 'VC403';
      end if;
    when 'send_recipients' then
      if (new.brand_id, new.send_id, new.chunk_no, new.email, new.contact_ids, new.recipient_id)
          is distinct from (old.brand_id, old.send_id, old.chunk_no, old.email, old.contact_ids, old.recipient_id) then
        raise exception 'An approved recipient cannot be changed.' using errcode = 'VC403';
      end if;
  end case;
  return new;
end;
$$;

create trigger sends_immutable before update or delete on public.sends
  for each row execute function private.refuse_approval_change();
create trigger send_chunks_immutable before update or delete on public.send_chunks
  for each row execute function private.refuse_approval_change();
create trigger send_recipients_immutable before update or delete on public.send_recipients
  for each row execute function private.refuse_approval_change();

-- -----------------------------------------------------------------------------
-- Audience
-- -----------------------------------------------------------------------------
-- Contactable-by-email customers, filtered by the campaign's target country
-- (unknown countries are excluded when a target is set), one row per address.
create or replace function private.send_audience(p_brand_id uuid, p_target_country char(2))
returns table (email text, contact_ids bigint[], recipient_id text)
language sql
stable
set search_path = ''
as $$
  select c.email, array_agg(c.id order by c.id), min(c.external_id)
  from public.contacts c
  where c.brand_id = p_brand_id
    and public.contact_block_reason(c) is null
    and (p_target_country is null or c.country = p_target_country)
  group by c.email;
$$;

create or replace function private.audience_rule(p_target_country char(2))
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Contactable by email'
    || case when p_target_country is null then '' else ' in ' || p_target_country end
    || ': valid email, marketing consent, not deleted, unsubscribed, complained, bounced, pending or suppressed. '
    || 'One message per email address.';
$$;

-- Most recent send of any kind: this portal, the source file, or the seed send log.
create or replace function private.campaign_last_sent_at(p_brand_id uuid, p_campaign_id bigint)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select greatest(
    (select max(s.approved_at) from public.sends s where s.brand_id = p_brand_id and s.campaign_id = p_campaign_id),
    (select c.sent_at from public.campaigns c where c.brand_id = p_brand_id and c.id = p_campaign_id),
    (select max(h.queued_at) from public.historical_sends h where h.brand_id = p_brand_id and h.campaign_id = p_campaign_id)
  );
$$;

revoke execute on function private.send_audience(uuid, char) from public, anon, authenticated;
revoke execute on function private.audience_rule(char) from public, anon, authenticated;
revoke execute on function private.campaign_last_sent_at(uuid, bigint) from public, anon, authenticated;
revoke execute on function private.refuse_approval_change() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- What every member sees on the campaigns list (AC3.2)
-- -----------------------------------------------------------------------------
create or replace function public.campaigns_overview()
returns table (
  campaign_id bigint,
  external_id text,
  name text,
  channel text,
  target_country char(2),
  sent_at timestamptz,
  last_sent_at timestamptz,
  in_flight_send_id uuid,
  sendable boolean,
  not_sendable_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id, c.external_id, c.name, c.channel, c.target_country, c.sent_at,
    private.campaign_last_sent_at(c.brand_id, c.id),
    f.id,
    c.channel = 'email' and f.id is null,
    case
      when c.channel <> 'email' then 'SMS campaigns cannot be sent from this portal; it sends email only.'
      when f.id is not null then 'A send for this campaign is already in progress.'
    end
  from public.campaigns c
  left join public.sends f on f.brand_id = c.brand_id and f.campaign_id = c.id and f.status = 'dispatching'
  where c.brand_id = (select private.current_brand_id())
  order by c.sent_at desc nulls last, c.external_id;
$$;

-- -----------------------------------------------------------------------------
-- Owner: preview and confirm
-- -----------------------------------------------------------------------------
create or replace function public.preview_send(p_campaign_id bigint)
returns table (
  campaign_id bigint,
  name text,
  channel text,
  target_country char(2),
  audience_rule text,
  customers bigint,
  addresses bigint,
  last_sent_at timestamptz,
  in_flight_send_id uuid,
  sendable boolean,
  not_sendable_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_brand uuid := private.require_owner();
  v_campaign public.campaigns;
  v_in_flight uuid;
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id and c.brand_id = v_brand;
  if not found then
    raise exception 'Campaign not found.' using errcode = 'VC404';
  end if;
  select s.id into v_in_flight from public.sends s
  where s.brand_id = v_brand and s.campaign_id = v_campaign.id and s.status = 'dispatching';

  return query
  select
    v_campaign.id, v_campaign.name, v_campaign.channel, v_campaign.target_country,
    private.audience_rule(v_campaign.target_country),
    coalesce(sum(cardinality(a.contact_ids)), 0)::bigint,
    count(a.email),
    private.campaign_last_sent_at(v_brand, v_campaign.id),
    v_in_flight,
    v_campaign.channel = 'email' and v_in_flight is null and count(a.email) > 0,
    case
      when v_campaign.channel <> 'email' then 'SMS campaigns cannot be sent from this portal; it sends email only.'
      when v_in_flight is not null then 'A send for this campaign is already in progress.'
      when count(a.email) = 0 then 'Nobody in the audience can be emailed.'
    end
  from private.send_audience(v_brand, case when v_campaign.channel = 'email' then v_campaign.target_country end) a
  where v_campaign.channel = 'email';
end;
$$;

-- The addresses a confirm would message, page by page, in chunk order.
create or replace function public.preview_send_recipients(p_campaign_id bigint, p_limit integer default 100, p_offset integer default 0)
returns table (email text, recipient_id text, customers integer, contact_names text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_brand uuid := private.require_owner();
  v_campaign public.campaigns;
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id and c.brand_id = v_brand;
  if not found then
    raise exception 'Campaign not found.' using errcode = 'VC404';
  end if;
  if v_campaign.channel <> 'email' then
    return;
  end if;
  return query
  select a.email, a.recipient_id, cardinality(a.contact_ids),
    (select array_agg(coalesce(c.full_name, c.external_id) order by c.id)
     from public.contacts c where c.brand_id = v_brand and c.id = any (a.contact_ids))
  from private.send_audience(v_brand, v_campaign.target_country) a
  order by a.recipient_id
  limit least(greatest(p_limit, 1), 1000) offset greatest(p_offset, 0);
end;
$$;

-- Confirm: freezes the audience into an immutable send. p_expected_addresses is
-- the "M addresses" the owner saw; if the audience moved since, nothing is
-- created and the owner must review again.
create or replace function public.approve_send(p_campaign_id bigint, p_expected_addresses integer)
returns public.sends
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand uuid := private.require_owner();
  v_chunk_size constant integer := 250;
  v_campaign public.campaigns;
  v_email text;
  v_send public.sends;
  v_addresses integer;
begin
  -- Serialises concurrent confirms for this campaign.
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id and c.brand_id = v_brand for update;
  if not found then
    raise exception 'Campaign not found.' using errcode = 'VC404';
  end if;
  if v_campaign.channel <> 'email' then
    raise exception 'SMS campaigns cannot be sent from this portal; it sends email only.' using errcode = 'VC422';
  end if;
  if exists (select 1 from public.sends s where s.brand_id = v_brand and s.campaign_id = v_campaign.id and s.status = 'dispatching') then
    raise exception 'A send for this campaign is already in progress.' using errcode = 'VC409';
  end if;

  select m.email into v_email from public.brand_members m where m.user_id = (select auth.uid());

  create temporary table approve_audience on commit drop as
  select a.email, a.contact_ids, a.recipient_id,
    ((row_number() over (order by a.recipient_id) - 1) / v_chunk_size)::integer as chunk_no
  from private.send_audience(v_brand, v_campaign.target_country) a;

  select count(*) into v_addresses from approve_audience;
  if v_addresses = 0 then
    raise exception 'Nobody in the audience can be emailed.' using errcode = 'VC422';
  end if;
  if p_expected_addresses is distinct from v_addresses then
    raise exception 'The audience changed from % to % addresses since the preview. Review it again before confirming.',
      p_expected_addresses, v_addresses using errcode = 'VC422';
  end if;

  insert into public.sends (brand_id, campaign_id, approved_by, approved_by_email, audience_rule, target_country,
    customers_count, addresses_count, chunk_size)
  select v_brand, v_campaign.id, (select auth.uid()), v_email, private.audience_rule(v_campaign.target_country),
    v_campaign.target_country, sum(cardinality(a.contact_ids)), count(*), v_chunk_size
  from approve_audience a
  returning * into v_send;

  insert into public.send_chunks (brand_id, send_id, chunk_no, idempotency_key)
  select distinct v_brand, v_send.id, a.chunk_no, v_send.id::text || ':' || a.chunk_no
  from approve_audience a;

  insert into public.send_recipients (brand_id, send_id, chunk_no, email, contact_ids, recipient_id)
  select v_brand, v_send.id, a.chunk_no, a.email, a.contact_ids, a.recipient_id
  from approve_audience a;

  drop table approve_audience;
  return v_send;
exception
  when unique_violation then
    raise exception 'A send for this campaign is already in progress.' using errcode = 'VC409';
end;
$$;

-- -----------------------------------------------------------------------------
-- Dispatch worker (service role only)
-- -----------------------------------------------------------------------------
create or replace function private.finish_send_if_done(p_send_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.sends s
  set status = 'completed', finished_at = now()
  where s.id = p_send_id
    and s.status = 'dispatching'
    and not exists (select 1 from public.send_chunks k where k.send_id = p_send_id and k.status in ('pending', 'sending'));
$$;
revoke execute on function private.finish_send_if_done(uuid) from public, anon, authenticated;

-- Claims the oldest claimable chunk. On its first claim the chunk's late
-- ineligibility is decided and stored; the returned recipients are exactly the
-- ones still pending, identical on every retry. A chunk whose worker vanished
-- for 3 minutes is retried; after 5 attempts it fails.
create or replace function public.claim_send_chunk()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chunk public.send_chunks;
  v_failed record;
  v_max_attempts constant integer := 5;
begin
  for v_failed in
    update public.send_chunks k
    set status = 'failed', locked_at = null
    where k.status = 'sending' and k.locked_at < now() - interval '3 minutes' and k.attempts >= v_max_attempts
    returning k.send_id, k.chunk_no, k.last_error
  loop
    update public.send_recipients r
    set status = 'failed', updated_at = now(),
        reason = 'Not confirmed by the provider after ' || v_max_attempts || ' attempts: ' || coalesce(v_failed.last_error, 'worker stopped')
    where r.send_id = v_failed.send_id and r.chunk_no = v_failed.chunk_no and r.status = 'pending';
    perform private.finish_send_if_done(v_failed.send_id);
  end loop;

  select k.* into v_chunk
  from public.send_chunks k
  join public.sends s on s.id = k.send_id
  where (k.status = 'pending' or (k.status = 'sending' and k.locked_at < now() - interval '3 minutes'))
  order by s.approved_at, k.send_id, k.chunk_no
  limit 1
  for update of k skip locked;

  if not found then
    return null;
  end if;

  if v_chunk.status = 'pending' then
    update public.send_recipients r
    set status = 'suppressed', reason = x.reason, updated_at = now()
    from (
      select r2.id,
        coalesce(
          (select 'Became ineligible after approval: ' || public.contact_block_reason(c)
           from public.contacts c
           where c.brand_id = r2.brand_id and c.id = any (r2.contact_ids) and public.contact_block_reason(c) is not null
           order by c.id limit 1),
          case when not exists (
            select 1 from public.contacts c
            where c.brand_id = r2.brand_id and c.id = any (r2.contact_ids) and c.email = r2.email
          ) then 'Email address changed after approval' end
        ) as reason
      from public.send_recipients r2
      where r2.send_id = v_chunk.send_id and r2.chunk_no = v_chunk.chunk_no
    ) x
    where r.id = x.id and x.reason is not null;
  end if;

  update public.send_chunks k
  set status = 'sending', attempts = k.attempts + 1, locked_at = now()
  where k.send_id = v_chunk.send_id and k.chunk_no = v_chunk.chunk_no
  returning * into v_chunk;

  return (
    select jsonb_build_object(
      'send_id', v_chunk.send_id,
      'chunk_no', v_chunk.chunk_no,
      'attempt', v_chunk.attempts,
      'idempotency_key', v_chunk.idempotency_key,
      'brand_code', b.code,
      'campaign_external_id', c.external_id,
      'campaign_name', c.name,
      'recipients', coalesce((
        select jsonb_agg(jsonb_build_object('recipient_id', r.recipient_id, 'email', r.email) order by r.recipient_id)
        from public.send_recipients r
        where r.send_id = v_chunk.send_id and r.chunk_no = v_chunk.chunk_no and r.status = 'pending'
      ), '[]'::jsonb)
    )
    from public.sends s
    join public.brands b on b.id = s.brand_id
    join public.campaigns c on c.brand_id = s.brand_id and c.id = s.campaign_id
    where s.id = v_chunk.send_id
  );
end;
$$;

-- Records the provider's answer for a claimed chunk. p_results must name every
-- pending recipient of the chunk: [{recipient_id, status: sent|failed, reason}].
-- Recording the same batch twice is a no-op, so a worker that retries after a
-- lost response cannot double-count.
create or replace function public.record_send_chunk(p_send_id uuid, p_chunk_no integer, p_batch_id text, p_results jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chunk public.send_chunks;
  v_pending integer;
  v_matched integer;
begin
  select * into v_chunk from public.send_chunks k where k.send_id = p_send_id and k.chunk_no = p_chunk_no for update;
  if not found then
    raise exception 'Unknown send chunk %:%', p_send_id, p_chunk_no using errcode = 'VC404';
  end if;
  if v_chunk.status = 'sent' and v_chunk.batch_id is not distinct from p_batch_id then
    return;
  end if;
  if v_chunk.status <> 'sending' then
    raise exception 'Send chunk %:% is %, not sending.', p_send_id, p_chunk_no, v_chunk.status using errcode = 'VC409';
  end if;

  select count(*) into v_pending from public.send_recipients r
  where r.send_id = p_send_id and r.chunk_no = p_chunk_no and r.status = 'pending';

  update public.send_recipients r
  set status = x.status, reason = x.reason, updated_at = now()
  from jsonb_to_recordset(p_results) as x (recipient_id text, status text, reason text)
  where r.send_id = p_send_id and r.chunk_no = p_chunk_no and r.status = 'pending'
    and r.recipient_id = x.recipient_id and x.status in ('sent', 'failed');
  get diagnostics v_matched = row_count;

  if v_matched <> v_pending then
    raise exception 'Provider results cover % of % pending recipients in chunk %:%.', v_matched, v_pending, p_send_id, p_chunk_no
      using errcode = 'VC422';
  end if;

  update public.send_chunks k
  set status = 'sent', batch_id = p_batch_id, sent_at = now(), locked_at = null, last_error = null
  where k.send_id = p_send_id and k.chunk_no = p_chunk_no;

  perform private.finish_send_if_done(p_send_id);
end;
$$;

-- A provider call that failed: keep the error and release the chunk for a
-- retry with the same key (the claim step fails it after 5 attempts).
create or replace function public.release_send_chunk(p_send_id uuid, p_chunk_no integer, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.send_chunks k
  set last_error = left(p_error, 1000),
      locked_at = case when k.attempts >= 5 then k.locked_at else null end
  where k.send_id = p_send_id and k.chunk_no = p_chunk_no and k.status = 'sending';
$$;

revoke execute on function public.campaigns_overview() from public, anon;
revoke execute on function public.preview_send(bigint) from public, anon;
revoke execute on function public.preview_send_recipients(bigint, integer, integer) from public, anon;
revoke execute on function public.approve_send(bigint, integer) from public, anon;
grant execute on function public.campaigns_overview() to authenticated;
grant execute on function public.preview_send(bigint) to authenticated;
grant execute on function public.preview_send_recipients(bigint, integer, integer) to authenticated;
grant execute on function public.approve_send(bigint, integer) to authenticated;

revoke execute on function public.claim_send_chunk() from public, anon, authenticated;
revoke execute on function public.record_send_chunk(uuid, integer, text, jsonb) from public, anon, authenticated;
revoke execute on function public.release_send_chunk(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.claim_send_chunk() to service_role;
grant execute on function public.record_send_chunk(uuid, integer, text, jsonb) to service_role;
grant execute on function public.release_send_chunk(uuid, integer, text) to service_role;
