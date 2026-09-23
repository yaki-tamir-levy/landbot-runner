-- 23.9.2026 — owner decision (SESSION_HANDOFF 0.00 item 4, option B).
-- The BOT_PATIENTS sheet is the authority on a sheet patient's email:
-- an empty email cell now CLEARS the stored email. Previously it kept it.
-- The only change from the previous body is the email_enc CASE:
--   before: when v_email_clean is null then email_enc
--   after:  when v_email_clean is null then null
-- trg_patient_identity_map_email_guard clears email_hash when email_enc is null.
-- Intake patients are not synced through this function and are not affected.
-- Applied to the live database on 23.9.2026 via apply_migration
-- (sheet_empty_email_clears_email_20260923). Grants unchanged:
-- postgres and service_role only.

CREATE OR REPLACE FUNCTION public.upsert_users_information_v2_from_sheet(p_phone text, p_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_user_text text DEFAULT NULL::text, p_active text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_psychologist text DEFAULT NULL::text, p_therapy_track text DEFAULT NULL::text, p_gender text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_phone_normalized text;
  v_phone_masked     text;
  v_name_clean       text;
  v_email_clean      text;
  v_patient_code     uuid;
  v_psych_normalized text;
  v_psych_track      text;
  v_crypto_key       text;
  v_track            text;
  v_status_clean     text;
  v_gender           text;
begin
  v_phone_normalized :=
    nullif(regexp_replace(trim(p_phone), '[^0-9]', '', 'g'), '');

  if v_phone_normalized is null then
    raise exception 'Phone is required';
  end if;

  v_status_clean := btrim(coalesce(p_status, ''));
  v_track := upper(nullif(trim(coalesce(p_therapy_track, '')), ''));

  -- Gender is optional and tolerant of what a spreadsheet actually sends.
  -- Anything unrecognised becomes null rather than an error: a typo must not
  -- block a patient from syncing, it only leaves the wording neutral.
  v_gender := upper(btrim(coalesce(p_gender, '')));
  v_gender := case
    when v_gender in ('M', 'MALE', 'ZACHAR', 'זכר', 'ז') then 'M'
    when v_gender in ('F', 'FEMALE', 'NEKEVA', 'נקבה', 'נ') then 'F'
    else null
  end;

  if v_status_clean in ('1', '3') and (v_track is null or v_track = 'KURS') then
    raise exception 'therapy_track is required when status is % (patient requires a real therapy track, not KURS)', p_status;
  end if;

  if v_status_clean = '2' then
    v_track := 'KURS';
  end if;

  if v_track is null then
    v_track := 'NLP_CBT';
  end if;
  if v_track not in ('NLP_CBT', 'CLINIC', 'KURS') then
    raise exception 'invalid_therapy_track: %', v_track;
  end if;

  v_psych_normalized := regexp_replace(coalesce(p_psychologist, ''), '[^0-9]', '', 'g');

  if left(v_psych_normalized, 2) = '00' then
    v_psych_normalized := substr(v_psych_normalized, 3);
  end if;

  if left(v_psych_normalized, 4) = '0972' then
    v_psych_normalized := substr(v_psych_normalized, 5);
  elsif left(v_psych_normalized, 3) = '972' then
    v_psych_normalized := substr(v_psych_normalized, 4);
  elsif left(v_psych_normalized, 1) = '0' then
    v_psych_normalized := substr(v_psych_normalized, 2);
  end if;

  v_psych_normalized := '0' || v_psych_normalized;

  if v_psych_normalized !~ '^05[0-9]{8}$' then
    raise exception 'psychologist_required';
  end if;

  select therapy_track into v_psych_track
  from public.psychologists_v2
  where phone = v_psych_normalized and active = true;

  if v_psych_track is null then
    raise exception 'psychologist_not_found_or_inactive';
  end if;

  -- Track-match gate does not apply to KURS: course participation is not
  -- gated by the psychologist's clinical specialty track.
  if v_track <> 'KURS' and v_psych_track <> 'BOTH' and v_psych_track <> v_track then
    raise exception 'track_mismatch: psychologist=% patient=%',
      v_psych_track, v_track;
  end if;

  v_phone_masked :=
    case
      when length(v_phone_normalized) <= 6 then v_phone_normalized
      else left(v_phone_normalized, 3) || '***' || right(v_phone_normalized, 3)
    end;

  v_name_clean  := nullif(trim(p_name), '');
  v_email_clean := nullif(trim(p_email), '');

  v_patient_code :=
    public.get_or_create_patient_code(v_phone_normalized, v_name_clean);

  select value into v_crypto_key
  from public.app_config
  where key = 'crypto_key_b64';

  if v_crypto_key is null or length(trim(v_crypto_key)) = 0 then
    raise exception 'Missing crypto_key_b64 in app_config';
  end if;

  -- 23.9.2026, owner decision (option B): the sheet is the authority on a
  -- sheet patient's email. An empty email cell CLEARS the stored email
  -- (the email guard trigger then clears email_hash too). Intake patients are
  -- not synced through this function, so their emails are not affected.
  update public.patient_identity_map
  set
    name_enc = case
      when v_name_clean is null then name_enc
      else 'db1:' || encode(
        extensions.pgp_sym_encrypt(v_name_clean, v_crypto_key,
                                   'cipher-algo=aes256, compress-algo=0'),
        'base64')
    end,
    email_enc = case
      when v_email_clean is null then null
      else 'db1:' || encode(
        extensions.pgp_sym_encrypt(v_email_clean, v_crypto_key,
                                   'cipher-algo=aes256, compress-algo=0'),
        'base64')
    end,
    updated_at = now()
  where patient_code = v_patient_code;

  insert into public.users_information_v2 (
    patient_code, phone, user_text, active, status, psychologist,
    therapy_track, gender, created_at, updated_at
  )
  values (
    v_patient_code, v_phone_masked, p_user_text, p_active, p_status,
    v_psych_normalized, v_track, v_gender, now(), now()
  )
  on conflict (patient_code)
  do update set
    phone         = excluded.phone,
    user_text     = excluded.user_text,
    active        = excluded.active,
    status        = excluded.status,
    psychologist  = excluded.psychologist,
    therapy_track = excluded.therapy_track,
    -- An empty gender cell must not wipe a value that is already stored.
    gender        = coalesce(excluded.gender, users_information_v2.gender),
    updated_at    = now();

  return v_patient_code::text;
end;
$function$;
