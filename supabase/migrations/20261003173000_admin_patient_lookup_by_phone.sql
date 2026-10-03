-- 20261003173000_admin_patient_lookup_by_phone.sql
-- Admin lookup by FULL phone. Addition only: existing functions are not changed.
--
-- Order (same as admin_patient_lookup_by_masked_phone_v2):
--   1. admin check first, so a non-admin learns nothing about the phone
--   2. input check: Israeli phone only, canonical form of 9 or 10 digits
--   3. hourly cap check before the search
--   4. resolve patient_code via patient_code_by_phone_v2
--      (covers the canonical hash and the two legacy hash forms; verified 3.10.2026
--       to resolve all 35 rows, with and without a leading 0)
--   5. audit row, then admin_patient_lookup_v2 (cap and OK row apply as today)
--
-- The full phone is NEVER written to the audit log. Only the masked form
-- (first 3 digits *** last 3 digits of the canonical form) goes to
-- query_masked_phone. BAD_INPUT and FORBIDDEN rows store null there.
-- The function never raises, so the input never reaches an error log line.
--
-- Rollback:
--   drop function if exists public.admin_patient_lookup_by_phone_v2(text);

create or replace function public.admin_patient_lookup_by_phone_v2(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  c_hourly_cap constant int := 20;
  v_email  text := lower(nullif(btrim(auth.jwt() ->> 'email'), ''));
  v_uid    uuid := auth.uid();
  v_canon  text;
  v_masked text;
  v_recent int;
  v_code   uuid;
begin
  perform pg_advisory_xact_lock(hashtext('admin_patient_lookup_v2:' || coalesce(v_email, '')));

  if not public.current_user_is_admin() then
    insert into public.admin_patient_lookup_log_v2
      (caller_email, caller_uid, patient_code, outcome, query_masked_phone)
    values (v_email, v_uid, null, 'FORBIDDEN', null);
    return jsonb_build_object('error', 'forbidden');
  end if;

  v_canon := public.phone_canon_v2(p_phone);

  if v_canon is null or v_canon !~ '^0[0-9]{8,9}$' then
    insert into public.admin_patient_lookup_log_v2
      (caller_email, caller_uid, patient_code, outcome, query_masked_phone)
    values (v_email, v_uid, null, 'BAD_INPUT', null);
    return jsonb_build_object('error', 'bad_input');
  end if;

  v_masked := left(v_canon, 3) || '***' || right(v_canon, 3);

  select count(*) into v_recent
  from public.admin_patient_lookup_log_v2
  where caller_email = v_email
    and created_at > now() - interval '1 hour';

  if v_recent >= c_hourly_cap then
    insert into public.admin_patient_lookup_log_v2
      (caller_email, caller_uid, patient_code, outcome, query_masked_phone)
    values (v_email, v_uid, null, 'RATE_LIMITED', v_masked);
    return jsonb_build_object('error', 'rate_limited');
  end if;

  v_code := public.patient_code_by_phone_v2(v_canon);

  if v_code is null then
    insert into public.admin_patient_lookup_log_v2
      (caller_email, caller_uid, patient_code, outcome, query_masked_phone)
    values (v_email, v_uid, null, 'NOT_FOUND', v_masked);
    return jsonb_build_object('error', 'not_found');
  end if;

  insert into public.admin_patient_lookup_log_v2
    (caller_email, caller_uid, patient_code, outcome, query_masked_phone)
  values (v_email, v_uid, v_code, 'SEARCH', v_masked);

  return public.admin_patient_lookup_v2(v_code);
end;
$function$;

revoke all on function public.admin_patient_lookup_by_phone_v2(text) from public;
revoke all on function public.admin_patient_lookup_by_phone_v2(text) from anon;
grant execute on function public.admin_patient_lookup_by_phone_v2(text) to authenticated;
grant execute on function public.admin_patient_lookup_by_phone_v2(text) to service_role;

notify pgrst, 'reload schema';
