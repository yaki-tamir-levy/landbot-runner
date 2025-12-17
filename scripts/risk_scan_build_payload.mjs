// scripts/risk_scan_build_payload.mjs
// Build payload for POST /rest/v1/risk_reviews from users_tzvira talks + risk_phrases.
// No external deps (Node 20).

import fs from "node:fs";
import crypto from "node:crypto";

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const talksPath = arg("--talks");
const phrasesPath = arg("--phrases");
const outPath = arg("--out", "payload.json");
const outMaxTimePath = arg("--out-max-time", "max_time.txt");
const contextLen = parseInt(arg("--context", "80"), 10);

if (!talksPath || !phrasesPath) {
  console.error("Usage: node scripts/risk_scan_build_payload.mjs --talks talks.json --phrases phrases.json --out payload.json --out-max-time max_time.txt --context 80");
  process.exit(2);
}

function safeJson(path) {
  try {
    const txt = fs.readFileSync(path, "utf8");
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function toStr(x) {
  return (x === null || x === undefined) ? "" : String(x);
}

function buildSnippet(text, idx, matchLen, ctx) {
  const start = Math.max(0, idx - ctx);
  const end = Math.min(text.length, idx + matchLen + ctx);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end) + suffix;
}

const talks = safeJson(talksPath);
const phrasesRaw = safeJson(phrasesPath);

// Normalize phrases: keep enabled if field exists; otherwise treat as enabled.
const phrases = phrasesRaw
  .map(p => ({
    id: p?.id,
    phrase: toStr(p?.phrase).trim(),
    severity: p?.severity ?? null,
    enabled: (p && Object.prototype.hasOwnProperty.call(p, "enabled")) ? !!p.enabled : true,
  }))
  .filter(p => p.enabled && p.phrase.length > 0 && p.id !== null && p.id !== undefined);

const hits = [];
let maxTime = "1970-01-01T00:00:00Z";

for (const row of talks) {
  const timeKey = toStr(row?.time).trim();
  const phone = toStr(row?.phone).trim();
  const talk = toStr(row?.last_talk_tzvira);

  if (!timeKey || !phone || !talk) continue;

  // track max time
  if (timeKey > maxTime) maxTime = timeKey;

  const hay = talk; // keep original; matching is case-insensitive
  const hayLower = talk.toLowerCase();

  for (const ph of phrases) {
    const needle = ph.phrase;
    const needleLower = needle.toLowerCase();
    let from = 0;

    while (true) {
      const idx = hayLower.indexOf(needleLower, from);
      if (idx < 0) break;

      const snippetText = buildSnippet(hay, idx, needle.length, contextLen);
      const snippetHash = sha256(`${timeKey}|${phone}|${ph.id}|${snippetText}`);

      hits.push({
        time_key: timeKey,
        phone,
        phrase_id: ph.id,
        severity: ph.severity,
        status: "NEW",
        snippet_text: snippetText,
        snippet_hash: snippetHash,
        // reviewer/reviewed_at נשארים null; ה-Viewer/מטפל יעדכן.
      });

      from = idx + Math.max(1, needle.length);
    }
  }
}

fs.writeFileSync(outPath, JSON.stringify(hits, null, 2), "utf8");
fs.writeFileSync(outMaxTimePath, maxTime, "utf8");

console.log(`talks=${talks.length} phrases=${phrases.length} hits=${hits.length} maxTime=${maxTime}`);
