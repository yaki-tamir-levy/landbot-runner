import fetch from "node-fetch";
/**
 * scripts/process_users_total_v2.mjs
 *
 * V2 runtime (isolated, dry-run)
 * - V2 runtime
 * - isolated runtime (never writes to legacy tables)
 * - dry-run runtime (no external side-effects)
 *
 * This file is a Phase-1 parallel clone of `scripts/process_users_total.mjs`.
 * Changes (V2):
 * - Uses `patient_code` as primary runtime identity (phone/name are shadows)
 * - V2 table names (users_total_v2, users_tzvira_v2, risk_reviews_v2, supa_guarded_run_log_details_v2)
 * - `supaPatch()` patches by `patient_code` only (never by phone)
 * - Risk dedup keys use `patient_code` instead of `phone`
 * - `DRY_RUN = true` (no writes to Supabase are performed)
 * - Adds compare metadata placeholders: legacy_runtime_id, compare_status, compare_reason
 *
 * IMPORTANT: READ-ONLY CHANGES TO PRODUCTION BEHAVIOR — THIS FILE MUST NOT
 * perform any real mutating side-effects while `DRY_RUN = true`.
 */

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY");

// V2 isolation: DRY_RUN prevents any real write operations from this runtime.
// Default = SAFE MODE
// To enable LIVE mode explicitly:
// PowerShell:
// $env:DRY_RUN="false"
const DRY_RUN =
  String(process.env.DRY_RUN ?? "true")
    .trim()
    .toLowerCase() === "true";

const MAX_ITEMS = parseInt(process.env.MAX_ITEMS ?? "20", 10);
const ONLY_ID = process.env.ONLY_ID ?? null;
const PHRASE_SCAN_ONLY = String(process.env.PHRASE_SCAN_ONLY ?? "").trim() === "1";
const RUNTIME_VERSION = "v2-hardening-upsert-done-order-2026-05-17";

// V2 tables
const USERS_TOTAL_TABLE = "users_total_v2";
const USERS_TZVIRA_TABLE = "users_tzvira_v2";
const RISK_REVIEWS_TABLE = "risk_reviews_v2";
const RISK_PHRASES_TABLE = "risk_phrases";

const USERS_INFORMATION_TABLE = "users_information";
const PROMPT10_PHONE = "77777777";
const PROMPT10_COLUMN = "user_text";

const RISK_SPLIT_DELIM = "===SPLIT_RISK_REASONS===";

const ELIGIBLE_PROCESSED_STATES = ["NEW", "IN_PROGRESS", "ERROR"];
const ELIGIBLE_OR_FILTER = `(${ELIGIBLE_PROCESSED_STATES.map((s) => `processed.eq.${s}`).join(",")})`;



async function rebuildUsersTotalRiskFieldsFromRiskReviews({ id, patient_code }) {
  if (!id || !patient_code) {
    throw new Error("rebuildUsersTotalRiskFieldsFromRiskReviews requires id and patient_code");
  }

  const url = new URL(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${RISK_REVIEWS_TABLE}`);

  url.searchParams.set("select", "line_num,short_risk,risk_reasons");
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("patient_code", `eq.${patient_code}`);
  url.searchParams.set("order", "line_num.asc");

  const res = await fetch(url, { headers: supaHeaders() });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`risk_reviews_v2 aggregation failed: ${res.status} ${text}`);
  }

  let rows = [];

  try {
    rows = JSON.parse(text);
  } catch {
    rows = [];
  }

  rows.sort((a, b) => Number(a.line_num ?? 0) - Number(b.line_num ?? 0));

  const uniqueRiskReasons = new Set();
  const uniqueShortRisks = new Set();

  const riskReasons = rows
    .filter(r => r.line_num != null && String(r.risk_reasons ?? "").trim())
    .map(r => `-${r.line_num}- | ${String(r.risk_reasons).trim()}`)
    .filter(v => {
      if (uniqueRiskReasons.has(v)) {
        return false;
      }
      uniqueRiskReasons.add(v);
      return true;
    })
    .join("\n");

  const summarizedLinkedTalkRisk = rows
    .filter(r => r.line_num != null && String(r.short_risk ?? "").trim())
    .map(r => `-${r.line_num}- ${String(r.short_risk).trim()}`)
    .filter(v => {
      if (uniqueShortRisks.has(v)) {
        return false;
      }
      uniqueShortRisks.add(v);
      return true;
    })
    .join("\n");

  await supaPatch(
    patient_code,
    {
      risk_reasons: riskReasons,
      summarized_linked_talk_risk: summarizedLinkedTalkRisk
    },
    ["processing"]
  );

  console.log(`[INFO] rebuilt aggregated risk fields for patient_code=${patient_code}`);
}


// ---------- helpers ----------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function supaHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function israelNowParts() {
  const dt = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(dt);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const ms = dt.getMilliseconds();
  const micro = String(ms).padStart(3, "0") + "000";
  return { ...map, micro };
}

function lastSummaryAtIsraelWithPlus00() {
  const p = israelNowParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${p.micro}+00`;
}

function summaryHeaderIsrael() {
  const p = israelNowParts();
  const ddmmyyyy = `${p.day}/${p.month}/${p.year}`;
  const compact = `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}Z`;
  return `${ddmmyyyy} - ${compact}`;
}

function buildNumberedTalk(talkText) {
  if (!talkText || typeof talkText !== "string") return { numberedText: "", count: 0 };
  const lines = talkText.split(/\r?\n/);
  const out = [];
  let n = 1;
  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const t = line.trimStart();
    const isHeb = line.includes("שאלה:") || line.includes("תשובה:");
    const isQA = t.startsWith("Q:") || t.startsWith("A:");
    if (isHeb || isQA) {
      out.push(`-${n}- ${line}`);
      n++;
    }
  }
  return { numberedText: out.join("\n"), count: out.length };
}

function concatSummaries(existing, header, summaryText) {
  const hasExisting = existing && String(existing).length > 0;
  const sep = hasExisting ? "\n\n========\n" : "";
  const block = `${sep}${header}\n${summaryText ?? ""}\n`;
  return (existing ?? "") + block;
}

function splitRiskText(x) {
  const s = String(x ?? "");
  const idx = s.indexOf(RISK_SPLIT_DELIM);
  if (idx === -1) return { risk: s.trim(), reasons: "" };
  const before = s.slice(0, idx).trim();
  const after = s.slice(idx + RISK_SPLIT_DELIM.length).trim();
  return { risk: before, reasons: after };
}

function parseNumberedLines(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const lines = s.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = String(raw ?? "").trim();
    if (!line) continue;
    const m = line.match(/^\s*-(\d+)-\s*(.*)\s*$/);
    if (!m) continue;
    const lineNo = parseInt(m[1], 10);
    if (!Number.isFinite(lineNo)) continue;
    const body = String(m[2] ?? "").trim();
    out.push({ line_no: lineNo, text: body });
  }
  return out;
}

function parseReasonsMap(text) {
  const items = parseNumberedLines(text);
  const map = new Map();
  for (const it of items) {
    const body = String(it.text ?? "");
    const idx = body.indexOf("|");
    const reason = idx >= 0 ? body.slice(idx + 1).trim() : body.trim();
    map.set(it.line_no, reason);
  }
  return map;
}

// ---------- OpenAI (unchanged behavior) ----------
function extractResponseText(respJson) {
  if (!respJson) return "";
  if (Array.isArray(respJson.output)) {
    const chunks = [];
    for (const item of respJson.output) {
      if (!item?.content) continue;
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c.text === "string") chunks.push(c.text);
        else if (typeof c?.text === "string") chunks.push(c.text);
      }
    }
    if (chunks.length) return chunks.join("\n").trim();
  }
  if (typeof respJson.output_text === "string") return respJson.output_text.trim();
  return "";
}

async function callOpenAI(body) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg = json?.error?.message || text || `OpenAI error status ${res.status}`;
    throw new Error(msg);
  }

  const out = extractResponseText(json);
  if (!out) throw new Error("OpenAI returned empty text");
  return out;
}

async function callOpenAISummary(talk) {
  return await callOpenAI({
    model: "gpt-4o",
    store: true,
    instructions: "נא סכם את השיחה",
    input: `שיחות קודמות:\n${talk ?? ""}`,
    max_output_tokens: 1000,
    temperature: 0.4,
  });
}

async function callOpenAIRisk(prompt10, numberedTalk) {
  return await callOpenAI({
    model: "gpt-4o",
    instructions: `הנחיות מחייבות:\n${prompt10 ?? ""}`,
    input: `שיחות קודמות:\n${numberedTalk ?? ""}`,
    max_output_tokens: 4000,
    temperature: 0.4,
  });
}

// ---------- Supabase (V2 safe helpers) ----------
async function supaGetEligibleRows(limit) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_TOTAL_TABLE}`);
  url.searchParams.set(
    "select",
    [
      "id",
      "patient_code",
      "phone",
      "name",
      "processed",
      "linked_talk",
      "last_talk_tzvira",
      "last_summary_at",
      "summarized_linked_talk",
      "summarized_linked_talk_num",
      "summarized_linked_talk_risk",
      "risk_reasons",
      "talk_id",
    ].join(",")
  );

  url.searchParams.set("or", ELIGIBLE_OR_FILTER);

  if (ONLY_ID) {
    url.searchParams.set("id", `eq.${ONLY_ID}`);
    url.searchParams.set("limit", "1");
  } else {
    url.searchParams.set("order", "patient_code.asc");
    url.searchParams.set("limit", String(limit));
  }

  const res = await fetch(url, { headers: supaHeaders() });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function supaGetRowById(id) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_TOTAL_TABLE}`);
  url.searchParams.set("select", ["id", "patient_code", "phone", "name", "processed", "last_summary_at", "summarized_linked_talk_num"].join(","));
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("limit", "1");

  const res = await fetch(url, { headers: supaHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET users_total_v2 by id failed: ${res.status} ${text}`);

  let rows = [];
  try {
    rows = JSON.parse(text);
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

// V2: patch by patient_code ONLY. Do NOT patch by phone.
async function supaPatch(patient_code, patchObj, expectedProcessedStates = null) {
  if (!patient_code) throw new Error("supaPatch requires patient_code");

  // Augment with compare metadata placeholders
  const patchPayload = { ...patchObj, legacy_runtime_id: null, compare_status: "PENDING", compare_reason: null };

  if (DRY_RUN) {
    console.log(`[DRY_RUN][PATCH] table=${USERS_TOTAL_TABLE} patient_code=${patient_code} patch=${JSON.stringify(patchPayload)}`);
    return;
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_TOTAL_TABLE}`);
  url.searchParams.set("patient_code", `eq.${patient_code}`);

  let expectedStatesFilter = null;
  if (Array.isArray(expectedProcessedStates) && expectedProcessedStates.length > 0) {
    if (expectedProcessedStates.length === 1) {
      expectedStatesFilter = `processed.eq.${expectedProcessedStates[0]}`;
      url.searchParams.set("processed", `eq.${expectedProcessedStates[0]}`);
    } else {
      const parts = expectedProcessedStates.map((v) => `processed.eq.${v}`).join(",");
      expectedStatesFilter = `(${parts})`;
      url.searchParams.set("or", expectedStatesFilter);
    }
  }

  const urlString = url.toString();
  console.log(
    `[DEBUG] supaPatch url=${urlString} filter.patient_code=eq.${patient_code} filter.processed=${expectedStatesFilter} payload=${JSON.stringify(patchPayload)}`
  );

  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...supaHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(patchPayload),
  });

  const bodyText = await res.text();
  console.log(`[DEBUG] supaPatch response status=${res.status} ok=${res.ok} body=${bodyText}`);

  if (!res.ok) throw new Error(bodyText || `Supabase PATCH failed (${res.status})`);

  let responseBody;
  try {
    responseBody = JSON.parse(bodyText || "null");
  } catch (err) {
    throw new Error(`Supabase PATCH returned invalid JSON: ${err.message}`);
  }

  if (!Array.isArray(responseBody) || responseBody.length === 0) {
    throw new Error(
      `Supabase PATCH claim failed for patient_code=${patient_code}. Row was not updated, likely already claimed or in an unexpected state.`
    );
  }
}

async function supaPatchByIdForClaim(id, patient_code, patchObj, expectedProcessedStates = null) {
  if (!id) throw new Error("supaPatchByIdForClaim requires id");
  if (!patient_code) throw new Error("supaPatchByIdForClaim requires patient_code");

  const patchPayload = { ...patchObj, legacy_runtime_id: null, compare_status: "PENDING", compare_reason: null };

  if (DRY_RUN) {
    console.log(`[DRY_RUN][PATCH-CLAIM] table=${USERS_TOTAL_TABLE} id=${id} patient_code=${patient_code} patch=${JSON.stringify(patchPayload)}`);
    return;
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_TOTAL_TABLE}`);
  url.searchParams.set("id", `eq.${id}`);

  let expectedStatesFilter = null;
  if (Array.isArray(expectedProcessedStates) && expectedProcessedStates.length > 0) {
    expectedStatesFilter = `processed=in.(${expectedProcessedStates.join(",")})`;
    url.searchParams.set("processed", `in.(${expectedProcessedStates.join(",")})`);
  }

  const urlString = url.toString();
  console.log(
    `[DEBUG] supaPatchByIdForClaim url=${urlString} filter.id=eq.${id} patient_code=eq.${patient_code} filter.processed=${expectedStatesFilter} payload=${JSON.stringify(patchPayload)}`
  );

  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...supaHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(patchPayload),
  });

  const bodyText = await res.text();
  console.log(`[DEBUG] supaPatchByIdForClaim response status=${res.status} ok=${res.ok} body=${bodyText}`);

  if (!res.ok) throw new Error(bodyText || `Supabase PATCH failed (${res.status})`);

  let responseBody;
  try {
    responseBody = JSON.parse(bodyText || "null");
  } catch (err) {
    throw new Error(`Supabase PATCH returned invalid JSON: ${err.message}`);
  }

  if (!Array.isArray(responseBody) || responseBody.length === 0) {
    throw new Error(
      `Supabase claim by id failed for id=${id} patient_code=${patient_code}. Row was not updated, likely already claimed or in an unexpected state.`
    );
  }
}

async function supaFetchPrompt10() {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_INFORMATION_TABLE}`);
  url.searchParams.set("select", PROMPT10_COLUMN);
  url.searchParams.set("phone", `eq.${PROMPT10_PHONE}`);
  url.searchParams.set("limit", "1");

  const res = await fetch(url, { headers: supaHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET prompt10 failed: ${res.status} ${text}`);

  let rows = [];
  try {
    rows = JSON.parse(text);
  } catch {
    rows = [];
  }
  const prompt10 = Array.isArray(rows) && rows.length ? rows[0]?.[PROMPT10_COLUMN] : null;

  if (!prompt10 || !String(prompt10).trim()) {
    throw new Error(
      `Prompt10 is empty/missing in ${USERS_INFORMATION_TABLE}.${PROMPT10_COLUMN} for phone=${PROMPT10_PHONE}`
    );
  }
  return String(prompt10);
}

async function supaFetchActiveRiskPhrases() {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${RISK_PHRASES_TABLE}`);
  url.searchParams.set("select", "pattern");
  url.searchParams.set("is_active", "eq.true");
  url.searchParams.set("order", "pattern.asc");

  const res = await fetch(url, { headers: supaHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET risk_phrases failed: ${res.status} ${text}`);

  let rows = [];
  try {
    rows = JSON.parse(text);
  } catch {
    rows = [];
  }

  const patterns = (Array.isArray(rows) ? rows : [])
    .map((r) => String(r?.pattern ?? "").trim())
    .filter((p) => p.length > 0);

  const seen = new Set();
  const out = [];
  for (const p of patterns) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function textContainsPattern(haystack, needle) {
  const h = String(haystack ?? "").toLowerCase();
  const n = String(needle ?? "").toLowerCase();
  if (!h || !n) return false;
  return h.includes(n);
}

// V2: check existence by patient_code (dedup key includes patient_code instead of phone)
async function supaRiskReviewExists({ id, time_key, patient_code, line_num }) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${RISK_REVIEWS_TABLE}`);
  url.searchParams.set("select", "id");
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("time_key", `eq.${time_key}`);
  url.searchParams.set("patient_code", `eq.${patient_code}`);
  url.searchParams.set("line_num", `eq.${line_num}`);
  url.searchParams.set("limit", "1");

  const res = await fetch(url, { headers: supaHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET risk_reviews_v2 exists failed: ${res.status} ${text}`);

  let rows = [];
  try {
    rows = JSON.parse(text);
  } catch {
    rows = [];
  }
  return Array.isArray(rows) && rows.length > 0;
}

async function phraseScanAndInsertRisks({ id, time_key, patient_code, phone, name, numberedText, activeRiskPhrases }) {
  if (!Array.isArray(activeRiskPhrases) || activeRiskPhrases.length === 0) return 0;

  const lines = parseNumberedLines(numberedText);
  if (!Array.isArray(lines) || lines.length === 0) return 0;

  let inserted = 0;

  for (const ln of lines) {
    const lineNum = ln.line_no;
    const lineText = ln.text ?? "";

    const _t = String(lineText ?? "").trimStart().toLowerCase();
    if (!(_t.startsWith("q:") || _t.startsWith("שאלה:"))) continue;

    let matchedPattern = null;
    for (const pattern of activeRiskPhrases) {
      if (textContainsPattern(lineText, pattern)) {
        matchedPattern = pattern;
        break;
      }
    }
    if (!matchedPattern) continue;

    const exists = await supaRiskReviewExists({
      id,
      time_key,
      patient_code,
      line_num: lineNum,
    });
    if (exists) continue;

    await insertRiskReviewsRows([
      {
        id,
        time_key,
        patient_code,
        phone,
        name,
        line_num: lineNum,
        short_risk: lineText,
        risk_reasons: matchedPattern,
        match_method: "2",
      },
    ]);

    inserted += 1;
  }

  return inserted;
}

async function supaInsert(table, payload, options = {}) {
  const { onConflict = null, operation = "INSERT" } = options;

  let bodyPayload;

  if (Array.isArray(payload)) {
    bodyPayload = payload.map((row) => ({
      ...row,
      legacy_runtime_id: null,
      compare_status: "PENDING",
      compare_reason: null,
    }));
  } else {
    bodyPayload = {
      ...payload,
      legacy_runtime_id: null,
      compare_status: "PENDING",
      compare_reason: null,
    };
  }

  if (DRY_RUN) {
    const conflictInfo = onConflict ? ` on_conflict=${onConflict}` : "";
    console.log(`[DRY_RUN][${operation}] table=${table}${conflictInfo} payload=${JSON.stringify(bodyPayload)}`);
    return;
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  if (onConflict) {
    url.searchParams.set("on_conflict", onConflict);
  }

  const prefer = onConflict
    ? "resolution=merge-duplicates,return=minimal"
    : "return=minimal";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...supaHeaders(),
      Prefer: prefer,
    },
    body: JSON.stringify(bodyPayload),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Supabase ${operation} into ${table} failed: ${res.status} ${text}`
    );
  }
}

async function supaUpsert(table, payload, onConflict) {
  if (!onConflict || !String(onConflict).trim()) {
    throw new Error(`supaUpsert requires onConflict for table=${table}`);
  }
  return await supaInsert(table, payload, { onConflict, operation: "UPSERT" });
}

async function insertUsersTzviraRow({ id, time_key, patient_code, phone, name, last_talk_tzvira, summarized_linked_talk }) {
  // V2: include patient_code as primary identity and keep phone/name as shadow fields
  await supaUpsert(
    USERS_TZVIRA_TABLE,
    {
      id,
      time_key,
      patient_code,
      phone,
      name,
      last_talk_tzvira,
      summarized_linked_talk,
    },
    "patient_code,time_key"
  );
}

async function insertRiskReviewsRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  await supaUpsert(
    RISK_REVIEWS_TABLE,
    rows,
    "patient_code,time_key,line_num,short_risk"
  );
}

async function processOneRow(row, prompt10Text, activeRiskPhrases) {
  // V2: primary identity is patient_code; phone/name are shadows
  const patient_code = row.patient_code;
  if (!patient_code) throw new Error("Row missing patient_code");

  const phone = row.phone ?? null; // shadow/debug
  const id = row.id;
  if (!id) throw new Error(`Row missing id for patient_code=${patient_code}`);

  const name = row.name ?? null;

  const linkedTalk = row.linked_talk ?? "";
  const existingLast = row.last_talk_tzvira ?? "";
  const talkSource = linkedTalk && linkedTalk.trim() ? linkedTalk : existingLast;

  if (!talkSource || !talkSource.trim()) {
    throw new Error("No talk text found in linked_talk or last_talk_tzvira");
  }

  // Claim + move: allow claiming NEW/IN_PROGRESS/ERROR by id to avoid race on patient_code
  const movePatch =
    linkedTalk && linkedTalk.trim()
      ? { processed: "processing", last_talk_tzvira: linkedTalk, linked_talk: null }
      : { processed: "processing", linked_talk: null };

  await supaPatchByIdForClaim(id, patient_code, movePatch, ELIGIBLE_PROCESSED_STATES);

  const { numberedText, count } = buildNumberedTalk(talkSource);
  console.log(`[INFO] patient_code=${patient_code} phone=${phone ?? '(none)'} numbered_lines=${count}`);

  const summaryText = await callOpenAISummary(talkSource);
  const header = summaryHeaderIsrael();
  const summarized = concatSummaries(row.summarized_linked_talk, header, summaryText);

  const x = await callOpenAIRisk(prompt10Text, numberedText);
  const { risk, reasons } = splitRiskText(x);

  const lastSummaryAt = lastSummaryAtIsraelWithPlus00();

  // Persist generated outputs while keeping the row in processing.
  // processed moves to DONE only after all child V2 writes succeed.
  await supaPatch(
    patient_code,
    {
      last_summary_at: lastSummaryAt,
      summarized_linked_talk: summarized,
      summarized_linked_talk_num: numberedText,
      summarized_linked_talk_risk: risk,
      risk_reasons: reasons,
    },
    ["processing"]
  );

  await insertUsersTzviraRow({
    id,
    time_key: lastSummaryAt,
    patient_code,
    phone,
    name,
    last_talk_tzvira: numberedText,
    summarized_linked_talk: summarized,
  });

  const reasonsTrim = String(reasons ?? "").trim();
  if (reasonsTrim) {
    const riskLines = parseNumberedLines(String(risk ?? "").trim());
    const reasonsMap = parseReasonsMap(reasonsTrim);

    const reviewRows = riskLines
      .filter((rl) => reasonsMap.has(rl.line_no))
      .map((rl) => ({
        id,
        time_key: lastSummaryAt,
        patient_code,
        phone,
        name,
        line_num: rl.line_no,
        short_risk: rl.text,
        risk_reasons: reasonsMap.get(rl.line_no) ?? "",
      }));

    if (reviewRows.length) {
      await insertRiskReviewsRows(reviewRows);
      console.log(`[INFO] patient_code=${patient_code} inserted risk_reviews_v2 rows=${reviewRows.length}`);
    } else {
      console.log(`[INFO] patient_code=${patient_code} risk_reasons present but no matched numbered lines; skipping risk_reviews_v2 insert.`);
    }
  }

  const phraseInserted = await phraseScanAndInsertRisks({
    id,
    time_key: lastSummaryAt,
    patient_code,
    phone,
    name,
    numberedText,
    activeRiskPhrases,
  });

  if (phraseInserted > 0) {
    console.log(`[INFO] patient_code=${patient_code} phrase_scan inserted risk_reviews_v2 rows=${phraseInserted}`);
  }

  await rebuildUsersTotalRiskFieldsFromRiskReviews({ id, patient_code });

  await supaPatch(
    patient_code,
    {
      processed: "DONE",
    },
    ["processing"]
  );

  console.log(
    `[DONE] patient_code=${patient_code} phone=${phone ?? '(none)'} (summary_len=${summaryText.length}, risk_len=${String(risk ?? "").length}, reasons_len=${String(
      reasons ?? ""
    ).length})`
  );
}

async function markError(patient_code, phone, err) {
  const msg = err?.message ? err.message : String(err);
  console.error(`[ERROR] patient_code=${patient_code} phone=${phone ?? '(none)'}: ${msg}`);
  try {
    await supaPatch(patient_code, { processed: "ERROR" });
  } catch (e) {
    console.error(`[ERROR] Failed to mark ERROR for patient_code=${patient_code}: ${e?.message ?? e}`);
  }
}

async function runPhraseScanOnly() {
  if (!ONLY_ID) throw new Error("PHRASE_SCAN_ONLY=1 requires ONLY_ID to be set (users_total_v2.id)");
  console.log(`PHRASE_SCAN_ONLY=1 (ONLY_ID=${ONLY_ID})`);

  const activeRiskPhrases = await supaFetchActiveRiskPhrases();
  console.log(`[INFO] Loaded active risk_phrases patterns=${activeRiskPhrases.length}`);

  const row = await supaGetRowById(ONLY_ID);
  if (!row) throw new Error(`users_total_v2 row not found for id=${ONLY_ID}`);

  const id = row.id;
  const patient_code = row.patient_code;
  const phone = row.phone;
  const name = row.name ?? null;
  const time_key = row.last_summary_at;

  if (!time_key || !String(time_key).trim()) {
    throw new Error(
      "users_total_v2.last_summary_at is empty; cannot use as time_key for risk_reviews_v2 PK in PHRASE_SCAN_ONLY mode"
    );
  }

  const numberedText = row.summarized_linked_talk_num ?? "";
  if (!String(numberedText).trim()) {
    console.log(`[INFO] patient_code=${patient_code} summarized_linked_talk_num is empty -> nothing to scan.`);
    return;
  }

  const phraseInserted = await phraseScanAndInsertRisks({
    id,
    time_key,
    patient_code,
    phone,
    name,
    numberedText,
    activeRiskPhrases,
  });

  console.log(`[DONE] PHRASE_SCAN_ONLY patient_code=${patient_code} inserted=${phraseInserted} time_key=${time_key}`);
}

async function main() {
  console.log(`[INFO] runtime_version=${RUNTIME_VERSION} dry_run=${DRY_RUN}`);

  if (PHRASE_SCAN_ONLY) {
    await runPhraseScanOnly();
    return;
  }

  const mode = ONLY_ID ? `ONLY_ID=${ONLY_ID}` : `limit=${MAX_ITEMS}`;
  console.log(
    `Scanning ${USERS_TOTAL_TABLE} for processed in (${ELIGIBLE_PROCESSED_STATES.join(", ")}) (${mode})...`
  );

  const prompt10Text = await supaFetchPrompt10();
  console.log(
    `[INFO] Loaded prompt10 from ${USERS_INFORMATION_TABLE}.${PROMPT10_COLUMN} phone=${PROMPT10_PHONE} (len=${prompt10Text.length})`
  );

  const activeRiskPhrases = await supaFetchActiveRiskPhrases();
  console.log(`[INFO] Loaded active risk_phrases patterns=${activeRiskPhrases.length}`);

  const rows = await supaGetEligibleRows(MAX_ITEMS);
  console.log(`Found ${rows.length} eligible rows.`);

  for (const row of rows) {
    const patient_code = row.patient_code ?? "(unknown)";
    const phone = row.phone ?? "(unknown)";
    try {
      await processOneRow(row, prompt10Text, activeRiskPhrases);
      await sleep(200);
    } catch (err) {
      await markError(patient_code, phone, err);
    }
  }

  console.log("Run complete.");
}

main().catch((e) => {
  console.error("Fatal error:", e?.message ?? e);
  process.exit(1);
});



