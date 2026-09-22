// meitar-api — single server entry point for meitar_v2.html (22.9.2026).
// Replaces meitar-lookup-proxy, meitar-chat-proxy and the page's direct anon
// RPC calls. meitar-otp-gate still sends the code and is not changed.
//
// Identity is never taken from the browser. After the code is verified here,
// the server issues a signed device token (HMAC-SHA256, 7 days). Every later
// action verifies the token and uses the patient it names; a phone or a
// patient id in the request body is ignored.
//
// Before the code: only "not found / inactive / wrong gate / ok" is revealed
// (decision 22.9). Name, background and conversation are never sent before
// verification, and background and conversation are never sent at all.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ENGINE_SECRET = Deno.env.get("LANDBOT_WEBHOOK_SECRET") ?? "";
const RUNTIME_URL = `${SUPABASE_URL}/functions/v1/runtime-corrected-response`;

const TOKEN_DAYS = 7;
const MAX_VERIFY_FAILS = 5;
const VERIFY_WINDOW_MINUTES = 60;
const FETCH_TIMEOUT_MS = 15000;
const ENGINE_TIMEOUT_MS = 90000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function timedFetch(url: string, init: RequestInit, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function rpc(fn: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await timedFetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc_${fn}_${res.status}`);
  return text.trim() ? JSON.parse(text) : null;
}

async function restGet(path: string): Promise<unknown[]> {
  const res = await timedFetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`rest_get_${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// ---------- signed device token ----------
const enc = new TextEncoder();
let hmacKey: CryptoKey | null = null;
async function getKey(): Promise<CryptoKey> {
  if (hmacKey) return hmacKey;
  // Derived from the service key, so no new secret is needed. Rotating the
  // service key signs everyone out, which is the right behaviour.
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("meitar-session-v1:" + SERVICE_KEY));
  hmacKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return hmacKey;
}
function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
}
async function issueToken(patientCode: string, phone: string): Promise<string> {
  const payload = b64u(enc.encode(JSON.stringify({
    pc: patientCode, ph: phone, exp: Date.now() + TOKEN_DAYS * 86400000,
  })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await getKey(), enc.encode(payload)));
  return `${payload}.${b64u(sig)}`;
}
async function readToken(token: unknown): Promise<{ pc: string; ph: string } | null> {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await getKey(), unb64u(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    if (typeof data.pc !== "string" || typeof data.ph !== "string") return null;
    return { pc: data.pc, ph: data.ph };
  } catch {
    return null;
  }
}

// ---------- patient data ----------
type Row = { name?: string; active?: string; status?: string; disclaimed?: string; gender?: string };
async function lookup(phone: string): Promise<Row | null> {
  const rows = await rpc("get_last_users_thread_v2", { p_phone: phone }) as Row[] | null;
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}
function gate(row: Row | null, mode: string): string {
  if (!row) return "not_found";
  if (!(row.active === "TRUE" || row.active === "yes")) return "inactive";
  // 1 = therapy only, 2 = course only, 3 = both, 4 = test.
  const allowed = mode === "course" ? ["2", "3", "4"] : ["1", "3", "4"];
  if (!allowed.includes(String(row.status))) return "wrong_gate";
  return "ok";
}
function profile(row: Row) {
  return {
    name: row.name || "",
    gender: row.gender === "M" || row.gender === "F" ? row.gender : "",
    disclaimed: row.disclaimed === "AGREED",
    status: String(row.status ?? ""),
  };
}
async function ownsConversation(patientCode: string, conversationId: unknown): Promise<boolean> {
  if (typeof conversationId !== "string" || !/^[0-9a-f-]{36}$/i.test(conversationId)) return false;
  const rows = await restGet(
    `conversations_session_v2?select=conversation_id&conversation_id=eq.${conversationId}&patient_code=eq.${patientCode}`,
  );
  return rows.length === 1;
}

// ---------- wrong-code limit (item 48) ----------
async function phoneHash(phone: string): Promise<string> {
  const digits = phone.replace(/[^0-9]/g, "");
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(digits)));
  return Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function verifyBlocked(ph: string): Promise<boolean> {
  const rows = await restGet(`meitar_verify_attempts?select=fails,first_fail_at&phone_hash=eq.${ph}`) as
    { fails: number; first_fail_at: string }[];
  if (!rows.length) return false;
  const ageMin = (Date.now() - new Date(rows[0].first_fail_at).getTime()) / 60000;
  return ageMin < VERIFY_WINDOW_MINUTES && rows[0].fails >= MAX_VERIFY_FAILS;
}
async function recordVerify(ph: string, success: boolean): Promise<void> {
  await rpc("meitar_record_verify_v2", { p_phone_hash: ph, p_success: success, p_window_minutes: VERIFY_WINDOW_MINUTES });
}

// ---------- actions ----------
async function handle(body: Record<string, unknown>): Promise<Response> {
  const action = String(body.action ?? "");

  if (action === "check") {
    const phone = String(body.phone ?? "").trim();
    if (!phone) return json({ error: "phone_required" }, 400);
    return json({ result: gate(await lookup(phone), String(body.mode ?? "treatment")) });
  }

  if (action === "verify") {
    const phone = String(body.phone ?? "").trim();
    const code = String(body.code ?? "").trim();
    if (!phone || !/^\d{6,10}$/.test(code)) return json({ error: "bad_request" }, 400);
    const ph = await phoneHash(phone);
    if (await verifyBlocked(ph)) return json({ error: "too_many_attempts" }, 429);

    const email = await rpc("get_patient_email_v2", { p_phone: phone });
    if (typeof email !== "string" || !email.trim()) return json({ error: "invalid_code" }, 401);

    const v = await timedFetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), token: code, type: "email" }),
    });
    await v.body?.cancel();
    if (!v.ok) {
      await recordVerify(ph, false);
      return json({ error: "invalid_code" }, 401);
    }
    await recordVerify(ph, true);

    const pc = await rpc("get_patient_by_email_phone_v2", { p_email: email.trim(), p_phone: phone });
    if (typeof pc !== "string") return json({ error: "identity_mismatch" }, 403);
    const row = await lookup(phone);
    if (gate(row, String(body.mode ?? "treatment")) !== "ok") return json({ error: "not_allowed" }, 403);
    return json({ token: await issueToken(pc, phone), profile: profile(row as Row) });
  }

  // Everything below requires a valid device token.
  const who = await readToken(body.token);
  if (!who) return json({ error: "unauthorized" }, 401);

  if (action === "me") {
    const row = await lookup(who.ph);
    const g = gate(row, String(body.mode ?? "treatment"));
    if (g !== "ok") return json({ error: g }, 403);
    return json({ profile: profile(row as Row) });
  }

  if (action === "disclaim") {
    await rpc("set_disclaimed_agreed_v2", { p_phone: who.ph });
    return json({ ok: true });
  }

  if (action === "start") {
    const source = body.source === "D" ? "D" : "C";
    const row = await lookup(who.ph);
    if (gate(row, source === "D" ? "course" : "treatment") !== "ok") return json({ error: "not_allowed" }, 403);
    const id = await rpc("start_conversation_v2", { p_phone: who.ph, p_name: row?.name ?? "", p_source: source });
    return json({ conversation_id: typeof id === "string" ? id : "" });
  }

  if (action === "set_lesson") {
    if (!(await ownsConversation(who.pc, body.conversation_id))) return json({ error: "forbidden" }, 403);
    await rpc("set_course_lesson_v2", {
      p_conversation_id: body.conversation_id,
      p_lesson_number: Number(body.lesson_number),
    });
    return json({ ok: true });
  }

  if (action === "chat") {
    const question = String(body.question ?? "").trim();
    if (!question) return json({ error: "question_required" }, 400);
    if (!(await ownsConversation(who.pc, body.conversation_id))) return json({ error: "forbidden" }, 403);

    const r = await timedFetch(RUNTIME_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-landbot-secret": ENGINE_SECRET },
      body: JSON.stringify({ question20: question, patient_id: who.ph, session_id: body.conversation_id }),
    }, ENGINE_TIMEOUT_MS);
    const data = await r.json().catch(() => ({}));
    const answer = String(data.corrected_answer || data.answer || "");
    if (!r.ok || !answer) return json({ error: "engine_failed" }, 502);

    // Logged server-side, so the browser can no longer write turns.
    await rpc("insert_conversation_v2", {
      p_phone: who.ph,
      p_conversation_id: body.conversation_id,
      p_question: question,
      p_answer: answer,
    });
    return json({ answer });
  }

  return json({ error: "unknown_action" }, 400);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !ENGINE_SECRET) {
    return json({ error: "server_configuration_missing" }, 500);
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  try {
    return await handle(body);
  } catch (e) {
    console.error("meitar-api", String(e));
    return json({ error: "server_error" }, 500);
  }
});
