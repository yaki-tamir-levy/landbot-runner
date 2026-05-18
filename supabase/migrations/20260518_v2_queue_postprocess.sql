-- Proposal: isolated V2 queue + postprocess schema
-- This is an incremental V2-only proposal. Do NOT execute automatically.

-- Ensure V2 postprocess data exists for users_total_v2.
alter table if exists public.users_total_v2
  add column if not exists short_summarized text;

-- Process queue for users_total_v2
create table if not exists public.process_queue_v2 (
  id uuid not null primary key default gen_random_uuid(),
  users_total_v2_id uuid not null,
  patient_code uuid not null,
  status text not null default 'NEW',
  last_error text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create unique index if not exists process_queue_v2_users_total_v2_id_status_uq
  on public.process_queue_v2 (users_total_v2_id)
  where status in ('NEW', 'PROCESSING');

-- V2 postprocess queue stores rows to summarize existing users_total_v2 text.
create table if not exists public.users_total_v2_postprocess_queue (
  id uuid not null primary key default gen_random_uuid(),
  users_total_v2_id uuid not null,
  patient_code uuid not null,
  phone text,
  status text not null default 'NEW',
  last_error text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Functions / RPC for V2 queue/postprocess
create or replace function public.fn_process_queue_claim_one_v2()
  returns setof public.process_queue_v2
  language sql security definer
as $$
  with q as (
    select id
    from public.process_queue_v2
    where status = 'NEW'
    order by created_at asc
    for update skip locked
    limit 1
  )
  update public.process_queue_v2
  set status = 'PROCESSING', updated_at = now()
  where id in (select id from q)
  returning *;
$$;

create or replace function public.fn_process_queue_finish_v2(
  p_queue_id uuid,
  p_status text,
  p_last_error text
)
  returns void
  language sql security definer
as $$
  update public.process_queue_v2
  set status = p_status,
      last_error = p_last_error,
      updated_at = now()
  where id = p_queue_id;
$$;

create or replace function public.dequeue_users_total_v2_postprocess()
  returns setof public.users_total_v2_postprocess_queue
  language sql security definer
as $$
  with q as (
    select id
    from public.users_total_v2_postprocess_queue
    where status = 'NEW'
    order by created_at asc
    for update skip locked
    limit 1
  )
  update public.users_total_v2_postprocess_queue
  set status = 'PROCESSING', updated_at = now()
  where id in (select id from q)
  returning *;
$$;

-- Optional: add row-level security policies and grants for V2 tables in a reviewed, separate migration.
