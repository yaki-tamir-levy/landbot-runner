-- 30.9.2026 - realtime risk detection in therapy conversations (task 4).
-- Additive only: one prompt row, one app_config key, one log table.
-- The classifier runs in the edge function risk-realtime-classify, called by
-- runtime-corrected-response in parallel with the therapist reply. Therapy
-- conversations only (CLINIC, NLP_CBT), never course. Only level 'high'
-- shows the patient the referral notice.

-- 1. Classifier prompt. Severity definitions copied from risk_staged_severity,
--    so the realtime check and the daily reports speak the same language.
insert into public.prompt_information_v2 (prompt_key, description, user_text)
values (
  'risk_realtime_classifier',
  'Realtime risk classifier for therapy conversations. Output level only: none, low, medium, high. Used by risk-realtime-classify.',
  $p$אתה מסווג סיכון בזמן אמת בשיחה טיפולית. אינך משיב למטופל ואינך כותב לו דבר.

תקבל את ההקשר של השיחה הנוכחית ואת ההודעה הנוכחית של המטופל. סווג את רמת הסיכון שעולה מההודעה הנוכחית. ההקשר נועד רק להבין את ההודעה הנוכחית, לא לסווג הודעות קודמות.

רמות:
high — כוונה, תכנית, אמצעי, או ציר זמן מפורשים, מכוונים בבירור כלפי המטופל עצמו או כלפי אדם אחר. המטופל מתאר צעד קונקרטי או רצון ברור ומיידי לפגוע בעצמו או באחר.
medium — מצוקה ברורה, ייאוש, חוסר תקווה, או אזכור ישיר של מוות/פגיעה — אך בלי כוונה או תכנית מפורשת.
low — רמז משתמע, לא מפורש. תחושת ריקנות, ניתוק, או ביטוי שיכול להתפרש כמצוקה אך אינו חד־משמעי בפני עצמו, ודורש הקשר כדי להיתפס כסיכון.
none — אין סימן לסיכון.

כללים:
- סיכון שהמטופל מתאר כעבר, ולא כעכשווי, אינו high.
- ציטוט של אדם אחר, דוגמה, דיון כללי או בדיחה מובהקת אינם high, אלא אם המטופל מייחס את הכוונה לעצמו עכשיו.
- כשיש כוונה, תכנית, אמצעי או ציר זמן מפורשים, ויש ספק בין high ל-medium — בחר high.
- החזר אובייקט JSON אחד בלבד, בצורה {"level": "none"}, עם אחד מארבעת הערכים. בלי טקסט נוסף.$p$
);

-- 2. Referral notice shown to the patient on level 'high'. Editable without
--    code changes. Details verified 30.9.2026: ERAN 1201 (24h), SAHAR written
--    chat at sahar.org.il. SAHAR hours not verified, so not stated.
insert into public.app_config (key, value)
values (
  'risk_realtime_notice',
  jsonb_build_object(
    'intro', 'נשמע שעובר עליך עכשיו משהו קשה מאוד. המקום הזה אינו מענה חירום, ויש עם מי לדבר ממש עכשיו:',
    'links', jsonb_build_array(
      jsonb_build_object('label', 'ער"ן — 1201, בטלפון, בכל שעות היממה', 'href', 'tel:1201'),
      jsonb_build_object('label', 'סה"ר — שיחה בכתיבה, באתר sahar.org.il', 'href', 'https://sahar.org.il')
    )
  )::text
);

-- 3. Log of every realtime classification. No message text, no phone:
--    conversation id, level, timing, outcome only.
create table public.risk_realtime_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  conversation_id uuid,
  correlation_id uuid,
  level text not null check (level in ('none', 'low', 'medium', 'high', 'error')),
  notice_shown boolean not null default false,
  elapsed_ms integer,
  error text
);

alter table public.risk_realtime_log enable row level security;
revoke all on public.risk_realtime_log from anon, authenticated;

create index risk_realtime_log_conversation_idx
  on public.risk_realtime_log (conversation_id, created_at);
