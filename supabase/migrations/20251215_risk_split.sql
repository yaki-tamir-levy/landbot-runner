-- 20251215_risk_split.sql
-- Purpose: Introduce server-side RISK engine tables + extend risk_reviews for centralized management.

begin;

-- 1) New table: risk_phrases
create table if not exists public.risk_phrases (
  id bigserial primary key,
  pattern_key text not null unique,
  pattern text not null,
  severity text not null check (severity in ('medium','high')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_risk_phrases_updated_at on public.risk_phrases;
create trigger trg_risk_phrases_updated_at
before update on public.risk_phrases
for each row execute function public.set_updated_at();

-- 2) New table: risk_scan_state (single row, id=1)
create table if not exists public.risk_scan_state (
  id int primary key default 1,
  last_time_key bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Ensure row exists
insert into public.risk_scan_state (id, last_time_key)
values (1, 0)
on conflict (id) do nothing;

drop trigger if exists trg_risk_scan_state_updated_at on public.risk_scan_state;
create trigger trg_risk_scan_state_updated_at
before update on public.risk_scan_state
for each row execute function public.set_updated_at();

-- 3) Extend existing table: risk_reviews
-- NOTE: Adjust column types if your existing schema differs.
alter table public.risk_reviews
  add column if not exists snippet_hash text,
  add column if not exists snippet_text text,
  add column if not exists pattern_key text,
  add column if not exists phrase_id bigint references public.risk_phrases(id),
  add column if not exists severity text check (severity in ('medium','high')),
  add column if not exists status text not null default 'pending' check (status in ('pending','reviewed','dismissed')),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewer text,
  add column if not exists match_method text not null default 'regex',
  add column if not exists match_score numeric;

-- 4) Uniqueness: time_key + phone + snippet_hash
-- If you already have a unique constraint, keep the existing one; otherwise create.
do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'risk_reviews_time_phone_snippet_hash_uq'
  ) then
    execute 'create unique index risk_reviews_time_phone_snippet_hash_uq on public.risk_reviews (time_key, phone, snippet_hash)';
  end if;
end$$;

-- 5) Helpful indexes for inbox + drilldown
create index if not exists risk_reviews_status_idx on public.risk_reviews (status);
create index if not exists risk_reviews_phone_time_idx on public.risk_reviews (phone, time_key desc);

-- 6) RLS: allow reads (optional), deny direct writes from client
alter table public.risk_phrases enable row level security;
alter table public.risk_scan_state enable row level security;
alter table public.risk_reviews enable row level security;

-- risk_phrases: allow authenticated to read active phrases (optional; you can restrict further)
drop policy if exists "risk_phrases_read" on public.risk_phrases;
create policy "risk_phrases_read"
on public.risk_phrases
for select
to authenticated
using (true);

-- risk_scan_state: no direct access for authenticated
drop policy if exists "risk_scan_state_no_access" on public.risk_scan_state;
create policy "risk_scan_state_no_access"
on public.risk_scan_state
for select
to authenticated
using (false);

-- risk_reviews: allow authenticated to read (optional; your Viewer should use Edge Function anyway)
drop policy if exists "risk_reviews_read" on public.risk_reviews;
create policy "risk_reviews_read"
on public.risk_reviews
for select
to authenticated
using (true);

-- Explicitly block direct writes (authenticated/anon)
drop policy if exists "risk_reviews_no_write" on public.risk_reviews;
create policy "risk_reviews_no_write"
on public.risk_reviews
for insert
to authenticated
with check (false);

drop policy if exists "risk_reviews_no_update" on public.risk_reviews;
create policy "risk_reviews_no_update"
on public.risk_reviews
for update
to authenticated
using (false);

drop policy if exists "risk_reviews_no_delete" on public.risk_reviews;
create policy "risk_reviews_no_delete"
on public.risk_reviews
for delete
to authenticated
using (false);

commit;
