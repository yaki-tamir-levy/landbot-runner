-- 27.9.2026 - Retention for email bodies stored in public.email_send_log.
--
-- tools/admin_daily_report.py now stores the body of each computed admin
-- report (full detail: masked phones, risk wording, patient turns up to 500
-- chars), so a later run for the same day re-sends it without recomputing.
-- The body is kept for 90 days, then emptied. Rows are not deleted: the send
-- record (when, to whom, subject, ok, meta) stays.
--
-- Daily at 00:15 UTC = 03:15 Israel summer time, 02:15 winter time.
-- cron.schedule with an existing name updates that job, so this is re-runnable.

select cron.schedule(
  'email_send_log_body_retention_90d',
  '15 0 * * *',
  $$update public.email_send_log
       set body = null
     where body is not null
       and sent_at < now() - interval '90 days'$$
);
