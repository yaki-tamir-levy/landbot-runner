// risk-realtime-classify v1 - 30.9.2026.
// Classifies the CURRENT patient message of a therapy conversation into
// none | low | medium | high, using prompt_information_v2 key
// 'risk_realtime_classifier'. On 'high' it also returns the referral notice
// from app_config key 'risk_realtime_notice'.
//
// Caller: runtime-corrected-response, in parallel with the therapist reply,
// therapy conversations only (never course). Also called directly for tests.
// Auth: header x-landbot-secret must equal LANDBOT_WEBHOOK_SECRET - the same
// secret runtime-corrected-response already holds. The name is historical.
//
// Never fatal to the conversation: every failure returns ok:false,
// level 'error', notice null, and the caller continues without a notice.
//
// Log: one row in risk_realtime_log per call that carries a conversation_id.
// No message text and no phone are ever stored. Test calls send no
// conversation_id and are not logged.

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.4";
const PROMPT_KEY = "risk_realtime_classifier";
const NOTICE_KEY = "risk_realtime_notice";
const TIMEOUT_MS = 20_000;
const MAX_CONTEXT_CHARS = 4_000;
const LEVELS = ["none", "low", "medium", "high"] as const;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

const SB_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

type Notice = { intro: string; links: { label: string; href: string }[] };

Deno.serve(async (request: Request): Promise<Response> => {
  const startedAt = Date.now();
  let conversationId: string | null = null;
  let correlationId: string | null = null;

  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  const secret = Deno.env.get("LANDBOT_WEBHOOK_SECRET") ?? "";
  if (!apiKey || !secret || !SB_URL || !SB_KEY) {
    return json({ ok: false, error: "server_configuration_missing" }, 500);
  }
  if (!constantTimeEqual(request.headers.get("x-landbot-secret") ?? "", secret)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const message = str(body.message);
  if (!message) return json({ ok: false, error: "message_required" }, 400);
  const context = str(body.context).slice(-MAX_CONTEXT_CHARS);
  conversationId = UUID_PATTERN.test(str(body.conversation_id)) ? str(body.conversation_id) : null;
  correlationId = UUID_PATTERN.test(str(body.correlation_id)) ? str(body.correlation_id) : null;

  try {
    const instructions = await fetchPrompt();
    const input = [
      "context (current conversation, for understanding only):",
      context || "(none)",
      "",
      "current_patient_message (classify this):",
      message,
    ].join("\n");

    const level = await classify(apiKey, instructions, input);
    const notice = level === "high" ? await fetchNotice() : null;
    const elapsedMs = Date.now() - startedAt;

    await writeLog({
      conversation_id: conversationId,
      correlation_id: correlationId,
      level,
      notice_shown: notice !== null,
      elapsed_ms: elapsedMs,
      error: level === "high" && notice === null ? "notice_missing" : null,
    });
    console.log(JSON.stringify({ event: "risk_realtime_classified", correlation_id: correlationId, level, elapsed_ms: elapsedMs }));

    return json({ ok: true, level, notice, elapsed_ms: elapsedMs });
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error).slice(0, 200);
    const elapsedMs = Date.now() - startedAt;
    await writeLog({
      conversation_id: conversationId,
      correlation_id: correlationId,
      level: "error",
      notice_shown: false,
      elapsed_ms: elapsedMs,
      error: reason,
    });
    console.error(JSON.stringify({ event: "risk_realtime_failed", correlation_id: correlationId, error: reason }));
    return json({ ok: false, level: "error", notice: null, error: reason, elapsed_ms: elapsedMs });
  }
});

async function classify(apiKey: string, instructions: string, input: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        model: Deno.env.get("RISK_MODEL") || DEFAULT_MODEL,
        store: false,
        instructions,
        input,
        temperature: 0,
        max_output_tokens: 300,
        text: {
          format: {
            type: "json_schema",
            name: "risk_realtime_level",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["level"],
              properties: { level: { type: "string", enum: LEVELS } },
            },
          },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`openai_http_${res.status}`);
    }
    const text = extractText(await res.json()).trim();
    const parsed = JSON.parse(text);
    const level = typeof parsed?.level === "string" ? parsed.level : "";
    if (!(LEVELS as readonly string[]).includes(level)) throw new Error("invalid_level");
    return level;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrompt(): Promise<string> {
  const res = await fetch(
    `${SB_URL}/rest/v1/prompt_information_v2?select=user_text&prompt_key=eq.${PROMPT_KEY}&limit=2`,
    { headers: sbHeaders() },
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error("prompt_fetch_failed");
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.user_text !== "string" || !rows[0].user_text.trim()) {
    throw new Error("prompt_missing");
  }
  return rows[0].user_text.trim();
}

// Returns null when the notice is missing or malformed. The caller then shows
// nothing; the log row records notice_missing so the gap is visible.
async function fetchNotice(): Promise<Notice | null> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/app_config?select=value&key=eq.${NOTICE_KEY}&limit=1`, { headers: sbHeaders() });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const value = JSON.parse(String(rows[0].value));
    const intro = str(value?.intro);
    const links = Array.isArray(value?.links)
      ? value.links
        .map((l: Record<string, unknown>) => ({ label: str(l?.label), href: str(l?.href) }))
        .filter((l: { label: string; href: string }) => l.label && /^(tel:|https:\/\/)/.test(l.href))
      : [];
    if (!intro || links.length === 0) return null;
    return { intro, links };
  } catch {
    return null;
  }
}

async function writeLog(row: Record<string, unknown>): Promise<void> {
  if (!row.conversation_id) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/risk_realtime_log`, {
      method: "POST",
      headers: { ...sbHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    await res.body?.cancel();
    if (!res.ok) console.error(JSON.stringify({ event: "risk_realtime_log_failed", http_status: res.status }));
  } catch {
    console.error(JSON.stringify({ event: "risk_realtime_log_exception" }));
  }
}

function extractText(response: unknown): string {
  const record = (response ?? {}) as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const chunks: string[] = [];
  for (const item of Array.isArray(record.output) ? record.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function sbHeaders(): Record<string, string> {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
