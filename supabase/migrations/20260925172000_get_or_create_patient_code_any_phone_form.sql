-- 25.9.2026: get_or_create_patient_code finds an existing patient from any
-- phone form via patient_code_by_phone_v2, and creates a new identity in the
-- canonical form only (phone_hash_v2 / phone_canon_v2). Before this, a
-- number typed with and without the leading zero created two patients.
-- Signature, SECURITY DEFINER, search_path and existing grants are unchanged.

CREATE OR REPLACE FUNCTION public.get_or_create_patient_code(p_phone text, p_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
    v_phone_canon text;
    v_crypto_key text;
    v_existing_patient_code uuid;
    v_phone_enc text;
    v_name_enc text;
    v_new_patient_code uuid;
begin
    v_phone_canon := public.phone_canon_v2(p_phone);

    if v_phone_canon is null then
        raise exception 'Phone is required';
    end if;

    -- existing patient, any phone form
    v_existing_patient_code := public.patient_code_by_phone_v2(p_phone);

    if v_existing_patient_code is not null then
        return v_existing_patient_code;
    end if;

    select value
    into v_crypto_key
    from public.app_config
    where key = 'crypto_key_b64';

    if v_crypto_key is null or length(trim(v_crypto_key)) = 0 then
        raise exception 'Missing crypto_key_b64 in app_config';
    end if;

    v_phone_enc :=
        'db1:' ||
        encode(
            pgp_sym_encrypt(
                v_phone_canon,
                v_crypto_key,
                'cipher-algo=aes256, compress-algo=0'
            ),
            'base64'
        );

    if p_name is not null and length(trim(p_name)) > 0 then
        v_name_enc :=
            'db1:' ||
            encode(
                pgp_sym_encrypt(
                    trim(p_name),
                    v_crypto_key,
                    'cipher-algo=aes256, compress-algo=0'
                ),
                'base64'
            );
    end if;

    insert into public.patient_identity_map (
        phone_hash,
        phone_enc,
        name_enc
    )
    values (
        public.phone_hash_v2(p_phone),
        v_phone_enc,
        v_name_enc
    )
    returning patient_code
    into v_new_patient_code;

    return v_new_patient_code;
end;
$function$;
