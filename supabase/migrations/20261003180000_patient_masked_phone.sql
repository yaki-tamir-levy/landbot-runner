-- 20261003180000_patient_masked_phone.sql
-- Stage A of removing the stored masked phone: a function that DERIVES the
-- masked phone from the patient's encrypted phone at read time.
-- Addition only: nothing existing is changed.
--
-- Rule:
--   decrypted phone -> canonical form (phone_canon_v2)
--   if the canonical form is an Israeli phone (0 + 8 or 9 digits) -> use it
--   otherwise (simulation phones, 11 digits) -> use the stored digits as they are,
--   so simulation masks keep their 888/999 prefix
--   result: first 3 digits *** last 3 digits (6 digits or fewer: returned as is)
--
-- Verified 3.10.2026 before writing, on all 35 rows of users_information_v2:
--   28 identical to the stored masked phone, 7 differ (stored without the
--   leading 0, now uniform), 0 null, 0 duplicates, 6 simulation rows keep 888/999.
--
-- Access: service_role only. Callers are SECURITY DEFINER report functions.
--
-- Rollback:
--   drop function if exists public.patient_masked_phone_v2(uuid);

create or replace function public.patient_masked_phone_v2(p_patient_code uuid)
returns text
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  with d as (
    select public.intake_dec(m.phone_enc) as ph
    from public.patient_identity_map m
    where m.patient_code = p_patient_code
  ),
  s as (
    select case
             when public.phone_canon_v2(ph) ~ '^0[0-9]{8,9}$' then public.phone_canon_v2(ph)
             else nullif(regexp_replace(coalesce(ph, ''), '\D', '', 'g'), '')
           end as src
    from d
  )
  select case
           when src is null then null
           when length(src) <= 6 then src
           else left(src, 3) || '***' || right(src, 3)
         end
  from s;
$function$;

revoke all on function public.patient_masked_phone_v2(uuid) from public;
revoke all on function public.patient_masked_phone_v2(uuid) from anon;
revoke all on function public.patient_masked_phone_v2(uuid) from authenticated;
grant execute on function public.patient_masked_phone_v2(uuid) to service_role;
