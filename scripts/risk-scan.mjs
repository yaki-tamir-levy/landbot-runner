#!/usr/bin/env node
/**
 * risk-scan.mjs (v2 - "PATTERN ONLY")
 *
 * שינוי לפי ההנחיה שלך:
 * - אין תלות ב"זיהוי שורות מטופל" לפי שם/תוויות
 * - אין בדיקת הקשר/שלילה/מילים לפני/אחרי לצורך החלטה אם זה RISK
 * - מחפשים רק את ה-PATTERN בטקסט המנורמל כולו
 * - עדיין שומרים snippet_text לחלון תצוגה סביב ההתאמה (לתצוגה בלבד)
 *
 * DB:
 * - עבור כל התאמה: בודקים קיום לפי (time_key, phone, snippet_hash)
 *   - אם קיים: לא עושים כלום
 *   - אם לא: INSERT status='pending' ושדות פסיכולוג ריקים
 */

import process from "node:process";
import { createClient } from "@supabase/supabase-js";

/* ==========================
   Env / Config
   ========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const USERS_TZVIRA_TABLE = process.env.USERS_TZVIRA_TABLE || "users_tzvira";
const RISK_REVIEWS_TABLE = process.env.RISK_REVIEWS_TABLE || "risk_reviews";

const PAGE_SIZE = Math.max(50, Math.min(2000, parseInt(process.env.PAGE_SIZE || "500", 10) || 500));

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing env: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ==========================
   Text normalization (same as Viewer)
   ========================== */
function stripAllHtml(raw) {
  let s = String(raw ?? "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?[^>]+>/g, "");
  return s;
}

function normalizeWs(raw) {
  return String(raw ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e\u200b]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n");
}

function cleanTalk(raw) {
  return normalizeWs(stripAllHtml(raw));
}

function rx(s) { return new RegExp(s, "iu"); }

/**
 * RISK patterns copied from your Viewer code.
 * Keep in sync with Viewer to preserve snippet_hash stability.
 */
const RISK = [
  { key: "suicide",    rx: rx("בא\\s*לי\\s*למות|רוצה\\s*למות|לא\\s*רוצה\\s*לחיות|אין\\s*לי\\s*בשביל\\s*מה\\s*לחיות|לסיים\\s*(?:את)?\\s*(?:ה(?:כול|כל|חיים))|להתאבד|התאבד(?:ו|ות)?|לפגוע\\s*בעצ(?:מי|מה|מו)|פגיעה\\s*עצמית|חתכ(?:תי|ים)|מנת\\s*יתר|הרס\\s*עצמי|ייאוש\\s*מוחלט|אין\\s*טעם|אני\\s*נואש|פאניקה\\s*קשה") },
  { key: "violence",   rx: rx("אהרוג|ארצח|לפגוע\\s*בו|אלימות\\s*קשה|מאיים\\s*עלי(?:י)?|עוקב\\s*אחר(?:י|ַי)|התעללות|אונס|הטרדה\\s*מינית") },
  { key: "psychosis",  rx: rx("פסיכוזה|שומע\\s*קולות|הלוצינציות") },
  { key: "substances", rx: rx("לקחתי\\s*יותר\\s*מדי\\s*תרופות|אלכוהול\\s*בכמויות") },
  { key: "hard_drugs", rx: rx("(סמים\\s*קשים|קוקאין|קראק|הרואין|פנטניל|מורפין|אוקסי(?:קודון)?|אופיאט(?:ים)?|מתאמפטמין|קריסטל(?:\\s*מת)?|(?:^|\\s)מת(?:\\s|$)|MDMA|אקסטז[יי]|LSD|אסיד|מסניף(?:ה)?|שואף(?:ת)?|הזרקתי|זריקה|מזרק|טריפ)") },
];

/** djb2-xor hash like in viewer */
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    const cc = str.charCodeAt(i);
    h = ((h << 5) + h) ^ cc;
  }
  return (h >>> 0).toString(16);
}

function snippetAroundAt(full, idx, len) {
  const s = String(full ?? "");
  if (idx < 0 || idx >= s.length) return s.slice(0, 60);
  const start = Math.max(0, idx - 18);
  const end = Math.min(s.length, idx + len + 18);
  return (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
}

/**
 * PATTERN ONLY scan over the entire cleaned text:
 * - Find all matches (global) for each pattern
 * - Build hits with snippet_hash + snippet_text
 */
function collectRiskHitsFromText(fullText) {
  const hits = [];
  const txt = String(fullText ?? "");
  if (!txt) return hits;

  for (const rk of RISK) {
    // Make a global version of the same regex
    const flags = rk.rx.flags.includes("g") ? rk.rx.flags : (rk.rx.flags + "g");
    const rgx = new RegExp(rk.rx.source, flags);

    for (const m of txt.matchAll(rgx)) {
      const matchText = m[0];
      const idx = (typeof m.index === "number") ? m.index : txt.indexOf(matchText);
      const snippet_text = snippetAroundAt(txt, idx, matchText.length);

      const snippet_hash = hashStr(matchText.replace(/\s+/g, " ").toLowerCase() + "|" + rk.key);

      hits.push({
        snippet_hash,
        pattern_key: rk.key,
        snippet_text,
      });
    }
  }
  return hits;
}

/* ==========================
   DB helpers
   ========================== */
async function existsRiskRow(time_key, phone, snippet_hash) {
  const { data, error } = await supa
    .from(RISK_REVIEWS_TABLE)
    .select("time_key")
    .eq("time_key", time_key)
    .eq("phone", phone)
    .eq("snippet_hash", snippet_hash)
    .limit(1);

  if (error) throw error;
  return (data && data.length > 0);
}

async function insertRiskRow(payload) {
  const { error } = await supa.from(RISK_REVIEWS_TABLE).insert(payload);
  if (error) throw error;
}

async function fetchUsersPage(offset, limit) {
  const { data, error } = await supa
    .from(USERS_TZVIRA_TABLE)
    .select("time, phone, name, last_talk_tzvira")
    .order("time", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}

function uniqByKey(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/* ==========================
   Main
   ========================== */
async function run() {
  console.log(`[risk-scan] start @ ${new Date().toISOString()}`);
  console.log(`[risk-scan] mode=PATTERN_ONLY users=${USERS_TZVIRA_TABLE} reviews=${RISK_REVIEWS_TABLE} page_size=${PAGE_SIZE}`);

  let offset = 0;
  let totalUsers = 0;
  let totalHits = 0;
  let totalInserted = 0;

  for (;;) {
    const rows = await fetchUsersPage(offset, PAGE_SIZE);
    if (!rows.length) break;

    totalUsers += rows.length;

    for (const r of rows) {
      const time_key = r.time;
      const phone = r.phone ?? "";
      const patient_name = r.name ?? null;

      if (!time_key || !phone) continue;

      const talkClean = cleanTalk(r.last_talk_tzvira ?? "");
      if (!talkClean) continue;

      const hits = collectRiskHitsFromText(talkClean);
      if (!hits.length) continue;

      // Deduplicate within same talk by (snippet_hash, pattern_key, snippet_text)
      const uniqHits = uniqByKey(hits, h => `${h.snippet_hash}|${h.pattern_key}|${h.snippet_text}`);
      totalHits += uniqHits.length;

      for (const h of uniqHits) {
        const already = await existsRiskRow(time_key, phone, h.snippet_hash);
        if (already) continue;

        const payload = {
          time_key,
          phone,
          patient_name,
          snippet_hash: h.snippet_hash,
          snippet_text: h.snippet_text,
          pattern_key: h.pattern_key,
          status: "pending",
          reviewed_at: null,
          reviewed_by: null,
          review_notes: null,
        };

        await insertRiskRow(payload);
        totalInserted += 1;

        if (totalInserted % 50 === 0) {
          console.log(`[risk-scan] inserted=${totalInserted} users=${totalUsers} hits=${totalHits}`);
        }
      }
    }

    offset += PAGE_SIZE;
    console.log(`[risk-scan] page done offset=${offset} users=${totalUsers} hits=${totalHits} inserted=${totalInserted}`);
  }

  console.log(`[risk-scan] done users=${totalUsers} hits=${totalHits} inserted=${totalInserted}`);
}

run().catch((e) => {
  console.error("[risk-scan] FAILED:", e?.message || e);
  if (e?.details) console.error("details:", e.details);
  if (e?.hint) console.error("hint:", e.hint);
  process.exit(1);
});
