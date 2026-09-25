-- 25.9.2026: admin daily report additions, requested by the system owner.
--   1. public.admin_report_labels - Hebrew descriptions for pg_cron jobs and
--      GitHub workflows shown in the report. Edited in the database, no code
--      change needed. A missing row shows as "no description" in the report.
--   2. public.admin_report_open_risks_v2() - all open risks (status NEW),
--      grouped by the patient's psychologist, with the ones open more than
--      24 hours listed for the top of the report.
-- Additions only. public.admin_daily_report_v2 is not changed.
-- Applied to the live database on 25.9.2026 via apply_migration
-- (admin_report_labels_open_risks_20260925).

create table public.admin_report_labels (
  kind        text        not null check (kind in ('cron', 'workflow')),
  key         text        not null,
  label_he    text        not null,
  updated_at  timestamptz not null default now(),
  primary key (kind, key)
);

alter table public.admin_report_labels enable row level security;
revoke all on table public.admin_report_labels from anon, authenticated;

comment on table public.admin_report_labels is
  'Hebrew descriptions for the admin daily report. kind=cron: key is cron.job.jobname. kind=workflow: key is the GitHub workflow display name. Service role only. Created 25.9.2026.';

insert into public.admin_report_labels (kind, key, label_he) values
  ('cron', 'supa_run_log_cleanup_daily_0830',
   'ניקוי היומן supa_run_log - משאיר את 20 הרשומות האחרונות'),
  ('cron', 'run_100_link_talk_api_hourly_15',
   'מסלול Landbot הישן - שולח בקשת הפעלה לבוט דרך Landbot API'),
  ('cron', 'run_100_link_talk_batch_hourly_15',
   'מסלול Landbot הישן - מפעיל עד 50 רשומות NEW מהטבלה הישנה users_total'),
  ('cron', 'reset_users_total_stuck',
   'מסלול Landbot הישן - מחזיר ל-NEW רשומות ב-users_total שנתקעו ב-IN_PROGRESS יותר משעתיים'),
  ('cron', 'guarded-v2-05-20-35-50',
   'מחזור ההעברה - בודק אילו שיחות הסתיימו (10 דקות בלי הודעה) ומעביר אותן להמשך הצינור'),
  ('cron', 'users_information_v2_daily_incremental_backup',
   'גיבוי מצטבר יומי של users_information_v2'),
  ('cron', 'dispatch_admin_daily_report',
   'מפעיל ב-GitHub את דוח האדמין היומי - הדוח הזה'),
  ('cron', 'dispatch_psychologist_risk',
   'מפעיל ב-GitHub את התראות הסיכון לפסיכולוגים (מצב risk)'),
  ('cron', 'dispatch_psychologist_daily',
   'מפעיל ב-GitHub את המייל היומי לפסיכולוגים (מצב daily)'),
  ('workflow', 'AB Processor (daily)',
   'ממזג סיכומי שיחות ישנים לסיכום-על (ab) לכל מטופל'),
  ('workflow', 'Admin Daily Report',
   'דוח האדמין היומי - הדוח הזה'),
  ('workflow', 'Intake Processor (hourly 08:00-00:00 Israel)',
   'מסלול הקבלה - אוסף שיחות מועמדים שהסתיימו, מכריע קבלה או פסילה ושולח התראות'),
  ('workflow', 'Postprocess short_summarized V2',
   'יוצר סיכום מקוצר (short_summarized) לכל מטופל, אחרי מעבד התור'),
  ('workflow', 'Process Queue Reconciler V2',
   'מחזיר לתור העיבוד רשומות ב-users_total_v2 שבמצב NEW, ERROR או IN_PROGRESS'),
  ('workflow', 'Process Queue Worker V2 (event-ish)',
   'מעבד התור - מעבד רשומות מתור העיבוד ויוצר סיכומי שיחה'),
  ('workflow', 'Psychologist Notify',
   'מיילים לפסיכולוגים - התראות סיכון והמייל היומי'),
  ('workflow', 'Pushover Notify (Israel Time)',
   'התראת Pushover ומייל על סיכונים שממתינים לבדיקה (risk_reviews_notify.py)'),
  ('workflow', 'pages build and deployment',
   'פרסום המסכים ב-GitHub Pages');

create or replace function public.admin_report_open_risks_v2()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_full boolean;
begin
  v_full := coalesce((select btrim(value) from public.app_config
                      where key = 'admin_daily_report_detail'), '') = 'full';

  return (
    with rr as (
      select r.id, r.severity, r.match_method, r.short_risk,
             case when r.time_key ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}'
                  then r.time_key::timestamptz end as tk,
             u.phone as mphone,
             coalesce(p.name, '(לא משויך)') as psychologist
        from public.risk_reviews_v2 r
        left join public.users_information_v2 u on u.patient_code = r.patient_code
        left join public.psychologists_v2 p
               on regexp_replace(coalesce(p.phone, ''), '\D', '', 'g')
                = regexp_replace(coalesce(u.psychologist, ''), '\D', '', 'g')
              and coalesce(u.psychologist, '') <> ''
       where r.status = 'NEW'),
    od as (
      select *, floor(extract(epoch from (now() - tk)) / 86400)::int as days
        from rr
       where tk is not null and tk < now() - interval '24 hours')
    select jsonb_build_object(
      'detail', case when v_full then 'full' else 'counts' end,
      'open_total', (select count(*) from rr),
      'overdue_total', (select count(*) from od),
      'by_psychologist', (select coalesce(jsonb_agg(jsonb_build_object(
                             'psychologist', psychologist, 'open', n_open, 'overdue', n_over,
                             'oldest_days', oldest) order by n_over desc, psychologist), '[]'::jsonb)
                            from (select rr.psychologist, count(*) n_open,
                                         count(*) filter (where rr.tk < now() - interval '24 hours') n_over,
                                         max(floor(extract(epoch from (now() - rr.tk)) / 86400))::int oldest
                                    from rr group by rr.psychologist) g),
      'overdue_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object(
                   'psychologist', psychologist, 'severity', severity, 'method', match_method,
                   'text', short_risk, 'phone', mphone, 'at', tk, 'days', days)
                 order by psychologist, tk), '[]'::jsonb) from od) end)
  );
end;
$$;

revoke all on function public.admin_report_open_risks_v2() from public, anon, authenticated;
grant execute on function public.admin_report_open_risks_v2() to service_role;

comment on function public.admin_report_open_risks_v2() is
  'Open risks (risk_reviews_v2.status = NEW) for the admin daily report, by psychologist; overdue = open more than 24h by conversation time. Detail follows app_config admin_daily_report_detail. Service role only. Created 25.9.2026.';
