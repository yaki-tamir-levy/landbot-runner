-- get_patient_email_v2 - decrypts patient email from patient_identity_map.email_enc
-- Created 19.9.2026. Consumer: meitar-otp-gate (service_role only).
CREATE OR REPLACE FUNCTION public.get_patient_email_v2(p_phone text)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
with norm as (
  select nullif(regexp_replace(trim(p_phone), '[^0-9]', '', 'g'), '') as q
),
hashed as (
  select encode(digest(q, 'sha256'), 'hex') as q_hash
  from norm
  where q is not null
),
key as (
  select value as k from public.app_config where key = 'crypto_key_b64'
)
select nullif(btrim(
         pgp_sym_decrypt(decode(substr(pim.email_enc, 5), 'base64'), (select k from key))
       ), '')
from hashed h
join public.patient_identity_map pim
  on pim.phone_hash = h.q_hash
where pim.email_enc like 'db1:%'
  and (select k from key) is not null
limit 1;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_patient_email_v2(text) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_patient_email_v2(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_patient_email_v2(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_patient_email_v2(text) TO service_role;
