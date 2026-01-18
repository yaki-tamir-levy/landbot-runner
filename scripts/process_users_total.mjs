/**
 * scripts/process_users_total.mjs
 *
 * Behaviors:
 * - Process rows where users_total.processed is NEW or IN_PROGRESS
 * - Optional: if ONLY_ID is set, process ONLY that users_total.id (and only if processed in NEW/IN_PROGRESS)
 * - Claim row: NEW/IN_PROGRESS -> processing -> DONE/ERROR
 * - Split OpenAI risk output by delimiter:
 *     ===SPLIT_RISK_REASONS===
 *   Before -> users_total.summarized_linked_talk_risk
 *   After  -> users_total.risk_reasons
 * - Insert snapshot into users_tzvira (id,time_key,phone,name,last_talk_tzvira,summarized_linked_talk)
 * - Insert into risk_reviews ONLY if risk_reasons is not empty
 *   PK in risk_reviews: (id, time_key, phone, line_num)
 */

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY");

const MAX_ITEMS = parseInt(process.env.MAX_ITEMS ?? "20", 10);
// If set: process a single users_total row by ID (and only if processed in NEW/IN_PROGRESS)
const ONLY_ID = process.env.ONLY_ID ?? null;

const USERS_TOTAL_TABLE = "users_total";
const USERS_TZVIRA_TABLE = "users_tzvira";
const RISK_REVIEWS_TABLE = "risk_reviews";
const RISK_PHRASES_TABLE = "risk_phrases";

const USERS_INFORMATION_TABLE = "users_information";
const PROMPT10_PHONE = "77777777";
const PROMPT10_COLUMN = "user_text";

const RISK_SPLIT_DELIM = "===SPLIT_RISK_REASONS===";

// Treat these as "new work" (NEW + IN_PROGRESS)
const ELIGIBLE_PROCESSED_STATES = ["NEW", "IN_PROGRESS"];

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

// ---------- OpenAI ----------
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
  } catch {}

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

// ---------- Supabase ----------
async function supaGetEligibleRows(limit) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_TOTAL_TABLE}`);
  url.searchParams.set(
    "select",
    [
      "id",
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

  // Only NEW/IN_PROGRESS, optionally only a specific ID
  // PostgREST: or=(processed.eq.NEW,processed.eq.IN_PROGRESS)
  url.searchParams.set("or", "(processed.eq.NEW,processed.eq.IN_PROGRESS)");

  if (ONLY_ID) {
    url.searchParams.set("id", `eq.${ONLY_ID}`);
    url.searchParams.set("limit", "1");
  } else {
    url.searchParams.set("order", "phone.asc");
    url.searchParams.set("limit", String(limit));
  }

  const res = await fetch(url, { headers: supaHeaders() });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function supaPatch(phone, patchObj, expectedProcessedStates = null) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_TOTAL_TABLE}`);
  url.searchParams.set("phone", `eq.${phone}`);

  if (Array.isArray(expectedProcessedStates) && expectedProcessedStates.length > 0) {
    // processed IN (...)
    const parts = expectedProcessedStates.map((v) => `processed.eq.${v}`).join(",");
    url.searchParams.set("or", `(${parts})`);
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...supaHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(patchObj),
  });

  const bodyText = await res.text();
  if (!res.ok) throw new Error(bodyText || `Supabase PATCH failed (${res.status})`);
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
  // Keep ordering stable (optional)
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

  // De-dup (case-insensitive)
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

async function supaRiskReviewExists({ id, time_key, phone, line_num }) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${RISK_REVIEWS_TABLE}`);
  url.searchParams.set("select", "id");
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("time_key", `eq.${time_key}`);
  url.searchParams.set("phone", `eq.${phone}`);
  url.searchParams.set("line_num", `eq.${line_num}`);
  url.searchParams.set("limit", "1");

  const res = await fetch(url, { headers: supaHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET risk_reviews exists failed: ${res.status} ${text}`);

  let rows = [];
  try {
    rows = JSON.parse(text);
  } catch {
    rows = [];
  }
  return Array.isArray(rows) && rows.length > 0;
}

async function phraseScanAndInsertRisks({ id, time_key, phone, name, numberedText, activeRiskPhrases }) {
  if (!Array.isArray(activeRiskPhrases) || activeRiskPhrases.length === 0) return 0;

  const lines = parseNumberedLines(numberedText);
  if (!Array.isArray(lines) || lines.length === 0) return 0;

  let inserted = 0;

  for (const ln of lines) {
    const lineNum = ln.line_no;
    const lineText = ln.text ?? "";

    // Find first matching pattern for this line
    let matchedPattern = null;
    for (const pattern of activeRiskPhrases) {
      if (textContainsPattern(lineText, pattern)) {
        matchedPattern = pattern;
        break;
      }
    }

    if (!matchedPattern) continue;

    // Skip if ANY existing risk_reviews row exists for this PK (regardless of who inserted it)
    const exists = await supaRiskReviewExists({
      id,
      time_key,
      phone,
      line_num: lineNum,
    });

    if (exists) continue;

    await insertRiskReviewsRows([
      {
        id,
        time_key,
        phone,
        name,
        line_num: lineNum,
        short_risk: null,
        risk_reasons: matchedPattern,
        match_method: "2",
      },
    ]);

    inserted += 1;
  }

  return inserted;
}

async function supaInsert(table, payload) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...supaHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase INSERT into ${table} failed: ${res.status} ${text}`);
}

async function insertUsersTzviraRow({ id, time_key, phone, name, last_talk_tzvira, summarized_linked_talk }) {
  await supaInsert(USERS_TZVIRA_TABLE, {
    id,
    time_key,
    phone,
    name,
    last_talk_tzvira,
    summarized_linked_talk,
  });
}

async function insertRiskReviewsRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  await supaInsert(RISK_REVIEWS_TABLE, rows);
}

async function processOneRow(row, prompt10Text, activeRiskPhrases) {
  const phone = row.phone;
  if (!phone) throw new Error("Row missing phone");

  const id = row.id;
  if (!id) throw new Error(`Row missing id for phone=${phone}`);

  const name = row.name ?? null;

  const linkedTalk = row.linked_talk ?? "";
  const existingLast = row.last_talk_tzvira ?? "";
  const talkSource = linkedTalk && linkedTalk.trim() ? linkedTalk : existingLast;

  if (!talkSource || !talkSource.trim()) {
    throw new Error("No talk text found in linked_talk or last_talk_tzvira");
  }

  // Claim + move: allow claiming NEW/IN_PROGRESS
  const movePatch =
    linkedTalk && linkedTalk.trim()
      ? { processed: "processing", last_talk_tzvira: linkedTalk, linked_talk: null }
      : { processed: "processing", linked_talk: null };

  await supaPatch(phone, movePatch, ELIGIBLE_PROCESSED_STATES);

  const { numberedText, count } = buildNumberedTalk(talkSource);
  console.log(`[INFO] phone=${phone} numbered_lines=${count}`);

  const summaryText = await callOpenAISummary(talkSource);
  const header = summaryHeaderIsrael();
  const summarized = concatSummaries(row.summarized_linked_talk, header, summaryText);

  const x = await callOpenAIRisk(prompt10Text, numberedText);
  const { risk, reasons } = splitRiskText(x);

  const lastSummaryAt = lastSummaryAtIsraelWithPlus00();

  await supaPatch(
    phone,
    {
      last_summary_at: lastSummaryAt,
      summarized_linked_talk: summarized,
      summarized_linked_talk_num: numberedText,
      summarized_linked_talk_risk: risk,
      risk_reasons: reasons,
      processed: "DONE",
    },
    ["processing"]
  );

  await insertUsersTzviraRow({
    id,
    time_key: lastSummaryAt,
    phone,
    name,
    last_talk_tzvira: numberedText,
    summarized_linked_talk: summarized,
  });

  // Insert risks ONLY if risk_reasons is not empty
  const reasonsTrim = String(reasons ?? "").trim();
  if (reasonsTrim) {
    const riskLines = parseNumberedLines(String(risk ?? "").trim());
    const reasonsMap = parseReasonsMap(reasonsTrim);

    const reviewRows = riskLines
      .filter((rl) => reasonsMap.has(rl.line_no))
      .map((rl) => ({
        id,
        time_key: lastSummaryAt,
        phone,
        name,
        line_num: rl.line_no,
        short_risk: rl.text,
        risk_reasons: reasonsMap.get(rl.line_no) ?? "",
      }));

    if (reviewRows.length) {
      await insertRiskReviewsRows(reviewRows);
      console.log(`[INFO] phone=${phone} inserted risk_reviews rows=${reviewRows.length}`);
    } else {
      console.log(
        `[INFO] phone=${phone} risk_reasons present but no matched numbered lines; skipping risk_reviews insert.`
      );
    }
  }

  // Phrase Scan (risk_phrases) - INSERT ONLY if no existing risk_reviews row for the same PK
  const phraseInserted = await phraseScanAndInsertRisks({
    id,
    time_key: lastSummaryAt,
    phone,
    name,
    numberedText,
    activeRiskPhrases,
  });

  if (phraseInserted > 0) {
    console.log(`[INFO] phone=${phone} phrase_scan inserted risk_reviews rows=${phraseInserted}`);
  }

  console.log(
    `[DONE] phone=${phone} (summary_len=${summaryText.length}, risk_len=${String(risk ?? "").length}, reasons_len=${String(
      reasons ?? ""
    ).length})`
  );
}

async function markError(phone, err) {
  const msg = err?.message ? err.message : String(err);
  console.error(`[ERROR] phone=${phone}: ${msg}`);
  try {
    await supaPatch(phone, { processed: "ERROR" });
  } catch (e) {
    console.error(`[ERROR] Failed to mark ERROR for phone=${phone}: ${e?.message ?? e}`);
  }
}

async function main() {
  const mode = ONLY_ID ? `ONLY_ID=${ONLY_ID}` : `limit=${MAX_ITEMS}`;
  console.log(`Scanning ${USERS_TOTAL_TABLE} for processed in (NEW, IN_PROGRESS) (${mode})...`);

  const prompt10Text = await supaFetchPrompt10();
  console.log(
    `[INFO] Loaded prompt10 from ${USERS_INFORMATION_TABLE}.${PROMPT10_COLUMN} phone=${PROMPT10_PHONE} (len=${prompt10Text.length})`
  );

  const activeRiskPhrases = await supaFetchActiveRiskPhrases();
  console.log(`[INFO] Loaded active risk_phrases patterns=${activeRiskPhrases.length}`);

  const rows = await supaGetEligibleRows(MAX_ITEMS);
  console.log(`Found ${rows.length} eligible rows.`);

  for (const row of rows) {
    const phone = row.phone ?? "(unknown)";
    try {
      await processOneRow(row, prompt10Text, activeRiskPhrases);
      await sleep(200);
    } catch (err) {
      await markError(phone, err);
    }
  }

  console.log("Run complete.");
}

main().catch((e) => {
  console.error("Fatal error:", e?.message ?? e);
  process.exit(1);
});
