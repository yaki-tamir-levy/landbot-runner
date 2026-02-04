// scripts/postprocess_short_summarized_worker.mjs
// Dequeues 1 item from users_total_postprocess_queue, runs OpenAI on users_total.summarized_linked_talk,
// writes result to users_total.short_summarized, then marks queue item DONE.
//
// Env required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   OPENAI_API_KEY
//
// Optional:
//   OPENAI_MODEL (default: gpt-4o-mini)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  console.error("Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY");
  process.exit(1);
}

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function supaRpc(fnName, body = {}) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: supaHeaders,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`RPC ${fnName} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function supaSelectUsersTotalByPhone(phone) {
  const url =
    `${SUPABASE_URL}/rest/v1/users_total` +
    `?select=phone,summarized_linked_talk` +
    `&phone=eq.${encodeURIComponent(phone)}` +
    `&limit=1`;

  const res = await fetch(url, { headers: supaHeaders });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SELECT users_total failed (${res.status}): ${text}`);
  }
  const rows = text ? JSON.parse(text) : [];
  return rows[0] || null;
}

async function supaUpdateUsersTotalShort(phone, shortSummarized) {
  // Ask Supabase to return the updated row so we can verify the UPDATE actually matched & persisted.
  const url =
    `${SUPABASE_URL}/rest/v1/users_total` +
    `?phone=eq.${encodeURIComponent(phone)}` +
    `&select=phone,short_summarized`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...supaHeaders,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ short_summarized: shortSummarized }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`UPDATE users_total.short_summarized failed (${res.status}): ${text}`);
  }

  const rows = text ? JSON.parse(text) : [];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`UPDATE users_total matched 0 rows for phone=${phone} (returned ${rows.length})`);
  }

  const saved = rows[0]?.short_summarized ?? "";
  return String(saved);
}

async function supaMarkQueue(queueId, status, last_error = null) {
  // Try with queue_id filter (after RPC change to return queue_id)
  let url = `${SUPABASE_URL}/rest/v1/users_total_postprocess_queue?queue_id=eq.${queueId}`;
  let res = await fetch(url, {
    method: "PATCH",
    headers: { ...supaHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      last_error,
      updated_at: new Date().toISOString(),
    }),
  });

  // Fallback for schema where PK column is still named "id"
  if (!res.ok) {
    url = `${SUPABASE_URL}/rest/v1/users_total_postprocess_queue?id=eq.${queueId}`;
    res = await fetch(url, {
      method: "PATCH",
      headers: { ...supaHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        status,
        last_error,
        updated_at: new Date().toISOString(),
      }),
    });
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`UPDATE queue failed (${res.status}): ${text}`);
  }
}

function sanitizeResult(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Prompt (from your uploaded file)
const PROMPT = `אתה מקבל קובץ שיחות קודמות בין מטופל לבין מערכת תומכת.
השיחות כוללות תיאורי חוויה, רגשות, מחשבות ותגובות,
ולעיתים גם שיח עמוק או ניסוחים שנשמעים טיפוליים.

❗ אינך מטפל.
❗ אינך מסכם טיפול.
❗ אינך מסיק תובנות.
❗ אינך מזהה דפוסים, תהליכים או משמעות.
❗ אינך שומר זיכרון טיפולי.

המטרה:
להפיק "קובץ הקשר היסטורי מוחלש" –
קובץ קצר, תיאורי וניטרלי,
שמאפשר זהירות בשיח עתידי,
מבלי ליצור רצף טיפולי או סמכות מצטברת.

עקרונות מחייבים:

1. כתיבה בגוף שלישי, בשפה יומיומית ולא מקצועית.
2. לתאר רק מה עלה בשיחות – לא מה זה אומר.
3. כל ניסוח חייב להיות ניתן להחלפה ב:
   “עלה שיח סביב…”, “הוזכרו נושאים של…”.
4. אין רצף כרונולוגי, אין התפתחות, אין חזרתיות משמעותית.
5. אם ניסוח מרגיש “חכם” או “מבין” – הוא נפסל.

מה מותר לכלול:
- נושאים שעלו בשיחות (Topics בלבד).
- רגישויות לשיח בניסוח כללי ולא רגשי.
- משאבים או פעילויות יומיומיות שצוינו.
- מאפייני שיח כלליים (אורך, קצב, סגנון).

מה אסור לכלול:
- פרשנות מכל סוג.
- ייחוס כוונות, רצונות או צרכים.
- תובנות, החלטות או כיוונים.
- דפוסים, מעגלים, תהליכים.
- תגובות, שאלות או ניסוחים של הבוט.
- מונחים טיפוליים או מקצועיים.
- אזכור של שינוי, התקדמות או נסיגה.
- אזכור של מסגרות טיפוליות.

אסור להשתמש במילים:
“דפוס”, “חיפוש”, “רצון”, “צורך”, “בעיה”, “קושי”,
“תהליך”, “התקדמות”, “נסיגה”, “ויסות”, “אבחון”,
“חרדה”, “דיכאון”, “טראומה”.

מבנה הפלט (חובה):

- נושאים שעלו בשיחות (רשימה קצרה)
- רגישויות לשיח (רשימה תיאורית)
- משאבים יומיומיים שצוינו
- מאפייני שיח כלליים (משפט אחד בלבד)

אורך מקסימלי: 6–8 שורות.
ללא תאריכים. ללא ציטוטים. ללא מינוחים מקצועיים.

בדיקת סיום (חובה):
אם קובץ הפלט יכול לשמש מטפל בפגישה –
הוא אינו תקין ויש לנסחו מחדש.

זכור:
המטרה אינה זיכרון או הבנה,
אלא זהירות והימנעות מנזק.`;

async function openaiSummarize(inputText) {
  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: PROMPT },
      { role: "user", content: inputText || "" },
    ],
    max_output_tokens: 600,
    temperature: 0.3,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`OpenAI failed (${res.status}): ${JSON.stringify(data)}`);
  }

  // Robust text extraction across Responses API shapes
  let out = sanitizeResult(data?.output_text || "");
  if (!out) {
    const parts = [];
    const outputArr = data?.output;
    if (Array.isArray(outputArr)) {
      for (const item of outputArr) {
        const contentArr = item?.content;
        if (Array.isArray(contentArr)) {
          for (const c of contentArr) {
            if (typeof c?.text === "string") parts.push(c.text);
            else if (typeof c?.content === "string") parts.push(c.content);
            else if (typeof c === "string") parts.push(c);
          }
        }
      }
    }
out = sanitizeResult(parts.join("\\n"));
  }

  if (!out) {
    const dbg = {
      id: data?.id,
      model: data?.model,
      output_len: Array.isArray(data?.output) ? data.output.length : null,
      output_text_len: (data?.output_text || "").length,
    };
    throw new Error(`OpenAI returned empty text. Debug=${JSON.stringify(dbg)}`);
  }

  return out;
}

async function main() {
  const picked = await supaRpc("dequeue_users_total_postprocess");
  if (!picked || picked.length === 0) {
    console.log("No NEW tasks. Exiting.");
    return;
  }

  const task = picked[0];
  const queueId = task.queue_id ?? task.id;
  const phone = task.phone;

  console.log(`Picked task queueId=${queueId} phone=${phone}`);

  try {
    const row = await supaSelectUsersTotalByPhone(phone);
    if (!row) throw new Error(`users_total not found for phone=${phone}`);

    const src = row.summarized_linked_talk || "";
    if (!src.trim()) {
      const saved = await supaUpdateUsersTotalShort(phone, "");
      console.log(`summarized_linked_talk empty; saved len=${saved.length}`);
      await supaMarkQueue(queueId, "DONE", null);
      return;
    }

    const shortSummarized = await openaiSummarize(src);
    console.log(`OpenAI output length=${shortSummarized.length}`);

    const saved = await supaUpdateUsersTotalShort(phone, shortSummarized);
    console.log(`Saved short_summarized length=${saved.length}`);

    await supaMarkQueue(queueId, "DONE", null);
    console.log("DONE");
  } catch (err) {
    const msg = err?.stack ? String(err.stack) : String(err);
    console.error("ERROR:", msg);

    try {
      await supaMarkQueue(queueId, "ERROR", msg.slice(0, 4000));
    } catch (e) {
      console.error("Failed to mark ERROR:", e);
    }

    process.exitCode = 1;
  }
}

main();
