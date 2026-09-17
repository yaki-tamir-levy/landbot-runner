-- 20260917_admin_patient_lookup_by_masked_phone_v2.sql
-- DRAFT FOR REVIEW. NOT APPLIED.
--
-- Adds lookup by masked phone (e.g. 050***000) on top of admin_patient_lookup_v2.
--
-- Verified live 17.9.2026:
--   users_information_v2.phone  -> 29/29 rows in shape 999***999, all unique today.
--   patient_identity_map.phone  -> 28 null, 5 masked, 1 in shape 9999. NOT a reliable
--                                  source for the masked phone. The masked search uses
--                                  users_information_v2 only.
--   Every users_information_v2 row has an identity row.
--   Identities with no users_information_v2 row cannot be found by masked phone.
--
-- A masked phone is NOT unique by design (3 + 3 digits). The function returns
-- ALL matches, never picks one.

begin;

-- 1. Log: record the masked query and a SEARCH outcome --------------------------
-- Adding a column and swapping a check constraint does not touch existing rows,
-- so the append-only triggers are not fired.

alter table public.admin_patient_lookup_log_v2
  add column query_masked_phone text;

alter table public.admin_patient_lookup_log_v2
  drop constraint admin_patient_lookup_log_v2_outcome_check;

alter table public.admin_patient_lookup_log_v2
  add constraint admin_patient_lookup_log_v2_outcome_check
  check (outcome in ('OK', 'NOT_FOUND', 'FORBIDDEN', 'RATE_LIMITED', 'BAD_INPUT', 'SEARCH'));

-- 2. Existing function: take the masked phone from users_information_v2 ---------
-- Same signature, same logic. Only the phone_masked source changes.

create or replace function public.admin_patient_lookup_v2(p_patient_code uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
declare
  c_hourly_cap constant int := 20;
  v_email  text := lower(nullif(btrim(auth.jwt() ->> 'email'), ''));
  v_uid    uuid := auth.uid();
  v_recent int;
  v_map    public.patient_identity_map%rowtype;
  v_user   public.users_information_v2%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('admin_patient_lookup_v2:' || coalesce(v_email, '')));

  if not public.current_user_is_admin() then
    insert into public.admin_patient_lookup_log_v2 (caller_email, caller_uid, patient_code, outcome)
    values (v_email, v_uid, p_patient_code, 'FORBIDDEN');
    return jsonb_build_object('error', 'forbidden');
  end if;

  if p_patient_code is null then
    insert into public.admin_patient_lookup_log_v2 (caller_email, caller_uid, patient_code, outcome)
    values (v_email, v_uid, null, 'BAD_INPUT');
    return jsonb_build_object('error', 'bad_input');
  end if;

  select count(*) into v_recent
  from public.admin_patient_lookup_log_v2
  where caller_email = v_email
    and created_at > now() - interval '1 hour';

  if v_recent >= c_hourly_cap then
    insert into public.admin_patient_lookup_log_v2 (caller_email, caller_uid, patient_code, outcome)
    values (v_email, v_uid, p_patient_code, 'RATE_LIMITED');
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into v_map from public.patient_identity_map where patient_code = p_patient_code;

  if not found then
    insert into public.admin_patient_lookup_log_v2 (caller_email, caller_uid, patient_code, outcome)
    values (v_email, v_uid, p_patient_code, 'NOT_FOUND');
    return jsonb_build_object('error', 'not_found');
  end if;

  select * into v_user from public.users_information_v2 where patient_code = p_patient_code;

  insert into public.admin_patient_lookup_log_v2 (caller_email, caller_uid, patient_code, outcome)
  values (v_email, v_uid, p_patient_code, 'OK');

  return jsonb_build_object(
    'patient_code',   v_map.patient_code,
    'phone_masked',   coalesce(v_user.phone, v_map.phone),
    'phone',          public.intake_dec(v_map.phone_enc),
    'name',           public.intake_dec(v_map.name_enc),
    'email',          public.intake_dec(v_map.email_enc),
    'active',         v_user.active,
    'status',         v_user.status,
    'therapy_track',  v_user.therapy_track,
    'psychologist',   v_user.psychologist,
    'gender',         v_user.gender,
    'patient_origin', v_user.patient_origin
  );
end;
$$;

-- CREATE OR REPLACE keeps existing grants, but re-assert them explicitly.
revoke all on function public.admin_patient_lookup_v2(uuid) from public, anon, authenticated;
grant execute on function public.admin_patient_lookup_v2(uuid) to authenticated;

-- 3. New function: search by masked phone ---------------------------------------
-- Admin check runs FIRST, before any search, so a non-admin learns nothing about
-- whether a masked phone exists.
-- Each match is resolved through admin_patient_lookup_v2, so every match is
-- logged as its own OK row and counts toward the hourly cap.

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

  if v_masked !~ '^0[0-9]{2}\*{3}[0-9]{3}$' then
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
    -- Stop as soon as the cap is hit; do not keep consuming.
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

commit;

-- 4. Post-apply checks (read-only) ---------------------------------------------
--
-- select has_function_privilege('anon',          'public.admin_patient_lookup_by_masked_phone_v2(text)', 'execute') anon_exec,
--        has_function_privilege('authenticated', 'public.admin_patient_lookup_by_masked_phone_v2(text)', 'execute') auth_exec;
-- expected: false, true
--
-- Without a JWT both must return {"error":"forbidden"}:
-- select public.admin_patient_lookup_by_masked_phone_v2('000***000');
-- select public.admin_patient_lookup_v2(gen_random_uuid());
--
-- 5. Rollback -------------------------------------------------------------------
--
-- drop function public.admin_patient_lookup_by_masked_phone_v2(text);
-- Restore admin_patient_lookup_v2 from 20260917_admin_patient_lookup_v2.sql
--   (only difference: 'phone_masked', v_map.phone).
-- The added column and the widened check constraint can stay; they are additive.
