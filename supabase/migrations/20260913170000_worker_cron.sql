-- =============================================================================
-- Background workers without anyone in the app. pg_cron runs every minute and
-- pg_net calls the Edge Function workers, only when there is work:
--   * process-imports — a run is queued, or a processing run's worker vanished
--     (lock older than 3 minutes). A healthy chain continues on its own.
-- The server key and project URL live in Vault (set by
-- scripts/set-worker-secrets.mjs), never in migrations or the repo.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function private.worker_request(p_function text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_url text;
begin
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'worker_secret_key';
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'project_url';
  if v_key is null or v_url is null then
    raise warning 'Worker secrets are missing in Vault; run scripts/set-worker-secrets.mjs.';
    return null;
  end if;
  return net.http_post(
    url := v_url || '/functions/v1/' || p_function,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
end;
$$;

create or replace function private.kick_workers()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.import_runs r
    where (r.status = 'queued' and r.locked_at is null)
       or (r.status = 'processing' and r.locked_at < now() - interval '3 minutes')
  ) then
    perform private.worker_request('process-imports');
  end if;
end;
$$;

revoke execute on function private.worker_request(text) from public, anon, authenticated;
revoke execute on function private.kick_workers() from public, anon, authenticated;

select cron.schedule('kick-workers', '* * * * *', 'select private.kick_workers()');
