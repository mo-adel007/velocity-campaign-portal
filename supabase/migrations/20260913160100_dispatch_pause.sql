-- =============================================================================
-- Dispatch pause with an expiry. While paused, claim_send_chunk hands out
-- nothing, so approvals made by live tests (or during an incident) are never
-- sent. The pause is a lease: if whoever set it disappears, dispatch resumes
-- on its own when it expires. Service role / postgres only.
-- =============================================================================

create table private.dispatch_control (
  id boolean primary key default true check (id),
  paused_until timestamptz,
  reason text
);
insert into private.dispatch_control default values;
revoke all on private.dispatch_control from public, anon, authenticated;

create or replace function public.pause_dispatch(p_minutes integer, p_reason text)
returns timestamptz
language sql
security definer
set search_path = ''
as $$
  update private.dispatch_control
  set paused_until = case when p_minutes > 0 then now() + make_interval(mins => least(p_minutes, 60)) end,
      reason = case when p_minutes > 0 then p_reason end
  returning paused_until;
$$;

revoke execute on function public.pause_dispatch(integer, text) from public, anon, authenticated;
grant execute on function public.pause_dispatch(integer, text) to service_role;

-- Wrap the claim: same function body, refused while paused.
alter function public.claim_send_chunk() rename to claim_send_chunk_unpaused;
revoke execute on function public.claim_send_chunk_unpaused() from public, anon, authenticated, service_role;
alter function public.claim_send_chunk_unpaused() set schema private;

create or replace function public.claim_send_chunk()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from private.dispatch_control where paused_until > now()) then
    return null;
  end if;
  return private.claim_send_chunk_unpaused();
end;
$$;

revoke execute on function public.claim_send_chunk() from public, anon, authenticated;
grant execute on function public.claim_send_chunk() to service_role;
