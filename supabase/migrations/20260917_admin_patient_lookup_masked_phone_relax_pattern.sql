-- 20260917_admin_patient_lookup_masked_phone_relax_pattern.sql
-- APPLIED LIVE 2026-09-17.
--
-- Relaxes the masked-phone format check in admin_patient_lookup_by_masked_phone_v2
-- from ^0[0-9]{2}\*{3}[0-9]{3}$ to ^[0-9]{3}\*{3}[0-9]{3}$.
-- Reason (verified live): 11 of 29 users_information_v2 rows have a masked phone
-- that does not start with 0 (sheet and simulation rows), and were unreachable.
-- Everything else in the function is unchanged. Still admin-only, audited, capped.

create or replace function public.admin_patient_lookup_by_masked_phone_v2(p_phone_masked text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_email   text := lower(nullif(btrim(auth.jwt() ->> 'email'), ''));
  v_uid     uuid := auth.uid();
  v_masked  text := regexp_replace(coalesce(p_phone_masked, ''), '[\s\-]', '', 'g');
  v_code    uuid;
  v_one     jsonb;
  v_matches jsonb := '[]'::jsonb;
  v_count   int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('admin_patient_lookup_v2:' || coalesce(v_email, '')));

  if not public.current_user_is_admin() then
    insert into public.admin_patient_lookup_log_v2
      (caller_email, caller_uid, patient_code, outcome, query_masked_phone)
    values (v_email, v_uid, null, 'FORBIDDEN', left(v_masked, 20));
    return jsonb_build_object('error', 'forbidden');
  end if;

  if v_masked !~ '^[0-9]{3}\*{3}[0-9]{3}$' then
    insert into public.admin_patient_lookup_log_v2
      (caller_email, caller_uid, patient_code, outcome, query_masked_phone)
    values (v_email, v_uid, null, 'BAD_INPUT', left(v_masked, 20));
    return jsonb_build_object('error', 'bad_input');
  end if;

  select count(*) into v_count
  from public.users_information_v2
  where phone = v_masked;

  insert into public.admin_patient_lookup_log_v2
    (caller_email, caller_uid, patient_code, outcome, query_masked_phone)
  values (v_email, v_uid, null,
          case when v_count = 0 then 'NOT_FOUND' else 'SEARCH' end,
          v_masked);

  if v_count = 0 then
    return jsonb_build_object('error', 'not_found');
  end if;

  for v_code in
    select patient_code
    from public.users_information_v2
    where phone = v_masked
    order by patient_code
  loop
    v_one := public.admin_patient_lookup_v2(v_code);
    v_matches := v_matches || jsonb_build_array(v_one);
    exit when v_one ? 'error' and v_one ->> 'error' = 'rate_limited';
  end loop;

  return jsonb_build_object(
    'query',       v_masked,
    'match_count', v_count,
    'matches',     v_matches
  );
end;
$$;

revoke all on function public.admin_patient_lookup_by_masked_phone_v2(text) from public, anon, authenticated;
grant execute on function public.admin_patient_lookup_by_masked_phone_v2(text) to authenticated;
