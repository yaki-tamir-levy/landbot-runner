#!/usr/bin/env node
/**
 * risk-scan.mjs  (FIXED to match existing schema)
 *
 * FIX:
 * - Do NOT write column "pattern" into risk_reviews
 *   (your table does not have this column, as seen in the error)
 *
 * CORE RULES (unchanged):
 * - RISK patterns are loaded ONLY from risk_phrases
 * - Substring-only detection
 * - No hardcoded RISK words in code
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
  RISK_REVIEWS_TABLE: process.env.RISK_REVIEWS_TABLE || "risk_reviews",

  SNIPPET_WINDOW_CHARS: Number(process.env.SNIPPET_WINDOW_CHARS || 120),
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

function normalizeText(s) {
  if (s == null) return "";
  let t = String(s);
  t = t.replace(/[\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C7]/g, "");
  t = t.toLowerCase();
  t = t.replace(/\s+/g, " ").trim();
  return t;
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
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${detail}`);
  }
  return json;
}

async function loadActivePatterns() {
  const rows = await supabaseFetch(
    `/rest/v1/${CFG.RISK_PHRASES_TABLE}?select=pattern,pattern_key,is_active&is_active=eq.true`
  );

  return (rows || [])
    .map((r) => {
      const norm = normalizeText(r.pattern);
      return {
        pattern_key: r.pattern_key || md5Hex(norm),
        pattern_norm: norm,
      };
    })
    .filter((p) => p.pattern_norm.length > 0)
    .sort((a, b) => b.pattern_norm.length - a.pattern_norm.length);
}

function buildSnippet(textNorm, idx, len, win) {
  const half = Math.floor(win / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(textNorm.length, idx + len + half);
  return textNorm.slice(start, end);
}

async function* fetchUsersRows(maxRows) {
  const select = [
    CFG.USERS_PHONE_FIELD,
    CFG.USERS_TIME_FIELD,
    CFG.USERS_TEXT_FIELD,
  ].join(",");

  let fetched = 0;
  let offset = 0;

  while (fetched < maxRows) {
    const limit = Math.min(CFG.PAGE_SIZE, maxRows - fetched);
    const rows = await supabaseFetch(
      `/rest/v1/${CFG.USERS_TABLE}?select=${encodeURIComponent(select)}&${CFG.USERS_TEXT_FIELD}=not.is.null&order=${CFG.USERS_TIME_FIELD}.desc`,
      { headers: { Range: `${offset}-${offset + limit - 1}` } }
    );

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      yield r;
      fetched++;
      if (fetched >= maxRows) break;
    }
    offset += rows.length;
    if (rows.length < limit) break;
  }
}

async function upsertRiskReview(row) {
  const qs = `?on_conflict=${encodeURIComponent("time_key,phone,snippet_hash")}`;
  await supabaseFetch(`/rest/v1/${CFG.RISK_REVIEWS_TABLE}${qs}`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: [row],
  });
}

async function main() {
  const patterns = await loadActivePatterns();
  console.log(`Loaded ${patterns.length} active patterns from DB`);

  if (!patterns.length) return;

  for await (const row of fetchUsersRows(CFG.MAX_ROWS)) {
    const phone = row[CFG.USERS_PHONE_FIELD];
    const time_key = row[CFG.USERS_TIME_FIELD];
    const textRaw = row[CFG.USERS_TEXT_FIELD];
    if (!phone || !time_key || !textRaw) continue;

    const textNorm = normalizeText(textRaw);

    for (const p of patterns) {
      const idx = textNorm.indexOf(p.pattern_norm);
      if (idx === -1) continue;

      const snippet_text = buildSnippet(
        textNorm,
        idx,
        p.pattern_norm.length,
        CFG.SNIPPET_WINDOW_CHARS
      );

      await upsertRiskReview({
        time_key,
        phone,
        snippet_hash: md5Hex(snippet_text),
        snippet_text,
        pattern_key: p.pattern_key,
        status: "pending",
      });
    }
  }

  console.log("DONE");
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
