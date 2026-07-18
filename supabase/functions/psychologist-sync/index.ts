// supabase/functions/psychologist-sync/index.ts
// Sync psychologists from Google Sheet -> psychologists table via RPC.
// Phone normalization + validation happen inside the RPC (DB level).

type PsychologistRow = {
  phone?: unknown;
  email?: unknown;
  name?: unknown;
  active?: unknown;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

Deno.serve(async (request: Request): Promise<Response> => {
  const correlationId = crypto.randomUUID();

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const expectedSecret = Deno.env.get("PSYCHOLOGIST_SHARED_SECRET") ?? "";
  // fail-closed: אם ה-secret לא מוגדר, זו תקלת תצורה — לא לפתוח את הדלת
  if (!expectedSecret) {
    console.error(JSON.stringify({
      event: "psychologist_sync_misconfigured",
      correlation_id: correlationId,
      reason: "shared_secret_not_configured",
    }));
    return jsonResponse({ ok: false, error: "shared_secret_not_configured" }, 500);
  }

  const suppliedSecret = request.headers.get("x-shared-secret") ?? "";
  if (!constantTimeEqual(suppliedSecret, expectedSecret)) {
    console.error(JSON.stringify({
      event: "psychologist_sync_unauthorized",
      correlation_id: correlationId,
      reason: "shared_secret_mismatch",
    }));
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
  }

  const payload = body as Record<string, unknown>;
  if (!Array.isArray(payload.rows)) {
    return jsonResponse({ ok: false, error: "invalid_rows" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return jsonResponse({ ok: false, error: "supabase_configuration_missing" }, 500);
  }

  const results: Array<{ index: number; ok: boolean; error?: string }> = [];

  for (const [index, row] of payload.rows.entries()) {
    const r = row as PsychologistRow;
    const phone = typeof r.phone === "string" ? r.phone : (r.phone != null ? String(r.phone) : null);
    const email = typeof r.email === "string" ? r.email : null;
    const name = typeof r.name === "string" ? r.name : null;
    const active = typeof r.active === "boolean" ? r.active
      : (typeof r.active === "string" ? !/^(false|0|no|לא)$/i.test(r.active.trim()) : true);

    if (!phone || !email) {
      results.push({ index, ok: false, error: "row_missing_required_fields" });
      continue;
    }

    try {
      const rpcResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/upsert_psychologist_from_sheet`, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          p_phone: phone,
          p_email: email,
          p_name: name,
          p_active: active,
        }),
      });

      if (!rpcResponse.ok) {
        let errorBody = "";
        try { errorBody = await rpcResponse.text(); } catch { errorBody = ""; }
        const errorMessage = /invalid_phone/.test(errorBody) ? "row_invalid_phone"
          : /email_required/.test(errorBody) ? "row_missing_email"
          : `rpc_http_${rpcResponse.status}`;
        console.error(JSON.stringify({
          event: "psychologist_sync_row_failed",
          correlation_id: correlationId, index, reason: errorMessage, response_body: errorBody,
        }));
        results.push({ index, ok: false, error: errorMessage });
        continue;
      }

      results.push({ index, ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ index, ok: false, error: msg });
    }
  }

  console.log(JSON.stringify({
    event: "psychologist_sync_completed",
    correlation_id: correlationId, row_count: payload.rows.length, results,
  }));

  return jsonResponse({ ok: true, results });
});