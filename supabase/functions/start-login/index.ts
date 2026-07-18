// supabase/functions/start-login/index.ts
// Supabase Edge Function (Deno)
//
// Purpose:
// - On-demand login by phone -> look up email in public.users_information
// - If found: ensure Auth user exists (Admin API), then send Email OTP
//
// Environment variables (set as Supabase Function secrets):
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// Optional:
// - ALLOWED_ORIGINS="https://yourdomain.com,https://sub.example.com"  (default: "*")
// - DEBUG_ENUM="true"  (default: "false")  // Only for testing; avoid in production

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const DEBUG_ENUM = (Deno.env.get("DEBUG_ENUM") ?? "false").toLowerCase() === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY env vars");
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function normalizePhone(input: string): string | null {
  let d = String(input ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0972")) d = d.slice(4);
  else if (d.startsWith("972")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  d = "0" + d;
  if (!/^05\d{8}$/.test(d)) return null;
  return d;
}

function corsHeaders(req: Request): Headers {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").trim();
  const origin = req.headers.get("origin") ?? "*";

  const headers = new Headers();
  headers.set("Vary", "Origin");

  if (allowed === "*") {
    headers.set("Access-Control-Allow-Origin", origin === "null" ? "*" : origin);
  } else {
    const allowedList = allowed.split(",").map((s) => s.trim()).filter(Boolean);
    if (allowedList.includes(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
    } else {
      // Block unknown origins (still return a valid response, but CORS will prevent browser reads)
      headers.set("Access-Control-Allow-Origin", allowedList[0] ?? "null");
    }
  }

  headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return headers;
}

function jsonResponse(req: Request, status: number, body: Record<string, unknown>) {
  const headers = corsHeaders(req);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

async function ensureAuthUserExists(email: string): Promise<void> {
  // Create Auth user via Admin API.
  // If user already exists, Supabase returns an error (commonly 422); we treat that as success.
  const url = `${SUPABASE_URL}/auth/v1/admin/users`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      email,
      email_confirm: true,
    }),
  });

  if (res.ok) return;

  const text = await res.text();
  // Common "already exists" patterns. Treat as success.
  const alreadyExists = res.status === 422 && /already/i.test(text) && /email/i.test(text);
  if (alreadyExists) return;

  console.error("ensureAuthUserExists failed:", res.status, text);
  throw new Error(`ensureAuthUserExists failed (${res.status})`);
}

if (import.meta.main) {
  serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse(req, 405, { ok: false, error: "method_not_allowed" });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "invalid_json" });
  }

  const phoneRaw = String(payload?.phone ?? "");
  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    return jsonResponse(req, 400, { ok: false, error: "invalid_phone" });
  }

  // Generic response to reduce account enumeration.
  const genericOk = { ok: true, message: "אם המספר קיים ובמערכת מוגדר מייל, נשלח קוד אימות." };

  // 1) Find email by phone in your table
  const { data, error } = await supabaseAdmin
    .from("psychologists")
    .select("email")
    .eq("phone", phone)
    .maybeSingle();

  if (error) {
    console.error("DB error:", error);
    return jsonResponse(req, 500, { ok: false, error: "db_error" });
  }

  const email = (data?.email ?? "").toString().trim();

  if (!email) {
    // Not found or no email configured
    return jsonResponse(req, 200, DEBUG_ENUM ? { ...genericOk, debug: { found: false } } : genericOk);
  }

  try {
    // 2) Ensure Auth user exists (admin only)
    await ensureAuthUserExists(email);

    // 3) Send Email OTP without allowing user creation from the OTP endpoint itself
    const { error: otpErr } = await supabaseAdmin.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });

    if (otpErr) {
      console.error("OTP error:", otpErr);
      return jsonResponse(req, 500, { ok: false, error: "otp_send_failed" });
    }

    return jsonResponse(req, 200, DEBUG_ENUM ? { ...genericOk, debug: { found: true, email } } : genericOk);
  } catch (e) {
    console.error("start-login failed:", e);
    return jsonResponse(req, 500, { ok: false, error: "internal_error" });
  }
  });
}
