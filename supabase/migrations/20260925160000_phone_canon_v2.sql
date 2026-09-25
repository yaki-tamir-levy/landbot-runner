-- 25.9.2026: one normalization rule for every phone in the system.
-- 0541111111, 541111111, 054-111-1111, +972541111111 -> 0541111111
-- Additive only. Nothing calls these functions yet.

create or replace function public.phone_canon_v2(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when s is null then null else '0' || s end
  from (
    select nullif(ltrim(
             case when d like '972%' and length(d) in (11, 12) then substr(d, 4) else d end,
           '0'), '') as s
    from (select ltrim(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '0') as d) a
  ) b;
$$;

create or replace function public.phone_hash_v2(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(extensions.digest(public.phone_canon_v2(p_phone), 'sha256'), 'hex');
$$;

revoke all on function public.phone_canon_v2(text) from public, anon, authenticated;
revoke all on function public.phone_hash_v2(text) from public, anon, authenticated;
grant execute on function public.phone_canon_v2(text) to service_role;
grant execute on function public.phone_hash_v2(text) to service_role;
