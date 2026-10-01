-- 30.9.2026: conversations older than 60 days (from conversation start) move daily
-- from users_tzvira_v2 to users_tzvira_v2_history. Owner decisions:
-- 60 days; counted from conversations_session_v2.started_at; a conversation with an
-- open risk (status NEW, REVIEWED or VIEWED) stays; the history table is not shown
-- in the viewer. Applied live on 30.9.2026 through the Supabase connector; first run
-- moved 24 rows (346 -> 322 + 24). This file records what is in the database.

create table if not exists public.users_tzvira_v2_history (
  time_key text primary key,
  patient_code uuid references public.patient_identity_map(patient_code),
  last_talk_tzvira text,
  summarized_linked_talk text,
  id uuid,
  legacy_runtime_id uuid,
  compare_status text,
  compare_reason text,
  conversation_id uuid,
  archived_at timestamptz not null default now()
);
create unique index if not exists users_tzvira_v2_history_unique_patient_time on public.users_tzvira_v2_history (patient_code, time_key);
create index if not exists users_tzvira_v2_history_conversation_id_idx on public.users_tzvira_v2_history (conversation_id);
alter table public.users_tzvira_v2_history enable row level security;
revoke all on public.users_tzvira_v2_history from anon, authenticated;
comment on table public.users_tzvira_v2_history is 'Conversations moved from users_tzvira_v2 after 60 days from conversation start, no open risk. Not read by the viewer. 30.9.2026.';

create or replace function public.archive_users_tzvira_v2_old(p_days integer default 60, p_dry_run boolean default false)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_catalog'
as $fn$
declare
  v_candidates int;
  v_kept_open_risk int;
  v_moved int := 0;
begin
  if p_days is null or p_days < 60 then
    raise exception 'p_days must be at least 60';
  end if;

  select count(*) filter (where not x.open_risk), count(*) filter (where x.open_risk)
    into v_candidates, v_kept_open_risk
  from (
    select exists (
      select 1 from public.risk_reviews_v2 r
      where r.status in ('NEW','REVIEWED','VIEWED')
        and (r.conversation_id = u.conversation_id
             or (r.patient_code = u.patient_code and r.time_key = u.time_key))
    ) as open_risk
    from public.users_tzvira_v2 u
    join public.conversations_session_v2 s on s.conversation_id = u.conversation_id
    where s.started_at < now() - make_interval(days => p_days)
  ) x;

  if not p_dry_run then
    with cand as (
      select u.time_key
      from public.users_tzvira_v2 u
      join public.conversations_session_v2 s on s.conversation_id = u.conversation_id
      where s.started_at < now() - make_interval(days => p_days)
        and not exists (
          select 1 from public.risk_reviews_v2 r
          where r.status in ('NEW','REVIEWED','VIEWED')
            and (r.conversation_id = u.conversation_id
                 or (r.patient_code = u.patient_code and r.time_key = u.time_key))
        )
    ), moved as (
      delete from public.users_tzvira_v2 u using cand
      where u.time_key = cand.time_key
      returning u.time_key, u.patient_code, u.last_talk_tzvira, u.summarized_linked_talk,
                u.id, u.legacy_runtime_id, u.compare_status, u.compare_reason, u.conversation_id
    ), ins as (
      insert into public.users_tzvira_v2_history
        (time_key, patient_code, last_talk_tzvira, summarized_linked_talk, id,
         legacy_runtime_id, compare_status, compare_reason, conversation_id)
      select * from moved
      returning 1
    )
    select count(*) into v_moved from ins;
  end if;

  return jsonb_build_object('dry_run', p_dry_run, 'days', p_days,
    'candidates', v_candidates, 'kept_open_risk', v_kept_open_risk, 'moved', v_moved);
end;
$fn$;

revoke all on function public.archive_users_tzvira_v2_old(integer, boolean) from public, anon, authenticated;

-- pg_cron job 46, daily at 00:45 UTC = 03:45 Israel summer time, 02:45 Israel winter time.
-- Created live on 30.9.2026 with:
-- select cron.schedule('archive_users_tzvira_v2_daily', '45 0 * * *', $c$select public.archive_users_tzvira_v2_old(60, false);$c$);
