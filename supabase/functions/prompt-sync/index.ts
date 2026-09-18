type PromptRow = {
  prompt_key?: unknown;
  description?: unknown;
  user_text?: unknown;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

Deno.serve(async (request: Request): Promise<Response> => {
  const correlationId = crypto.randomUUID();

  if (request.method !== "POST") {
    console.error(JSON.stringify({
      event: "prompt_sync_method_not_allowed",
      correlation_id: correlationId,
      method: request.method,
    }));
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const suppliedSecret = request.headers.get("x-shared-secret") ?? "";
  const expectedSecret = Deno.env.get("PROMPT_SHARED_SECRET") ?? "";

  if (!constantTimeEqual(suppliedSecret, expectedSecret)) {
    console.error(JSON.stringify({
      event: "prompt_sync_unauthorized",
      correlation_id: correlationId,
      reason: "shared_secret_mismatch",
    }));
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (_error) {
    console.error(JSON.stringify({
      event: "prompt_sync_bad_json",
      correlation_id: correlationId,
      reason: "request_body_is_not_valid_json",
    }));
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    console.error(JSON.stringify({
      event: "prompt_sync_bad_payload",
      correlation_id: correlationId,
      reason: "request_body_must_be_a_json_object",
    }));
    return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
  }

  const payload = body as Record<string, unknown>;
  if (!Array.isArray(payload.rows)) {
    console.error(JSON.stringify({
      event: "prompt_sync_bad_payload",
      correlation_id: correlationId,
      reason: "rows_field_must_be_an_array",
    }));
    return jsonResponse({ ok: false, error: "invalid_rows" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error(JSON.stringify({
      event: "prompt_sync_configuration_error",
      correlation_id: correlationId,
      reason: "missing_supabase_configuration",
    }));
    return jsonResponse({ ok: false, error: "supabase_configuration_missing" }, 500);
  }

  const results: Array<{ index: number; ok: boolean; error?: string }> = [];

  for (const [index, row] of payload.rows.entries()) {
    const promptRow = row as PromptRow;
    const promptKey = typeof promptRow.prompt_key === "string" ? promptRow.prompt_key : null;
    const description = typeof promptRow.description === "string" ? promptRow.description : null;
    const userText = typeof promptRow.user_text === "string" ? promptRow.user_text : null;

    if (!promptKey || !description || userText === null) {
      const error = "row_missing_required_fields";
      console.error(JSON.stringify({
        event: "prompt_sync_row_failed",
        correlation_id: correlationId,
        index,
        reason: error,
      }));
      results.push({ index, ok: false, error });
      continue;
    }

    try {
      const rpcResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/upsert_prompt_from_sheet`, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          p_prompt_key: promptKey,
          p_description: description,
          p_user_text: userText,
        }),
      });

      if (!rpcResponse.ok) {
        let errorBody = "";
        try {
          errorBody = await rpcResponse.text();
        } catch (_error) {
          errorBody = "";
        }

        const errorMessage = `rpc_http_${rpcResponse.status}`;
        console.error(JSON.stringify({
          event: "prompt_sync_row_failed",
          correlation_id: correlationId,
          index,
          reason: errorMessage,
          response_body: errorBody,
        }));
        results.push({ index, ok: false, error: errorMessage });
        continue;
      }

      results.push({ index, ok: true });
    } catch (error) {
      const typedError = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: "prompt_sync_row_failed",
        correlation_id: correlationId,
        index,
        reason: typedError,
      }));
      results.push({ index, ok: false, error: typedError });
    }
  }

  console.log(JSON.stringify({
    event: "prompt_sync_completed",
    correlation_id: correlationId,
    row_count: payload.rows.length,
    results,
  }));

  return jsonResponse({ ok: true, results });
});
