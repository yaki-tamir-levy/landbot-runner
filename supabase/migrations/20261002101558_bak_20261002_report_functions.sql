create table public.bak_20261002_report_functions as
select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def, now() as saved_at
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('admin_report_open_risks_v2','admin_daily_report_v2');
alter table public.bak_20261002_report_functions enable row level security;
revoke all on public.bak_20261002_report_functions from anon, authenticated;
