-- 26.9.2026: tools/psychologist_notify.py wrote a watermark with channel
-- 'phrase' for the admin report, but the check constraint allowed only
-- 'risk' and 'daily'. The upsert of ALL daily marks failed together, after
-- the emails were already sent, so the "new" lists repeated on every run.
-- Additive: the allowed set only grows. (The phrase section itself was
-- removed from the report later the same day; the constraint is harmless.)
alter table public.notification_watermark
  drop constraint notification_watermark_channel_chk,
  add constraint notification_watermark_channel_chk
    check (channel = any (array['risk'::text, 'daily'::text, 'phrase'::text]));
