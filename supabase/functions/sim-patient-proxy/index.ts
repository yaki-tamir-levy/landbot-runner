const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.4";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-landbot-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    if (request.method === "OPTIONS") {
      return new Response("ok", { headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!openAiApiKey || !supabaseUrl || !serviceKey) {
      return jsonResponse({ ok: false, error: "server_configuration_missing" }, 500);
    }

    const body = await request.json();
    const rulesKey = String(body?.rules_key ?? "").trim();
    const patientBio = String(body?.patient_bio ?? "").trim();
    const conversationSoFar = Array.isArray(body?.conversation) ? body.conversation : [];

    if (!rulesKey) {
      return jsonResponse({ ok: false, error: "missing_rules_key" }, 400);
    }
    if (!/^[a-z0-9_]{1,80}$/.test(rulesKey)) {
      return jsonResponse({ ok: false, error: "invalid_rules_key" }, 400);
    }

    // Fetch the patient-simulation rules prompt by key, same table every
    // other prompt in this project lives in.
    const promptUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/prompt_information_v2?select=user_text&prompt_key=eq.${encodeURIComponent(rulesKey)}&limit=1`;
    const promptRes = await fetch(promptUrl, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: "application/json" },
    });
    if (!promptRes.ok) {
      return jsonResponse({ ok: false, error: "rules_fetch_failed" }, 502);
    }
    const promptData = await promptRes.json();
    const rulesText = Array.isArray(promptData) && promptData[0]?.user_text
      ? String(promptData[0].user_text)
      : "";
    if (!rulesText) {
      return jsonResponse({ ok: false, error: "missing_rules_prompt" }, 502);
    }

    const historyText = conversationSoFar
      .map((turn: { role: string; text: string }) => `${turn.role === "patient" ? "מטופל" : "מטפל"}: ${turn.text}`)
      .join("\n");

    const instructions = [
      rulesText,
      "",
      "רקע קליני על הדמות שאתה מגלם:",
      patientBio,
      "",
      "כתוב אך ורק את ההודעה הבאה של המטופל, בעברית, בלי תוספות, בלי כותרות, בלי לציין 'מטופל:'.",
    ].join("\n");

    const input = conversationSoFar.length === 0
      ? "פתח את השיחה כמטופל, הודעה ראשונה קצרה וטבעית."
      : `היסטוריית השיחה עד כה:\n${historyText}\n\nכתוב את ההודעה הבאה שלך כמטופל, בתגובה למה שהמטפל אמר.`;

    const aiRes = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        store: false,
        instructions,
        input,
        max_output_tokens: 300,
        temperature: 0.8,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return jsonResponse({ ok: false, error: "openai_http_error", detail: errText.slice(0, 500) }, 502);
    }

    const aiData = await aiRes.json();
    const patientMessage = extractResponseText(aiData).trim();
    if (!patientMessage) {
      return jsonResponse({ ok: false, error: "empty_patient_message" }, 502);
    }

    return jsonResponse({ ok: true, patient_message: patientMessage }, 200);
  } catch (error) {
    return jsonResponse({ ok: false, error: "unexpected_error", detail: String(error) }, 500);
  }
});

function extractResponseText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const record = response as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const output = record.output;
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      if (typeof partRecord.text === "string") chunks.push(partRecord.text);
      else if (typeof partRecord.output_text === "string") chunks.push(partRecord.output_text);
    }
  }
  return chunks.join("");
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}
