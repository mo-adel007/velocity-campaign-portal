-- =============================================================================
-- Dashboard read functions.
--
-- All four are SECURITY INVOKER: they run as the signed-in user, so the forced
-- RLS policies alone decide which brand's rows they can see. The explicit
-- `brand_id = current_brand_id()` filters only let the planner use the
-- brand-leading indexes; removing them changes speed, not what is returned.
-- `anon` has no EXECUTE, so signed-out calls are refused outright.
-- =============================================================================

-- Total customers = every loaded contact row for the brand (one row per
-- external_id), including deleted/uncontactable ones.
create or replace function public.dashboard_totals()
returns table (
  brand_name text,
  timezone text,
  total_customers bigint,
  contactable_by_email bigint,
  as_of timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    b.name,
    b.timezone,
    count(c.id),
    count(c.id) filter (where public.contact_block_reason(c) is null),
    now()
  from public.brands b
  left join public.contacts c on c.brand_id = b.id
  where b.id = (select private.current_brand_id())
  group by b.id;
$$;

-- One row per reason, in contact_block_reason's precedence order, zero-filled.
-- Reasons are mutually exclusive, so the rows sum to total_customers.
-- The full join keeps any reason added to contact_block_reason later visible
-- even before it is listed here.
create or replace function public.dashboard_contactable_breakdown()
returns table (reason text, customers bigint, sort_order integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with counts as (
    select coalesce(public.contact_block_reason(c), 'contactable') as reason, count(*) as customers
    from public.contacts c
    where c.brand_id = (select private.current_brand_id())
    group by 1
  )
  select
    coalesce(r.reason, counts.reason),
    coalesce(counts.customers, 0),
    coalesce(r.sort_order, 99)
  from (values
    ('contactable', 0), ('deleted', 1), ('invalid_email', 2), ('complained', 3),
    ('unsubscribed', 4), ('bounced', 5), ('no_consent', 6), ('pending', 7), ('suppressed', 8)
  ) as r (reason, sort_order)
  full join counts on counts.reason = r.reason
  where (select private.current_brand_id()) is not null
  order by 3, 1;
$$;

-- Today plus the 29 prior days in the brand's local timezone, zero-filled.
-- Today is still running, so it is flagged partial. Contacts without a
-- signup date count in the total but cannot appear here.
create or replace function public.dashboard_signups_per_day()
returns table (day date, signups bigint, is_partial boolean, timezone text)
language sql
stable
security invoker
set search_path = ''
as $$
  with brand as (
    select b.id, b.timezone, (now() at time zone b.timezone)::date as today
    from public.brands b
    where b.id = (select private.current_brand_id())
  ),
  counts as (
    select (c.signup_at at time zone brand.timezone)::date as day, count(*) as signups
    from brand
    join public.contacts c on c.brand_id = brand.id
    where c.signup_at >= (brand.today - 29)::timestamp at time zone brand.timezone
      and c.signup_at < (brand.today + 1)::timestamp at time zone brand.timezone
    group by 1
  )
  select d.day::date, coalesce(counts.signups, 0), d.day::date = brand.today, brand.timezone
  from brand
  cross join generate_series((brand.today - 29)::timestamp, brand.today::timestamp, interval '1 day') as d (day)
  left join counts on counts.day = d.day::date
  order by 1;
$$;

-- Per campaign, side by side:
--   reported_*  — figures as stated in the source campaigns file
--   events_*    — distinct contacts per event type, counted from loaded and
--                 provider events (duplicates and repeats count once)
-- events_denominator is what the events_* figures are measured against; for
-- now always the file's reported_sent (seed events carry no "delivered").
create or replace function public.dashboard_campaign_performance()
returns table (
  campaign_id bigint,
  external_id text,
  name text,
  channel text,
  sent_at timestamptz,
  reported_sent integer,
  reported_delivered integer,
  reported_bounced integer,
  reported_opens integer,
  reported_clicks integer,
  events_delivered bigint,
  events_opened bigint,
  events_clicked bigint,
  events_bounced bigint,
  events_unsubscribed bigint,
  events_complained bigint,
  events_denominator integer,
  events_denominator_source text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ev as (
    select e.campaign_id,
      count(distinct e.contact_id) filter (where e.type = 'delivered') as delivered,
      count(distinct e.contact_id) filter (where e.type = 'open') as opened,
      count(distinct e.contact_id) filter (where e.type = 'click') as clicked,
      count(distinct e.contact_id) filter (where e.type = 'bounce') as bounced,
      count(distinct e.contact_id) filter (where e.type = 'unsubscribe') as unsubscribed,
      count(distinct e.contact_id) filter (where e.type = 'complaint') as complained
    from public.engagement_events e
    where e.brand_id = (select private.current_brand_id())
      and e.campaign_id is not null
    group by e.campaign_id
  )
  select
    c.id, c.external_id, c.name, c.channel, c.sent_at,
    c.reported_sent, c.reported_delivered, c.reported_bounced, c.reported_opens, c.reported_clicks,
    coalesce(ev.delivered, 0), coalesce(ev.opened, 0), coalesce(ev.clicked, 0),
    coalesce(ev.bounced, 0), coalesce(ev.unsubscribed, 0), coalesce(ev.complained, 0),
    c.reported_sent,
    'reported_sent'
  from public.campaigns c
  left join ev on ev.campaign_id = c.id
  where c.brand_id = (select private.current_brand_id())
  order by c.sent_at desc nulls last, c.external_id;
$$;

revoke execute on function public.dashboard_totals() from public, anon;
revoke execute on function public.dashboard_contactable_breakdown() from public, anon;
revoke execute on function public.dashboard_signups_per_day() from public, anon;
revoke execute on function public.dashboard_campaign_performance() from public, anon;
grant execute on function public.dashboard_totals() to authenticated;
grant execute on function public.dashboard_contactable_breakdown() to authenticated;
grant execute on function public.dashboard_signups_per_day() to authenticated;
grant execute on function public.dashboard_campaign_performance() to authenticated;
