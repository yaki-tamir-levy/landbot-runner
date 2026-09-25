-- 25.9.2026: start GitHub Actions workflows from the database instead of the
-- GitHub "schedule" trigger, which was measured to run 4-6 hours late and to
-- drop about 80% of hourly runs. pg_cron -> public.dispatch_workflow() ->
-- pg_net -> edge function dispatch-workflow -> GitHub workflow_dispatch.
--
-- Prerequisite, created manually and NOT in this file (the value must not
-- enter Git): a Vault secret named 'dispatch_workflow_secret', equal to the
-- edge function secret DISPATCH_SECRET.
--
-- This migration adds objects only. No cron job is created here.
-- Applied to the live database on 25.9.2026 via apply_migration
-- (workflow_dispatch_20260925).

create table public.workflow_dispatch_log (
  id              bigint generated always as identity primary key,
  requested_at    timestamptz not null default now(),
  workflow        text        not null,
  inputs          jsonb       not null default '{}'::jsonb,
  source          text        not null,
  net_request_id  bigint,
  responded_at    timestamptz,
  http_status     integer,
  run_id          bigint,
  ok              boolean,
  error           text
);

create index workflow_dispatch_log_requested_at_idx
  on public.workflow_dispatch_log (requested_at);

alter table public.workflow_dispatch_log enable row level security;

revoke all on table public.workflow_dispatch_log from anon, authenticated;
revoke all on sequence public.workflow_dispatch_log_id_seq from anon, authenticated;

comment on table public.workflow_dispatch_log is
  'One row per workflow_dispatch request. Written by public.dispatch_workflow() and completed by edge function dispatch-workflow. responded_at null = the request never completed. Service role only. Created 25.9.2026.';

create or replace function public.dispatch_workflow(
  p_workflow text,
  p_inputs   jsonb default '{}'::jsonb,
  p_source   text  default 'pg_cron'
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_secret text;
  v_log_id bigint;
  v_req_id bigint;
begin
  insert into public.workflow_dispatch_log (workflow, inputs, source)
  values (p_workflow, coalesce(p_inputs, '{}'::jsonb), coalesce(p_source, 'pg_cron'))
  returning id into v_log_id;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'dispatch_workflow_secret'
  limit 1;

  if v_secret is null then
    update public.workflow_dispatch_log
       set ok = false, error = 'vault_secret_missing', responded_at = now()
     where id = v_log_id;
    return v_log_id;
  end if;

  v_req_id := net.http_post(
    url     := 'https://qcwimczsiuxkarwfiyai.supabase.co/functions/v1/dispatch-workflow',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-dispatch-secret', v_secret
               ),
    body    := jsonb_build_object(
                 'workflow', p_workflow,
                 'inputs',   coalesce(p_inputs, '{}'::jsonb),
                 'log_id',   v_log_id
               ),
    timeout_milliseconds := 15000
  );

  update public.workflow_dispatch_log
     set net_request_id = v_req_id
   where id = v_log_id;

  return v_log_id;
end;
$$;

revoke all on function public.dispatch_workflow(text, jsonb, text) from public, anon, authenticated;

comment on function public.dispatch_workflow(text, jsonb, text) is
  'Starts a GitHub workflow via edge function dispatch-workflow. Called by pg_cron. Returns the workflow_dispatch_log id. Created 25.9.2026.';
