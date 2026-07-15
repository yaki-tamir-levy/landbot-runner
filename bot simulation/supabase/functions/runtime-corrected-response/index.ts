type RequestPayload = {
  prompt20: string;
  pre_patient20: string;
  patient20: string;
  summarized20: string;
  tzvira: string;
  response20?: string;
  question20: string;
  patient_id: string;
  session_id: string;
};

type CorrectorDecision = "PASS" | "REWRITE" | "FALLBACK";

type CorrectorResult = {
  action: "PASS" | "REWRITE";
  final_response: string;
  reason_codes: string[];
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.4";
const CANDIDATE_TIMEOUT_MS = 60_000;
const CORRECTOR_TIMEOUT_MS = 60_000;

const REQUIRED_TEXT_FIELDS = [
  "prompt20",
  "pre_patient20",
  "patient20",
  "summarized20",
  "tzvira",
  "question20",
  "patient_id",
  "session_id",
] as const;

const REASON_CODES = [
  "REPEATS_REJECTED_IDEA",
  "VIOLATES_USER_CONSTRAINT",
  "REDUNDANT_SUMMARY",
  "NO_FORWARD_PROGRESS",
  "UNSUPPORTED_INFERENCE",
  "OVER_ANALYSIS",
  "OVERLY_TASK_ORIENTED",
  "TOO_LONG",
  "CONTINUITY_ERROR",
  "MISSES_DIRECT_REQUEST",
  "TONE_MISMATCH",
  "OTHER",
] as const;

const REASON_CODE_SET = new Set<string>(REASON_CODES);

Deno.serve(async (request: Request): Promise<Response> => {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  let candidateElapsedMs = 0;
  let correctorElapsedMs = 0;
  let httpStatus = 200;
  let correctorDecision: CorrectorDecision | "" = "";
  let fallbackUsed = false;
  let candidateSuccess = false;
  let diagnosticTherapistModel = DEFAULT_MODEL;
  let diagnosticTherapistInstructions = "";
  let diagnosticCandidateInput = "";
  let diagnosticPayload: {
    prompt20: string;
    pre_patient20: string;
    patient20: string;
    summarized20: string;
    tzvira: string;
    response20: string;
    question20: string;
    patient_id: string;
    session_id: string;
  } | null = null;

  try {
    if (request.method !== "POST") {
      httpStatus = 405;
      return jsonResponse({ ok: false, error: "method_not_allowed" }, httpStatus);
    }

    const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
    const landbotSecret = Deno.env.get("LANDBOT_WEBHOOK_SECRET");
    if (!openAiApiKey || !landbotSecret) {
      httpStatus = 500;
      return jsonResponse({ ok: false, error: "server_configuration_missing" }, httpStatus);
    }

    const suppliedSecret = request.headers.get("x-landbot-secret") ?? "";
    if (!constantTimeEqual(suppliedSecret, landbotSecret)) {
      httpStatus = 401;
      return jsonResponse({ ok: false, error: "unauthorized" }, httpStatus);
    }

    const payload = await parseAndValidatePayload(request);
    if (!payload.ok) {
      httpStatus = 400;
      return jsonResponse({ ok: false, error: payload.error }, httpStatus);
    }

    const therapistModel = Deno.env.get("THERAPIST_MODEL") || DEFAULT_MODEL;
    const correctorModel = Deno.env.get("CORRECTOR_MODEL") || DEFAULT_MODEL;
    const therapistInstructions = buildTherapistInstructions(payload.value);
    const candidateInput = buildCandidateInput(payload.value);

    diagnosticTherapistModel = therapistModel;
    diagnosticTherapistInstructions = therapistInstructions;
    diagnosticCandidateInput = candidateInput;
    diagnosticPayload = {
      prompt20: payload.value.prompt20,
      pre_patient20: payload.value.pre_patient20,
      patient20: payload.value.patient20,
      summarized20: payload.value.summarized20,
      tzvira: payload.value.tzvira,
      response20: payload.value.response20 ?? "",
      question20: payload.value.question20,
      patient_id: payload.value.patient_id,
      session_id: payload.value.session_id,
    };

    console.log(JSON.stringify({
      event: "candidate_request_debug",
      correlation_id: correlationId,
      therapist_model: therapistModel,
      therapistInstructions,
      candidateInput,
      payload: {
        prompt20: payload.value.prompt20,
        pre_patient20: payload.value.pre_patient20,
        patient20: payload.value.patient20,
        summarized20: payload.value.summarized20,
        tzvira: payload.value.tzvira,
        response20: payload.value.response20 ?? "",
        question20: payload.value.question20,
        patient_id: payload.value.patient_id,
        session_id: payload.value.session_id,
      },
    }));

    const candidateStartedAt = Date.now();
    let candidateText: string | null;
    try {
      candidateText = await generateCandidate({
        apiKey: openAiApiKey,
        model: therapistModel,
        instructions: therapistInstructions,
        input: candidateInput,
        patientId: payload.value.patient_id,
        sessionId: payload.value.session_id,
      });
    } finally {
      candidateElapsedMs = Date.now() - candidateStartedAt;
    }

    if (!candidateText) {
      httpStatus = 502;
      return jsonResponse({ ok: false, error: "candidate_generation_failed" }, httpStatus);
    }

    candidateSuccess = true;

    let correctorInstructions: string;
    try {
      correctorInstructions = await fetchRuntimeCorrectorPrompt(correlationId);
    } catch (error) {
      const typedError = toError(error);
      if (
        typedError.message === "runtime_corrector_prompt_fetch_failed" ||
        typedError.message === "missing_runtime_corrector_prompt"
      ) {
        return jsonResponse({ ok: false, error: typedError.message }, 502);
      }
      throw error;
    }

    try {
      const correctorStartedAt = Date.now();
      let correctorResult: CorrectorResult;
      try {
        correctorResult = await runCorrector({
          apiKey: openAiApiKey,
          model: correctorModel,
          correctorInstructions,
          acceptedPriorHistory: payload.value.tzvira,
          previousAcceptedTherapistResponse: payload.value.response20 ?? "",
          currentPatientMessage: payload.value.question20,
          candidateResponse: candidateText,
        });
      } finally {
        correctorElapsedMs = Date.now() - correctorStartedAt;
      }

      if (correctorResult.action === "PASS") {
        correctorDecision = "PASS";
        return jsonResponse({
          ok: true,
          answer: formatDiagnosticAnswer(candidateText, "לא נדרש תיקון."),
          candidate_answer: candidateText,
          corrected_answer: candidateText,
          corrector_decision: "PASS",
          correction_action: "PASS",
          reason_codes: [],
          fallback_used: false,
        }, 200);
      }

      const rewrite = correctorResult.final_response.trim();
      if (rewrite.length === 0) {
        throw new Error("empty_rewrite");
      }

      correctorDecision = "REWRITE";
      return jsonResponse({
        ok: true,
        answer: formatDiagnosticAnswer(candidateText, rewrite),
        candidate_answer: candidateText,
        corrected_answer: rewrite,
        corrector_decision: "REWRITE",
        correction_action: "REWRITE",
        reason_codes: correctorResult.reason_codes,
        fallback_used: false,
      }, 200);
    } catch (_error) {
      correctorDecision = "FALLBACK";
      fallbackUsed = true;
      return jsonResponse({
        ok: true,
        answer: formatDiagnosticAnswer(candidateText, "הבדיקה לא הושלמה, ולכן לא בוצע תיקון."),
        candidate_answer: candidateText,
        corrected_answer: candidateText,
        corrector_decision: "FALLBACK",
        correction_action: "FALLBACK",
        reason_codes: [],
        fallback_used: true,
      }, 200);
    }
  } catch (error) {
    const candidateError = toError(error);
    console.error(JSON.stringify({
      event: "candidate_generation_exception",
      correlation_id: correlationId,
      error_name: candidateError.name,
      error_message: candidateError.message,
    }));
    httpStatus = 502;
    return jsonResponse({ ok: false, error: "candidate_generation_failed" }, httpStatus);
  } finally {
    logDiagnostic({
      correlation_id: correlationId,
      candidate_success: candidateSuccess,
      corrector_decision: correctorDecision || null,
      fallback_used: fallbackUsed,
      http_status: httpStatus,
      candidate_elapsed_ms: candidateElapsedMs,
      corrector_elapsed_ms: correctorElapsedMs,
      total_elapsed_ms: Date.now() - startedAt,
      therapist_model: diagnosticTherapistModel,
      therapistInstructions: diagnosticTherapistInstructions,
      candidateInput: diagnosticCandidateInput,
      payload: diagnosticPayload ?? {
        prompt20: "",
        pre_patient20: "",
        patient20: "",
        summarized20: "",
        tzvira: "",
        response20: "",
        question20: "",
        patient_id: "",
        session_id: "",
      },
    });
  }
});

async function parseAndValidatePayload(
  request: Request,
): Promise<{ ok: true; value: RequestPayload } | { ok: false; error: string }> {
  let parsed: unknown;

  try {
    parsed = await request.json();
  } catch (_error) {
    return { ok: false, error: "malformed_json" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "malformed_json" };
  }

  const record = parsed as Record<string, unknown>;
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof record[field] !== "string") {
      return { ok: false, error: `missing_required_field:${field}` };
    }
  }

  return { ok: true, value: record as RequestPayload };
}

async function fetchRuntimeCorrectorPrompt(correlationId: string): Promise<string> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error(JSON.stringify({
      event: "runtime_corrector_prompt_fetch_failed",
      correlation_id: correlationId,
      error: "supabase_configuration_missing",
    }));
    throw new Error("runtime_corrector_prompt_fetch_failed");
  }

  const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/prompt_information_v2?select=user_text&prompt_key=eq.corrector&limit=1`;
  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: "application/json",
      Prefer: "count=exact",
    },
  });

  if (!response.ok) {
    console.error(JSON.stringify({
      event: "runtime_corrector_prompt_fetch_failed",
      correlation_id: correlationId,
      error: "supabase_http_error",
      status: response.status,
      status_text: response.statusText,
    }));
    throw new Error("runtime_corrector_prompt_fetch_failed");
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    console.error(JSON.stringify({
      event: "runtime_corrector_prompt_fetch_failed",
      correlation_id: correlationId,
      error: "supabase_invalid_response",
    }));
    throw new Error("runtime_corrector_prompt_fetch_failed");
  }

  if (data.length === 0) {
    console.error(JSON.stringify({
      event: "missing_runtime_corrector_prompt",
      correlation_id: correlationId,
    }));
    throw new Error("missing_runtime_corrector_prompt");
  }

  if (data.length > 1) {
    console.error(JSON.stringify({
      event: "runtime_corrector_prompt_fetch_failed",
      correlation_id: correlationId,
      error: "multiple_runtime_corrector_prompts_found",
    }));
    throw new Error("runtime_corrector_prompt_fetch_failed");
  }

  const record = data[0] as Record<string, unknown>;
  if (record.user_text == null || typeof record.user_text !== "string") {
    console.error(JSON.stringify({
      event: "missing_runtime_corrector_prompt",
      correlation_id: correlationId,
    }));
    throw new Error("missing_runtime_corrector_prompt");
  }

  const prompt = record.user_text.trim();
  if (prompt.length === 0) {
    console.error(JSON.stringify({
      event: "missing_runtime_corrector_prompt",
      correlation_id: correlationId,
    }));
    throw new Error("missing_runtime_corrector_prompt");
  }

  return prompt;
}

function buildTherapistInstructions(payload: RequestPayload): string {
  return [
    payload.prompt20,
    payload.pre_patient20,
    payload.patient20,
    "",
    "Mandatory operational rules for this runtime request:",
    "- Reply in Hebrew only.",
    "- Maintain gender consistency with the patient and prior context.",
    "- Plain text only; no Markdown, numbering decorations, tables, or JSON.",
    "- Ask at most one question.",
    "- Do not repeat a proposal that was already rejected or did not fit.",
    "- Do not repeat the same empathy phrasing or emotional reflection from the previous therapist response.",
    "- Offer one practical suggestion only when the patient explicitly requests practical help.",
    "- Safety rules override all other instructions.",
  ].join("\n");
}

function buildCandidateInput(payload: RequestPayload): string {
  return [
    "summarized20:",
    payload.summarized20,
    "",
    "tzvira:",
    payload.tzvira,
    "",
    "response20:",
    payload.response20 ?? "",
    "",
    "question20:",
    payload.question20,
  ].join("\n");
}

function formatDiagnosticAnswer(candidate: string, checkedResult: string): string {
  return `תשובה מקורית:\n${candidate}\n\nתשובה לאחר בדיקה:\n${checkedResult}`;
}

async function generateCandidate(args: {
  apiKey: string;
  model: string;
  instructions: string;
  input: string;
  patientId: string;
  sessionId: string;
}): Promise<string | null> {
  const response = await postOpenAI({
    apiKey: args.apiKey,
    timeoutMs: CANDIDATE_TIMEOUT_MS,
    body: {
      model: args.model,
      store: false,
      instructions: args.instructions,
      input: args.input,
      max_output_tokens: 500,
      temperature: 0.7,
      metadata: {
        patient_id: args.patientId,
        session_id: args.sessionId,
      },
    },
  });

  const text = extractResponseText(response).trim();
  return text.length > 0 ? text : null;
}

async function runCorrector(args: {
  apiKey: string;
  model: string;
  correctorInstructions: string;
  acceptedPriorHistory: string;
  previousAcceptedTherapistResponse: string;
  currentPatientMessage: string;
  candidateResponse: string;
}): Promise<CorrectorResult> {
  const correctorPayload = {
    experiment: "runtime_corrected_response_edge_function",
    no_look_ahead_contract:
      "runtime payload contains accepted prior history, previous accepted therapist response, current patient message, and current candidate response only",
    response_format_instruction:
      "Return one valid JSON object only with action, final_response, and reason_codes. No Markdown and no text outside JSON.",
    accepted_prior_history: args.acceptedPriorHistory,
    previous_accepted_therapist_response: args.previousAcceptedTherapistResponse,
    current_patient_message: args.currentPatientMessage,
    candidate_response: args.candidateResponse,
  };

  const response = await postOpenAI({
    apiKey: args.apiKey,
    timeoutMs: CORRECTOR_TIMEOUT_MS,
    body: {
      model: args.model,
      store: false,
      instructions: args.correctorInstructions,
      input: JSON.stringify(correctorPayload),
      temperature: 0.1,
      max_output_tokens: 700,
      text: {
        format: {
          type: "json_schema",
          name: "runtime_corrector_response",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["action", "final_response", "reason_codes"],
            properties: {
              action: {
                type: "string",
                enum: ["PASS", "REWRITE"],
              },
              final_response: {
                type: "string",
              },
              reason_codes: {
                type: "array",
                items: {
                  type: "string",
                  enum: REASON_CODES,
                },
              },
            },
          },
        },
      },
    },
  });

  return validateCorrectorResult(extractResponseText(response), args.candidateResponse);
}

async function postOpenAI(args: {
  apiKey: string;
  timeoutMs: number;
  body: Record<string, unknown>;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch (_error) {
        errorBody = "";
      }

      console.error(JSON.stringify({
        event: "openai_http_error",
        status: response.status,
        statusText: response.statusText,
        request_id: response.headers.get("x-request-id"),
        error_body: sanitizeOpenAIErrorBody(errorBody),
      }));

      throw new Error(`openai_http_${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeOpenAIErrorBody(body: string): string {
  return body
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function extractResponseText(response: unknown): string {
  if (!response || typeof response !== "object") {
    return "";
  }

  const record = response as Record<string, unknown>;
  if (typeof record.output_text === "string") {
    return record.output_text;
  }

  const output = record.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const partRecord = part as Record<string, unknown>;
      if (typeof partRecord.text === "string") {
        chunks.push(partRecord.text);
      } else if (typeof partRecord.output_text === "string") {
        chunks.push(partRecord.output_text);
      }
    }
  }

  return chunks.join("");
}

function validateCorrectorResult(rawText: string, candidateResponse: string): CorrectorResult {
  const clean = rawText.trim();
  if (!clean.startsWith("{") || !clean.endsWith("}")) {
    throw new Error("corrector_not_json_object");
  }

  const parsed: unknown = JSON.parse(clean);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("corrector_invalid_json_object");
  }

  const keys = Object.keys(parsed as Record<string, unknown>);
  const expectedKeys = ["action", "final_response", "reason_codes"];
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw new Error("corrector_schema_mismatch");
  }

  const result = parsed as Record<string, unknown>;
  if (result.action !== "PASS" && result.action !== "REWRITE") {
    throw new Error("corrector_invalid_action");
  }

  if (typeof result.final_response !== "string") {
    throw new Error("corrector_missing_final_response");
  }

  if (!Array.isArray(result.reason_codes)) {
    throw new Error("corrector_invalid_reason_codes");
  }

  const reasonCodes = result.reason_codes.map((code) => {
    if (typeof code !== "string" || !REASON_CODE_SET.has(code)) {
      throw new Error("corrector_invalid_reason_code");
    }
    return code;
  });

  if (result.action === "PASS" && result.final_response !== candidateResponse) {
    throw new Error("corrector_pass_final_response_mismatch");
  }

  if (result.action === "REWRITE" && result.final_response.trim().length === 0) {
    throw new Error("corrector_empty_rewrite");
  }

  return {
    action: result.action,
    final_response: result.final_response,
    reason_codes: reasonCodes,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;

  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }

  return diff === 0;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function logDiagnostic(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}
