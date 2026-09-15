// meitar-otp-gate — מרווח בין שליחות קוד אימות לאותו טלפון: שעה אחת.
// מונע הצפת מטופל אמיתי (או תיבת הדואר הזמנית האחת)
// בהצפות חוזרות. מחזיק service_role בצד השרת.

const SUPABASE_URL = "https://qcwimczsiuxkarwfiyai.supabase.co";
const RATE_LIMIT_MINUTES = 60;
// Three codes may be sent in a row; the fourth is refused until an hour has
// passed since the third. A full hour of silence resets the count, so an
// occasional single request never accumulates toward a block.
const MAX_SENDS_PER_WINDOW = 3;

// זמני בלבד: כל הקודים הולכים לכתובת אחת, עד שייאסף אימייל
// אמיתי לכל מטופל. רק השורה הזו תצטרך שינוי אז, לא שום קוד אחר בקובץ.
const EMAIL_FOR_OTP_INTERIM = "jacob.tmr@gmail.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!anonKey || !serviceKey) return json({ error: "server_configuration_missing" }, 500);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const phone = (body as Record<string, unknown>)?.phone;
  if (typeof phone !== "string" || phone.trim().length === 0) {
    return json({ error: "phone_required" }, 400);
  }
  const cleanPhone = phone.trim();
  // Default: no row yet for this phone, or the check failed - this send is
  // the first of a fresh window.
  let sendCount = 1;

  // שלב 1 - בדיקת מרווח
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/otp_send_log?select=last_sent_at,send_count&phone=eq.${encodeURIComponent(cleanPhone)}`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (checkRes.ok) {
    const rows = await checkRes.json();
    if (Array.isArray(rows) && rows.length > 0) {
      const lastSentAt = new Date(rows[0].last_sent_at as string).getTime();
      const minutesSince = (Date.now() - lastSentAt) / 60000;
      const prior = typeof rows[0].send_count === "number" ? rows[0].send_count : 0;
      // Inside the window the count carries forward; outside it the window
      // has expired and this send starts a fresh one.
      sendCount = (minutesSince < RATE_LIMIT_MINUTES) ? prior + 1 : 1;
      if (minutesSince < RATE_LIMIT_MINUTES && prior >= MAX_SENDS_PER_WINDOW) {
        const waitMinutes = Math.ceil(RATE_LIMIT_MINUTES - minutesSince);
        return json({ allowed: false, wait_minutes: waitMinutes });
      }
    }
  } else {
    await checkRes.body?.cancel();
  }

  // שלב 2 - מותר, שולחים בפועל
  const otpRes = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL_FOR_OTP_INTERIM, create_user: true }),
  });
  if (!otpRes.ok) {
    await otpRes.body?.cancel();
    return json({ allowed: false, error: "send_failed" }, 502);
  }
  await otpRes.body?.cancel();

  // שלב 3 - רישום/עדכון זמן השליחה האחרונה
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/otp_send_log`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      phone: cleanPhone,
      last_sent_at: new Date().toISOString(),
      send_count: sendCount,
    }),
  });
  await upsertRes.body?.cancel();

  return json({ allowed: true });
});
