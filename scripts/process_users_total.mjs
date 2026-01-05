/**
 * scripts/process_users_total.mjs
 *
 * Scans users_total where processed='NEW' (up to MAX_ITEMS) and for each row:
 * - sets processed='processing'
 * - moves linked_talk -> last_talk_tzvira and clears linked_talk
 * - calls OpenAI (Responses API) to summarize last_talk_tzvira
 * - updates last_summary_at with Israel local time but suffix +00 (as requested)
 * - appends the summary into summarized_linked_talk with a date header + blank line
 * - writes a numbered version of the talk into summarized_linked_talk_num
 * - sets processed='DONE' or 'ERROR'
 *
 * NOTE: Does NOT read/write a users_total.summary1 column (it may not exist).
 *
 * Env:
 *  SUPABASE_URL
 *  SUPABASE_SERVICE_ROLE_KEY
 *  OPENAI_API_KEY
 *  MAX_ITEMS (default 20)
 */

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY");
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS ?? "20", 10);

const USERS_TOTAL_TABLE = "users_total";

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

// Returns Israel time components for "now" using Intl (Asia/Jerusalem)
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
  const ms = dt.getMilliseconds(); // ms precision only
  const micro = String(ms).padStart(3, "0") + "000"; // 6 digits
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
    micro,
  };
}

// last_summary_at format requested: "YYYY-MM-DD HH:mm:ss.ffffff+00" with Israel clock but +00 suffix
function lastSummaryAtIsraelWithPlus00() {
  const p = israelNowParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${p.micro}+00`;
}

// Header format requested: "DD/MM/YYYY - YYYYMMDDTHHMMSSZ" (Israel clock)
function summaryHeaderIsrael() {
  const p = israelNowParts();
  const ddmmyyyy = `${p.day}/${p.month}/${p.year}`;
  const compact = `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}Z`;
  return `${ddmmyyyy} - ${compact}`;
}

// Build numbered lines only for lines containing "שאלה:"/"תשובה:" OR starting with Q:/A:
function buildNumberedTalk(talkText) {
  if (!talkText || typeof talkText !== "string") return "";
  const lines = talkText.split(/\r?\n/);
  const out = [];
  let n = 1;

  for (const line of lines) {
    const s = line ?? "";
    if (/\b(שאלה:|תשובה:)\b/.test(s) || /^\s*(Q:|A:)\b/.test(s)) {
      out.push(`-${n}- ${s}`);
      n++;
    }
  }
  return out.join("\n");
}

function concatSummaries(existing, header, summaryText) {
  const block = `${header}\n${summaryText ?? ""}\n\n`;
  if (!existing) return block;
  return String(existing) + block;
}

// Extract text from OpenAI Responses API response
function extractResponseText(respJson) {
  if (!respJson) return "";
  if (Array.isArray(respJson.output)) {
    const chunks = [];
    for (const item of respJson.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (!c) continue;
        if (c.type === "output_text" && typeof c.text === "string") chunks.push(c.text);
        if ((c.type === "text" || c.type === "output") && typeof c.text === "string") chunks.push(c.text);
      }
    }
    if (chunks.length) return chunks.join("\n").trim();
  }
  if (typeof respJson.output_text === "string") return respJson.output_text.trim();
  return "";
}

// ---------- OpenAI ----------
async function callOpenAIToSummarize(talk) {
  const body = {
    model: "gpt-4o",
    store: true,
    instructions: "נא סכם את השיחה",
    input: `שיחות קודמות:\n${talk ?? ""}`,
    max_output_tokens: 1000,
    temperature: 0.4,
  };

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

  const outText = extractResponseText(json);
  if (!outText) throw new Error("OpenAI returned empty summary text");
  return outText;
}

// ---------- Supabase ----------
async function supaGetNewRows(limit) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_TOTAL_TABLE}`);
  // IMPORTANT: no summary1 column here
  url.searchParams.set(
    "select",
    "phone,processed,linked_talk,last_talk_tzvira,last_summary_at,summarized_linked_talk,summarized_linked_talk_num"
  );
  url.searchParams.set("processed", "eq.NEW");
  url.searchParams.set("order", "phone.asc");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, { headers: supaHeaders() });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function supaPatchByPhoneAndProcessed(phone, expectedProcessed, patchObj) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${USERS_TOTAL_TABLE}`);
  url.searchParams.set("phone", `eq.${phone}`);
  if (expectedProcessed) url.searchParams.set("processed", `eq.${expectedProcessed}`);

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...supaHeaders(),
      Prefer: "return=representation",
    },
    body: JSON.stringify(patchObj),
  });

  const bodyText = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH failed (${phone}): ${res.status} ${bodyText}`);

  let json = [];
  try {
    json = JSON.parse(bodyText || "[]");
  } catch {}
  return Array.isArray(json) ? json.length : 0;
}

async function processOneRow(row) {
  const phone = row.phone;
  if (!phone) throw new Error("Row missing phone");

  // 1) claim: NEW -> processing + move linked_talk
  const linkedTalk = row.linked_talk ?? "";
  const claimed = await supaPatchByPhoneAndProcessed(phone, "NEW", {
    processed: "processing",
    last_talk_tzvira: linkedTalk,
    linked_talk: null,
  });

  if (claimed === 0) {
    console.log(`[SKIP] phone=${phone} was not NEW (already claimed).`);
    return;
  }

  // 2) create numbered talk
  const numbered = buildNumberedTalk(linkedTalk);

  // 3) OpenAI summary (kept in-memory only)
  const summaryText = await callOpenAIToSummarize(linkedTalk);

  // 4) timestamps & append
  const last_summary_at = lastSummaryAtIsraelWithPlus00();
  const header = summaryHeaderIsrael();
  const summarized_linked_talk = concatSummaries(row.summarized_linked_talk, header, summaryText);

  // 5) final update + DONE (no summary1 field)
  await supaPatchByPhoneAndProcessed(phone, "processing", {
    last_summary_at,
    summarized_linked_talk,
    summarized_linked_talk_num: numbered,
    processed: "DONE",
  });

  console.log(`[DONE] phone=${phone} (summary length=${summaryText.length})`);
}

async function markError(phone, err) {
  const msg = err?.message ? err.message : String(err);
  console.error(`[ERROR] phone=${phone}: ${msg}`);
  try {
    await supaPatchByPhoneAndProcessed(phone, null, { processed: "ERROR" });
  } catch (e) {
    console.error(`[ERROR] Failed to mark ERROR for phone=${phone}: ${e?.message ?? e}`);
  }
}

async function main() {
  console.log(`Scanning ${USERS_TOTAL_TABLE} for processed=NEW (limit=${MAX_ITEMS})...`);
  const rows = await supaGetNewRows(MAX_ITEMS);
  console.log(`Found ${rows.length} NEW rows.`);

  for (const row of rows) {
    const phone = row.phone ?? "(unknown)";
    try {
      await processOneRow(row);
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
