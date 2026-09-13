// supabase/functions/crypto-tool/index.ts
// Edge Function: AES-GCM encrypt/decrypt with header-based authorization (x-crypto-secret).
//
// REQUIRED Supabase Secret (Functions -> Secrets):
//   Prefer: CRYPTO_SECRET = <base64-encoded 32-byte key>
//   Also accepted: X_CRYPTO_SECRET, CRYPTO_TOOL_SECRET, SUPA_CRYPTO_SECRET
//
// Diagnostic mode (safe): On Unauthorized, returns only lengths + which env var was found.
// Does NOT return any secret contents.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type Mode = "encrypt" | "decrypt";

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  const h = new Headers(extraHeaders);
  h.set("content-type", "application/json; charset=utf-8");
  // CORS (adjust if you want to restrict origins)
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type, authorization, apikey, x-crypto-secret");
  h.set("access-control-allow-methods", "POST, OPTIONS");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function b64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(normalized);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const ENV_NAMES = ["CRYPTO_SECRET", "X_CRYPTO_SECRET", "CRYPTO_TOOL_SECRET", "SUPA_CRYPTO_SECRET"] as const;

function getExpectedSecretWithName(): { name: string | null; value: string | null } {
  for (const n of ENV_NAMES) {
    const v = Deno.env.get(n);
    if (v && v.trim().length > 0) return { name: n, value: v.trim() };
  }
  return { name: null, value: null };
}

function getProvidedSecret(req: Request): string | null {
  const v = req.headers.get("x-crypto-secret");
  return v ? v.trim() : null;
}

async function importAesKeyFromEnv(expectedB64: string): Promise<CryptoKey> {
  const keyBytes = b64ToBytes(expectedB64);
  if (keyBytes.length !== 32) {
    throw new Error(`Server misconfigured: secret must decode to 32 bytes, got ${keyBytes.length}`);
  }
  return await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptText(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(plain);
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  const ct = new Uint8Array(ctBuf);
  return `v1.${bytesToB64(iv)}.${bytesToB64(ct)}`;
}

async function decryptText(key: CryptoKey, token: string): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Invalid ciphertext format. Expected v1.<iv_b64>.<ct_b64>");
  }
  const iv = b64ToBytes(parts[1]);
  const ct = b64ToBytes(parts[2]);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return json({ ok: true }, 204);
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  // --- AUTH (header-based) + SAFE DIAGNOSTICS ---
  const { name: envName, value: expected } = getExpectedSecretWithName();
  const provided = getProvidedSecret(req);

  const diag = {
    env_found: envName,                         // which env var name was found (or null)
    env_len: expected ? expected.length : 0,    // length only
    header_present: !!provided,
    header_len: provided ? provided.length : 0, // length only
  };

  if (!expected) {
    console.error("crypto-tool auth: missing env secret", diag);
    return json({ ok: false, error: "Unauthorized", reason: "missing_env", diag }, 401);
  }
  if (!provided || provided.length === 0) {
    console.error("crypto-tool auth: missing header", diag);
    return json({ ok: false, error: "Unauthorized", reason: "missing_header", diag }, 401);
  }
  if (provided !== expected) {
    console.error("crypto-tool auth: mismatch", diag);
    return json({ ok: false, error: "Unauthorized", reason: "mismatch", diag }, 401);
  }

  // --- BODY ---
  let payload: { mode?: Mode; text?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const mode = payload.mode;
  const text = payload.text;

  if (mode !== "encrypt" && mode !== "decrypt") {
    return json({ ok: false, error: "Invalid mode. Use encrypt|decrypt" }, 400);
  }
  if (typeof text !== "string") {
    return json({ ok: false, error: "Missing 'text' (string) in body" }, 400);
  }

  try {
    const key = await importAesKeyFromEnv(expected);
    const result = mode === "encrypt" ? await encryptText(key, text) : await decryptText(key, text);
    return json({ ok: true, mode, result }, 200);
  } catch (e) {
    console.error("crypto-tool error:", e);
    return json({ ok: false, error: (e instanceof Error ? e.message : String(e)) }, 400);
  }
});
