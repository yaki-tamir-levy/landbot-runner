# SESSION HANDOFF

**Last updated: 2026-07-26 (session 2)**

Merged handoff. This file is NOT an append-only log: on every update it is merged in place.
Completed items move from OPEN to DONE with a date, new items are added, learnings are updated,
and duplicates are consolidated. Do not accumulate historical session sections.

---

## DONE

**1. "Unknown" status bug — root-caused to 3 separate layers** *(2026-07-26)*
- 400 error from an empty `or=()` query parameter.
- Missing RLS policy on `users_information_v2`: RLS enabled with 0 policies returns a silent empty result (no error), which surfaced as "Unknown".
- Partial status label map: only values `1` and `3` were mapped.
- Status label map now covers: `1 = מטופל`, `2 = קורסיסט`, `3 = מטופל קורסיסט`, `4 = פיקטיבי`, with a normalized string/number comparison.

**2. Status filter isolation** *(2026-07-26)*
- Status `4` (test) is now isolated. Filter semantics: `1 → {1,3}`, `2 → {2,3}`, `3 → {1,2,3}`, `4 → {4}` only.

**3. Migration `phone` → `patient_code` COMPLETE** *(2026-07-26)*
- Includes `talk_read_flags`: the table was emptied (192 junk rows, 0 tied to live conversations), `patient_code uuid NOT NULL` was added, the PK changed from `(time_key, phone)` to `(time_key, patient_code)`, and `phone` was made nullable and then DROPPED.
- Also migrated: `riskKey`, `keyOf`, `flagsMap`, `onConflict`, and the patient counter (which was the last consumer of `r.phone`).

**4. Shadow columns DROPPED** *(2026-07-26)*
- `name` + `phone` from `users_tzvira_v2`; `phone` from `talk_read_flags`.
- Verified no code reads them. Masked phone/name now come only from `patient_identity_map`.

**5. SECURITY DEFINER RLS filtering by psychologist** *(2026-07-26)*
- Full resolution chain: `auth.jwt()->>'email'` → `psychologists_v2.email` → `.phone` → `users_information_v2.psychologist` → `patient_code`.
- Functions: `current_psychologist_phone()`, `current_user_is_admin()`.
- Policies `psychologist_select` / `psychologist_update` / `psychologist_insert` on 5 tables: `users_information_v2`, `users_tzvira_v2`, `patient_identity_map`, `risk_reviews_v2`, `talk_read_flags`. Each policy is: admin OR own-patient.
- `psychologists_v2` stays RLS-locked with 0 policies — reachable only via the definer functions.

**6. Admin mechanism** *(2026-07-26)*
- Added `is_admin boolean NOT NULL DEFAULT false` to `psychologists_v2`. It is NEVER written by the sheet sync (verified: `upsert_psychologist_from_sheet` updates explicit columns only).
- Admin account: `yonatan10.bot@gmail.com`.
- Added a `UNIQUE INDEX` on `lower(email)` after fixing duplicate-email rows. The duplicates were a live privilege leak: a shared email meant shared admin rights plus non-deterministic psychologist resolution.

**7. Live version timestamp in the header** *(2026-07-26)*
- The viewer fetches the last commit date for its own file from the GitHub API and converts it to `Asia/Jerusalem`.
- This addressed the root cause of roughly half the session's confusion: GitHub Pages was serving STALE cached versions even after `Ctrl+Shift+R`, with no way to tell which version was loaded.
- The "חיים search bug" that was chased for a long time was NOT a code bug. Proven by the `NAMEFILTER` log showing `indexOf=0`; it was GitHub Pages cache serving old code. Shifting line numbers (557 → 586 → 629) confirmed when a new version finally loaded.

**8. Psychologist name display** *(2026-07-26)*
- RPC `psychologist_names_for_viewer()` returns `(patient_code, name)` only for viewable patients (admin = all, psychologist = own).
- Displayed as `name · phone · המטפל: X` in the main row and in the alert box.
- Shows `לא משויך` for unassigned patients.

**9. Risk reviewer simplified** *(2026-07-26)*
- `risk_reviews_v2.reviewer` is now auto-derived from the assigned psychologist (`psychNameFor`), never from the old free-text field.
- The free-text `שם מטפל` input was REMOVED from the UI, and the `שם המטפל` label was REMOVED from the alert box. The `review_notes` field was KEPT.
- Existing rows were retroactively updated to `NURIT`.
- Never writes empty: uses the derived name, otherwise omits `reviewer` from the payload rather than blocking the write.

**10. Viewer gate confirmed secure** *(2026-07-26, session 2)*
- With no session the page redirects to login; RLS returns 0 rows without a valid JWT.
- The old "debug open gate" concern is RESOLVED by the RLS built earlier in the session.
- Verified by clearing the `localStorage` session → redirect to login.

**11. Merged handoff mechanism created** *(2026-07-26, session 2)*
- `docs\SESSION_HANDOFF.md` — merge-on-update, chat-facing.
- `CLAUDE.md` at repo root — auto-read by Claude Code at session start.

---

## OPEN

**1. `start_conversation_v2` — PGRST203 overload conflict (REGRESSED, root cause unknown)**
- CONFIRMED STILL BROKEN: `start_conversation_v2` has 3 overloads again. `(p_phone, p_name)` and `(p_phone, p_name, p_source)` both match the incoming call → PostgREST returns `PGRST203` → Landbot cannot create a `conversation_id` → NO conversation reaches the DB.
- This is exactly why course/all conversations do not write to `conversations_prod_v2`. It breaks at step 1 — not a table or migration issue.
- The 2-arg version was re-dropped this session as a STOPGAP only.
- ROOT CAUSE NOT YET FOUND: something recreates the stale 2-arg version. Suspect a migration/SQL file in the repo running `CREATE OR REPLACE` on deploy.
- NEXT: search the repo for `start_conversation_v2` definitions and remove the stale 2-arg one at source, otherwise it returns on every deploy.
- Originally root-caused live via a real Landbot test with phone `22222223`: no new session row appeared, and the `PGRST203` error was then surfaced.

**2. `insert_conversation_v2` — 2 overloads, verify overload risk**
- Signatures: `(p_phone, p_conversation_id uuid, ...)` vs `(p_phone, p_name text, ...)`.
- The 2nd-argument type differs (`uuid` vs `text`), so it MAY be safe if Landbot calls by name — but VERIFY, given that `start_conversation_v2` kept regressing.

**3. Finish shadow columns everywhere**
- `risk_reviews_v2` still has `phone` + `name` shadow columns. Needs full read/write mapping before dropping. Code-before-DB.

**4. Clean up patients that are not in the SHEET.**

**5. `otp_send_failed` on the 2nd consecutive OTP send** — suspected Supabase Auth rate limit; verify.

**6. 8 orphan `patient_identity_map` rows** from the deleted prompt rows in *(source note truncated — origin table/scope to be confirmed next session)*.

---

## Key learnings

- GitHub Pages serves stale cache independently of a browser hard-refresh. Always verify that the header timestamp SHA matches the pushed SHA before concluding anything about viewer behavior.
- PostgREST function overloads are a recurring failure mode in this project. A dropped overload can come back on deploy — treat "dropped it in the DB" as a stopgap, never as a fix, until the source definition is removed from the repo.
- Claude Code's default permission mode was Manual, so file writes silently waited for approval — earlier "wrote to file" reports were issued before approval was granted. Fixed by ending each instruction with auto-approve; reports are now written in English to avoid RTL/encoding issues.
- `conversations_session_v2` is a SESSION tracker (`conversation_id`, `patient_code`, `current_stage`, `started_at`, `source`) — NOT a message-content table. Do not compare its row count to `conversations_prod_v2`.

---

## Working rules

- End-of-session: when the user says "סיום סשן", update this file via merge, then run a full Git cycle (add / commit / push) and verify against `origin/main`.
