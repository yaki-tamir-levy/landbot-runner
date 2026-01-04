// scripts/risk_scan_processed_new.mjs
// Node 18+ (fetch מובנה)
//
// ENV נדרש:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (או SUPABASE_KEY עם הרשאות SELECT לטבלת users_total)
//   OPENAI_API_KEY
//
// אופציונלי:
//   OPENAI_MODEL   (ברירת מחדל: gpt-5.2)
//   BATCH_SIZE     (ברירת מחדל: 50)
//   MAX_ITEMS      (ברירת מחדל: 1)  <-- SMOKE
//   ORDER_BY       (ברירת מחדל: created_at.asc)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || "50");
const MAX_ITEMS = Number(process.env.MAX_ITEMS || "1"); // SMOKE: ברירת מחדל 1
const ORDER_BY = process.env.ORDER_BY || "created_at.asc";

if (!SUPABASE_URL) throw new Error("Missing env: SUPABASE_URL");
if (!SUPABASE_KEY)
  throw new Error("Missing env: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)");
if (!OPENAI_API_KEY) throw new Error("Missing env: OPENAI_API_KEY");
if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE <= 0)
  throw new Error("BATCH_SIZE must be a positive number");
if (!Number.isFinite(MAX_ITEMS) || MAX_ITEMS < 0)
  throw new Error("MAX_ITEMS must be >= 0 (0 = no limit)");

const INSTRUCTIONS = `אתה כלי סריקה טקסטואלי לאיתור סימני RISK בשיחה.
אינך מטפל, אינך מגיב רגשית, ואינך מציע פתרונות.


קלט:
תמלול שיחה בפורמט שורות ממוספרות.
כל שורה מתחילה במספר שורה בצורה:
-N- ואז רווח ואז "שאלה:" (מטופל) או "תשובה:" (מטפל).


מטרה:
להחזיר מחרוזת אחת שמכילה:
(1) רק שורות מטופל ("שאלה:") שבהן נמצא RISK, בדיוק כפי בקלט
(2) שורת הפרדה קבועה (Split sign)
(3) הסבר קצר לכל שורת סיכון באותו מספר שורה


חובה מוחלטת – חלק 1 (שורות סיכון):
- החזר אך ורק שורות מטופל שבהן נמצא RISK.
- כל שורה חייבת להופיע במלואה ובדיוק מוחלט כפי שהופיעה בקלט:
כולל מספר השורה (-N-), רווחים, סימני פיסוק, ושגיאות כתיב אם קיימות.
- אסור לשנות, לקצר, לערוך או להזיז טקסט.
- אסור להחזיר שורות "תשובה:".


חובה מוחלטת – Split sign:
- אחרי שורות הסיכון, הדפס בדיוק את השורה הבאה לבדה:
===SPLIT_RISK_REASONS===


חובה מוחלטת – חלק 2 (סיבות סיכון):
- עבור כל שורה שהוחזרה בחלק 1, החזר שורה מקבילה של סיבה קצרה.
- פורמט מחייב לכל שורה:
-N- | <סיבה קצרה>
- מספר השורה (-N-) חייב להיות זהה בדיוק למספר השורה של שורת הסיכון.
- הסיבה:
- אורך: 2–6 מילים בלבד
- תיאורית וקטגוריאלית בלבד, ללא הסבר
- דוגמאות תקינות:
נטייה אובדנית
איום התאבדותי מפורש
אמירה על מוות
יאוש עמוק
חוסר תקווה קיצוני
בדידות קיומית
- אם קיימים כמה סוגי סיכון באותה שורה – בחר רק את המרכזי והחמור ביותר.


מקרה קצה:
אם לא נמצאה אף שורת מטופל עם RISK:
- החזר רק את Split sign בשורה אחת:
<<<SPLIT_RISK_REASONS>>>
(ולאחריו כלום)


איסורים מוחלטים:
- לא JSON
- לא Markdown
- לא כותרות נוספות
- לא הסברים
- לא שינוי סדר שורות
- לא סימוני RISK בתוך הטקסט
`;

function buildSupabaseListNewUrl({ supabaseUrl, limit, offset, orderBy }) {
  const base = supabaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  // קלט = summarized_linked_talk_num
  params.set(
    "select",
    "id,phone,processed,summarized_linked_talk_num"
  );
  params.set("processed", "eq.NEW");
  if (orderBy) params.set("order", orderBy);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `${base}/rest/v1/users_total?${params.toString()}`;
}

async function supabaseListProcessedNew({ supabaseUrl, supabaseKey, limit, offset, orderBy }) {
  const url = buildSupabaseListNewUrl({ supabaseUrl, limit, offset, orderBy });

  const res = await fetch(url, {
    method: "GET",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Supabase returned non-JSON: ${text}`);
  }

  if (!Array.isArray(data)) {
    throw new Error(`Unexpected Supabase response: ${text}`);
  }

  return data;
}

function extractAssistantTextFromResponsesApi(rawJson) {
  if (rawJson && typeof rawJson.output_text === "string" && rawJson.output_text.length) {
    return rawJson.output_text;
  }

  const out = rawJson?.output;
  if (!Array.isArray(out)) return "";

  const chunks = [];
  for (const item of out) {
    if (item?.type === "message") {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === "string") chunks.push(part.text);
          else if (typeof part?.content === "string") chunks.push(part.content);
        }
      }
    }
    if (typeof item?.text === "string") chunks.push(item.text);
  }

  return chunks.join("").trim();
}

async function runOpenAIResponses({ apiKey, model, instructions, inputText, maxOutputTokens }) {
  // הגנה: Responses API דורש input לא-ריק
  const safeInput = typeof inputText === "string" ? inputText.trim() : "";
  if (!safeInput) {
    return { output_text: "" };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input: safeInput,
      max_output_tokens: maxOutputTokens,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${text}`);
  }

  return data;
}

async function main() {
  const results = [];
  let offset = 0;
  let processedCount = 0;

  while (true) {
    const rows = await supabaseListProcessedNew({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_KEY,
      limit: BATCH_SIZE,
      offset,
      orderBy: ORDER_BY,
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      if (MAX_ITEMS > 0 && processedCount >= MAX_ITEMS) break;

      const id = row?.id ?? null;
      const phone = row?.phone ?? null;

      // ✅ זה שדה הקלט
      const rawInput =
        typeof row?.summarized_linked_talk_num === "string"
          ? row.summarized_linked_talk_num
          : "";

      const trimmed = rawInput.trim();

      // אם ריק — דלג כדי לא לקבל 400
      if (!trimmed) {
        console.log(`SKIP id=${id} phone=${phone} (empty summarized_linked_talk_num)`);
        continue;
      }

      const openaiRaw = await runOpenAIResponses({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        instructions: INSTRUCTIONS,
        inputText: trimmed,
        maxOutputTokens: 4000,
      });

      const assistantText = extractAssistantTextFromResponsesApi(openaiRaw);

      results.push({
        id,
        phone,
        response: assistantText,
      });

      processedCount += 1;
    }

    if (MAX_ITEMS > 0 && processedCount >= MAX_ITEMS) break;

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  // תוצאה בשדה: response
  process.stdout.write(
    JSON.stringify(
      {
        processed: results.length,
        response: results,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err?.message || err) + "\n");
  process.exit(1);
});
