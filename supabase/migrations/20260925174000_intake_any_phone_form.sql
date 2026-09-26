-- 25.9.2026: the intake (candidates) path accepts a phone with or without the
-- leading zero. intake_hash and intake_norm now use the canonical rule
-- (phone_canon_v2). Verified before the change: all 11 existing candidates
-- are stored with the zero and their stored hash already equals the
-- canonical hash, so no existing candidate row changes meaning.
-- The "is this phone already a patient" checks and the patient_code lookup
-- after acceptance go through patient_code_by_phone_v2 (any stored form).
-- Signatures, SECURITY DEFINER, search_path and grants unchanged.

CREATE OR REPLACE FUNCTION public.intake_hash(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
begin
  if public.phone_canon_v2(p_phone) is null then
    raise exception 'Phone is required';
  end if;
  return public.phone_hash_v2(p_phone);
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_norm(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_norm text;
begin
  v_norm := public.phone_canon_v2(p_phone);
  if v_norm is null then
    raise exception 'Phone is required';
  end if;
  return v_norm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_check_phone(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
begin
  -- raises 'Phone is required' on an empty phone, as before
  perform public.intake_hash(p_phone);
  if public.patient_code_by_phone_v2(p_phone) is not null then
    return 'taken';
  end if;
  return 'open';
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_start(p_phone text, p_name text, p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_hash text;
  v_row public.candidates_intake%rowtype;
  v_conv uuid;
begin
  v_hash := public.intake_hash(p_phone);

  if public.patient_code_by_phone_v2(p_phone) is not null then
    perform public.intake_log('blocked_already_patient', v_hash, null, null);
    return jsonb_build_object('state','taken');
  end if;

  select * into v_row from public.candidates_intake where phone_hash = v_hash;

  if found and v_row.processed = 'NEW' then
    perform public.intake_log('blocked_pending_decision', v_hash, null, null);
    return jsonb_build_object('state','pending');
  end if;

  if found and v_row.decision = 'ACCEPTED' then
    perform public.intake_log('blocked_already_accepted', v_hash, null, null);
    return jsonb_build_object('state','taken');
  end if;

  v_conv := gen_random_uuid();

  if found then
    update public.candidates_intake
       set conversation_id = v_conv,
           processed       = 'OPEN',
           name_enc        = coalesce(public.intake_enc(p_name), name_enc),
           email_enc       = coalesce(public.intake_enc(p_email), email_enc),
           updated_at      = now()
     where phone_hash = v_hash;

    perform public.intake_log('conversation_resumed', v_hash, v_conv,
      'missing: ' || coalesce(v_row.missing_fields::text,'[]'));

    return jsonb_build_object(
      'state','resume',
      'conversation_id', v_conv,
      'missing', coalesce(v_row.missing_fields, '[]'::jsonb));
  end if;

  insert into public.candidates_intake
    (phone_hash, phone_enc, name_enc, email_enc, conversation_id, processed)
  values
    (v_hash,
     public.intake_enc(public.intake_norm(p_phone)),
     public.intake_enc(p_name),
     public.intake_enc(p_email),
     v_conv,
     'OPEN');

  perform public.intake_log('candidate_created', v_hash, v_conv, null);

  return jsonb_build_object('state','new','conversation_id', v_conv);
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_apply_decision(p_phone_hash text, p_decision text, p_missing jsonb, p_background text, p_risk boolean DEFAULT false, p_gender text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_row public.candidates_intake%rowtype;
  v_phone text;
  v_name  text;
  v_email text;
  v_code  uuid;
  v_psy   text;
  v_track text;
  v_gender text;
begin
  if p_decision not in ('ACCEPTED','REJECTED') then
    raise exception 'intake: bad decision %', p_decision;
  end if;

  select * into v_row from public.candidates_intake where phone_hash = p_phone_hash;
  if not found then
    raise exception 'intake: unknown candidate';
  end if;

  if v_row.processed = 'DONE' and v_row.decision = 'ACCEPTED' then
    return jsonb_build_object('state','already_accepted');
  end if;

  -- Gender is inferred from the conversation, never asked. Anything the model
  -- is not certain about must arrive as null and stay null: a wrong guess
  -- addresses a patient in the wrong form, which is worse than neutral wording.
  v_gender := upper(btrim(coalesce(p_gender, '')));
  v_gender := case
    when v_gender in ('M', 'MALE', 'זכר', 'ז') then 'M'
    when v_gender in ('F', 'FEMALE', 'נקבה', 'נ') then 'F'
    else null
  end;

  v_phone := public.intake_dec(v_row.phone_enc);
  v_name  := public.intake_dec(v_row.name_enc);
  v_email := public.intake_dec(v_row.email_enc);

  if p_risk then
    perform public.intake_log('risk_flagged', p_phone_hash, v_row.conversation_id, null);
  end if;

  if p_decision = 'ACCEPTED' then
    select value into v_psy from public.app_config where key = 'intake_psychologist_phone';
    if v_psy is null or length(btrim(v_psy)) = 0 then
      perform public.intake_log('decision_failed', p_phone_hash, v_row.conversation_id,
        'missing intake_psychologist_phone');
      raise exception 'intake: missing intake_psychologist_phone in app_config';
    end if;

    select case when therapy_track = 'CLINIC' then 'CLINIC' else 'NLP_CBT' end
      into v_track
      from public.psychologists_v2
     where phone = btrim(v_psy) and active
     limit 1;

    if v_track is null then
      perform public.intake_log('decision_failed', p_phone_hash, v_row.conversation_id,
        'psychologist not found or inactive: ' || v_psy);
      raise exception 'intake: configured psychologist % not found or inactive', v_psy;
    end if;

    perform public.upsert_users_information_v2_from_sheet(
      p_phone         => v_phone,
      p_name          => v_name,
      p_email         => v_email,
      p_user_text     => p_background,
      p_active        => 'yes',
      p_status        => '1',
      p_psychologist  => btrim(v_psy),
      p_therapy_track => v_track,
      p_gender        => v_gender);

    -- 25.9.2026: by phone (any stored form), not by the candidate hash.
    v_code := public.patient_code_by_phone_v2(v_phone);

    -- מקור המטופל וסטטוס. פעולה נפרדת, ואינה נוגעת בפונקציית הסנכרון מהגיליון.
    if v_code is not null then
      update public.users_information_v2
         set patient_origin = 'INTAKE',
             status         = '1'
       where patient_code = v_code;
    end if;

    perform public.intake_log('patient_created', p_phone_hash, v_row.conversation_id,
      'track: ' || v_track || ' | psychologist: ' || btrim(v_psy)
      || ' | gender: ' || coalesce(v_gender, 'unknown'));
  end if;

  update public.candidates_intake
     set decision       = p_decision,
         missing_fields = coalesce(p_missing,'[]'::jsonb),
         background     = p_background,
         risk_flag      = coalesce(p_risk,false),
         gender         = coalesce(v_gender, gender),
         patient_code   = coalesce(v_code, patient_code),
         processed      = 'DONE',
         decided_at     = now(),
         updated_at     = now()
   where phone_hash = p_phone_hash;

  perform public.intake_log(
    case when p_decision = 'ACCEPTED' then 'decision_accepted' else 'decision_rejected' end,
    p_phone_hash, v_row.conversation_id,
    'missing: ' || coalesce(p_missing::text,'[]'));

  return jsonb_build_object(
    'state', lower(p_decision),
    'patient_code', v_code,
    'name',  v_name,
    'phone', v_phone,
    'email', v_email,
    'track', v_track,
    'gender', v_gender,
    'risk',  coalesce(p_risk,false));
end;
$function$;
