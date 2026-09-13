// meitar-chat-proxy — נקודת קצה עצמאית ללקוח המית"ר העצמאי (בלי לנדבוט).
// מחזיק את LANDBOT_WEBHOOK_SECRET בצד השרת בלבד, מעביר הלאה
// ל-runtime-corrected-response בלי לגעת במנגנון האימות הקיים שלה.
// אין כאן שום לוגיקה קלינית - הכל עובר במצבו ל-runtime-corrected-response.

const RUNTIME_URL = "https://qcwimczsiuxkarwfiyai.supabase.co/functions/v1/runtime-corrected-response";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const secret = Deno.env.get("LANDBOT_WEBHOOK_SECRET");
  if (!secret) {
    return new Response(JSON.stringify({ ok: false, error: "server_configuration_missing" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // רק מעביר הלאה, מוסיף את הסוד שכבר אינו חשוף לדפדפן - אין שינוי בלוגיקה.
  const upstream = await fetch(RUNTIME_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-landbot-secret": secret,
    },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
});
