-- 22.9.2026 — close the patient-takeover path.
-- Applied to the live database via MCP as migration
-- revoke_public_patient_writers_20260922.
--
-- upsert_users_information_v2_from_sheet overwrites a patient's email,
-- psychologist, status, active flag and background by phone. It was
-- executable by anon, whose key is public in the GitHub Pages files: anyone
-- could set a patient's email to their own and receive the login code.
-- intake_apply_decision calls it and was also executable by anon.
--
-- Only callers (verified 22.9 in the repo and the database): the supa-sync
-- Edge Function and tools/intake_processor.py, both with the service role key.
-- Live check after apply: anon call returns 401.

revoke all on function public.upsert_users_information_v2_from_sheet(text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.upsert_users_information_v2_from_sheet(text,text,text,text,text,text,text,text,text) to service_role;

revoke all on function public.intake_apply_decision(text,text,jsonb,text,boolean,text) from public, anon, authenticated;
grant execute on function public.intake_apply_decision(text,text,jsonb,text,boolean,text) to service_role;
