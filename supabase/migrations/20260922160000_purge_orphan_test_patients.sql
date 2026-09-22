-- 22.9.2026 — purge of 5 orphan test identities.
-- Applied to the live database via MCP as migration
-- purge_orphan_test_patients_20260922.
--
-- THIS FILE IS A RECORD, NOT A RERUNNABLE SCRIPT. The executed version
-- selected the purge set by a keep-list of real test phone numbers; the repo
-- is public, so the list is deliberately not stored here.
--
-- Purge set: identities in patient_identity_map that were not on the owner's
-- 17-number keep list, not SIM patients (masked phone 888*** / 999***) and
-- not intake candidates. Result: 5 identities with no users_information_v2
-- row - two patients whose details were deleted 11.8.2026 and three test
-- values.
--
-- Deleted, each count checked inside the transaction:
--   conversation_events_v2 126, conversations_session_v2 36,
--   corrector_test_log 23, users_information_v2_daily_backup 4,
--   users_tzvira_v2 3, process_queue_v2 3, supa_guarded_run_log_details_v2 3,
--   users_total_v2 1, patient_identity_map 5. Total 204.
--
-- conversation_events_v2 is append-only by trigger. Only the delete trigger
-- was disabled, inside the same transaction, and re-enabled before commit.
--
-- Every deleted row is kept as jsonb in the closed table below.
-- After: 29 identities, 29 detail rows, 0 orphans, 6 with email.

create table public.bak_20260922_patient_purge (
  src text not null,
  row_data jsonb not null,
  backed_at timestamptz not null default now()
);
alter table public.bak_20260922_patient_purge enable row level security;
revoke all on table public.bak_20260922_patient_purge from public, anon, authenticated;
