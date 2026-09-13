-- =============================================================================
-- Chunked loader. Edge Functions get ~2 s of CPU per invocation, so the
-- `process-imports` worker reads each uploaded file in ~1 MB byte ranges and
-- commits one range per call through `yield_import_run`. The run keeps the byte
-- cursor, header line and encoding it needs to continue in a fresh invocation.
--
-- Guarantees:
--   * a range's rows, issues, counters and cursor move commit together or not
--     at all, and a stale worker's range is refused by the cursor check;
--   * runs of one brand load strictly in queue order (contacts before the
--     events that reference them), while different brands load in parallel;
--   * a range that keeps killing its worker fails the run after 3 attempts
--     instead of blocking that brand's queue forever.
-- =============================================================================

alter table public.import_runs
  add column byte_cursor bigint not null default 0,
  add column file_size bigint,
  add column header_line text,
  add column encoding text check (encoding in ('utf-8', 'windows-1252')),
  add column stale_claims integer not null default 0;

create or replace function public.claim_import_run()
returns public.import_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.import_runs;
begin
  -- A worker that held a range for 3 minutes died (CPU limit, crash). Third time: give up.
  update public.import_runs
  set status = 'failed', finished_at = now(), locked_at = null,
      status_message = format('Loading stopped after 3 failed attempts at row %s. Rows before that point were loaded.', cursor_row + 1)
  where status = 'processing' and locked_at < now() - interval '3 minutes' and stale_claims >= 2;

  select * into v_run
  from public.import_runs r
  where r.status in ('queued', 'processing')
    and (r.locked_at is null or r.locked_at < now() - interval '3 minutes')
    and not exists (
      select 1 from public.import_runs o
      where o.brand_id = r.brand_id
        and o.status in ('queued', 'processing')
        and (o.created_at, o.id) < (r.created_at, r.id)
    )
  order by r.created_at, r.id
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.import_runs
  set status = 'processing',
      stale_claims = stale_claims + (locked_at is not null)::integer,
      locked_at = now(),
      started_at = coalesce(started_at, now())
  where id = v_run.id
  returning * into v_run;
  return v_run;
end;
$$;

-- Commit one byte range: issues, rows, counters and the cursor, atomically.
create or replace function public.yield_import_run(
  p_run_id bigint,
  p_expected_cursor bigint,
  p_next_cursor bigint,
  p_rows integer,
  p_kind text,
  p_header_line text,
  p_encoding text,
  p_file_size bigint,
  p_records jsonb,
  p_issues jsonb,
  p_done boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.import_runs;
begin
  select * into v_run from public.import_runs where id = p_run_id for update;
  if v_run.status is distinct from 'processing' or v_run.byte_cursor <> p_expected_cursor then
    raise exception 'Import run % is no longer at byte %; this range was already handled.', p_run_id, p_expected_cursor
      using errcode = '40001';
  end if;

  update public.import_runs
  set kind = coalesce(kind, p_kind),
      header_line = coalesce(header_line, p_header_line),
      encoding = coalesce(encoding, p_encoding),
      file_size = p_file_size
  where id = p_run_id;

  perform public.record_import_issues(p_run_id, p_issues);

  if jsonb_array_length(p_records) > 0 then
    case p_kind
      when 'contacts' then perform public.ingest_contacts(p_run_id, p_records);
      when 'campaigns' then perform public.ingest_campaigns(p_run_id, p_records);
      when 'events' then perform public.ingest_events(p_run_id, p_records);
      when 'send_log' then perform public.ingest_send_log(p_run_id, p_records);
      else raise exception 'Unknown import kind %', p_kind;
    end case;
  end if;

  update public.import_runs
  set byte_cursor = p_next_cursor,
      cursor_row = cursor_row + p_rows,
      rows_total = cursor_row + p_rows,
      rows_processed = cursor_row + p_rows,
      locked_at = null,
      stale_claims = 0
  where id = p_run_id;

  if p_done then
    perform public.finish_import_run(p_run_id, 'completed', null);
  end if;
end;
$$;

revoke execute on function public.yield_import_run(bigint, bigint, bigint, integer, text, text, text, bigint, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.yield_import_run(bigint, bigint, bigint, integer, text, text, text, bigint, jsonb, jsonb, boolean)
  to service_role;

-- `update_import_progress` is superseded by `yield_import_run`.
drop function public.update_import_progress(bigint, text, integer, integer);
