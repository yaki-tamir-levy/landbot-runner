// supabase/functions/verify-login/index.ts
// Minimal verify-login: phone + token -> lookup email -> verify OTP -> return session tokens
// Does NOT require the client to provide email.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function normalizePhone(input: string): string | null {
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
    headers.set("Access-Control-Allow-Origin", allowedList.includes(origin) ? origin : (allowedList[0] ?? "null"));
  }
  headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return headers;
}

function json(req: Request, status: number, body: Record<string, unknown>) {
  const headers = corsHeaders(req);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false });

  let payload: any;
  try { payload = await req.json(); } catch { return json(req, 400, { ok: false }); }

  const phone = normalizePhone(String(payload?.phone ?? ""));
  const token = String(payload?.token ?? "").trim();

  if (!phone) return json(req, 400, { ok: false });
  if (!token || token.length < 4) return json(req, 400, { ok: false });

  const { data, error } = await supabaseAdmin
    .from("psychologists")
    .select("email, active")
    .eq("phone", phone)
    .maybeSingle();

  if (error) {
    console.error("DB error:", error);
    return json(req, 500, { ok: false, error: "db_error" });
  }

  const email = (data?.email ?? "").toString().trim();
  if (!email || data?.active === false) {
    return json(req, 401, { ok: false, error: "verify_failed" });
  }

  const { data: out, error: verr } = await supabaseAdmin.auth.verifyOtp({
    email,
    token,
    type: "email",
  });

  if (verr) {
    console.error("verifyOtp error:", verr);
    return json(req, 401, { ok: false, error: "verify_failed" });
  }

  const session = out?.session;
  if (!session?.access_token || !session?.refresh_token) {
    return json(req, 500, { ok: false, error: "no_session" });
  }

  return json(req, 200, {
    ok: true,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    token_type: session.token_type,
  });
});