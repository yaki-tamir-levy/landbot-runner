// scripts/postprocess_short_summarized_worker.mjs
// Pulls 1 item from users_total_postprocess_queue, runs OpenAI on users_total.summarized_linked_talk,
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

const headers = {
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function supaRpc(fnName, body = {}) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`RPC ${fnName} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function supaSelectUsersTotalByPhone(phone) {
  const url = `${SUPABASE_URL}/rest/v1/users_total?select=phone,summarized_linked_talk&phone=eq.${encodeURIComponent(phone)}&limit=1`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SELECT users_total failed (${res.status}): ${text}`);
  }
  const rows = text ? JSON.parse(text) : [];
  return rows[0] || null;
}

async function supaUpdateUsersTotalShort(phone, shortSummarized) {
  const url = `${SUPABASE_URL}/rest/v1/users_total?phone=eq.${encodeURIComponent(phone)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...headers,
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({ short_summarized: shortSummarized }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`UPDATE users_total.short_summarized failed (${res.status}): ${text}`);
  }
}

async function supaMarkQueue(id, status, last_error = null) {
  const url = `${SUPABASE_URL}/rest/v1/users_total_postprocess_queue?id=eq.${id}`;
  const payload = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (last_error !== null) payload.last_error = last_error;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...headers,
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`UPDATE queue failed (${res.status}): ${text}`);
  }
}

function sanitizeResult(text) {
  // keep it clean: trim, collapse excessive blank lines
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function openaiSummarize(inputText) {
  const prompt = "אתה מקבל קובץ שיחות קודמות בין מטופל לבין מערכת תומכת.\nהשיחות כוללות תיאורי חוויה, רגשות, מחשבות ותגובות,\nולעיתים גם שיח עמוק או ניסוחים שנשמעים טיפוליים.\n\n❗ אינך מטפל.\n❗ אינך מסכם טיפול.\n❗ אינך מסיק תובנות.\n❗ אינך מזהה דפוסים, תהליכים או משמעות.\n❗ אינך שומר זיכרון טיפולי.\n\nהמטרה:\nלהפיק \"קובץ הקשר היסטורי מוחלש\" –\nקובץ קצר, תיאורי וניטרלי,\nשמאפשר זהירות בשיח עתידי,\nמבלי ליצור רצף טיפולי או סמכות מצטברת.\n\nעקרונות מחייבים:\n\n1. כתיבה בגוף שלישי, בשפה יומיומית ולא מקצועית.\n2. לתאר רק מה עלה בשיחות – לא מה זה אומר.\n3. כל ניסוח חייב להיות ניתן להחלפה ב:\n   “עלה שיח סביב…”, “הוזכרו נושאים של…”.\n4. אין רצף כרונולוגי, אין התפתחות, אין חזרתיות משמעותית.\n5. אם ניסוח מרגיש “חכם” או “מבין” – הוא נפסל.\n\nמה מותר לכלול:\n- נושאים שעלו בשיחות (Topics בלבד).\n- רגישויות לשיח בניסוח כללי ולא רגשי.\n- משאבים או פעילויות יומיומיות שצוינו.\n- מאפייני שיח כלליים (אורך, קצב, סגנון).\n\nמה אסור לכלול:\n- פרשנות מכל סוג.\n- ייחוס כוונות, רצונות או צרכים.\n- תובנות, החלטות או כיוונים.\n- דפוסים, מעגלים, תהליכים.\n- תגובות, שאלות או ניסוחים של הבוט.\n- מונחים טיפוליים או מקצועיים.\n- אזכור של שינוי, התקדמות או נסיגה.\n- אזכור של מסגרות טיפוליות.\n\nאסור להשתמש במילים:\n“דפוס”, “חיפוש”, “רצון”, “צורך”, “בעיה”, “קושי”,\n“תהליך”, “התקדמות”, “נסיגה”, “ויסות”, “אבחון”,\n“חרדה”, “דיכאון”, “טראומה”.\n\nמבנה הפלט (חובה):\n\n- נושאים שעלו בשיחות (רשימה קצרה)\n- רגישויות לשיח (רשימה תיאורית)\n- משאבים יומיומיים שצוינו\n- מאפייני שיח כלליים (משפט אחד בלבד)\n\nאורך מקסימלי: 6–8 שורות.\nללא תאריכים. ללא ציטוטים. ללא מינוחים מקצועיים.\n\nבדיקת סיום (חובה):\nאם קובץ הפלט יכול לשמש מטפל בפגישה –\nהוא אינו תקין ויש לנסחו מחדש.\n\nזכור:\nהמטרה אינה זיכרון או הבנה,\nאלא זהירות והימנעות מנזק.\n";
  const body = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: inputText || "",
      },
    ],
    max_output_tokens: 500,
    temperature: 0.3,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`OpenAI failed (${res.status}): ${JSON.stringify(data)}`);
  }

  // responses API: easiest is output_text
  const out = data.output_text || "";
  return sanitizeResult(out);
}

async function main() {
  // 1) Dequeue one task (atomic)
  const picked = await supaRpc("dequeue_users_total_postprocess");
  if (!picked || picked.length === 0) {
    console.log("No NEW tasks. Exiting.");
    return;
  }

  const task = picked[0];
  const queueId = task.id;
  const phone = task.phone;

  console.log(`Picked task id=${queueId} phone=${phone}`);

  try {
    // 2) Read users_total by phone
    const row = await supaSelectUsersTotalByPhone(phone);
    if (!row) {
      throw new Error(`users_total not found for phone=${phone}`);
    }

    const src = row.summarized_linked_talk || "";
    if (!src.trim()) {
      // If empty, still mark done (or you can set empty output)
      await supaUpdateUsersTotalShort(phone, "");
      await supaMarkQueue(queueId, "DONE", null);
      console.log("summarized_linked_talk empty; wrote empty short_summarized; DONE");
      return;
    }

    // 3) OpenAI
    const shortSummarized = await openaiSummarize(src);

    // 4) Write back
    await supaUpdateUsersTotalShort(phone, shortSummarized);

    // 5) Mark done
    await supaMarkQueue(queueId, "DONE", null);

    console.log("DONE");
  } catch (err) {
    const msg = (err && err.stack) ? err.stack : String(err);
    console.error("ERROR:", msg);

    // best effort: mark ERROR with last_error
    try {
      await supaMarkQueue(queueId, "ERROR", msg.slice(0, 4000));
    } catch (e) {
      console.error("Failed to mark ERROR:", e);
    }

    process.exitCode = 1;
  }
}

main();
