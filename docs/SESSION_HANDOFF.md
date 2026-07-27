# SESSION HANDOFF

**Last verified: 2026-07-27 (evening session)**

Merge-on-update. Not append-only. Completed items move to DONE with a date; contradictions
against the live DB are corrected, not accumulated.

**Scope note:** stable architecture lives in `PROJECT_GUIDE.md` and `docs/ENCRYPTION.md`.
This file holds only working state — what changed recently, what is mid-flight, what regressed.
Do not duplicate architecture here.

---

## CORRECTIONS TO THE PREVIOUS VERSION

The 2026-07-27 morning version carried three claims that live verification later disproved.

**A. `start_conversation_v2` — NOT "recreated on every deploy".**
Previous version: the 2-arg overload was dropped and "something recreates it on deploy".
FALSE. A full-repo search found NO `CREATE FUNCTION` for it anywhere — no migration, no deploy
SQL. The overload was an old leftover; the earlier DROP failed silently because it did not name
the exact signature. It was dropped for good on 07-27 by full signature and verified gone by a
live call. There is no regeneration mechanism.

**B. "risk-scan is the only phrase-scan and it's dead" — INCOMPLETE.**
The phrase scanner also lives inside `process_users_total_v2.mjs` (`phraseScanAndInsertRisks`),
runs on the automatic hourly chain with `DRY_RUN=false`, and writes `match_method=2`. That path
is healthy. `risk-scan.mjs` was a third, broken, redundant copy — now disabled.

**C. "No match_method=2 rows means the phrase path is broken" — FALSE.**
Proven by a live end-to-end test: a seeded phrase produced a `match_method=2` row immediately.
The earlier absence just meant no listed phrase appeared in patient lines in the test data.

---

## DONE — this session (2026-07-27 evening), verified live

**1. Deleted `patient_identity_map_decrypted`** — closed the medical-data exposure.
The View granted anon full rights and pulled the crypto key from `app_config`. Its only
protection was a decode failure (the `db1:` prefix breaks Base64 on all 38 rows). Pre-checks:
0 dependents, no function references it, no HTML reads it. Verified gone after DROP.

**2. Fixed `start_conversation_v2` overload** — dropped the 2-arg
`(p_phone text, p_name text)` signature by full signature. Two clean signatures remain:
`(p_patient_code uuid)` and `(p_phone, p_name, p_source)`. A live call returned a single uuid
with no PGRST203 ambiguity. Root cause was the earlier silent DROP failure, not regeneration.

**3. Disabled `risk-scan V2`** — `gh workflow disable "risk-scan V2"` -> `disabled_manually`.
Redundant broken copy of the phrase path. The YAML still contains its `schedule:` block; final
removal from the file is a separate step (OPEN).

**4. Verified the risk system end-to-end** — seeded one live conversation (fake phone
`00000000000`, patient c32c06d5 test data) with two lines: one implicit, one containing a listed
phrase. Result: two rows — `match_method=1` (model) and `match_method=2` (phrase). This proves
the DB trigger fires, the queue processes, and both scan paths write. Test rows left in place
(all patients are test data).

**5. Confirmed the automatic processing chain** — `process-queue-worker-v2.yml` (cron `0 * * * *`)
runs `process_queue_worker_v2.mjs`, which spawns `process_users_total_v2.mjs` per queue row with
`DRY_RUN=false`. That spawned script runs BOTH scans in sequence (model at line 853, phrase at
860-869). Queue feed is three-layer: DB trigger (immediate) + `reconcile-new-to-queue-v2` (safety
net). Only ONE script does users_total_v2 NEW->DONE.

**6. Confirmed failure monitoring already exists** — GitHub emails the repo owner on any Actions
failure (screenshot confirmed: "risk-scan V2: All jobs have failed"). No custom monitor needed.
Covers Actions only, NOT pg_cron. The monitor we drafted (monitor-failures.yml, email_send.py)
was discarded to avoid duplicating a built-in feature.

**7. Verified audit log is truly append-only** — a DELETE on `conversation_events_v2` was blocked
by trigger `prevent_conversation_events_v2_change` with `conversation_events_v2 is append only`.
There is a FK `conversation_events_v2_conversation_fk` -> `conversations_session_v2`, so a session
already logged cannot be deleted at all. Working as designed.

---

## OPEN

**1. `insert_conversation_v2` — highest remaining overload risk. TOP PRIORITY.**
Two signatures with the SAME arity, differing only in the 2nd parameter type:
`(p_phone text, p_conversation_id uuid, ...)` vs `(p_phone text, p_name text, ...)`.
An untyped string conversation_id could land in the name field. Fix as we fixed
start_conversation_v2: verify callers, then DROP the wrong signature BY FULL SIGNATURE.
Lesson — DROP FUNCTION on a multi-overload name MUST name the exact signature or it fails silently.

**2. BOT MONITOR enhancements — tomorrow's task.**
(a) Add the assigned psychologist's name to the monitor display.
(b) Add the end time to the `Conversation Ended` event. Structural gap: there is no `ended_at`
column on `conversations_session_v2`, and `current_stage` never advances past
`conversation_started`. May require adding explicit end-of-conversation recording.

**3. `risk-scan.mjs` / risk-scan-v2.yml — finish the removal.**
Workflow disabled but the file still has its `schedule:` block and the script still reads the
dropped `users_tzvira_v2.name`. Either delete the workflow file, or (if kept as a manual tool)
repoint the name lookup to `patient_identity_map` by `patient_code`.

**4. Shadow columns on `risk_reviews_v2`** — `phone` + `name` still exist; viewer line 559 still
selects them. Safe to drop now that the phrase path uses the integrated scanner (which resolves
name differently). Verify no other consumer first.

**5. `talk_read_flags` vs `talk_read_flags_v2`** — viewer reads the no-suffix table (line 287),
where the 3 psychologist policies live. The `_v2` version is abandoned AND carries two open
policies: select on `auth.role()='authenticated'`, update on `true`. Remove those.

**6. Missing write policies — verify intent.** `users_information_v2`, `users_tzvira_v2`,
`patient_identity_map` have SELECT policies only. Likely deliberate (writes via SECURITY DEFINER).

**7. Production blockers** — close the temporary open gate `users_viewer_risk_v2.html`; restore
email auth + close the bypass login; connect the viewer to `rpc_get_users_tzvira_v2_viewer`.

**8. Safety-net reconciler** — the DB trigger IS firing (proven this session). Re-evaluate whether
`reconcile-new-to-queue-v2` is still needed, or is now redundant.

**9. pg_cron failures** (not covered by GitHub's email): jobs 1 and 11 target a deleted function
(delete them); job 24 needs a `pg_net` signature fix.

**10. Five *.psbackup.* files on disk but gitignored** (`*.psbackup.*`), including two scripts.
They cannot run anywhere. Decide keep-out-of-git vs delete.

**11. Unresolved timing note** — audit chain stamped 08:20 but the only relevant cron is minute 00.
No minute-20 schedule exists in the repo. Needs GitHub Actions run history; low priority.

---

## Key learnings

- **PostgREST function overloads are this project's most persistent failure mode.** Two overloads
  that can both match one call cause PGRST203 and silent mis-routing. Fix by DROP with EXACT
  signature — a name-only DROP fails silently and looks like the overload "came back".

- **A column drop breaks consumers outside the viewer.** The `users_tzvira_v2` migration was
  verified against the viewer only and killed `scripts/risk-scan.mjs` for a day. Always check
  `scripts/`, `tools/`, workflows, and DB functions.

- **Don't build what already exists.** We nearly added a failure-monitor duplicating GitHub's
  built-in email alerts. Check account-level features, not just the YAML, before building.

- **The audit log is genuinely append-only** and FK-linked to sessions — so seeded test
  conversations cannot be deleted. Seed test data only with clearly fake phones; accept it becomes
  permanent.

- GitHub Pages serves stale cache independently of a browser hard-refresh. Match the header
  timestamp SHA against the pushed SHA before concluding anything about viewer behavior.

- Claude Code defaults to Manual approval — file writes silently wait. Choose "allow all edits
  during this session". Reports in English to avoid RTL/encoding, written to
  `powershell_text\POWERSHELL_TXT.txt`, overwrite, then read back to verify non-empty.

- **All 38 patients are test data.** One holds 98 of 127 sessions (min gap < 6s). Never derive
  usage metrics from row counts.

---

## Working rules

- On "סיום סשן": merge this file, then run the full Git cycle (add / commit / push) and verify
  against `origin/main`.
- Architecture goes in `PROJECT_GUIDE.md`. Encryption detail goes in `docs/ENCRYPTION.md`.
  This file stays short.
