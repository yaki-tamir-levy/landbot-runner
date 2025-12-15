// Supabase Edge Function: risk_engine
// Actions:
// - scan_incremental
// - list_open_risks
// - update_risk_status
//
// Security model:
// - Caller uses normal JWT (Authorization: Bearer <user_jwt>)
// - Function verifies caller is authenticated (via anon client + auth.getUser())
// - All DB writes use Service Role (server-side only)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

type Action = "scan_incremental" | "list_open_risks" | "update_risk_status";

type RiskPhrase = {
  id: number;
  pattern_key: string;
  pattern: string;
  severity: "medium" | "high";
  is_active: boolean;
};

type UsersTzviraRow = {
  time: number;              // watermark key (bigint mapped to number; if it can exceed JS safe int, store as string)
  phone: string;
  last_talk_tzvira: string | null;
};

type Json = Record<string, unknown>;

function jsonResponse(body: Json, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function badRequest(message: string, extra: Json = {}) {
  return jsonResponse({ ok: false, error: message, ...extra }, 400);
}

function unauthorized(message = "Unauthorized") {
  return jsonResponse({ ok: false, error: message }, 401);
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Normalization (stable + simple):
 * - lowercase
 * - normalize unicode (NFKC)
 * - collapse whitespace
 * - replace common problematic chars
 */
function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u200f|\u200e/g, "")     // bidi marks
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function snippetAround(text: string, startIdx: number, endIdx: number, windowN: number): string {
  const half = Math.floor(windowN / 2);
  const from = Math.max(0, startIdx - half);
  const to = Math.min(text.length, endIdx + half);
  return text.slice(from, to);
}

function compileRegex(pattern: string): RegExp | null {
  // Patterns are stored as either:
  // - raw regex: /.../flags  (recommended)
  // - plain text: treated as escaped literal
  // We compile into a global regex to find multiple matches.
  try {
    const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) {
      const body = m[1];
      const flags = m[2].includes("g") ? m[2] : (m[2] + "g");
      return new RegExp(body, flags);
    }
    // literal text -> escape special regex chars
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "g");
  } catch {
    return null;
  }
}

function getAction(payload: any): Action | null {
  const a = payload?.action;
  if (a === "scan_incremental" || a === "list_open_risks" || a === "update_risk_status") return a;
  return null;
}

async function requireUser(anonClient: any, authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  // When calling auth.getUser() with supabase-js v2 in edge functions:
  // pass token to getUser(token)
  const token = authHeader.slice("Bearer ".length);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

async function loadWatermark(admin: any): Promise<number> {
  const { data, error } = await admin
    .from("risk_scan_state")
    .select("last_time_key")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return (data?.last_time_key ?? 0) as number;
}

async function saveWatermark(admin: any, last_time_key: number) {
  const { error } = await admin
    .from("risk_scan_state")
    .update({ last_time_key })
    .eq("id", 1);
  if (error) throw error;
}

async function fetchActivePhrases(admin: any): Promise<RiskPhrase[]> {
  const { data, error } = await admin
    .from("risk_phrases")
    .select("id, pattern_key, pattern, severity, is_active")
    .eq("is_active", true)
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []) as RiskPhrase[];
}

async function fetchUsersBatch(admin: any, afterTime: number, limit: number): Promise<UsersTzviraRow[]> {
  const { data, error } = await admin
    .from("users_tzvira")
    .select("time, phone, last_talk_tzvira")
    .gt("time", afterTime)
    .order("time", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as UsersTzviraRow[];
}

async function upsertRiskReviews(admin: any, rows: any[]) {
  if (rows.length === 0) return { inserted_or_updated: 0 };
  // We want "insert if new, otherwise do nothing" (keep existing status/reviewer decisions).
  // PostgREST supports upsert with ignoreDuplicates=true.
  const { data, error } = await admin
    .from("risk_reviews")
    .upsert(rows, {
      onConflict: "time_key,phone,snippet_hash",
      ignoreDuplicates: true,
    })
    .select("time_key"); // minimal
  if (error) throw error;
  return { inserted_or_updated: (data ?? []).length };
}

async function scanIncremental(admin: any, params: any) {
  const batchLimit = Math.max(1, Math.min(1000, Number(params?.limit ?? 200)));
  const snippetWindow = Math.max(40, Math.min(1000, Number(Deno.env.get("SNIPPET_WINDOW") ?? "160")));

  const phrases = await fetchActivePhrases(admin);
  const compiled = phrases
    .map((p) => ({ phrase: p, re: compileRegex(p.pattern) }))
    .filter((x) => x.re !== null) as { phrase: RiskPhrase; re: RegExp }[];

  const startedWatermark = await loadWatermark(admin);
  let watermark = startedWatermark;

  let scannedRows = 0;
  let totalMatches = 0;
  let inserted = 0;

  // Single batch scan (incremental-only, no overlap). If you want multi-batch per run, loop here.
  const batch = await fetchUsersBatch(admin, watermark, batchLimit);
  if (batch.length === 0) {
    return {
      ok: true,
      action: "scan_incremental",
      watermark_start: startedWatermark,
      watermark_end: startedWatermark,
      scanned_rows: 0,
      matches_found: 0,
      inserted,
      note: "No new rows to scan.",
    };
  }

  const toUpsert: any[] = [];

  for (const row of batch) {
    scannedRows += 1;
    watermark = Math.max(watermark, Number(row.time));

    const rawText = row.last_talk_tzvira ?? "";
    if (!rawText.trim()) continue;

    const norm = normalizeText(rawText);

    for (const { phrase, re } of compiled) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(norm)) !== null) {
        const start = m.index;
        const end = m.index + (m[0]?.length ?? 0);
        const snip = snippetAround(norm, start, end, snippetWindow);
        const snipHash = await sha256Hex(snip);

        totalMatches += 1;

        toUpsert.push({
          time_key: row.time,
          phone: row.phone,
          snippet_text: snip,
          snippet_hash: snipHash,
          pattern_key: phrase.pattern_key,
          phrase_id: phrase.id,
          severity: phrase.severity,
          status: "pending",
          match_method: "regex",
          match_score: null,
        });

        // prevent infinite loops on zero-length matches
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  }

  const up = await upsertRiskReviews(admin, toUpsert);
  inserted += up.inserted_or_updated;

  // watermark update to max scanned time (incremental, time-only)
  await saveWatermark(admin, watermark);

  return {
    ok: true,
    action: "scan_incremental",
    watermark_start: startedWatermark,
    watermark_end: watermark,
    scanned_rows: scannedRows,
    matches_found: totalMatches,
    candidates_to_insert: toUpsert.length,
    inserted_new: inserted,
    batch_limit: batchLimit,
    snippet_window: snippetWindow,
  };
}

async function listOpenRisks(admin: any, params: any) {
  const limit = Math.max(1, Math.min(2000, Number(params?.limit ?? 500)));

  const { data, error } = await admin
    .from("risk_reviews")
    .select("time_key, phone, snippet_hash, snippet_text, pattern_key, phrase_id, severity, status, reviewed_at, reviewer, match_method, match_score, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return { ok: true, action: "list_open_risks", count: (data ?? []).length, items: data ?? [] };
}

async function updateRiskStatus(admin: any, user: any, params: any) {
  const phone = String(params?.phone ?? "");
  const time_key = params?.time_key;
  const snippet_hash = String(params?.snippet_hash ?? "");
  const status = String(params?.status ?? "");

  if (!phone || !snippet_hash || (status !== "pending" && status !== "reviewed" && status !== "dismissed")) {
    return badRequest("Missing/invalid parameters", {
      required: ["phone", "time_key", "snippet_hash", "status(pending|reviewed|dismissed)"],
    });
  }

  const reviewer = user?.email ?? user?.id ?? "unknown";

  const patch: any = {
    status,
    reviewer,
  };
  if (status === "reviewed" || status === "dismissed") {
    patch.reviewed_at = new Date().toISOString();
  } else {
    patch.reviewed_at = null;
  }

  const { data, error } = await admin
    .from("risk_reviews")
    .update(patch)
    .eq("phone", phone)
    .eq("time_key", time_key)
    .eq("snippet_hash", snippet_hash)
    .select("time_key, phone, snippet_hash, status, reviewed_at, reviewer")
    .maybeSingle();

  if (error) throw error;
  if (!data) return jsonResponse({ ok: false, error: "Risk item not found" }, 404);

  return jsonResponse({ ok: true, action: "update_risk_status", item: data });
}

Deno.serve(async (req) => {
  try {
    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

    const authHeader = req.headers.get("Authorization");

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });

    const user = await requireUser(anon, authHeader);
    if (!user) return unauthorized();

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const payload = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams.entries())
      : await req.json().catch(() => ({}));

    const action = getAction(payload);
    if (!action) return badRequest("Invalid action. Use scan_incremental | list_open_risks | update_risk_status");

    if (action === "scan_incremental") {
      const result = await scanIncremental(admin, payload);
      return jsonResponse(result);
    }

    if (action === "list_open_risks") {
      const result = await listOpenRisks(admin, payload);
      return jsonResponse(result);
    }

    if (action === "update_risk_status") {
      // updateRiskStatus returns Response directly (for richer errors)
      return await updateRiskStatus(admin, user, payload);
    }

    return badRequest("Unhandled action");
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e?.message ?? e), stack: String(e?.stack ?? "") }, 500);
  }
});
