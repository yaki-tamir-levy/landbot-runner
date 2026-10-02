-- 20261002090000_auth_code_notify.sql
-- Created 2.10.2026.
--
-- One email to the admin for every code the Supabase Auth service is asked to
-- send (login of an existing user, first registration). Purpose: answering
-- "the verification email never arrived". The email never contains the code.
--
-- trigger on auth.audit_log_entries
--   -> public.auth_code_notify_trigger() -> pg_net POST {audit_id}
--   -> edge function auth-code-notify
--   -> public.auth_code_notify_claim(audit_id) -> SMTP -> email_send_log
--
-- The trigger swallows every error: a notification problem must never block a
-- login. The claim answers only for a real event younger than 10 minutes and
-- only once per event (unique index below), so the edge function needs no secret.
-- Plain phones never leave the database: the psychologist phone is masked here,
-- and users_information_v2.phone is stored masked.
--
-- Rollback (in this order):
--   drop trigger auth_code_notify on auth.audit_log_entries;
--   drop function public.auth_code_notify_trigger();
--   drop function public.auth_code_notify_claim(uuid);
--   drop index public.email_send_log_auth_code_notify_audit_uq;

create unique index if not exists email_send_log_auth_code_notify_audit_uq
  on public.email_send_log ((meta->>'audit_id'))
  where sender = 'auth_code_notify';

create or replace function public.auth_code_notify_claim(p_audit_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_action  text;
  v_email   text;
  v_created timestamptz;
  v_is_psy  boolean := false;
  v_is_pat  boolean := false;
  v_psy_ph  text;
  v_pat_ph  text;
  v_role    text;
  v_admin   text;
  v_log_id  bigint;
begin
  select a.payload->>'action', lower(btrim(a.payload->>'actor_username')), a.created_at
    into v_action, v_email, v_created
    from auth.audit_log_entries a
   where a.id = p_audit_id
     and a.payload->>'action' in ('user_recovery_requested', 'user_confirmation_requested')
     and a.created_at > now() - interval '10 minutes';
  if v_action is null then
    return null;
  end if;

  select true, case when p.phone ~ '^[0-9]{7,}$' then left(p.phone, 3) || '***' || right(p.phone, 3) else p.phone end
    into v_is_psy, v_psy_ph
    from public.psychologists_v2 p
   where lower(btrim(p.email)) = v_email
   limit 1;

  select true, u.phone
    into v_is_pat, v_pat_ph
    from public.patient_identity_map m
    left join public.users_information_v2 u on u.patient_code = m.patient_code
   where m.email_hash = encode(extensions.digest(v_email, 'sha256'), 'hex')
   limit 1;

  v_role := case
    when coalesce(v_is_psy, false) and coalesce(v_is_pat, false) then 'both'
    when coalesce(v_is_psy, false) then 'psychologist'
    when coalesce(v_is_pat, false) then 'patient'
    else 'unknown' end;

  select btrim(p.email) into v_admin
    from public.psychologists_v2 p
   where p.is_admin and p.active and coalesce(btrim(p.email), '') <> ''
   order by p.created_at
   limit 1;

  insert into public.email_send_log (sender, kind, recipient, subject, ok, error, meta)
  values ('auth_code_notify', 'auth_code', coalesce(v_admin, ''), null, false, 'pending',
          jsonb_build_object('audit_id', p_audit_id::text, 'action', v_action, 'role', v_role,
                             'event_at', v_created))
  on conflict ((meta->>'audit_id')) where sender = 'auth_code_notify' do nothing
  returning id into v_log_id;

  if v_log_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'log_id', v_log_id,
    'action', v_action,
    'email', v_email,
    'created_at', v_created,
    'role', v_role,
    'phone', case v_role when 'patient' then v_pat_ph else coalesce(v_psy_ph, v_pat_ph) end,
    'admin_email', v_admin);
end;
$$;

revoke all on function public.auth_code_notify_claim(uuid) from public, anon, authenticated;
grant execute on function public.auth_code_notify_claim(uuid) to service_role;

comment on function public.auth_code_notify_claim(uuid) is
  'Called only by edge function auth-code-notify. Returns the details of one auth code-send event younger than 10 minutes and claims it in email_send_log, once per event; otherwise null. Service role only. Created 2.10.2026.';

create or replace function public.auth_code_notify_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
begin
  begin
    perform net.http_post(
      url     := 'https://qcwimczsiuxkarwfiyai.supabase.co/functions/v1/auth-code-notify',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := jsonb_build_object('audit_id', new.id::text),
      timeout_milliseconds := 15000
    );
  exception when others then
    raise warning 'auth_code_notify_trigger: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.auth_code_notify_trigger() from public, anon, authenticated;

comment on function public.auth_code_notify_trigger() is
  'AFTER INSERT trigger on auth.audit_log_entries for code-send actions. Calls edge function auth-code-notify via pg_net. Swallows every error so a login is never blocked. Created 2.10.2026.';

drop trigger if exists auth_code_notify on auth.audit_log_entries;
create trigger auth_code_notify
  after insert on auth.audit_log_entries
  for each row
  when ((new.payload->>'action') in ('user_recovery_requested', 'user_confirmation_requested'))
  execute function public.auth_code_notify_trigger();
