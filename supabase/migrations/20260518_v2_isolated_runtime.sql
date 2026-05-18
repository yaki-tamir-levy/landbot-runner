-- Proposal: isolated V2 runtime schema
-- This file is a safe manual migration proposal for V2-only tables and indexes.
-- Do NOT execute automatically without review.

create table if not exists public.users_total_v2 (
  id uuid not null primary key,
  patient_code uuid not null,
  phone text,
  name text,
  processed text not null default 'NEW',
  linked_talk text,
  last_talk_tzvira text,
  last_summary_at timestamp with time zone,
  summarized_linked_talk text,
  summarized_linked_talk_num text,
  summarized_linked_talk_risk text,
  risk_reasons text,
  talk_id text,
  legacy_runtime_id uuid,
  compare_status text,
  compare_reason text,
  short_summarized text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists users_total_v2_patient_code_uq on public.users_total_v2 (patient_code);
create index if not exists users_total_v2_processed_idx on public.users_total_v2 (processed);

create table if not exists public.users_tzvira_v2 (
  id uuid not null,
  time_key timestamp with time zone not null primary key,
  patient_code uuid not null,
  phone text,
  name text,
  last_talk_tzvira text,
  summarized_linked_talk text,
  legacy_runtime_id uuid,
  compare_status text,
  compare_reason text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  unique (patient_code, time_key)
);

create table if not exists public.risk_reviews_v2 (
  id uuid not null,
  time_key timestamp with time zone not null,
  patient_code uuid not null,
  phone text,
  name text,
  line_num int not null,
  short_risk text,
  risk_reasons text,
  match_method text,
  legacy_runtime_id uuid,
  compare_status text,
  compare_reason text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  primary key (id, time_key, patient_code, line_num)
);

create unique index if not exists risk_reviews_v2_patient_code_time_line_risk_uq on public.risk_reviews_v2 (patient_code, time_key, line_num, short_risk);
create index if not exists risk_reviews_v2_patient_code_time_idx on public.risk_reviews_v2 (patient_code, time_key desc);

-- Add row-level security policies and grants for V2 tables as needed in a separate controlled migration.
