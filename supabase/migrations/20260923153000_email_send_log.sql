-- 23.9.2026: one row per email sent by the system's own senders
-- (psychologist_notify.py, intake_processor.py, ab_processor.py,
-- risk_reviews_notify.py). Read by the admin daily report.
-- Holds recipient addresses: closed to anon and authenticated.
-- Applied to the live database on 23.9.2026 via apply_migration
-- (email_send_log_20260923).
create table public.email_send_log (
  id         bigserial primary key,
  sent_at    timestamptz not null default now(),
  sender     text        not null,
  kind       text,
  recipient  text        not null,
  subject    text,
  ok         boolean     not null default true,
  error      text,
  meta       jsonb
);

create index email_send_log_sent_at_idx on public.email_send_log (sent_at);

alter table public.email_send_log enable row level security;

revoke all on table public.email_send_log from anon, authenticated;
revoke all on sequence public.email_send_log_id_seq from anon, authenticated;

comment on table public.email_send_log is
  'One row per email sent by the system scripts. Service role only. Read by the admin daily report. Created 23.9.2026.';
