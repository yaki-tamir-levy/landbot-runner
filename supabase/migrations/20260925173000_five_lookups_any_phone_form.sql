-- 25.9.2026: five lookup functions on the live path find the patient from any
-- phone form (with or without the leading zero, +972, spaces) via
-- patient_code_by_phone_v2. Only the lookup changed in each. Signatures,
-- return values, SECURITY DEFINER, search_path and existing grants unchanged.

CREATE OR REPLACE FUNCTION public.get_patient_email_v2(p_phone text)
 RETURNS text
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
select nullif(btrim(
         pgp_sym_decrypt(decode(substr(pim.email_enc, 5), 'base64'), (select k from key))
       ), '')
from found f
join public.patient_identity_map pim
  on pim.patient_code = f.patient_code
where pim.email_enc like 'db1:%'
  and (select k from key) is not null
limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_patient_by_email_phone_v2(p_email text, p_phone text)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  select min(patient_code::text)::uuid
  from public.patient_identity_map
  where email_hash = encode(digest(lower(btrim(p_email)), 'sha256'), 'hex')
    and patient_code = public.patient_code_by_phone_v2(p_phone)
  having count(*) = 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_current_conversation_tzvira_v2(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_patient_code uuid;
    v_val text;
    v_row_count int;
begin
    if p_phone is null or btrim(p_phone) = '' then
        return jsonb_build_object('tzvira', null, 'row_count', 0);
    end if;

    if public.phone_canon_v2(p_phone) is null then
        return jsonb_build_object('tzvira', null, 'row_count', 0);
    end if;

    v_patient_code := public.patient_code_by_phone_v2(p_phone);

    if v_patient_code is null then
        return jsonb_build_object('tzvira', null, 'row_count', 0);
    end if;

    select count(*)
      into v_row_count
    from public.conversations_prod_v2 c
    where c.patient_code = v_patient_code
      and (coalesce(nullif(c.question,''),'') <> '' or coalesce(nullif(c.answer,''),'') <> '');

    select string_agg(
             'Q: ' || coalesce(nullif(c.question,''),'') ||
             E'\nA: ' || coalesce(nullif(c.answer,''),''),
             E'\n\n'
             order by c.created_at
           )
      into v_val
    from public.conversations_prod_v2 c
    where c.patient_code = v_patient_code
      and (coalesce(nullif(c.question,''),'') <> '' or coalesce(nullif(c.answer,''),'') <> '');

    return jsonb_build_object('tzvira', v_val, 'row_count', v_row_count);
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_summarized_linked_talk_v2(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
    v_patient_code uuid;
    v_val text;
    v_ab text;
    -- רשת ביטחון בלבד. המהלך היומי הוא המגביל האמיתי, ובמצב תקין השדה
    -- עומד על כ-930 תווים. התקרה נוגעת רק אם המהלך נכשל כמה ימים ברצף,
    -- ומונעת חזרה למצב של עשרות אלפי תווים בכל הודעה.
    v_max_chars constant int := 8000;
    v_cut int;
begin
    if p_phone is null or btrim(p_phone) = '' then
        return jsonb_build_object('summarized_linked_talk', null);
    end if;

    if public.phone_canon_v2(p_phone) is null then
        return jsonb_build_object('summarized_linked_talk', null);
    end if;

    v_patient_code := public.patient_code_by_phone_v2(p_phone);

    if v_patient_code is null then
        return jsonb_build_object('summarized_linked_talk', null);
    end if;

    select ut.summarized_linked_talk, ut.ab
      into v_val, v_ab
    from public.users_total_v2 ut
    where ut.patient_code = v_patient_code
    limit 1;

    v_ab  := nullif(btrim(coalesce(v_ab, '')), '');
    v_val := nullif(btrim(coalesce(v_val, ''), E' \n\r'), '');

    -- החיתוך משאיר את הסוף - החומר העדכני - ומיישר לתחילת הקטע השלם
    -- הראשון שנשאר, כדי שלא יישלח חצי סיכום בלי ההקשר שלו.
    if v_val is not null and length(v_val) > v_max_chars then
        v_val := right(v_val, v_max_chars);
        v_cut := position('========' in v_val);
        if v_cut > 0 then
            v_val := btrim(substr(v_val, v_cut + 8), E' \n\r');
        end if;
        v_val := nullif(v_val, '');
    end if;

    if v_val is null and v_ab is null then
        return jsonb_build_object('summarized_linked_talk', null);
    end if;

    if v_val is null then
        return jsonb_build_object(
            'summarized_linked_talk',
            '## תמונת מצב מצטברת' || E'\n' || v_ab
        );
    end if;

    if v_ab is null then
        return jsonb_build_object('summarized_linked_talk', v_val);
    end if;

    return jsonb_build_object(
        'summarized_linked_talk',
        '## תמונת מצב מצטברת' || E'\n' || v_ab || E'\n\n'
        || '## השיחות האחרונות' || E'\n' || v_val
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_disclaimed_agreed_v2(p_phone text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
v_patient_code uuid;
begin
if public.phone_canon_v2(p_phone) is null then
    raise exception 'Phone is required';
end if;

v_patient_code := public.patient_code_by_phone_v2(p_phone);

if v_patient_code is null then
    return;
end if;

update public.users_information_v2
set
    disclaimed = 'AGREED',
    updated_at = now()
where patient_code = v_patient_code;

end;
$function$;
