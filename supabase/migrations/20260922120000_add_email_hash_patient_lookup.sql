-- 22.9.2026 — stage 1 of server-derived patient identity (SESSION_HANDOFF item 44).
-- Additive only. Applied to the live database via MCP as migration
-- add_email_hash_patient_lookup_20260922.
--
-- Identity = email proven by the patient's auth token + a phone that belongs
-- to that email. Decision 22.9: an email may belong to ONE patient only.
-- Existing test data still has 5 patients on one email, so uniqueness cannot
-- be a constraint yet: it is enforced by a trigger (separate migration), and
-- a unique index is added on launch day after test data is deleted.
-- The (email, phone) pair stays as a second check.

alter table public.patient_identity_map add column if not exists email_hash text;
create index if not exists patient_identity_map_email_hash_idx on public.patient_identity_map (email_hash);

update public.patient_identity_map pim
set email_hash = encode(extensions.digest(lower(btrim(
      extensions.pgp_sym_decrypt(decode(substr(pim.email_enc, 5), 'base64'),
        (select value from public.app_config where key = 'crypto_key_b64'))
    )), 'sha256'), 'hex')
where pim.email_enc like 'db1:%' and pim.email_hash is null;

create or replace function public.get_patient_by_email_phone_v2(p_email text, p_phone text)
returns uuid
language sql security definer
set search_path = public, extensions, pg_catalog
as $fn$
  select min(patient_code::text)::uuid
  from public.patient_identity_map
  where email_hash = encode(digest(lower(btrim(p_email)), 'sha256'), 'hex')
    and phone_hash = encode(digest(nullif(regexp_replace(btrim(p_phone), '[^0-9]', '', 'g'), ''), 'sha256'), 'hex')
  having count(*) = 1;
$fn$;
revoke all on function public.get_patient_by_email_phone_v2(text, text) from public, anon, authenticated;
grant execute on function public.get_patient_by_email_phone_v2(text, text) to service_role;
