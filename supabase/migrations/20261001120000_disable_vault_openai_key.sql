-- 1.10.2026: the vault secret openai_api_key was invalid (OpenAI 401) and had no users.
-- Checked: database functions, views, triggers and cron jobs; the repository; the source
-- of every deployed edge function; edge and Postgres logs for the last 24 hours.
-- The only two functions that read it, summarize_users_total_row and test_openai_auth,
-- had no callers. Both were SECURITY DEFINER and executable by anon.
-- Applied live on 1.10.2026 through the Supabase connector. This file records it.

revoke execute on function public.summarize_users_total_row(text) from public, anon, authenticated, service_role;
revoke execute on function public.test_openai_auth() from public, anon, authenticated, service_role;
comment on function public.summarize_users_total_row(text) is 'DISABLED 1.10.2026: no callers in DB, repo or deployed functions; used vault secret openai_api_key (invalid, 401), which was deleted. Execute revoked from all but postgres. Delete later.';
comment on function public.test_openai_auth() is 'DISABLED 1.10.2026: no callers; vault secret openai_api_key deleted. Execute revoked from all but postgres. Delete later.';

-- Done once, live, after the revokes above. Do not re-run:
-- delete from vault.secrets where name = 'openai_api_key';
