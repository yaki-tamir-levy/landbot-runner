#!/usr/bin/env node
/**
 * risk-scan.mjs
 * VERSION: 2025-12-19-FIX4 (speaker parsing aligned with viewer HTML + patient-only scan + word snippet)
 *
 * AGREED BEHAVIOR:
 * - NO hardcoded RISK words/regex in code.
 * - Load patterns ONLY from DB table: public.risk_phrases
 * - Detection is substring-only on normalized text.
 * - Scan ONLY patient utterances (exclude therapist) using SAME speaker rules as viewer (toDialogLines()).
 * - snippet_text = match + 2 words before + 2 words after.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   RISK_PHRASES_TABLE           default: risk_phrases
 *   USERS_TABLE                  default: users_tzvira
 *   USERS_TEXT_FIELD             default: last_talk_tzvira
 *   USERS_PHONE_FIELD            default: phone
 *   USERS_TIME_FIELD             default: time
 *   USERS_NAME_FIELD             default: name
 *   RISK_REVIEWS_TABLE           default: risk_reviews
 *   MAX_ROWS                     default: 5000
 *   PAGE_SIZE                    default: 1000
 */

import crypto from "node:crypto";

const CFG = {
  SUPABASE_URL: process.env.SUPABASE_URL?.replace(/\/+$/, "") || "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",

  RISK_PHRASES_TABLE: process.env.RISK_PHRASES_TABLE || "risk_phrases",
  USERS_TABLE: process.env.USERS_TABLE || "users_tzvira",
  USERS_TEXT_FIELD: process.env.USERS_TEXT_FIELD || "last_talk_tzvira",
  USERS_PHONE_FIELD: process.env.USERS_PHONE_FIELD || "phone",
  USERS_TIME_FIELD: process.env.USERS_TIME_FIELD || "time",
  USERS_NAME_FIELD: process.env.USERS_NAME_FIELD || "name",
  RISK_REVIEWS_TABLE: process.env.RISK_REVIEWS_TABLE || "risk_reviews",

  MAX_ROWS: Number(process.env.MAX_ROWS || 5000),
  PAGE_SIZE: Number(process.env.PAGE_SIZE || 1000),
};

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!CFG.SUPABASE_URL) die("SUPABASE_URL is missing");
if (!CFG.SUPABASE_SERVICE_ROLE_KEY) die("SUPABASE_SERVICE_ROLE_KEY is missing");

function md5Hex(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

/**
 * Normalize with newlines:
 * - remove Hebrew niqqud/cantillation
 * - lowercase
 * - normalize CRLF -> LF
 * - collapse spaces/tabs per line, keep newlines
 */
function normalizeTextKeepNewlines(s) {
  if (s == null) return "";
  let t = String(s);

  // Hebrew diacritics: U+0591–U+05BD, U+05BF, U+05C1–U+05C2, U+05C4–U+05C7
  t = t.replace(/[\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C7]/g, "");

  t = t.toLowerCase();

  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  t = t
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();

  return t;
}

/** Inline normalization (for patterns, etc.) */
function normalizeInline(s) {
  return normalizeTextKeepNewlines(s).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Speaker parsing: align with viewer's toDialogLines()
 *
 * Viewer rules summary:
 * - Optional WhatsApp timestamp prefix: "[...]" at start of line
 * - Patient line if starts with: "{patientName}:" OR "מטופל:"/"המטופל:"/"מטופל/ת:" (generic)
 * - Therapist line if starts with: "המטפל:"
 * - Q: is patient, A: is therapist
 * - "שאלה:" patient, "תשובה:" therapist
 * - Lines without a prefix belong to the last known speaker.
 *
 * We extract ONLY patient content (excluding therapist).
 */
function buildSpeakerRegexes(patientName) {
  const name = (patientName && String(patientName).trim()) ? String(patientName).trim() : "";
  const tsPrefix = String.raw`\s*(?:\[[^\]]*\]\s*)?`;

  const rxPatientName = name
    ? new RegExp("^" + tsPrefix + escapeRegExp(name.toLowerCase()) + String.raw`:\s*`)
    : null;

  const rxTher = new RegExp("^" + tsPrefix + String.raw`המטפל:\s*`);
  const rxQ = new RegExp("^" + tsPrefix + String.raw`q:\s*`, "i");
  const rxA = new RegExp("^" + tsPrefix + String.raw`a:\s*`, "i");
  const rxGenericPatient = new RegExp("^" + tsPrefix + String.raw`(?:המטופל|מטופל\/ת|מטופל):\s*`);
  const rxGenericTher = new RegExp("^" + tsPrefix + String.raw`(?:המטפל):\s*`);

  const rxHebQ = new RegExp("^" + String.raw`\s*שאלה:\s*`);
  const rxHebA = new RegExp("^" + String.raw`\s*תשובה:\s*`);

  return {
    rxPatientName,
    rxTher,
    rxQ,
    rxA,
    rxGenericPatient,
    rxGenericTher,
    rxHebQ,
    rxHebA,
  };
}

function extractPatientOnlyByViewerRules(textNormWithNL, patientName) {
  const rx = buildSpeakerRegexes(patientName);
  const lines = textNormWithNL.split("\n");

  let speaker = null; // "patient" | "therapist" | null
  const out = [];

  for (let line of lines) {
    if (!line) continue;

    // Patient by explicit name
    if (rx.rxPatientName && rx.rxPatientName.test(line)) {
      speaker = "patient";
      line = line.replace(rx.rxPatientName, "").trim();
      if (line) out.push(line);
      continue;
    }

    // Therapist by "המטפל:"
    if (rx.rxTher.test(line) || rx.rxGenericTher.test(line)) {
      speaker = "therapist";
      // do not collect therapist content
      continue;
    }

    // Q/A
    if (rx.rxQ.test(line)) {
      speaker = "patient";
      line = line.replace(rx.rxQ, "").trim();
      if (line) out.push(line);
      continue;
    }
    if (rx.rxA.test(line)) {
      speaker = "therapist";
      // do not collect therapist
      continue;
    }

    // Generic patient prefix
    if (rx.rxGenericPatient.test(line)) {
      speaker = "patient";
      line = line.replace(rx.rxGenericPatient, "").trim();
      if (line) out.push(line);
      continue;
    }

    // Hebrew "שאלה/תשובה"
    if (rx.rxHebQ.test(line)) {
      speaker = "patient";
      line = line.replace(rx.rxHebQ, "").trim();
      if (line) out.push(line);
      continue;
    }
    if (rx.rxHebA.test(line)) {
      speaker = "therapist";
      continue;
    }

    // No prefix: attribute to previous speaker
    if (speaker === "patient") out.push(line);
  }

  return out.join(" ").replace(/\s+/g, " ").trim();
}

async function supabaseFetch(path, { method = "GET", headers = {}, body } = {}) {
  const url = `${CFG.SUPABASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: CFG.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${CFG.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) {
    const detail = typeof json === "string" ? json : JSON.stringify(json);
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${detail}`);
  }
  return json;
}

async function loadActivePatterns() {
  const table = CFG.RISK_PHRASES_TABLE;
  const rows = await supabaseFetch(
    `/rest/v1/${table}?select=pattern,pattern_key,is_active&is_active=eq.true`
  );

  const list = (rows || [])
    .map((r) => {
      const raw = r?.pattern ?? "";
      const norm = normalizeInline(raw);
      if (!norm) return null;
      return {
        pattern_key: r?.pattern_key ?? md5Hex(norm),
        pattern_norm: norm,
      };
    })
    .filter(Boolean);

  // Deduplicate by normalized pattern
  const seen = new Set();
  const uniq = [];
  for (const p of list) {
    if (seen.has(p.pattern_norm)) continue;
    seen.add(p.pattern_norm);
    uniq.push(p);
  }

  uniq.sort((a, b) => b.pattern_norm.length - a.pattern_norm.length);
  return uniq;
}

/**
 * Build snippet by words: 2 words before + match words + 2 words after.
 * We locate the match by character indices on the normalized patient-only text.
 */
function snippetByWords(textNorm, matchStart, matchLen, wordsBefore = 2, wordsAfter = 2) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(textNorm)) !== null) {
    tokens.push({ w: m[0], s: m.index, e: m.index + m[0].length });
  }
  if (!tokens.length) return "";

  const matchEnd = matchStart + matchLen;

  let iStart = 0;
  while (iStart < tokens.length && tokens[iStart].e <= matchStart) iStart++;

  let iEnd = iStart;
  while (iEnd < tokens.length && tokens[iEnd].s < matchEnd) iEnd++;

  if (iStart >= tokens.length) iStart = tokens.length - 1;
  if (iEnd <= iStart) iEnd = iStart + 1;

  const from = Math.max(0, iStart - wordsBefore);
  const to = Math.min(tokens.length, iEnd + wordsAfter);

  return tokens.slice(from, to).map((t) => t.w).join(" ");
}

async function* fetchUsersRows(maxRows) {
  const table = CFG.USERS_TABLE;
  const select = [
    CFG.USERS_PHONE_FIELD,
    CFG.USERS_TIME_FIELD,
    CFG.USERS_NAME_FIELD,
    CFG.USERS_TEXT_FIELD,
  ].join(",");

  let fetched = 0;
  let offset = 0;

  while (fetched < maxRows) {
    const limit = Math.min(CFG.PAGE_SIZE, maxRows - fetched);
    const from = offset;
    const to = offset + limit - 1;

    const rows = await supabaseFetch(
      `/rest/v1/${table}?select=${encodeURIComponent(select)}&${encodeURIComponent(
        CFG.USERS_TEXT_FIELD
      )}=not.is.null&order=${encodeURIComponent(CFG.USERS_TIME_FIELD)}.desc`,
      { headers: { Range: `${from}-${to}` } }
    );

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      yield r;
      fetched += 1;
      if (fetched >= maxRows) break;
    }

    offset += rows.length;
    if (rows.length < limit) break;
  }
}

async function upsertRiskReview({ time_key, phone, snippet_hash, snippet_text, pattern_key }) {
  const table = CFG.RISK_REVIEWS_TABLE;
  const qs = `?on_conflict=${encodeURIComponent("time_key,phone,snippet_hash")}`;

  await supabaseFetch(`/rest/v1/${table}${qs}`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: [
      {
        time_key,
        phone,
        snippet_hash,
        snippet_text,
        pattern_key,
        status: "pending",
      },
    ],
  });
}

async function main() {
  console.log("RISK_SCAN_VERSION=2025-12-19-FIX4");

  const patterns = await loadActivePatterns();
  console.log(`Loaded ${patterns.length} active patterns from ${CFG.RISK_PHRASES_TABLE}`);

  if (patterns.length === 0) {
    console.log("No active patterns. Nothing to scan.");
    return;
  }

  let scanned = 0;
  let matches = 0;

  for await (const row of fetchUsersRows(CFG.MAX_ROWS)) {
    scanned += 1;

    const phone = String(row?.[CFG.USERS_PHONE_FIELD] ?? "").trim();
    const time_key = row?.[CFG.USERS_TIME_FIELD];
    const name = String(row?.[CFG.USERS_NAME_FIELD] ?? "").trim();
    const talkRaw = row?.[CFG.USERS_TEXT_FIELD];

    if (!phone || !time_key || !talkRaw) continue;

    const talkNormWithNL = normalizeTextKeepNewlines(talkRaw);

    // Patient-only extraction using viewer rules
    const patientText = extractPatientOnlyByViewerRules(talkNormWithNL, name);
    if (!patientText) continue;

    for (const p of patterns) {
      const idx = patientText.indexOf(p.pattern_norm);
      if (idx === -1) continue;

      matches += 1;

      const snippet_text = snippetByWords(patientText, idx, p.pattern_norm.length, 2, 2);
      const snippet_hash = md5Hex(snippet_text);

      await upsertRiskReview({
        time_key,
        phone,
        snippet_hash,
        snippet_text,
        pattern_key: p.pattern_key,
      });
    }
  }

  console.log("DONE");
  console.log(JSON.stringify({ scanned_rows: scanned, matches_found: matches }, null, 2));
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
