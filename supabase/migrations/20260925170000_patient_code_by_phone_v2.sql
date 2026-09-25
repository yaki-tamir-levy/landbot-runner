-- 25.9.2026: one lookup from any phone form to patient_code.
-- Tries, in order: canonical hash (0541111111), canonical without the
-- leading zero (541111111, how 13 identities are stored today), and the
-- raw digits as typed (the legacy rule). The last two are a bridge until
-- stored identities are migrated to the canonical form; remove them after.
-- Additive only. Nothing calls this function yet.

create or replace function public.patient_code_by_phone_v2(p_phone text)
returns uuid
language sql
stable
set search_path = ''
as $$
  with c as (
    select public.phone_canon_v2(p_phone) as canon,
           nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '') as raw
  )
  select pim.patient_code
  from public.patient_identity_map pim, c
  where c.canon is not null
    and pim.phone_hash in (
      encode(extensions.digest(c.canon, 'sha256'), 'hex'),
      encode(extensions.digest(substr(c.canon, 2), 'sha256'), 'hex'),
      encode(extensions.digest(c.raw, 'sha256'), 'hex')
    )
  order by (pim.phone_hash = encode(extensions.digest(c.canon, 'sha256'), 'hex')) desc
  limit 1;
$$;

revoke all on function public.patient_code_by_phone_v2(text) from public, anon, authenticated;
grant execute on function public.patient_code_by_phone_v2(text) to service_role;
