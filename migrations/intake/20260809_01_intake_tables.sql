-- מסלול הקבלה — שתי הטבלאות
-- הרצה: נכתב במסד ב-9.8.2026. הקובץ הוא העתק המקור לצורכי מעקב.

create table if not exists public.conversations_intake (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  phone_hash text not null,
  question text,
  answer text,
  created_at timestamptz not null default now()
);

create index if not exists conversations_intake_conversation_idx on public.conversations_intake (conversation_id);
create index if not exists conversations_intake_phone_hash_idx  on public.conversations_intake (phone_hash);
create index if not exists conversations_intake_created_at_idx   on public.conversations_intake (created_at);

create table if not exists public.candidates_intake (
  id uuid primary key default gen_random_uuid(),
  phone_hash text not null unique,
  phone_enc text not null,
  name_enc text,
  email_enc text,
  conversation_id uuid,
  linked_talk text,
  processed text not null default 'OPEN',
  decision text,
  missing_fields jsonb,
  background text,
  risk_flag boolean not null default false,
  patient_code uuid,
  decided_at timestamptz,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidates_intake_processed_chk check (processed in ('OPEN','NEW','DONE','ERROR')),
  constraint candidates_intake_decision_chk  check (decision is null or decision in ('ACCEPTED','REJECTED'))
);

create index if not exists candidates_intake_processed_idx    on public.candidates_intake (processed);
create index if not exists candidates_intake_conversation_idx on public.candidates_intake (conversation_id);

alter table public.conversations_intake enable row level security;
alter table public.candidates_intake    enable row level security;

-- אפס מדיניות במכוון. כל גישה עוברת דרך SECURITY DEFINER.
revoke all on table public.candidates_intake    from anon, authenticated, public;
revoke all on table public.conversations_intake from anon, authenticated, public;
grant  all on table public.candidates_intake    to service_role;
grant  all on table public.conversations_intake to service_role;
