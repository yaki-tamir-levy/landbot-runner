-- מסלול הקבלה — שתים־עשרה הפונקציות
-- העתק מצב חי, נשלף מהמסד ב-9.8.2026 באמצעות pg_get_functiondef.
-- אין להריץ על המסד הקיים. הקובץ קיים כדי שלא יהיה קוד פרוס בלי עקבה.

-- ============================ עזר: נרמול, טביעה, הצפנה ============================

CREATE OR REPLACE FUNCTION public.intake_norm(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_norm text;
begin
  v_norm := nullif(regexp_replace(trim(coalesce(p_phone,'')), '[^0-9]', '', 'g'), '');
  if v_norm is null then
    raise exception 'Phone is required';
  end if;
  if length(v_norm) = 12 and left(v_norm,3) = '972' then
    v_norm := '0' || substr(v_norm,4);
  end if;
  return v_norm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_hash(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_norm text;
begin
  v_norm := nullif(regexp_replace(trim(coalesce(p_phone,'')), '[^0-9]', '', 'g'), '');
  if v_norm is null then
    raise exception 'Phone is required';
  end if;
  if length(v_norm) = 12 and left(v_norm,3) = '972' then
    v_norm := '0' || substr(v_norm,4);
  end if;
  return encode(digest(v_norm,'sha256'),'hex');
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_enc(p_value text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_key text;
begin
  if p_value is null or length(trim(p_value)) = 0 then
    return null;
  end if;
  select value into v_key from public.app_config where key = 'crypto_key_b64';
  if v_key is null or length(trim(v_key)) = 0 then
    raise exception 'Missing crypto_key_b64 in app_config';
  end if;
  return 'db1:' || encode(
    pgp_sym_encrypt(trim(p_value), v_key, 'cipher-algo=aes256, compress-algo=0'),
    'base64');
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_dec(p_value text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_key text;
begin
  if p_value is null or p_value not like 'db1:%' then
    return null;
  end if;
  select value into v_key from public.app_config where key = 'crypto_key_b64';
  if v_key is null then
    raise exception 'Missing crypto_key_b64 in app_config';
  end if;
  return pgp_sym_decrypt(decode(substr(p_value,5),'base64'), v_key);
end;
$function$;

-- ============================ מסלול השיחה ============================

CREATE OR REPLACE FUNCTION public.intake_check_phone(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_hash text;
begin
  v_hash := public.intake_hash(p_phone);
  if exists (select 1 from public.patient_identity_map where phone_hash = v_hash) then
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

  if exists (select 1 from public.patient_identity_map where phone_hash = v_hash) then
    return jsonb_build_object('state','taken');
  end if;

  select * into v_row from public.candidates_intake where phone_hash = v_hash;

  if found and v_row.processed = 'NEW' then
    return jsonb_build_object('state','pending');
  end if;

  if found and v_row.decision = 'ACCEPTED' then
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

  return jsonb_build_object('state','new','conversation_id', v_conv);
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_add_turn(p_conversation_id uuid, p_question text, p_answer text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_hash text;
begin
  select phone_hash into v_hash
  from public.candidates_intake
  where conversation_id = p_conversation_id and processed = 'OPEN';

  if v_hash is null then
    raise exception 'intake: unknown or closed conversation';
  end if;

  insert into public.conversations_intake
    (conversation_id, phone_hash, question, answer)
  values (p_conversation_id, v_hash, p_question, p_answer);

  update public.candidates_intake
     set updated_at = now()
   where conversation_id = p_conversation_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_history(p_conversation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('q', question, 'a', answer) order by created_at), '[]'::jsonb)
    into v
  from public.conversations_intake
  where conversation_id = p_conversation_id;
  return v;
end;
$function$;

-- ============================ המהלך המושהה ============================

CREATE OR REPLACE FUNCTION public.intake_sweep(p_idle_minutes integer DEFAULT 15)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_count integer := 0;
  r record;
  v_talk text;
begin
  for r in
    select c.phone_hash
    from public.candidates_intake c
    where c.processed = 'OPEN'
      and exists (select 1 from public.conversations_intake t
                  where t.phone_hash = c.phone_hash)
      and (select max(t.created_at) from public.conversations_intake t
           where t.phone_hash = c.phone_hash) < now() - make_interval(mins => p_idle_minutes)
  loop
    select string_agg(line, E'\n\n' order by ord)
      into v_talk
      from (
        select t.created_at as ord,
               concat_ws(E'\n',
                 case when nullif(btrim(coalesce(t.question,'')),'') is not null
                      then 'q: ' || t.question end,
                 case when nullif(btrim(coalesce(t.answer,'')),'') is not null
                      then 'a: ' || t.answer end) as line
        from public.conversations_intake t
        where t.phone_hash = r.phone_hash
      ) s;

    update public.candidates_intake
       set linked_talk = v_talk,
           processed   = 'NEW',
           updated_at  = now()
     where phone_hash = r.phone_hash;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_pending()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'phone_hash', phone_hash,
           'talk', linked_talk) order by updated_at), '[]'::jsonb)
    into v
  from public.candidates_intake
  where processed = 'NEW' and linked_talk is not null;
  return v;
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_mark_error(p_phone_hash text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
begin
  update public.candidates_intake
     set processed  = 'ERROR',
         updated_at = now()
   where phone_hash = p_phone_hash
     and processed  = 'NEW';
end;
$function$;

CREATE OR REPLACE FUNCTION public.intake_apply_decision(p_phone_hash text, p_decision text, p_missing jsonb, p_background text, p_risk boolean DEFAULT false)
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

  v_phone := public.intake_dec(v_row.phone_enc);
  v_name  := public.intake_dec(v_row.name_enc);
  v_email := public.intake_dec(v_row.email_enc);

  if p_decision = 'ACCEPTED' then
    -- המטפל אינו קבוע בקוד. הוא הגדרה, וניתן להחליפו בלי לגעת בפונקציה.
    select value into v_psy from public.app_config where key = 'intake_psychologist_phone';
    if v_psy is null or length(btrim(v_psy)) = 0 then
      raise exception 'intake: missing intake_psychologist_phone in app_config';
    end if;

    -- המסלול נגזר מהמטפל עצמו, ולכן track_mismatch אינו יכול לקרות.
    select case when therapy_track = 'CLINIC' then 'CLINIC' else 'NLP_CBT' end
      into v_track
      from public.psychologists_v2
     where phone = btrim(v_psy) and active
     limit 1;

    if v_track is null then
      raise exception 'intake: configured psychologist % not found or inactive', v_psy;
    end if;

    perform public.upsert_users_information_v2_from_sheet(
      p_phone         => v_phone,
      p_name          => v_name,
      p_email         => v_email,
      p_user_text     => p_background,
      p_active        => 'yes',
      p_status        => null,
      p_psychologist  => btrim(v_psy),
      p_therapy_track => v_track);

    select patient_code into v_code
    from public.patient_identity_map
    where phone_hash = p_phone_hash;
  end if;

  update public.candidates_intake
     set decision       = p_decision,
         missing_fields = coalesce(p_missing,'[]'::jsonb),
         background     = p_background,
         risk_flag      = coalesce(p_risk,false),
         patient_code   = coalesce(v_code, patient_code),
         processed      = 'DONE',
         decided_at     = now(),
         updated_at     = now()
   where phone_hash = p_phone_hash;

  return jsonb_build_object(
    'state', lower(p_decision),
    'patient_code', v_code,
    'name',  v_name,
    'phone', v_phone,
    'email', v_email,
    'track', v_track,
    'risk',  coalesce(p_risk,false));
end;
$function$;

-- ============================ הרשאות ============================
-- חובה אחרי כל CREATE OR REPLACE. ברירת המחדל מחזירה EXECUTE ל-PUBLIC.

revoke all on function public.intake_norm(text)          from public, anon, authenticated;
revoke all on function public.intake_hash(text)          from public, anon, authenticated;
revoke all on function public.intake_enc(text)           from public, anon, authenticated;
revoke all on function public.intake_dec(text)           from public, anon, authenticated;
revoke all on function public.intake_check_phone(text)   from public, anon, authenticated;
revoke all on function public.intake_start(text,text,text)        from public, anon, authenticated;
revoke all on function public.intake_add_turn(uuid,text,text)     from public, anon, authenticated;
revoke all on function public.intake_history(uuid)                from public, anon, authenticated;
revoke all on function public.intake_sweep(integer)               from public, anon, authenticated;
revoke all on function public.intake_pending()                    from public, anon, authenticated;
revoke all on function public.intake_mark_error(text)             from public, anon, authenticated;
revoke all on function public.intake_apply_decision(text,text,jsonb,text,boolean) from public, anon, authenticated;
