// intake — נקודת הקצה היחידה של מסלול קבלת המועמדים.
//
// הדף הציבורי מדבר רק איתה. הוא אינו מחזיק מפתחות ואינו נוגע במסד.
// כל הכתיבה נעשית דרך פונקציות המסד, ולכן ההצפנה חיה במקום אחד בלבד.
//
// פריסה:
//   supabase functions deploy intake --project-ref qcwimczsiuxkarwfiyai --no-verify-jwt

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_KEY    = Deno.env.get("OPENAI_API_KEY")!;
const INTAKE_MODEL  = Deno.env.get("INTAKE_MODEL") ?? "gpt-5.4";

const DONE_MARK = "[[COLLECTION_COMPLETE]]";

// מגבלות מול דף פתוח לכל
const MAX_CHARS = 1200;
const MAX_TURNS = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// הפרומפט נשלף דרך הפונקציה הרגילה, ולא בשאילתה ישירה.
// הקורקטור הוא החריג היחיד המוסכם, ואין להוסיף עליו שני.
async function getPrompt(key: string): Promise<string> {
  const text = await rpc("get_prompt_v2", { p_prompt_key: key });
  if (!text) throw new Error(`prompt '${key}' is empty or missing`);
  return text as string;
}

async function askModel(system: string, messages: { role: string; content: string }[]) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: INTAKE_MODEL,
      temperature: 0.6,
      max_tokens: 600,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`openai failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content ?? "").trim();
}

// בונה את הוראות המערכת: הפרומפט מהטבלה, ועליו ההקשר של השיחה הנוכחית
function buildSystem(prompt: string, name: string, missing: string[]) {
  let ctx = `\n\n## הקשר\nשם המועמד כפי שנרשם: ${name}\n`;

  if (missing.length > 0) {
    ctx +=
      `זו כניסה חוזרת. הוא כבר סיפר על עצמו בעבר, ורק הפרטים הבאים חסרים: ` +
      `${missing.join(", ")}.\n` +
      `אל תבקש ממנו לספר על עצמו מחדש. פתח במשפט שמסביר שנשארו כמה דברים להשלים, ` +
      `ושאל רק עליהם.\n`;
  }

  ctx +=
    `כשסיימת לאסוף, סיים את תשובתך האחרונה בשורה נפרדת שמכילה בדיוק: ${DONE_MARK}\n` +
    `אל תזכיר את הסימון בשום מקום אחר.\n`;

  return prompt + ctx;
}

function splitMark(raw: string) {
  const complete = raw.includes(DONE_MARK);
  return { text: raw.replace(DONE_MARK, "").trim(), complete };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "bad_json" }, 400);
  }

  const action = String(body?.action ?? "");

  try {
    // ---------- בדיקת תפיסת המספר ----------
    if (action === "check") {
      const state = await rpc("intake_check_phone", { p_phone: String(body.phone ?? "") });
      return reply({ state });
    }

    // ---------- פתיחת שיחה או חידושה ----------
    if (action === "start") {
      const name = String(body.name ?? "").trim().slice(0, 80);

      const started = await rpc("intake_start", {
        p_phone: String(body.phone ?? ""),
        p_name: name,
        p_email: String(body.email ?? "").trim().slice(0, 120),
      });

      if (started.state === "taken" || started.state === "pending") {
        return reply({ state: started.state });
      }

      const missing: string[] = Array.isArray(started.missing) ? started.missing : [];
      const prompt = await getPrompt("intake");

      const raw = await askModel(buildSystem(prompt, name, missing), [
        { role: "user", content: "(המועמד נכנס כעת. פתח את השיחה.)" },
      ]);
      const { text, complete } = splitMark(raw);

      await rpc("intake_add_turn", {
        p_conversation_id: started.conversation_id,
        p_question: null,
        p_answer: text,
      });

      return reply({
        state: started.state,
        conversation_id: started.conversation_id,
        text,
        collection_complete: complete,
      });
    }

    // ---------- תור בשיחה ----------
    if (action === "talk") {
      const conv = String(body.conversation_id ?? "");
      const msg = String(body.message ?? "").trim();

      if (!conv) return reply({ error: "missing_conversation" }, 400);
      if (!msg) return reply({ error: "empty_message" }, 400);
      if (msg.length > MAX_CHARS) return reply({ error: "message_too_long" }, 400);

      const history = await rpc("intake_history", { p_conversation_id: conv });
      if (!Array.isArray(history) || history.length === 0) {
        return reply({ error: "unknown_conversation" }, 400);
      }
      if (history.length > MAX_TURNS) return reply({ error: "conversation_too_long" }, 400);

      const name = String(body.name ?? "").trim().slice(0, 80);
      const prompt = await getPrompt("intake");

      // ההיסטוריה נבנית מהמסד בלבד. מה שהדפדפן שולח אינו נאמן.
      const messages: { role: string; content: string }[] = [];
      for (const turn of history) {
        if (turn.q) messages.push({ role: "user", content: String(turn.q) });
        if (turn.a) messages.push({ role: "assistant", content: String(turn.a) });
      }
      messages.push({ role: "user", content: msg });

      const raw = await askModel(buildSystem(prompt, name, []), messages);
      const { text, complete } = splitMark(raw);

      await rpc("intake_add_turn", {
        p_conversation_id: conv,
        p_question: msg,
        p_answer: text,
      });

      return reply({ text, collection_complete: complete });
    }

    return reply({ error: "unknown_action" }, 400);
  } catch (err) {
    console.error("intake error", String(err));
    return reply({ error: "internal" }, 500);
  }
});
