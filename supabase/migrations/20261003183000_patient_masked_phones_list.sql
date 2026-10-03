-- 20261003183000_patient_masked_phones_list.sql
-- Stage B3a of removing the stored masked phone: one call that returns, for
-- every patient, the derived masked phone and the simulation flag.
-- Used by tools/psychologist_notify.py instead of reading
-- users_information_v2.phone and patient_identity_map.phone directly.
-- Addition only: nothing existing is changed.
--
--   phone_masked  public.patient_masked_phone_v2(patient_code)
--   is_sim        users_information_v2.patient_origin = 'SIM'
--
-- Access: service_role only.
--
-- Rollback:
--   drop function if exists public.patient_masked_phones_v2();

create or replace function public.patient_masked_phones_v2()
returns table(patient_code uuid, phone_masked text, is_sim boolean)
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  select m.patient_code,
         public.patient_masked_phone_v2(m.patient_code) as phone_masked,
         coalesce(u.patient_origin, '') = 'SIM' as is_sim
    from public.patient_identity_map m
    left join public.users_information_v2 u on u.patient_code = m.patient_code
   order by m.patient_code;
$function$;

revoke all on function public.patient_masked_phones_v2() from public;
revoke all on function public.patient_masked_phones_v2() from anon;
revoke all on function public.patient_masked_phones_v2() from authenticated;
grant execute on function public.patient_masked_phones_v2() to service_role;

notify pgrst, 'reload schema';
