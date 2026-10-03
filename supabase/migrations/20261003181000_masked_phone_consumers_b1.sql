-- 20261003181000_masked_phone_consumers_b1.sql
-- Stage B1 of removing the stored masked phone: five small consumers stop
-- reading users_information_v2.phone / patient_identity_map.phone and take the
-- masked phone from public.patient_masked_phone_v2(patient_code) instead.
-- Signatures, return shapes, grants and view columns are unchanged.
--
--   1. admin_patient_lookup_v2      'phone_masked'
--   2. get_last_users_thread_v2     column phone
--   3. quality_conversations_for_day_v2  'phone'
--   4. auth_code_notify_claim       patient phone (psychologist branch unchanged)
--   5. conversation_events_v2_view  column phone_masked (computed once per patient)
--
-- Rollback: re-apply the previous definitions (taken from the live database
-- on 3.10.2026 before this migration; recorded in docs/SESSION_LOG.md).

-- 1 ---------------------------------------------------------------------------
create or replace function public.admin_patient_lookup_v2(p_patient_code uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  c_hourly_cap constant int := 20;
  v_email  text := lower(nullif(btrim(auth.jwt() ->> 'email'), ''));
  v_uid    uuid := auth.uid();
  v_recent int;
  v_map    public.patient_identity_map%rowtype;
  v_user   public.users_information_v2%rowtype;
begin
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
    'phone_masked',   public.patient_masked_phone_v2(v_map.patient_code),
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
$function$;

-- 2 ---------------------------------------------------------------------------
create or replace function public.get_last_users_thread_v2(p_phone text)
returns table(name text, user_text text, phone text, conversation text, active text, status text, disclaimed text, therapy_track text, gender text)
language sql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
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
  public.patient_masked_phone_v2(pim.patient_code) as phone,
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

-- 3 ---------------------------------------------------------------------------
create or replace function public.quality_conversations_for_day_v2(p_day date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_from timestamptz := p_day::timestamp at time zone 'Asia/Jerusalem';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'Asia/Jerusalem';
begin
  return (
    with act as (
      select s.conversation_id, s.patient_code, s.source
        from conversations_session_v2 s
       where coalesce(s.source, '') <> 'D'
         and exists (select 1 from corrector_test_log c
                      where c.conversation_id = s.conversation_id
                        and c.created_at >= v_from and c.created_at < v_to))
    select coalesce(jsonb_agg(jsonb_build_object(
             'conversation_id', a.conversation_id,
             'patient_code', a.patient_code,
             'source', a.source,
             'phone', public.patient_masked_phone_v2(a.patient_code),
             'psychologist', coalesce(p.name, '(לא משויך)'),
             'turns', (select jsonb_agg(jsonb_build_object(
                          'q', c.question,
                          'a', coalesce(c.corrected_answer, c.candidate_answer))
                          order by c.created_at)
                         from corrector_test_log c
                        where c.conversation_id = a.conversation_id
                          and c.created_at < v_to))
           order by a.conversation_id), '[]'::jsonb)
      from act a
      left join users_information_v2 u on u.patient_code = a.patient_code
      left join psychologists_v2 p
             on regexp_replace(coalesce(p.phone, ''), '\D', '', 'g')
              = regexp_replace(coalesce(u.psychologist, ''), '\D', '', 'g')
            and coalesce(u.psychologist, '') <> ''
  );
end;
$function$;

-- 4 ---------------------------------------------------------------------------
create or replace function public.auth_code_notify_claim(p_audit_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_action  text;
  v_email   text;
  v_created timestamptz;
  v_is_psy  boolean := false;
  v_is_pat  boolean := false;
  v_psy_ph  text;
  v_pat_ph  text;
  v_role    text;
  v_admin   text;
  v_log_id  bigint;
begin
  select a.payload->>'action', lower(btrim(a.payload->>'actor_username')), a.created_at
    into v_action, v_email, v_created
    from auth.audit_log_entries a
   where a.id = p_audit_id
     and a.payload->>'action' in ('user_recovery_requested', 'user_confirmation_requested')
     and a.created_at > now() - interval '10 minutes';
  if v_action is null then
    return null;
  end if;

  select true, case when p.phone ~ '^[0-9]{7,}$' then left(p.phone, 3) || '***' || right(p.phone, 3) else p.phone end
    into v_is_psy, v_psy_ph
    from public.psychologists_v2 p
   where lower(btrim(p.email)) = v_email
   limit 1;

  select true, public.patient_masked_phone_v2(m.patient_code)
    into v_is_pat, v_pat_ph
    from public.patient_identity_map m
   where m.email_hash = encode(extensions.digest(v_email, 'sha256'), 'hex')
   limit 1;

  v_role := case
    when coalesce(v_is_psy, false) and coalesce(v_is_pat, false) then 'both'
    when coalesce(v_is_psy, false) then 'psychologist'
    when coalesce(v_is_pat, false) then 'patient'
    else 'unknown' end;

  select btrim(p.email) into v_admin
    from public.psychologists_v2 p
   where p.is_admin and p.active and coalesce(btrim(p.email), '') <> ''
   order by p.created_at
   limit 1;

  insert into public.email_send_log (sender, kind, recipient, subject, ok, error, meta)
  values ('auth_code_notify', 'auth_code', coalesce(v_admin, ''), null, false, 'pending',
          jsonb_build_object('audit_id', p_audit_id::text, 'action', v_action, 'role', v_role,
                             'event_at', v_created))
  on conflict ((meta->>'audit_id')) where sender = 'auth_code_notify' do nothing
  returning id into v_log_id;

  if v_log_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'log_id', v_log_id,
    'action', v_action,
    'email', v_email,
    'created_at', v_created,
    'role', v_role,
    'phone', case v_role when 'patient' then v_pat_ph else coalesce(v_psy_ph, v_pat_ph) end,
    'admin_email', v_admin);
end;
$function$;

-- 5 ---------------------------------------------------------------------------
create or replace view public.conversation_events_v2_view as
 WITH conversation_start AS (
         SELECT conversation_events_v2.conversation_id,
            max(conversation_events_v2.created_at) AS conversation_started_at
           FROM conversation_events_v2
          WHERE (conversation_events_v2.event_name = 'conversation_started'::text)
          GROUP BY conversation_events_v2.conversation_id
        ), masked AS (
         SELECT m.patient_code,
            public.patient_masked_phone_v2(m.patient_code) AS phone_masked
           FROM patient_identity_map m
        )
 SELECT "right"((e.conversation_id)::text, 4) AS conversation_suffix,
        CASE
            WHEN (e.event_name = 'process_queue_created'::text) THEN '-> process_queue_v2'::text
            WHEN (e.event_name = 'users_tzvira_updated'::text) THEN '-> users_tzvira_v2'::text
            WHEN (e.event_name = 'postprocess_completed'::text) THEN '----------------------------------------'::text
            ELSE e.source_table
        END AS source_table,
    e.event_name,
    e.patient_code,
    e.created_at,
    e.source_id,
    e.details,
    e.id,
    mk.phone_masked,
    s.started_at,
    e.conversation_id,
    s.source,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM conversation_events_v2 pe
              WHERE ((pe.conversation_id = e.conversation_id) AND (pe.event_name = 'postprocess_completed'::text)))) THEN 'Completed'::text
            ELSE s.current_stage
        END AS conversation_status,
    psy.name AS psychologist_name
   FROM (((((conversation_events_v2 e
     JOIN conversation_start cs ON ((cs.conversation_id = e.conversation_id)))
     LEFT JOIN conversations_session_v2 s ON ((s.conversation_id = e.conversation_id)))
     LEFT JOIN masked mk ON ((mk.patient_code = e.patient_code)))
     LEFT JOIN users_information_v2 ui ON ((ui.patient_code = e.patient_code)))
     LEFT JOIN psychologists_v2 psy ON ((psy.phone = ui.psychologist)))
  ORDER BY s.started_at DESC NULLS LAST, cs.conversation_started_at DESC,
        CASE e.event_name
            WHEN 'conversation_started'::text THEN 1
            WHEN 'users_total_updated'::text THEN 2
            WHEN 'process_queue_created'::text THEN 3
            WHEN 'users_tzvira_updated'::text THEN 4
            WHEN 'postprocess_completed'::text THEN 5
            ELSE 999
        END, e.created_at, e.id;

notify pgrst, 'reload schema';
