#!/usr/bin/env node
/**
 * risk-scan.mjs
 *
 * Goal (as agreed):
 * - NO hardcoded RISK words/regex in code.
 * - Load all RISK patterns ONLY from DB table: public.risk_phrases
 * - Detection is substring-only (indexOf) on normalized text.
 *
 * Required env:
 *   SUPABASE_URL                 e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    Service Role key (server-side only)
 *
 * Optional env:
 *   RISK_PHRASES_TABLE           default: risk_phrases
 *   USERS_TABLE                  default: users_tzvira
 *   USERS_TEXT_FIELD             default: last_talk_tzvira
 *   USERS_PHONE_FIELD            default: phone
 *   USERS_TIME_FIELD             default: time
 *   RISK_REVIEWS_TABLE           default: risk_reviews
 *   SNIPPET_WINDOW_CHARS         default: 120   (60 before + 60 after)
 *   MAX_ROWS                     default: 5000  (max users rows to scan per run)
 *   PAGE_SIZE                    default: 1000
 *
 * Notes:
 * - This script assumes your DB already has the tables/columns you use today.
 * - The ONLY behavioral change here is: patterns come from risk_phrases, not code.
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

/**
 * Normalize text:
 * - lower-case
 * - remove Hebrew niqqud/cantillation
 * - collapse whitespace
 */
function normalizeText(s) {
  if (s == null) return "";
  let t = String(s);

  // Remove Hebrew diacritics (niqqud + cantillation marks)
  // Ranges: U+0591–U+05BD, U+05BF, U+05C1–U+05C2, U+05C4–U+05C7
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
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${detail}`);
  }
  return json;
}

async function loadActivePatterns() {
  // We only need 'pattern' (substring), optional fields kept if exist
  // If your table uses different column names, map here.
  const table = CFG.RISK_PHRASES_TABLE;
  const rows = await supabaseFetch(
    `/rest/v1/${table}?select=pattern,pattern_key,severity,is_active&is_active=eq.true`
  );

  const patterns = (rows || [])
    .map((r) => {
      const raw = r?.pattern ?? "";
      const patternNorm = normalizeText(raw);
      return {
        pattern_key: r?.pattern_key ?? md5Hex(patternNorm),
        pattern_raw: String(raw),
        pattern_norm: patternNorm,
        severity: r?.severity ?? null,
      };
    })
    .filter((p) => p.pattern_norm.length > 0);

  // Deduplicate by pattern_norm (defensive)
  const seen = new Set();
  const uniq = [];
  for (const p of patterns) {
    if (seen.has(p.pattern_norm)) continue;
    seen.add(p.pattern_norm);
    uniq.push(p);
  }

  // Sort longer patterns first (helps avoid tiny patterns “winning” in UX; still substring-only)
  uniq.sort((a, b) => b.pattern_norm.length - a.pattern_norm.length);

  return uniq;
}

function buildSnippet(textNorm, matchStart, matchLen, windowChars) {
  const half = Math.max(1, Math.floor(windowChars / 2));
  const start = Math.max(0, matchStart - half);
  const end = Math.min(textNorm.length, matchStart + matchLen + half);
  return textNorm.slice(start, end);
}

/**
 * Iterate users rows with paging using Range headers.
 * PostgREST supports "Range" + "Prefer: count=exact" if needed.
 */
async function* fetchUsersRows(maxRows) {
  const table = CFG.USERS_TABLE;
  const select = [
    CFG.USERS_PHONE_FIELD,
    CFG.USERS_TIME_FIELD,
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
      {
        headers: {
          Range: `${from}-${to}`,
        },
      }
    );

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      yield r;
      fetched += 1;
      if (fetched >= maxRows) break;
    }

    offset += rows.length;
    if (rows.length < limit) break; // last page
  }
}

async function upsertRiskReview({
  time_key,
  phone,
  snippet_hash,
  snippet_text,
  pattern_key,
  pattern,
  severity,
}) {
  const table = CFG.RISK_REVIEWS_TABLE;

  // IMPORTANT:
  // We assume your DB already has a UNIQUE constraint on (time_key, phone, snippet_hash).
  // We use PostgREST upsert with on_conflict + Prefer resolution=ignore-duplicates
  // so repeated runs stay idempotent.
  const qs = `?on_conflict=${encodeURIComponent("time_key,phone,snippet_hash")}`;
  await supabaseFetch(`/rest/v1/${table}${qs}`, {
    method: "POST",
    headers: {
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: [
      {
        time_key,
        phone,
        snippet_hash,
        snippet_text,
        pattern_key,
        pattern,
        severity,
        status: "pending",
      },
    ],
  });
}

async function main() {
  const patterns = await loadActivePatterns();
  console.log(`Loaded ${patterns.length} active patterns from ${CFG.RISK_PHRASES_TABLE}`);

  if (patterns.length === 0) {
    console.log("No active patterns. Nothing to scan.");
    return;
  }

  let totalRows = 0;
  let totalMatches = 0;
  let totalInsertedOrIgnored = 0;

  for await (const row of fetchUsersRows(CFG.MAX_ROWS)) {
    totalRows += 1;

    const phone = String(row?.[CFG.USERS_PHONE_FIELD] ?? "").trim();
    const time_key = row?.[CFG.USERS_TIME_FIELD];
    const textRaw = row?.[CFG.USERS_TEXT_FIELD];

    if (!phone || !time_key || !textRaw) continue;

    const textNorm = normalizeText(textRaw);
    if (!textNorm) continue;

    // Substring-only scanning
    for (const p of patterns) {
      const idx = textNorm.indexOf(p.pattern_norm);
      if (idx === -1) continue;

      totalMatches += 1;

      const snippet_text = buildSnippet(
        textNorm,
        idx,
        p.pattern_norm.length,
        CFG.SNIPPET_WINDOW_CHARS
      );
      const snippet_hash = md5Hex(snippet_text);

      try {
        await upsertRiskReview({
          time_key,
          phone,
          snippet_hash,
          snippet_text,
          pattern_key: p.pattern_key,
          pattern: p.pattern_norm, // store normalized pattern for audit/display
          severity: p.severity || "high",
        });
        totalInsertedOrIgnored += 1;
      } catch (e) {
        // If your schema differs (column names/unique keys), you'll see it here clearly.
        console.error("Failed inserting risk_review:", {
          phone,
          time_key,
          pattern: p.pattern_norm,
          err: String(e?.message || e),
        });
        throw e;
      }

      // NOTE: we do NOT break; multiple patterns may match the same talk text.
      // If you want "first match only" behavior, add: break;
    }
  }

  console.log("DONE");
  console.log(
    JSON.stringify(
      {
        scanned_rows: totalRows,
        matches_found: totalMatches,
        inserts_attempted: totalInsertedOrIgnored,
        max_rows: CFG.MAX_ROWS,
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
