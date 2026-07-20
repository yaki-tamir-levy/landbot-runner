// supabase/functions/supa-sync/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Json = Record<string, unknown>;

function nowIL(): string {
const dtf = new Intl.DateTimeFormat("en-GB", {
timeZone: "Asia/Jerusalem",
year: "numeric",
month: "2-digit",
day: "2-digit",
hour: "2-digit",
minute: "2-digit",
second: "2-digit",
hourCycle: "h23",
timeZoneName: "shortOffset",
});

const parts = dtf.formatToParts(new Date());
const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
const dd = get("day");
const mm = get("month");
const yyyy = get("year");
const hh = get("hour");
const mi = get("minute");
const ss = get("second");
const tz = get("timeZoneName");

let offset = "+00:00";
const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
if (m) {
const sign = m[1] === "-" ? "-" : "+";
const h = String(m[2]).padStart(2, "0");
const mins = String(m[3] ?? "00").padStart(2, "0");
offset = `${sign}${h}:${mins}`;
}

return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}${offset}`;
}

function normalizeStr(v: unknown): string {
return String(v ?? "").trim();
}

function cleanRow(input: Json, disallowKeys: Set<string>): Json {
const out: Json = {};

for (const [k, v] of Object.entries(input)) {
if (!k || disallowKeys.has(k)) continue;
if (v === null || v === undefined) continue;
if (typeof v === "string" && v.trim() === "") continue;
out[k] = v;
}

return out;
}

function getOptionalText(row: Json, key: string): string | null {
const value = normalizeStr(row[key]);
return value ? value : null;
}

Deno.serve(async (req) => {
try {
if (req.method !== "POST") {
return new Response(JSON.stringify({ error: "Method not allowed" }), {
status: 405,
headers: { "content-type": "application/json; charset=utf-8" },
});
}

const shared = req.headers.get("x-shared-secret") ?? "";
const expected = Deno.env.get("FUNCTION_SHARED_SECRET") ?? "";

if (!expected || shared !== expected) {
  return new Response(
    JSON.stringify({
      error: "Unauthorized",
      hint: "Missing or invalid x-shared-secret",
    }),
    {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !serviceKey) {
  return new Response(
    JSON.stringify({
      error: "Server misconfigured",
      hint: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in function secrets",
    }),
    {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

const body = (await req.json().catch(() => ({}))) as Json;

const table = normalizeStr(body.table || "users_information") || "users_information";
const keyCol = normalizeStr(body.key_col || "phone") || "phone";
const updateCol = normalizeStr(body.update_col || "update") || "update";

const rowsRaw = body.rows ?? [];
const rows = Array.isArray(rowsRaw) ? (rowsRaw as Json[]) : [];

if (!rows.length) {
  return new Response(JSON.stringify({ ok: true, processed: 0, results: [] }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const disallow = new Set<string>([updateCol]);
const now = nowIL();
const results: Array<Json> = [];

for (let i = 0; i < rows.length; i++) {
  const row = rows[i] ?? {};
  const phone = normalizeStr(row[keyCol]);

  if (!phone) {
    results.push({ index: i, ok: false, code: "NO_PHONE" });
    continue;
  }

  if (table === "users_information_v2") {
    const { data, error } = await supabase.rpc("upsert_users_information_v2_from_sheet", {
      p_phone: phone,
      p_name: getOptionalText(row, "name"),
      p_email: getOptionalText(row, "email"),
      p_user_text: getOptionalText(row, "user_text"),
      p_active: getOptionalText(row, "active"),
      p_status: getOptionalText(row, "status"),
      p_psychologist: getOptionalText(row, "psychologist"),
    });

    if (error) {
      results.push({
        index: i,
        ok: false,
        phone,
        stage: "rpc_upsert_users_information_v2_from_sheet",
        error: error.message,
      });
      continue;
    }

    results.push({
      index: i,
      ok: true,
      phone,
      action: "rpc_upserted",
      patient_code: data,
    });

    continue;
  }

  const { data: found, error: selErr } = await supabase
    .from(table)
    .select(keyCol)
    .eq(keyCol, phone)
    .limit(1);

  if (selErr) {
    results.push({
      index: i,
      ok: false,
      phone,
      stage: "select",
      error: selErr.message,
    });
    continue;
  }

  const exists = Array.isArray(found) && found.length > 0;

  if (exists) {
    const updateObj = cleanRow(row, disallow);
    updateObj["updated_at"] = now;

    const { error: updErr } = await supabase
      .from(table)
      .update(updateObj)
      .eq(keyCol, phone);

    if (updErr) {
      results.push({
        index: i,
        ok: false,
        phone,
        stage: "update",
        error: updErr.message,
      });
      continue;
    }

    results.push({ index: i, ok: true, phone, action: "updated" });
  } else {
    const insertObj = cleanRow(row, disallow);
    insertObj[keyCol] = phone;
    insertObj["created_at"] = now;
    insertObj["updated_at"] = now;
    insertObj["timestampz"] = now;

    const { error: insErr } = await supabase
      .from(table)
      .insert(insertObj);

    if (insErr) {
      results.push({
        index: i,
        ok: false,
        phone,
        stage: "insert",
        error: insErr.message,
      });
      continue;
    }

    results.push({ index: i, ok: true, phone, action: "inserted" });
  }
}

const okCount = results.filter((r) => r.ok === true).length;
const failCount = results.length - okCount;

return new Response(
  JSON.stringify({
    ok: true,
    table,
    key_col: keyCol,
    processed: results.length,
    ok_count: okCount,
    fail_count: failCount,
    results,
  }),
  { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
);

} catch (e) {
const msg = e instanceof Error ? e.message : String(e);

return new Response(JSON.stringify({ error: "Unhandled error", message: msg }), {
  status: 500,
  headers: { "content-type": "application/json; charset=utf-8" },
});

}
});