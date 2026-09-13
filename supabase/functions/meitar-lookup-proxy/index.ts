// meitar-lookup-proxy — עוטף את get_last_users_thread_v2 מאחורי גישה ישירה מהדפדפן.
// מחזיק את מפתח service_role בצד השרת בלבד. אחרי פריסה זו,
// הרשאת הרצה של anon על הפונקציה עצמה נשללה - רק הפרוקסי הזה
// יכול לקרוא לה.

const SUPABASE_URL = "https://qcwimczsiuxkarwfiyai.supabase.co";

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
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) {
    return new Response(JSON.stringify({ error: "server_configuration_missing" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const phone = (body as Record<string, unknown>)?.phone;
  if (typeof phone !== "string" || phone.trim().length === 0) {
    return new Response(JSON.stringify({ error: "phone_required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const upstream = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_last_users_thread_v2`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_phone: phone }),
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
});
