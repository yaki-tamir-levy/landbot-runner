-- 22.9.2026 — wrong-code limit for meitar-api (SESSION_HANDOFF item 48).
-- Applied to the live database via MCP as migration
-- meitar_verify_attempts_20260922.
--
-- meitar-api blocks code verification for a phone after 5 wrong codes within
-- 60 minutes. A correct code clears the counter. The table is closed on
-- creation: RLS on, no privileges for anon or authenticated.

create table if not exists public.meitar_verify_attempts (
  phone_hash text primary key,
  fails integer not null default 0,
  first_fail_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.meitar_verify_attempts enable row level security;
revoke all on table public.meitar_verify_attempts from public, anon, authenticated;

create or replace function public.meitar_record_verify_v2(p_phone_hash text, p_success boolean, p_window_minutes integer)
returns void
language plpgsql security definer
set search_path = public, pg_catalog
as $fn$
begin
  if p_success then
    delete from public.meitar_verify_attempts where phone_hash = p_phone_hash;
    return;
  end if;
  insert into public.meitar_verify_attempts as t (phone_hash, fails, first_fail_at, updated_at)
  values (p_phone_hash, 1, now(), now())
  on conflict (phone_hash) do update set
    fails = case when t.first_fail_at < now() - make_interval(mins => p_window_minutes) then 1 else t.fails + 1 end,
    first_fail_at = case when t.first_fail_at < now() - make_interval(mins => p_window_minutes) then now() else t.first_fail_at end,
    updated_at = now();
end;
$fn$;
revoke all on function public.meitar_record_verify_v2(text, boolean, integer) from public, anon, authenticated;
grant execute on function public.meitar_record_verify_v2(text, boolean, integer) to service_role;
