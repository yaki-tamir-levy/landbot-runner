#!/usr/bin/env node
/**
 * risk-scan.mjs
 * VERSION: 2026-05-11-PARSER-ID-LINE-PREFIX-YEAR-GTE-2026
 *
 * AGREED BEHAVIOR:
 * - NO hardcoded RISK words/regex in code.
 * - Load patterns ONLY from DB table: public.risk_phrases.
 * - Detection is substring-only on normalized text.
 * - Scan ONLY patient utterances, using the same speaker rules as the viewer.
 * - Attach each RISK row to users_tzvira by: id + time_key + phone + line_num.
 * - If a row already exists in risk_reviews for the same time_key + phone + line_num: skip.
 * - If no row exists: insert into risk_reviews with match_method = "2" and status = "NEW".
 * - Do NOT use snippet_hash or pattern_key in risk_reviews.
 * - Do NOT change DB structure.
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
 *   USERS_TIME_FIELD             default: time_key
 *   USERS_NAME_FIELD             default: name
 *   RISK_REVIEWS_TABLE           default: risk_reviews
 *   MATCH_METHOD                 default: 2
 *   DEFAULT_SEVERITY             default: medium
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
  USERS_TIME_FIELD: process.env.USERS_TIME_FIELD || "time_key",
  USERS_NAME_FIELD: process.env.USERS_NAME_FIELD || "name",
  RISK_REVIEWS_TABLE: process.env.RISK_REVIEWS_TABLE || "risk_reviews",

  MATCH_METHOD: String(process.env.MATCH_METHOD || "2"),
  DEFAULT_SEVERITY: process.env.DEFAULT_SEVERITY || "medium",

  MAX_ROWS: Number(process.env.MAX_ROWS || 5000),
  PAGE_SIZE: Number(process.env.PAGE_SIZE || 1000),
};

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!CFG.SUPABASE_URL) die("SUPABASE_URL is missing");
if (!CFG.SUPABASE_SERVICE_ROLE_KEY) die("SUPABASE_SERVICE_ROLE_KEY is missing");
if (!Number.isFinite(CFG.MAX_ROWS) || CFG.MAX_ROWS <= 0) die("MAX_ROWS must be a positive number");
if (!Number.isFinite(CFG.PAGE_SIZE) || CFG.PAGE_SIZE <= 0) die("PAGE_SIZE must be a positive number");

function md5Hex(s) {
  return crypto.createHash("md5").update(String(s ?? ""), "utf8").digest("hex");
}

function normalizeTextKeepNewlines(s) {
  if (s == null) return "";
  let t = String(s);

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

function normalizeInline(s) {
  return normalizeTextKeepNewlines(s).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSpeakerRegexes(patientName) {
  const name = patientName && String(patientName).trim() ? String(patientName).trim() : "";

  const tsPrefix = String.raw`\s*(?:\[[^\]]*\]\s*)?`;
  const lineNumPrefix = String.raw`(?:-\d+-\s*)?`;
  const leadPrefix = tsPrefix + lineNumPrefix;

  const rxPatientName = name
    ? new RegExp("^" + leadPrefix + escapeRegExp(name.toLowerCase()) + String.raw`:\s*`)
    : null;

  const rxTher = new RegExp("^" + leadPrefix + String.raw`המטפל:\s*`);
  const rxQ = new RegExp("^" + leadPrefix + String.raw`q:\s*`, "i");
  const rxA = new RegExp("^" + leadPrefix + String.raw`a:\s*`, "i");
  const rxGenericPatient = new RegExp("^" + leadPrefix + String.raw`(?:המטופל|מטופל\/ת|מטופל):\s*`);
  const rxGenericTher = new RegExp("^" + leadPrefix + String.raw`(?:המטפל):\s*`);

  const rxHebQ = new RegExp("^" + leadPrefix + String.raw`שאלה:\s*`);
  const rxHebA = new RegExp("^" + leadPrefix + String.raw`תשובה:\s*`);

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

function stripSpeakerPrefixFromLine(line, rx, speakerType) {
  if (!line) return { matched: false, speaker: null, text: "" };

  if (rx.rxPatientName && rx.rxPatientName.test(line)) {
    return { matched: true, speaker: "patient", text: line.replace(rx.rxPatientName, "").trim() };
  }

  if (rx.rxTher.test(line) || rx.rxGenericTher.test(line)) {
    return { matched: true, speaker: "therapist", text: "" };
  }

  if (rx.rxQ.test(line)) {
    return { matched: true, speaker: "patient", text: line.replace(rx.rxQ, "").trim() };
  }

  if (rx.rxA.test(line)) {
    return { matched: true, speaker: "therapist", text: "" };
  }

  if (rx.rxGenericPatient.test(line)) {
    return { matched: true, speaker: "patient", text: line.replace(rx.rxGenericPatient, "").trim() };
  }

  if (rx.rxHebQ.test(line)) {
    return { matched: true, speaker: "patient", text: line.replace(rx.rxHebQ, "").trim() };
  }

  if (rx.rxHebA.test(line)) {
    return { matched: true, speaker: "therapist", text: "" };
  }

  return { matched: false, speaker: speakerType, text: line.trim() };
}

function extractPatientLinesByViewerRules(textNormWithNL, patientName) {
  const rx = buildSpeakerRegexes(patientName);
  const lines = textNormWithNL.split("\n");

  let speaker = null;
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const sourceLineNum = i + 1;
    const line = lines[i];
    if (!line) continue;

    const parsed = stripSpeakerPrefixFromLine(line, rx, speaker);

    if (parsed.matched) {
      speaker = parsed.speaker;
      if (parsed.speaker === "patient" && parsed.text) {
        out.push({ line_num: sourceLineNum, text: parsed.text, text_norm: normalizeInline(parsed.text) });
      }
      continue;
    }

    if (speaker === "patient" && parsed.text) {
      out.push({ line_num: sourceLineNum, text: parsed.text, text_norm: normalizeInline(parsed.text) });
    }
  }

  return out;
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
  const rows = await supabaseFetch(`/rest/v1/${table}?select=pattern,is_active&is_active=eq.true`);

  const list = (rows || [])
    .map((r) => {
      const raw = String(r?.pattern ?? "").trim();
      const norm = normalizeInline(raw);
      if (!norm) return null;

      return {
        pattern_id: md5Hex(norm),
        pattern_norm: norm,
        pattern_raw: raw,
      };
    })
    .filter(Boolean);

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

async function* fetchUsersRows(maxRows) {
  const table = CFG.USERS_TABLE;
  const select = [
    "id",
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

function buildRiskReviewExistsPath({ time_key, phone, line_num }) {
  const table = CFG.RISK_REVIEWS_TABLE;
  const params = new URLSearchParams();
  params.set("select", "id");
  params.set("time_key", `eq.${time_key}`);
  params.set("phone", `eq.${phone}`);
  params.set("line_num", `eq.${line_num}`);
  params.set("limit", "1");
  return `/rest/v1/${table}?${params.toString()}`;
}

async function riskReviewExists({ time_key, phone, line_num }) {
  const rows = await supabaseFetch(buildRiskReviewExistsPath({ time_key, phone, line_num }));
  return Array.isArray(rows) && rows.length > 0;
}

async function insertRiskReview({ id, time_key, phone, name, line_num, short_risk, risk_reasons }) {
  const table = CFG.RISK_REVIEWS_TABLE;

  const row = {
    id,
    time_key,
    phone,
    name: name || null,
    line_num,
    status: "NEW",
    severity: CFG.DEFAULT_SEVERITY,
    match_method: CFG.MATCH_METHOD,
    short_risk: short_risk || null,
    risk_reasons: risk_reasons || null,
  };

  await supabaseFetch(`/rest/v1/${table}`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: [row],
  });
}

function findFirstRiskPattern(patientLine, patterns) {
  const lineNorm = patientLine?.text_norm || "";
  if (!lineNorm) return null;

  for (const p of patterns) {
    if (lineNorm.includes(p.pattern_norm)) return p;
  }

  return null;
}

function isTimeKeyYearAtLeast2026(timeKey) {
  const raw = String(timeKey ?? "").trim();
  const yearMatch = raw.match(/^(\d{4})/);

  if (yearMatch) {
    return Number(yearMatch[1]) >= 2026;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return false;

  return parsed.getUTCFullYear() >= 2026;
}

async function main() {
  console.log("RISK_SCAN_VERSION=QQQ 2026-05-11-PARSER-ID-LINE-PREFIX-YEAR-GTE-2026");

  const patterns = await loadActivePatterns();
  console.log(`Loaded ${patterns.length} active patterns from ${CFG.RISK_PHRASES_TABLE}`);

  if (patterns.length === 0) {
    console.log("No active patterns. Nothing to scan.");
    return;
  }

  let scannedRows = 0;
  let patientLinesScanned = 0;
  let matchesFound = 0;
  let insertedRows = 0;
  let skippedExistingRows = 0;

  for await (const row of fetchUsersRows(CFG.MAX_ROWS)) {
    scannedRows += 1;

    const id = String(row?.id ?? "").trim();
    const phone = String(row?.[CFG.USERS_PHONE_FIELD] ?? "").trim();
    const time_key = row?.[CFG.USERS_TIME_FIELD];

    if (!isTimeKeyYearAtLeast2026(time_key)) continue;

    const name = String(row?.[CFG.USERS_NAME_FIELD] ?? "").trim();
    const talkRaw = row?.[CFG.USERS_TEXT_FIELD];

    if (!id || !phone || !time_key || !talkRaw) continue;

    const talkNormWithNL = normalizeTextKeepNewlines(talkRaw);
    const patientLines = extractPatientLinesByViewerRules(talkNormWithNL, name);

    for (const patientLine of patientLines) {
      patientLinesScanned += 1;

      const matchedPattern = findFirstRiskPattern(patientLine, patterns);
      if (!matchedPattern) continue;

      matchesFound += 1;

      const alreadyExists = await riskReviewExists({
        time_key,
        phone,
        line_num: patientLine.line_num,
      });

      if (alreadyExists) {
        skippedExistingRows += 1;
        continue;
      }

      await insertRiskReview({
        id,
        time_key,
        phone,
        name,
        line_num: patientLine.line_num,
        short_risk: patientLine.text,
        risk_reasons: matchedPattern.pattern_raw || matchedPattern.pattern_norm,
      });

      insertedRows += 1;
    }
  }

  console.log("DONE");
  console.log(
    JSON.stringify(
      {
        scanned_rows: scannedRows,
        patient_lines_scanned: patientLinesScanned,
        matches_found: matchesFound,
        inserted_rows: insertedRows,
        skipped_existing_rows: skippedExistingRows,
        match_method_for_new_rows: CFG.MATCH_METHOD,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
