-- =============================================================================
-- Every row of a file lands in exactly one counter:
--   rows_total = inserted + updated + unchanged + rejected + merged
-- "merged" is a row whose customer/campaign id already appeared earlier in the
-- same file: it was folded into that id's record (last row wins) rather than
-- creating or updating a record of its own. This holds whether the repeat sits
-- in the same byte range (collapsed by the worker, reported as p_merged) or in
-- a later range (the id was already written by this run).
-- =============================================================================

alter table public.import_runs add column rows_merged integer not null default 0;

drop function public.yield_import_run(bigint, bigint, bigint, integer, text, text, text, bigint, jsonb, jsonb, boolean);

create or replace function public.yield_import_run(
  p_run_id bigint,
  p_expected_cursor bigint,
  p_next_cursor bigint,
  p_rows integer,
  p_merged integer,
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
  v_repeat_same integer := 0;
  v_repeat_changed integer := 0;
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

  -- Ids this run already wrote in an earlier range: the ingest functions would
  -- count them as updated/unchanged; they are repeats within the file.
  if p_kind = 'contacts' then
    select count(*) filter (where t.row_hash = r ->> 'row_hash'), count(*) filter (where t.row_hash <> r ->> 'row_hash')
    into v_repeat_same, v_repeat_changed
    from jsonb_array_elements(p_records) r
    join public.contacts t on t.brand_id = v_run.brand_id and t.external_id = r ->> 'external_id' and t.last_import_run_id = p_run_id;
  elsif p_kind = 'campaigns' then
    select count(*) filter (where t.row_hash = r ->> 'row_hash'), count(*) filter (where t.row_hash <> r ->> 'row_hash')
    into v_repeat_same, v_repeat_changed
    from jsonb_array_elements(p_records) r
    join public.campaigns t on t.brand_id = v_run.brand_id and t.external_id = r ->> 'external_id' and t.last_import_run_id = p_run_id;
  end if;

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
      rows_updated = rows_updated - v_repeat_changed,
      rows_unchanged = rows_unchanged - v_repeat_same,
      rows_merged = rows_merged + p_merged + v_repeat_same + v_repeat_changed,
      locked_at = null,
      stale_claims = 0
  where id = p_run_id;

  if p_done then
    perform public.finish_import_run(p_run_id, 'completed', null);
  end if;
end;
$$;

revoke execute on function public.yield_import_run(bigint, bigint, bigint, integer, integer, text, text, text, bigint, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.yield_import_run(bigint, bigint, bigint, integer, integer, text, text, text, bigint, jsonb, jsonb, boolean)
  to service_role;
