-- 22.9.2026 — email_hash sync and one-email-per-patient guard.
-- Applied to the live database via MCP as migration
-- patient_email_guard_trigger_20260922.
--
-- Fills patient_identity_map.email_hash whenever email_enc is written, and
-- rejects (email_in_use, 23505) an email already held by another patient.
-- The duplicate check runs only when the email itself changes: the writer
-- re-encrypts the same email on every sheet sync, and 5 test patients still
-- share one email. A unique index on email_hash is added on launch day,
-- after test data is deleted.
--
-- The only writer of email_enc is upsert_users_information_v2_from_sheet
-- (sheet sync and intake_apply_decision), so one trigger covers both paths.
--
-- Verified 22.9 inside a rolled-back transaction: same email re-encrypted ->
-- hash unchanged; another patient's email -> rejected; new email -> hashed.

create or replace function public.patient_identity_map_email_guard()
returns trigger
language plpgsql security definer
set search_path = public, extensions, pg_catalog
as $fn$
declare
  v_hash text;
begin
  if new.email_enc is null or new.email_enc not like 'db1:%' then
    new.email_hash := null;
    return new;
  end if;

  v_hash := encode(digest(lower(btrim(
    pgp_sym_decrypt(decode(substr(new.email_enc, 5), 'base64'),
      (select value from public.app_config where key = 'crypto_key_b64'))
  )), 'sha256'), 'hex');

  if (tg_op = 'INSERT' or v_hash is distinct from old.email_hash)
     and exists (select 1 from public.patient_identity_map
                 where email_hash = v_hash and patient_code <> new.patient_code) then
    raise exception 'email_in_use' using errcode = '23505';
  end if;

  new.email_hash := v_hash;
  return new;
end;
$fn$;
revoke all on function public.patient_identity_map_email_guard() from public, anon, authenticated;

create trigger trg_patient_identity_map_email_guard
before insert or update of email_enc on public.patient_identity_map
for each row execute function public.patient_identity_map_email_guard();
