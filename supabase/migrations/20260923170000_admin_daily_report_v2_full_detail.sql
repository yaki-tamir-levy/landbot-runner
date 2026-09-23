-- 23.9.2026: admin daily report — every item that can be itemised is itemised
-- (owner request, temporary; the switch app_config 'admin_daily_report_detail'
-- still reduces everything to counts).
-- Adds:
--   email_send_log.body                  the email text, for the report
--   admin_report_mask_phone(text)        050***123 style mask of a full phone
--   admin_daily_report_v2 (replaced)     itemised lists in every section:
--     updated patients, intake candidates, conversation turns (question and
--     answer, 500 chars each), test/simulation calls, intake conversation
--     turns, admin lookups, read-flag toggles, code sends, wrong-code phones,
--     failed cron runs, migration runs that processed rows, queue errors,
--     summaries and snapshots written, script email bodies.
-- Applied to the live database on 23.9.2026 via apply_migration
-- (admin_daily_report_v2_full_detail_20260923).

alter table public.email_send_log add column if not exists body text;

create or replace function public.admin_report_mask_phone(p text)
returns text
language sql
immutable
set search_path to 'pg_catalog'
as $f$
  select case
    when p is null then null
    when length(regexp_replace(p, '[^0-9]', '', 'g')) <= 6 then regexp_replace(p, '[^0-9]', '', 'g')
    else left(regexp_replace(p, '[^0-9]', '', 'g'), 3) || '***' || right(regexp_replace(p, '[^0-9]', '', 'g'), 3)
  end
$f$;

revoke all on function public.admin_report_mask_phone(text) from public, anon, authenticated;
grant execute on function public.admin_report_mask_phone(text) to service_role;

create or replace function public.admin_daily_report_v2(p_day date default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_day   date := coalesce(p_day, (now() at time zone 'Asia/Jerusalem')::date - 1);
  v_from  timestamptz;
  v_to    timestamptz;
  v_full  boolean;
  v_key   text;
  r       jsonb := '{}'::jsonb;
begin
  v_from := v_day::timestamp at time zone 'Asia/Jerusalem';
  v_to   := (v_day + 1)::timestamp at time zone 'Asia/Jerusalem';
  v_full := coalesce((select btrim(value) from public.app_config
                      where key = 'admin_daily_report_detail'), '') = 'full';
  v_key  := (select value from public.app_config where key = 'crypto_key_b64');

  r := jsonb_build_object(
    'day', v_day, 'from', v_from, 'to', v_to,
    'detail', case when v_full then 'full' else 'counts' end,
    'generated_at', now());

  -- ---------- people ----------
  r := r || jsonb_build_object('people', (
    with cand as (
      select c.*,
             coalesce(u.phone,
               case when c.phone_enc like 'db1:%' and v_key is not null then
                 admin_report_mask_phone(pgp_sym_decrypt(decode(substr(c.phone_enc, 5), 'base64'), v_key)) end) as mphone
        from candidates_intake c
        left join users_information_v2 u on u.patient_code = c.patient_code
       where (c.created_at >= v_from and c.created_at < v_to)
          or (c.decided_at >= v_from and c.decided_at < v_to))
    select jsonb_build_object(
      'new_psychologists_count',
        (select count(*) from psychologists_v2 where created_at >= v_from and created_at < v_to),
      'new_psychologists', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'active', active,
                  'is_admin', is_admin, 'track', therapy_track, 'organization', organization,
                  'at', created_at) order by created_at), '[]'::jsonb)
           from psychologists_v2 where created_at >= v_from and created_at < v_to) end,
      'new_patients_count',
        (select count(*) from users_information_v2 where created_at >= v_from and created_at < v_to),
      'new_patients', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('phone', u.phone, 'origin', u.patient_origin,
                  'status', u.status, 'active', u.active, 'track', u.therapy_track, 'gender', u.gender,
                  'psychologist', p.name, 'at', u.created_at) order by u.created_at), '[]'::jsonb)
           from users_information_v2 u left join psychologists_v2 p on p.phone = u.psychologist
          where u.created_at >= v_from and u.created_at < v_to) end,
      'updated_patients_count',
        (select count(*) from users_information_v2
          where updated_at >= v_from and updated_at < v_to and created_at < v_from),
      'updated_patients', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('phone', u.phone, 'origin', u.patient_origin,
                  'status', u.status, 'active', u.active, 'psychologist', p.name, 'at', u.updated_at)
                  order by u.updated_at), '[]'::jsonb)
           from users_information_v2 u left join psychologists_v2 p on p.phone = u.psychologist
          where u.updated_at >= v_from and u.updated_at < v_to and u.created_at < v_from) end,
      'intake_new_candidates',
        (select count(*) from candidates_intake where created_at >= v_from and created_at < v_to),
      'intake_decided',
        (select coalesce(jsonb_object_agg(coalesce(decision, '(none)'), n), '{}'::jsonb)
           from (select decision, count(*) n from candidates_intake
                  where decided_at >= v_from and decided_at < v_to group by decision) d),
      'intake_risk_flagged',
        (select count(*) from candidates_intake
          where created_at >= v_from and created_at < v_to and risk_flag),
      'intake_candidates', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('phone', mphone, 'created_at', created_at,
                  'decided_at', decided_at, 'decision', decision, 'processed', processed,
                  'risk_flag', risk_flag, 'missing_fields', missing_fields, 'gender', gender)
                  order by created_at), '[]'::jsonb) from cand) end)
  ));

  -- ---------- conversations ----------
  r := r || jsonb_build_object('conversations', (
    with ct as (
      select c.*,
             exists (select 1 from conversations_session_v2 s where s.conversation_id = c.conversation_id) as prod
        from corrector_test_log c
       where c.created_at >= v_from and c.created_at < v_to),
    act as (
      select s.conversation_id, s.patient_code, s.source, s.started_at, s.current_stage
        from conversations_session_v2 s
       where (s.started_at >= v_from and s.started_at < v_to)
          or s.conversation_id in (select conversation_id from ct where prod)),
    ci as (
      select i.*, (select coalesce(u.phone,
                     case when c.phone_enc like 'db1:%' and v_key is not null then
                       admin_report_mask_phone(pgp_sym_decrypt(decode(substr(c.phone_enc, 5), 'base64'), v_key)) end)
                     from candidates_intake c left join users_information_v2 u on u.patient_code = c.patient_code
                    where c.phone_hash = i.phone_hash limit 1) as mphone
        from conversations_intake i
       where i.created_at >= v_from and i.created_at < v_to)
    select jsonb_build_object(
      'sessions_started',
        (select count(*) from conversations_session_v2 where started_at >= v_from and started_at < v_to),
      'active_sessions', (select count(*) from act),
      'turns', (select count(*) from ct where prod),
      'test_or_sim_calls', (select count(*) from ct where not prod),
      'corrector_decisions', (select coalesce(jsonb_object_agg(coalesce(corrector_decision, '(none)'), n), '{}'::jsonb)
                                from (select corrector_decision, count(*) n from ct where prod group by corrector_decision) d),
      'sessions', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('phone', u.phone, 'source', a.source,
                  'stage', a.current_stage, 'started_at', a.started_at,
                  'turns_day', (select count(*) from ct where ct.conversation_id = a.conversation_id),
                  'turns_total', (select count(*) from corrector_test_log c where c.conversation_id = a.conversation_id),
                  'items', (select coalesce(jsonb_agg(jsonb_build_object('at', ct.created_at,
                              'q', left(ct.question, 500),
                              'a', left(coalesce(ct.corrected_answer, ct.candidate_answer), 500),
                              'decision', ct.corrector_decision, 'reasons', ct.reason_codes)
                              order by ct.created_at), '[]'::jsonb)
                              from ct where ct.conversation_id = a.conversation_id))
                  order by a.started_at), '[]'::jsonb)
           from act a left join users_information_v2 u on u.patient_code = a.patient_code) end,
      'test_or_sim_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('at', created_at,
                  'phone', admin_report_mask_phone(phone), 'q', left(question, 200),
                  'decision', corrector_decision) order by created_at), '[]'::jsonb)
           from ct where not prod) end,
      'intake_conversations', (select count(distinct conversation_id) from ci),
      'intake_turns', (select count(*) from ci),
      'intake_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'phone', mphone,
                  'q', left(question, 500), 'a', left(answer, 500)) order by created_at), '[]'::jsonb)
           from ci) end)
  ));

  -- ---------- risks (by conversation time; risk_reviews_v2 has no creation time) ----------
  r := r || jsonb_build_object('risks', (
    with rr as (
      select x.*, u.phone as mphone
        from (select *, case when time_key ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}'
                             then time_key::timestamptz end as tk
                from risk_reviews_v2) x
        left join users_information_v2 u on u.patient_code = x.patient_code
       where x.tk >= v_from and x.tk < v_to)
    select jsonb_build_object(
      'count', (select count(*) from rr),
      'by_severity', (select coalesce(jsonb_object_agg(coalesce(severity, '(none)'), n), '{}'::jsonb)
                        from (select severity, count(*) n from rr group by severity) s),
      'by_method', (select coalesce(jsonb_object_agg(coalesce(match_method, '(none)'), n), '{}'::jsonb)
                      from (select match_method, count(*) n from rr group by match_method) m),
      'items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('phone', mphone, 'severity', severity,
                  'method', match_method, 'status', status, 'reasons', risk_reasons,
                  'text', short_risk, 'line', line_num, 'reviewer', reviewer,
                  'notes', review_notes, 'at', tk) order by tk), '[]'::jsonb) from rr) end)
  ));

  -- ---------- logins and access ----------
  r := r || jsonb_build_object('access', (
    with psy as (select lower(btrim(email)) em, name from psychologists_v2 where email is not null),
    lg as (
      select a.created_at, lower(btrim(a.payload->>'actor_username')) em
        from auth.audit_log_entries a
       where a.created_at >= v_from and a.created_at < v_to and a.payload->>'action' = 'login'),
    vf as (
      select v.*, (select u.phone from patient_identity_map m join users_information_v2 u on u.patient_code = m.patient_code
                    where m.phone_hash = v.phone_hash limit 1) as mphone
        from meitar_verify_attempts v
       where v.updated_at >= v_from and v.updated_at < v_to and v.fails > 0)
    select jsonb_build_object(
      'psychologist_logins', (select count(*) from lg join psy on psy.em = lg.em),
      'psychologist_login_list', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('name', psy.name, 'at', lg.created_at)
                  order by lg.created_at), '[]'::jsonb) from lg join psy on psy.em = lg.em) end,
      'patient_code_logins', (select count(*) from lg where lg.em not in (select em from psy)),
      'patient_code_login_list', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('phone', coalesce(u.phone, '(unmatched)'),
                  'at', lg.created_at) order by lg.created_at), '[]'::jsonb)
           from lg
           left join patient_identity_map m on m.email_hash = encode(digest(lg.em, 'sha256'), 'hex')
           left join users_information_v2 u on u.patient_code = m.patient_code
          where lg.em not in (select em from psy)) end,
      'no_code_logins', 'not_recorded_in_db',
      'admin_lookups', (select coalesce(jsonb_object_agg(coalesce(outcome, '(none)'), n), '{}'::jsonb)
                          from (select outcome, count(*) n from admin_patient_lookup_log_v2
                                 where created_at >= v_from and created_at < v_to group by outcome) o),
      'admin_lookup_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('at', l.created_at, 'by', l.caller_email,
                  'outcome', l.outcome, 'query', l.query_masked_phone, 'patient', u.phone)
                  order by l.created_at), '[]'::jsonb)
           from admin_patient_lookup_log_v2 l left join users_information_v2 u on u.patient_code = l.patient_code
          where l.created_at >= v_from and l.created_at < v_to) end,
      'read_flag_toggles', (select count(*) from talk_read_flags where toggled_at >= v_from and toggled_at < v_to),
      'read_flag_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('at', t.toggled_at, 'by', t.toggled_by,
                  'hidden', t.is_hidden, 'patient', u.phone, 'talk', t.time_key) order by t.toggled_at), '[]'::jsonb)
           from talk_read_flags t left join users_information_v2 u on u.patient_code = t.patient_code
          where t.toggled_at >= v_from and t.toggled_at < v_to) end,
      'otp_phones_sent', (select count(*) from otp_send_log where last_sent_at >= v_from and last_sent_at < v_to),
      'otp_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('phone', admin_report_mask_phone(phone),
                  'last_sent', last_sent_at, 'count_total', send_count) order by last_sent_at), '[]'::jsonb)
           from otp_send_log where last_sent_at >= v_from and last_sent_at < v_to) end,
      'wrong_code_phones', (select count(*) from vf),
      'wrong_code_total', (select coalesce(sum(fails), 0) from vf),
      'wrong_code_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('phone', coalesce(mphone, '(unmatched)'),
                  'fails', fails, 'first_fail', first_fail_at, 'last', updated_at) order by updated_at), '[]'::jsonb)
           from vf) end)
  ));

  -- ---------- automation ----------
  r := r || jsonb_build_object('automation', jsonb_build_object(
    'cron', (select coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'schedule', j.schedule,
               'runs', (select count(*) from cron.job_run_details d where d.jobid = j.jobid
                          and d.start_time >= v_from and d.start_time < v_to),
               'fails', (select count(*) from cron.job_run_details d where d.jobid = j.jobid
                          and d.start_time >= v_from and d.start_time < v_to and d.status <> 'succeeded'))
               order by j.jobid), '[]'::jsonb)
             from cron.job j where j.active),
    'cron_failures', case when v_full then
      (select coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'at', d.start_time,
                'status', d.status, 'message', left(d.return_message, 500)) order by d.start_time), '[]'::jsonb)
         from cron.job_run_details d join cron.job j on j.jobid = d.jobid
        where d.start_time >= v_from and d.start_time < v_to and d.status <> 'succeeded') end,
    'guarded_runs', (select jsonb_build_object('runs', count(*),
                       'processed', coalesce(sum(processed_count), 0),
                       'skipped', coalesce(sum(skipped_count), 0))
                       from supa_guarded_run_log where started_at >= v_from and started_at < v_to),
    'guarded_items', case when v_full then
      (select coalesce(jsonb_agg(jsonb_build_object('at', started_at, 'processed', processed_count,
                'skipped', skipped_count, 'ms', duration_ms, 'message', left(return_message, 300))
                order by started_at), '[]'::jsonb)
         from supa_guarded_run_log
        where started_at >= v_from and started_at < v_to
          and (coalesce(processed_count, 0) > 0 or coalesce(skipped_count, 0) > 0)) end,
    'queue_now', (select coalesce(jsonb_object_agg(coalesce(status, '(none)'), n), '{}'::jsonb)
                    from (select status, count(*) n from process_queue_v2 group by status) q),
    'queue_errors_day', (select count(*) from process_queue_v2
                          where updated_at >= v_from and updated_at < v_to and last_error is not null),
    'queue_error_items', case when v_full then
      (select coalesce(jsonb_agg(jsonb_build_object('at', q.updated_at, 'status', q.status,
                'patient', u.phone, 'error', left(q.last_error, 500)) order by q.updated_at), '[]'::jsonb)
         from process_queue_v2 q left join users_information_v2 u on u.patient_code = q.patient_code
        where q.updated_at >= v_from and q.updated_at < v_to and q.last_error is not null) end,
    'summaries_written', (select count(*) from users_total_v2 where last_summary_at >= v_from and last_summary_at < v_to),
    'summary_items', case when v_full then
      (select coalesce(jsonb_agg(jsonb_build_object('at', t.last_summary_at, 'patient', u.phone,
                'processed', t.processed, 'risk', t.summarized_linked_talk_risk,
                'short', left(t.short_summarized, 500)) order by t.last_summary_at), '[]'::jsonb)
         from users_total_v2 t left join users_information_v2 u on u.patient_code = t.patient_code
        where t.last_summary_at >= v_from and t.last_summary_at < v_to) end,
    'ab_updated', (select count(*) from users_total_v2 where ab_updated_at >= v_from and ab_updated_at < v_to),
    'ab_items', case when v_full then
      (select coalesce(jsonb_agg(jsonb_build_object('at', t.ab_updated_at, 'patient', u.phone,
                'ab', left(t.ab, 600)) order by t.ab_updated_at), '[]'::jsonb)
         from users_total_v2 t left join users_information_v2 u on u.patient_code = t.patient_code
        where t.ab_updated_at >= v_from and t.ab_updated_at < v_to) end,
    'github_actions', 'not_in_db'
  ));

  -- ---------- emails ----------
  r := r || jsonb_build_object('emails', (
    with psy as (select lower(btrim(email)) em from psychologists_v2 where email is not null),
    au as (
      select a.created_at, a.payload->>'action' act, lower(btrim(a.payload->>'actor_username')) em
        from auth.audit_log_entries a
       where a.created_at >= v_from and a.created_at < v_to
         and a.payload->>'action' in ('user_confirmation_requested', 'user_recovery_requested',
                                      'user_repeated_signup', 'user_invited', 'user_reauthenticate_requested')),
    sl as (select * from email_send_log where sent_at >= v_from and sent_at < v_to)
    select jsonb_build_object(
      'auth_count', (select count(*) from au),
      'auth_by_action', (select coalesce(jsonb_object_agg(act, n), '{}'::jsonb)
                           from (select act, count(*) n from au group by act) x),
      'auth_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('action', act,
                  'to', case when em in (select em from psy) then em
                             else left(split_part(em, '@', 1), 2) || '***@' || split_part(em, '@', 2) end,
                  'patient', (select u.phone from patient_identity_map m join users_information_v2 u on u.patient_code = m.patient_code
                               where m.email_hash = encode(digest(au.em, 'sha256'), 'hex') limit 1),
                  'at', created_at) order by created_at), '[]'::jsonb) from au) end,
      'system_count', (select count(*) from sl),
      'system_failed', (select count(*) from sl where not ok),
      'system_by_sender', (select coalesce(jsonb_object_agg(sender, n), '{}'::jsonb)
                             from (select sender, count(*) n from sl group by sender) x),
      'system_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('sender', sender, 'kind', kind,
                  'to', case when lower(btrim(recipient)) in (select em from psy) then recipient
                             else left(split_part(recipient, '@', 1), 2) || '***@' || split_part(recipient, '@', 2) end,
                  'subject', subject, 'body', left(body, 2000), 'ok', ok, 'error', error, 'at', sent_at)
                  order by sent_at), '[]'::jsonb)
           from sl) end,
      'system_log_note', 'email_send_log exists from 23.9.2026; only admin_daily_report writes to it so far')
  ));

  return r;
end;
$function$;

revoke all on function public.admin_daily_report_v2(date) from public, anon, authenticated;
grant execute on function public.admin_daily_report_v2(date) to service_role;
