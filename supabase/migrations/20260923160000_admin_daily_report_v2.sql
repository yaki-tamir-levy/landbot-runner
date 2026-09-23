-- 23.9.2026: data for the admin daily report (one Israel calendar day).
-- Read-only. Detail level from app_config 'admin_daily_report_detail':
-- 'full' = masked phones, risk wording, recipients; anything else = counts only.
-- Turns are counted from corrector_test_log, not conversations_prod_v2:
-- conversations_prod_v2 is a staging table that supa_migrate_one_phone_v2
-- empties, so it cannot give a daily count. A turn is production when its
-- conversation_id exists in conversations_session_v2; any other engine call
-- is a test or simulation call.
-- Applied to the live database on 23.9.2026 via apply_migration
-- (admin_daily_report_v2_20260923, then
--  admin_daily_report_v2_turns_from_corrector_log_20260923). This file holds
-- the final state. Execute: service_role only.

insert into public.app_config (key, value)
select 'admin_daily_report_detail', 'full'
where not exists (select 1 from public.app_config where key = 'admin_daily_report_detail');

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
  r       jsonb := '{}'::jsonb;
begin
  v_from := v_day::timestamp at time zone 'Asia/Jerusalem';
  v_to   := (v_day + 1)::timestamp at time zone 'Asia/Jerusalem';
  v_full := coalesce((select btrim(value) from public.app_config
                      where key = 'admin_daily_report_detail'), '') = 'full';

  r := jsonb_build_object(
    'day', v_day, 'from', v_from, 'to', v_to,
    'detail', case when v_full then 'full' else 'counts' end,
    'generated_at', now());

  -- ---------- people ----------
  r := r || jsonb_build_object('people', jsonb_build_object(
    'new_psychologists_count',
      (select count(*) from psychologists_v2 where created_at >= v_from and created_at < v_to),
    'new_psychologists', case when v_full then
      (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'active', active,
                'is_admin', is_admin, 'at', created_at) order by created_at), '[]'::jsonb)
         from psychologists_v2 where created_at >= v_from and created_at < v_to) end,
    'new_patients_count',
      (select count(*) from users_information_v2 where created_at >= v_from and created_at < v_to),
    'new_patients', case when v_full then
      (select coalesce(jsonb_agg(jsonb_build_object('phone', u.phone, 'origin', u.patient_origin,
                'status', u.status, 'active', u.active, 'psychologist', p.name, 'at', u.created_at)
                order by u.created_at), '[]'::jsonb)
         from users_information_v2 u left join psychologists_v2 p on p.phone = u.psychologist
        where u.created_at >= v_from and u.created_at < v_to) end,
    'updated_patients_count',
      (select count(*) from users_information_v2
        where updated_at >= v_from and updated_at < v_to and created_at < v_from),
    'intake_new_candidates',
      (select count(*) from candidates_intake where created_at >= v_from and created_at < v_to),
    'intake_decided',
      (select coalesce(jsonb_object_agg(coalesce(decision, '(none)'), n), '{}'::jsonb)
         from (select decision, count(*) n from candidates_intake
                where decided_at >= v_from and decided_at < v_to group by decision) d),
    'intake_risk_flagged',
      (select count(*) from candidates_intake
        where created_at >= v_from and created_at < v_to and risk_flag)
  ));

  -- ---------- conversations ----------
  r := r || jsonb_build_object('conversations', (
    with ct as (
      select c.conversation_id, c.corrector_decision,
             exists (select 1 from conversations_session_v2 s where s.conversation_id = c.conversation_id) as prod
        from corrector_test_log c
       where c.created_at >= v_from and c.created_at < v_to),
    act as (
      select s.conversation_id, s.patient_code, s.source, s.started_at
        from conversations_session_v2 s
       where (s.started_at >= v_from and s.started_at < v_to)
          or s.conversation_id in (select conversation_id from ct where prod))
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
                  'started_at', a.started_at,
                  'turns_day', (select count(*) from ct where ct.conversation_id = a.conversation_id),
                  'turns_total', (select count(*) from corrector_test_log c where c.conversation_id = a.conversation_id))
                  order by a.started_at), '[]'::jsonb)
           from act a left join users_information_v2 u on u.patient_code = a.patient_code) end,
      'intake_conversations',
        (select count(distinct conversation_id) from conversations_intake where created_at >= v_from and created_at < v_to),
      'intake_turns',
        (select count(*) from conversations_intake where created_at >= v_from and created_at < v_to))
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
                  'text', short_risk, 'at', tk) order by tk), '[]'::jsonb) from rr) end)
  ));

  -- ---------- logins and access ----------
  r := r || jsonb_build_object('access', (
    with psy as (select lower(btrim(email)) em, name from psychologists_v2 where email is not null),
    lg as (
      select a.created_at, lower(btrim(a.payload->>'actor_username')) em
        from auth.audit_log_entries a
       where a.created_at >= v_from and a.created_at < v_to and a.payload->>'action' = 'login')
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
      'read_flag_toggles', (select count(*) from talk_read_flags where toggled_at >= v_from and toggled_at < v_to),
      'read_flag_by', case when v_full then
        (select coalesce(jsonb_object_agg(coalesce(toggled_by, '(none)'), n), '{}'::jsonb)
           from (select toggled_by, count(*) n from talk_read_flags
                  where toggled_at >= v_from and toggled_at < v_to group by toggled_by) t) end,
      'otp_phones_sent', (select count(*) from otp_send_log where last_sent_at >= v_from and last_sent_at < v_to),
      'wrong_code_phones', (select count(*) from meitar_verify_attempts
                             where updated_at >= v_from and updated_at < v_to and fails > 0),
      'wrong_code_total', (select coalesce(sum(fails), 0) from meitar_verify_attempts
                            where updated_at >= v_from and updated_at < v_to and fails > 0))
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
    'guarded_runs', (select jsonb_build_object('runs', count(*),
                       'processed', coalesce(sum(processed_count), 0),
                       'skipped', coalesce(sum(skipped_count), 0))
                       from supa_guarded_run_log where started_at >= v_from and started_at < v_to),
    'queue_now', (select coalesce(jsonb_object_agg(coalesce(status, '(none)'), n), '{}'::jsonb)
                    from (select status, count(*) n from process_queue_v2 group by status) q),
    'queue_errors_day', (select count(*) from process_queue_v2
                          where updated_at >= v_from and updated_at < v_to and last_error is not null),
    'summaries_written', (select count(*) from users_total_v2 where last_summary_at >= v_from and last_summary_at < v_to),
    'ab_updated', (select count(*) from users_total_v2 where ab_updated_at >= v_from and ab_updated_at < v_to),
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
                  'at', created_at) order by created_at), '[]'::jsonb) from au) end,
      'system_count', (select count(*) from sl),
      'system_failed', (select count(*) from sl where not ok),
      'system_by_sender', (select coalesce(jsonb_object_agg(sender, n), '{}'::jsonb)
                             from (select sender, count(*) n from sl group by sender) x),
      'system_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object('sender', sender, 'kind', kind,
                  'to', case when lower(btrim(recipient)) in (select em from psy) then recipient
                             else left(split_part(recipient, '@', 1), 2) || '***@' || split_part(recipient, '@', 2) end,
                  'subject', subject, 'ok', ok, 'error', error, 'at', sent_at) order by sent_at), '[]'::jsonb)
           from sl) end,
      'system_log_note', 'email_send_log exists from 23.9.2026; senders not yet writing to it')
  ));

  return r;
end;
$function$;

revoke all on function public.admin_daily_report_v2(date) from public, anon, authenticated;
grant execute on function public.admin_daily_report_v2(date) to service_role;
