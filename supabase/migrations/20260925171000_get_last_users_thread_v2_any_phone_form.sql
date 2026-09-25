-- 25.9.2026: get_last_users_thread_v2 finds the patient from any phone form
-- (with or without the leading zero, +972, spaces) via patient_code_by_phone_v2.
-- Only the lookup changed. Signature, return columns, SECURITY DEFINER,
-- search_path and existing grants are unchanged.

CREATE OR REPLACE FUNCTION public.get_last_users_thread_v2(p_phone text)
 RETURNS TABLE(name text, user_text text, phone text, conversation text, active text, status text, disclaimed text, therapy_track text, gender text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
with found as (
  select public.patient_code_by_phone_v2(p_phone) as patient_code
),
key as (
  select value as k from public.app_config where key = 'crypto_key_b64'
)
select
  coalesce(
    nullif(btrim(pim.name), ''),
    case
      when pim.name_enc like 'db1:%' and (select k from key) is not null
      then nullif(btrim(
             pgp_sym_decrypt(decode(substr(pim.name_enc, 5), 'base64'), (select k from key))
           ), '')
    end
  ) as name,
  ui.user_text,
  coalesce(ui.phone, pim.phone) as phone,
  ui.conversation,
  ui.active,
  ui.status,
  ui.disclaimed,
  ui.therapy_track,
  ui.gender
from found f
join public.patient_identity_map pim
  on pim.patient_code = f.patient_code
join public.users_information_v2 ui
  on ui.patient_code = pim.patient_code
order by
  ui.timestampz desc nulls last,
  ui.updated_at desc nulls last,
  ui.created_at desc nulls last
limit 1;
$function$;
