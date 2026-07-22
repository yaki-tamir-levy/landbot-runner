# runtime-corrected-response — תיעוד ארכיטקטורה

תיעוד זה נגזר **אך ורק** מקריאת הקוד בקובץ `index.ts` שבתיקייה זו.
כל פרט שלא ניתן לאמת מהקוד מסומן במפורש: **לא מאומת מהקוד**.

---

## 1. תמונת מצב כללית

Edge Function יחיד (Deno) המקבל בקשת `POST` מ-Landbot, מייצר תשובת מטפל
(Candidate) מול OpenAI Responses API, מעביר אותה למנגנון Corrector, ומחזיר JSON.

זרימה מלאה:

```
POST
 └─> בדיקת method (POST בלבד)
 └─> בדיקת משתני סביבה (OPENAI_API_KEY, LANDBOT_WEBHOOK_SECRET)
 └─> אימות header x-landbot-secret (השוואה בזמן קבוע)
 └─> parseAndValidatePayload()      — JSON + שדות חובה
 └─> buildTherapistInstructions()   — הוראות המטפל
 └─> buildCandidateInput()          — קלט המטפל
 └─> generateCandidate()            — OpenAI Responses API
 └─> fetchRuntimeCorrectorPrompt()  — שליפת פרומפט ה-Corrector מ-Supabase REST
 └─> runCorrector()                 — OpenAI Responses API + json_schema
 └─> validateCorrectorResult()      — ולידציה קשיחה של הפלט
 └─> jsonResponse()                 — JSON חזרה ל-Landbot
 └─> finally: logDiagnostic()       — לוג דיאגנוסטי (console.log)
```

---

## 2. שלבי הזרימה בפירוט

### 2.1 קבלת POST ובדיקות מקדימות

הפונקציה רשומה דרך `Deno.serve`. בתחילת כל בקשה נוצר `correlationId`
באמצעות `crypto.randomUUID()` ונרשם `startedAt`.

סדר הבדיקות (כל אחת מחזירה מיד במקרה של כישלון):

| בדיקה | תנאי כישלון | סטטוס | `error` |
|---|---|---|---|
| מתודה | `request.method !== "POST"` | 405 | `method_not_allowed` |
| הגדרות שרת | חסר `OPENAI_API_KEY` או `LANDBOT_WEBHOOK_SECRET` | 500 | `server_configuration_missing` |
| אימות | `x-landbot-secret` אינו זהה ל-`LANDBOT_WEBHOOK_SECRET` | 401 | `unauthorized` |
| גוף הבקשה | JSON לא תקין / לא אובייקט / מערך | 400 | `malformed_json` |
| שדה חובה | שדה חסר או שאינו מחרוזת | 400 | `missing_required_field:<field>` |

### 2.2 בדיקת ה-header

`x-landbot-secret` מושווה לסוד שב-`LANDBOT_WEBHOOK_SECRET` באמצעות
`constantTimeEqual()` — השוואת בתים ב-XOR על כל האורך (כולל אורכי המחרוזות),
כדי למנוע דליפת מידע דרך זמן ההשוואה. כותרת חסרה נחשבת למחרוזת ריקה.

### 2.3 `buildTherapistInstructions(payload)`

משרשרת בשורות: `prompt20`, `pre_patient20`, `patient20`, שורה ריקה,
ואז הכותרת `Mandatory operational rules for this runtime request:` ושמונה כללים
קבועים (מצוטטים מהקוד):

- `Reply in Hebrew only.`
- `Maintain gender consistency with the patient and prior context.`
- `Plain text only; no Markdown, numbering decorations, tables, or JSON.`
- `Ask at most one question.`
- `Do not repeat a proposal that was already rejected or did not fit.`
- `Do not repeat the same empathy phrasing or emotional reflection from the previous therapist response.`
- `Offer one practical suggestion only when the patient explicitly requests practical help.`
- `Safety rules override all other instructions.`

### 2.4 `buildCandidateInput(payload)`

בונה טקסט עם ארבעה מקטעים מתויגים, בסדר הזה, מופרדים בשורה ריקה:
`summarized20:`, `tzvira:`, `response20:` (ברירת מחדל `""` אם חסר), `question20:`.

### 2.5 `generateCandidate()`

קריאת `POST` ל-`https://api.openai.com/v1/responses`:

| פרמטר | ערך |
|---|---|
| `model` | `THERAPIST_MODEL` או ברירת המחדל `gpt-5.4` |
| `instructions` | פלט `buildTherapistInstructions()` |
| `input` | פלט `buildCandidateInput()` |
| `max_output_tokens` | 500 |
| `temperature` | 0.7 |
| `store` | `false` |
| `metadata` | `{ patient_id, session_id }` |
| timeout | 60,000ms (`AbortController`) |

הטקסט מחולץ ב-`extractResponseText()`: קודם `output_text` ברמה העליונה,
ואם אינו קיים — שרשור כל `content[].text` (או `content[].output_text`) מתוך `output[]`.
תוצאה ריקה לאחר `trim()` → HTTP 502 עם `candidate_generation_failed`.

### 2.6 `fetchRuntimeCorrectorPrompt()`

הפרומפט של ה-Corrector **אינו** מוטמע בקוד — הוא נשלף בזמן ריצה מ-Supabase REST:

```
GET {SUPABASE_URL}/rest/v1/prompt_information_v2?select=user_text&prompt_key=eq.corrector&limit=1
```

- מפתח: `SUPABASE_SERVICE_ROLE_KEY`, ואם חסר — `SUPABASE_ANON_KEY`, ואם חסר — `SUPABASE_KEY`.
- כותרות: `apikey`, `Authorization: Bearer …`, `Accept: application/json`, `Prefer: count=exact`.

מצבי כישלון (כולם מוחזרים כ-HTTP 502, **לפני** שלב ה-Corrector, ולכן אינם FALLBACK):

| מצב | `error` |
|---|---|
| חסר `SUPABASE_URL` או מפתח | `runtime_corrector_prompt_fetch_failed` |
| תשובת HTTP לא תקינה | `runtime_corrector_prompt_fetch_failed` |
| גוף התשובה אינו מערך | `runtime_corrector_prompt_fetch_failed` |
| נמצאה יותר מרשומה אחת | `runtime_corrector_prompt_fetch_failed` |
| לא נמצאה רשומה | `missing_runtime_corrector_prompt` |
| `user_text` חסר / אינו מחרוזת / ריק לאחר `trim()` | `missing_runtime_corrector_prompt` |

### 2.7 `runCorrector()`

קריאה שנייה ל-Responses API. ה-`input` הוא מחרוזת JSON של האובייקט הבא:

| מפתח | מקור |
|---|---|
| `experiment` | קבוע: `runtime_corrected_response_edge_function` |
| `no_look_ahead_contract` | טקסט קבוע: הקלט מכיל רק היסטוריה מאושרת, תשובת מטפל קודמת מאושרת, הודעת מטופל נוכחית ותשובת Candidate נוכחית |
| `response_format_instruction` | טקסט קבוע: אובייקט JSON תקין אחד בלבד, ללא Markdown וללא טקסט מחוץ ל-JSON |
| `accepted_prior_history` | `tzvira` |
| `previous_accepted_therapist_response` | `response20` (או `""`) |
| `current_patient_message` | `question20` |
| `candidate_response` | פלט `generateCandidate()` |

הגדרות הקריאה: `model` = `CORRECTOR_MODEL` או `gpt-5.4`, `temperature` = 0.1,
`max_output_tokens` = 700, `store` = `false`, timeout 60,000ms,
ופורמט פלט כפוי: `text.format` מסוג `json_schema` בשם `runtime_corrector_response`
עם `strict: true` ו-`additionalProperties: false`, הדורש בדיוק את השדות
`action` (enum: `PASS` / `REWRITE`), `final_response` (מחרוזת) ו-`reason_codes`
(מערך מתוך רשימת ה-reason codes הסגורה).

### 2.8 `validateCorrectorResult()` — ולידציה מעבר לסכימה

גם לאחר `json_schema`, הפלט נבדק שוב בקוד. כל כישלון זורק שגיאה ומוביל ל-FALLBACK:

| שגיאה | תנאי |
|---|---|
| `corrector_not_json_object` | הטקסט אינו מתחיל ב-`{` ומסתיים ב-`}` |
| `corrector_invalid_json_object` | לאחר `JSON.parse` — אינו אובייקט או שהוא מערך |
| `corrector_schema_mismatch` | קבוצת המפתחות אינה בדיוק `action`, `final_response`, `reason_codes` |
| `corrector_invalid_action` | `action` אינו `PASS` ואינו `REWRITE` |
| `corrector_missing_final_response` | `final_response` אינו מחרוזת |
| `corrector_invalid_reason_codes` | `reason_codes` אינו מערך |
| `corrector_invalid_reason_code` | קוד שאינו ברשימה הסגורה |
| `corrector_pass_final_response_mismatch` | ב-`PASS`, `final_response` אינו זהה בדיוק ל-Candidate |
| `corrector_empty_rewrite` | ב-`REWRITE`, `final_response` ריק לאחר `trim()` |

בנוסף, לאחר הוולידציה: אם `action === "REWRITE"` וה-`final_response` ריק לאחר
`trim()`, נזרקת `empty_rewrite` — גם היא מובילה ל-FALLBACK.

---

## 3. שדות הקלט

טיפוס `RequestPayload` מגדיר **תשעה** שדות. עם זאת, רשימת האימות בקוד
(`REQUIRED_TEXT_FIELDS`) כוללת **שמונה** שדות בלבד — `response20` מוגדר אופציונלי
(`response20?: string`) ואינו נבדק.

| # | שדה | טיפוס | נדרש בוולידציה? |
|---|---|---|---|
| 1 | `prompt20` | string | כן |
| 2 | `pre_patient20` | string | כן |
| 3 | `patient20` | string | כן |
| 4 | `summarized20` | string | כן |
| 5 | `tzvira` | string | כן |
| 6 | `response20` | string (אופציונלי) | **לא** — ברירת מחדל `""` |
| 7 | `question20` | string | כן |
| 8 | `patient_id` | string | כן |
| 9 | `session_id` | string | כן |

שדה נדרש שחסר או שאינו מחרוזת (כולל מחרוזת ריקה — שהיא **תקינה**) מחזיר
HTTP 400 עם `missing_required_field:<field>`.

---

## 4. מבנה ה-JSON החוזר

### 4.1 תשובת הצלחה (HTTP 200)

```json
{
  "ok": true,
  "answer": "תשובה מקורית:\n…\n\nתשובה לאחר בדיקה:\n…",
  "candidate_answer": "…",
  "corrected_answer": "…",
  "corrector_decision": "PASS | REWRITE | FALLBACK",
  "correction_action": "PASS | REWRITE | FALLBACK",
  "reason_codes": [],
  "fallback_used": false
}
```

- `correction_action` תמיד זהה ל-`corrector_decision`.
- `answer` נבנה ב-`formatDiagnosticAnswer()` ומכיל **טקסט דיאגנוסטי משולב**:
  `"תשובה מקורית:\n<candidate>\n\nתשובה לאחר בדיקה:\n<checked>"` — כלומר אינו
  התשובה הסופית הנקייה בלבד.
- `correlation_id` נוצר בקוד אך **אינו** מוחזר בגוף התשובה — הוא מופיע רק בלוגים.

### 4.2 תשובת שגיאה

```json
{ "ok": false, "error": "<code>" }
```

קודי השגיאה האפשריים: `method_not_allowed` (405), `server_configuration_missing` (500),
`unauthorized` (401), `malformed_json` (400), `missing_required_field:<field>` (400),
`candidate_generation_failed` (502), `runtime_corrector_prompt_fetch_failed` (502),
`missing_runtime_corrector_prompt` (502).

כל התשובות מוחזרות עם `Content-Type: application/json; charset=utf-8`.

---

## 5. שלוש התוצאות האפשריות

| תוצאה | מתי | `answer` (החלק השני) | `corrected_answer` | `reason_codes` | `fallback_used` |
|---|---|---|---|---|---|
| **PASS** | ה-Corrector החזיר `action: "PASS"` והוולידציה עברה | `"לא נדרש תיקון."` | ה-Candidate | `[]` (קבוע בקוד) | `false` |
| **REWRITE** | `action: "REWRITE"` עם `final_response` לא ריק | ה-rewrite | ה-rewrite | מה-Corrector | `false` |
| **FALLBACK** | כל חריגה בשלב ה-Corrector (קריאת OpenAI, ולידציה, rewrite ריק) | `"הבדיקה לא הושלמה, ולכן לא בוצע תיקון."` | ה-Candidate | `[]` | `true` |

הערות:

- FALLBACK מחזיר **HTTP 200** ו-`ok: true` — כשל ה-Corrector אינו מכשיל את הבקשה,
  ותשובת ה-Candidate נשמרת.
- FALLBACK חל רק על השלב שאחרי שליפת פרומפט ה-Corrector. כשל בשליפת הפרומפט
  עצמו מחזיר 502 ואינו FALLBACK.
- כשל בשלב ה-Candidate מחזיר 502 ולעולם אינו מגיע ל-Corrector.

---

## 6. Reason codes

רשימה סגורה (`REASON_CODES`), נאכפת גם ב-`json_schema` וגם ב-`validateCorrectorResult()`
מול `REASON_CODE_SET`. קוד שאינו ברשימה → FALLBACK.

| # | קוד |
|---|---|
| 1 | `REPEATS_REJECTED_IDEA` |
| 2 | `VIOLATES_USER_CONSTRAINT` |
| 3 | `REDUNDANT_SUMMARY` |
| 4 | `NO_FORWARD_PROGRESS` |
| 5 | `UNSUPPORTED_INFERENCE` |
| 6 | `OVER_ANALYSIS` |
| 7 | `OVERLY_TASK_ORIENTED` |
| 8 | `TOO_LONG` |
| 9 | `CONTINUITY_ERROR` |
| 10 | `MISSES_DIRECT_REQUEST` |
| 11 | `TONE_MISMATCH` |
| 12 | `OTHER` |

הקוד אינו מגדיר סמנטיקה לקודים — המשמעות מגיעה מפרומפט ה-Corrector הנשלף
מ-Supabase, ולכן **לא מאומת מהקוד**.

---

## 7. משתני סביבה

| משתנה | חובה | שימוש |
|---|---|---|
| `OPENAI_API_KEY` | כן | קריאות ל-OpenAI; חסר → 500 |
| `LANDBOT_WEBHOOK_SECRET` | כן | אימות `x-landbot-secret`; חסר → 500 |
| `THERAPIST_MODEL` | לא | מודל ה-Candidate; ברירת מחדל `gpt-5.4` |
| `CORRECTOR_MODEL` | לא | מודל ה-Corrector; ברירת מחדל `gpt-5.4` |
| `SUPABASE_URL` | כן, לשלב ה-Corrector | בסיס ה-REST לשליפת הפרומפט |
| `SUPABASE_SERVICE_ROLE_KEY` | ראשון בסדר העדיפויות | מפתח לשליפת הפרומפט |
| `SUPABASE_ANON_KEY` | חלופה שנייה | מפתח לשליפת הפרומפט |
| `SUPABASE_KEY` | חלופה שלישית | מפתח לשליפת הפרומפט |

---

## 8. לוגים ודיאגנוסטיקה

- `candidate_request_debug` (`console.log`) — לפני קריאת ה-Candidate. מכיל את
  `correlation_id`, `therapist_model`, את הוראות המטפל, את קלט ה-Candidate ואת
  **כל תשעת שדות ה-payload בטקסט מלא**.
- `openai_http_error` (`console.error`) — סטטוס, `x-request-id` וגוף השגיאה לאחר
  `sanitizeOpenAIErrorBody()`: מיסוך `sk-…` ו-`Bearer …`, וקיצור ל-1000 תווים.
- `runtime_corrector_prompt_fetch_failed` / `missing_runtime_corrector_prompt` (`console.error`).
- `candidate_generation_exception` (`console.error`) — בבלוק ה-catch החיצוני.
- לוג סיכום ב-`finally` (`logDiagnostic`) — `correlation_id`, `candidate_success`,
  `corrector_decision`, `fallback_used`, `http_status`, `candidate_elapsed_ms`,
  `corrector_elapsed_ms`, `total_elapsed_ms`, `therapist_model`, ההוראות, הקלט וה-payload.

הערה מאומתת מהקוד: המשתנה `httpStatus` שנרשם בלוג הסיכום אינו מתעדכן במסלול
כשל שליפת פרומפט ה-Corrector (המחזיר 502 ישירות), ולכן הלוג ירשום שם 200.

---

## 9. מה **לא** מופיע בקוד

- אין כתיבה לשום טבלה. הגישה היחידה ל-Supabase היא **קריאה** מ-`prompt_information_v2`.
- טבלאות אחרות (למשל `users_information_v2`, `risk_reviews_v2`) אינן מוזכרות
  בקובץ זה כלל.
- מיפוי הפלט ל-Landbot (איזה שדה נכתב לאיזה משתנה ב-Flow) אינו בקוד — **לא מאומת מהקוד**.
