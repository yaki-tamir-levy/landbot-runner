// scripts/users_inform_checker.mjs
// קורא CSV מגוגל-שיט, מחפש update=V/v, מדפיס שמות ואם נמצא לפחות אחד — מזניק repository_dispatch

const CSV_URL = process.env.CSV_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // יסופק אוטומטית ב-GitHub Actions
const REPO = process.env.GITHUB_REPOSITORY;    // owner/repo (יסופק אוטומטית)
const EVENT_TYPE = "users_inform_trigger";     // נשתמש בזה ב-workflow הידני
const TRIGGER_INFO = {
  file: "users_inform_landbot_trigger.mjs",    // אינפורמטיבי בלבד ללוג
  note: "dispatch from users_inform_checker",
};

if (!CSV_URL) {
  console.error("❌ Missing CSV_URL env var");
  process.exit(1);
}

// פונקציית פרסינג CSV פשוטה (מספיקה ל-columns update,name ללא גרשיים מורכבים)
function parseCsvSimple(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const splitLine = (line) => {
    // מפריד לפי פסיק, מתמודד ברמה בסיסית עם מרכאות
    const out = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // toggle quotes, תמיכה בסיסית בגרשיים כפולים
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  };

  const headers = splitLine(lines[0]).map(h => h.toLowerCase());
  const rows = lines.slice(1).map(splitLine);
  return { headers, rows };
}

async function main() {
  console.log("➡️  Fetching CSV:", CSV_URL);
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    console.error(`❌ Failed to fetch CSV. HTTP ${res.status}`);
    process.exit(1);
  }
  const text = await res.text();

  const { headers, rows } = parseCsvSimple(text);
  const idxUpdate = headers.indexOf("update");
  const idxName = headers.indexOf("name");

  if (idxUpdate === -1 || idxName === -1) {
    console.error("❌ CSV must contain headers: update, name");
    console.error("   Found headers:", headers);
    process.exit(1);
  }

  const hits = [];
  for (const r of rows) {
    const val = (r[idxUpdate] || "").trim();
    const nm = (r[idxName] || "").trim();
    if (!nm) continue;
    if (val.toLowerCase() === "v") {
      hits.push(nm);
    }
  }

  if (hits.length === 0) {
    console.log("✅ No rows with update=V/v. Nothing to trigger.");
    return;
  }

  console.log("✅ Found rows with V/v in update. Names:");
  hits.forEach(n => console.log(" -", n));

  // מזניק repository_dispatch → יפעיל את ה-workflow הידני (שהוגדר גם ל-repository_dispatch)
  if (!GITHUB_TOKEN || !REPO) {
    console.error("❌ Missing GITHUB_TOKEN or GITHUB_REPOSITORY in env.");
    process.exit(1);
  }

  const url = `https://api.github.com/repos/${REPO}/dispatches`;
  const body = {
    event_type: EVENT_TYPE,
    client_payload: {
      source: "users_inform_checker",
      names: hits,
      trigger: TRIGGER_INFO,
    },
  };

  console.log("➡️  Dispatching repository_dispatch:", EVENT_TYPE);
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error(`❌ repository_dispatch failed. HTTP ${r.status}`);
    console.error(t);
    process.exit(1);
  }

  console.log("🚀 repository_dispatch sent. The manual trigger workflow should start shortly.");
}

main().catch(err => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
