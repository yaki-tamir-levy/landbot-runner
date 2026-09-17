-- 20260917_admin_patient_lookup_v2.sql
-- DRAFT FOR REVIEW. NOT APPLIED.
--
-- Purpose: decrypt one patient's identity for an authenticated admin only,
-- with an audit row per attempt and a per-admin hourly cap.
-- No secret is ever stored on the client. The encryption key never leaves the DB.
--
-- Depends on (verified live 17.9.2026):
--   public.current_user_is_admin()  -- admin by JWT email, active + is_admin in psychologists_v2
--   public.intake_dec(text)         -- decrypts 'db1:' values, no anon/authenticated execute
--   public.patient_identity_map     -- phone_enc, name_enc, email_enc (all 'db1:')
--   public.users_information_v2

begin;

-- 1. Audit log -----------------------------------------------------------------
-- Every new public table is born open. Close it explicitly in the same step.

create table public.admin_patient_lookup_log_v2 (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  caller_email  text,
  caller_uid    uuid,
  patient_code  uuid,
  outcome       text not null
    check (outcome in ('OK', 'NOT_FOUND', 'FORBIDDEN', 'RATE_LIMITED', 'BAD_INPUT'))
);

create index admin_patient_lookup_log_v2_caller_time
  on public.admin_patient_lookup_log_v2 (caller_email, created_at);

alter table public.admin_patient_lookup_log_v2 enable row level security;
revoke all on public.admin_patient_lookup_log_v2 from public, anon, authenticated;

-- Append only: no update, no delete, for anyone except the table owner.
create or replace function public.admin_patient_lookup_log_v2_block_change()
returns trigger
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
begin
  raise exception 'admin_patient_lookup_log_v2 is append-only';
end;
$$;

create trigger trg_admin_patient_lookup_log_v2_no_update
  before update on public.admin_patient_lookup_log_v2
  for each row execute function public.admin_patient_lookup_log_v2_block_change();

create trigger trg_admin_patient_lookup_log_v2_no_delete
  before delete on public.admin_patient_lookup_log_v2
  for each row execute function public.admin_patient_lookup_log_v2_block_change();

revoke all on function public.admin_patient_lookup_log_v2_block_change()
  from public, anon, authenticated;

-- 2. Lookup function -----------------------------------------------------------
-- Returns jsonb with "error" instead of raising, so the audit row is kept
-- even when the request is refused.

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
  -- Serialize per caller so two parallel calls cannot both slip under the cap.
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

  -- Cap counts every attempt by this admin in the last hour, whatever the outcome.
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
    'phone_masked',   v_map.phone,
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

-- Supabase grants execute on new functions to anon/authenticated by default.
-- Close everything, then open to authenticated only. The admin check is inside.
revoke all on function public.admin_patient_lookup_v2(uuid) from public, anon, authenticated;
grant execute on function public.admin_patient_lookup_v2(uuid) to authenticated;

commit;

-- 3. Post-apply checks (run separately, read-only) -----------------------------
--
-- select c.relrowsecurity,
--        has_table_privilege('anon',          c.oid, 'select') anon_sel,
--        has_table_privilege('authenticated', c.oid, 'select') auth_sel
-- from pg_class c where c.oid = 'public.admin_patient_lookup_log_v2'::regclass;
-- expected: true, false, false
--
-- select has_function_privilege('anon',          'public.admin_patient_lookup_v2(uuid)', 'execute') anon_exec,
--        has_function_privilege('authenticated', 'public.admin_patient_lookup_v2(uuid)', 'execute') auth_exec;
-- expected: false, true
--
-- Called without a JWT (e.g. from SQL editor) it must return {"error":"forbidden"}
-- and leave one FORBIDDEN row:
-- select public.admin_patient_lookup_v2(gen_random_uuid());
-- select outcome, caller_email from public.admin_patient_lookup_log_v2 order by id desc limit 1;
--
-- 4. Rollback -----------------------------------------------------------------
--
-- drop function public.admin_patient_lookup_v2(uuid);
-- drop table public.admin_patient_lookup_log_v2;   -- triggers go with it
-- drop function public.admin_patient_lookup_log_v2_block_change();
