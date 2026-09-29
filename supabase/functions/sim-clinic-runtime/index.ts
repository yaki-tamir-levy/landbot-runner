// sim-clinic-runtime v4 - SIMULATION ONLY. Not called by any production client.
// A condensed copy of the CLINIC path of runtime-corrected-response v64,
// with one difference that is the whole point of this function: the three
// clinic prompts may be supplied in the request body, so an edited prompt can
// be tested WITHOUT writing to prompt_information_v2. A prompt that is not
// supplied is read from the table exactly as v64 does.
// Also generates the simulated patient message for the round.
// Writes: clinic_*_log per session (needed by the move/warning mechanisms).
// Does NOT write corrector_test_log or the storage log.
// Auth: header x-sim-secret must equal DISPATCH_SECRET.

type CorrectorResult = { action: "PASS" | "REWRITE"; final_response: string; reason_codes: string[] };

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.4";
const TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 500;

const REASON_CODES = [
  "REPEATS_REJECTED_IDEA", "VIOLATES_USER_CONSTRAINT", "REDUNDANT_SUMMARY", "NO_FORWARD_PROGRESS",
  "UNSUPPORTED_INFERENCE", "OVER_ANALYSIS", "OVERLY_TASK_ORIENTED", "TOO_LONG", "CONTINUITY_ERROR",
  "MISSES_DIRECT_REQUEST", "TONE_MISMATCH", "OTHER",
] as const;
const REASON_CODE_SET = new Set<string>(REASON_CODES);

const CLINIC_MOVE_TYPES = ["echo", "simple_presence", "normalization", "widening", "deepening", "other"] as const;
const CLINIC_MOVE_TYPE_SET = new Set<string>(CLINIC_MOVE_TYPES);
const CLINIC_MOVES_WITHOUT_ECHO = ["simple_presence", "normalization", "widening", "deepening"] as const;
const CLINIC_MOVES_WITH_ECHO = ["echo", "simple_presence", "normalization", "widening", "deepening"] as const;
const CLINIC_ECHO_COOLDOWN_TURNS = 3;
const CLINIC_FRAGMENT_WINDOW_TURNS = 3;
const CLINIC_FRAGMENT_WARNING_THRESHOLD = 2;
const CLINIC_REPEAT_CHECK_WINDOW = 3;
const MIN_SENTENCE_LENGTH_FOR_REPEAT_CHECK = 12;
const CLINIC_BLOCKED_WINDOW_TURNS = 3;
const CLINIC_BLOCKED_WARNING_THRESHOLD = 2;

const CLINIC_FRAGMENT_WARNING_LINE =
  "אזהרה מוגברת: התשובות האחרונות שלך פיצלו לשני רכיבים יותר מדי. התשובה הזו חייבת להיות משפט יחיד, בלי שום חיבור מנוגד או משלים - לא \"לא X אלא Y\", לא \"גם...וגם\", לא \"בין...לבין\".";
const CLINIC_REPEAT_WARNING_LINE =
  "אזהרה מוגברת: אחד המשפטים בתשובותיך הקודמות בשיחה הזו כבר הופיע כמעט מילה במילה. אסור לחזור על אותו משפט או על ניסוח קרוב אליו, גם לא כחלק מתשובה שונה בשאר תוכנה. אם המטופל ביקש עזרה בפועל ולא קיבל - ענה עכשיו בפועל (הצעה קטנה אחת) או הסבר בכנות שלא ענית קודם. אל תשקף, אל תשאל שאלה נגדית, ואל תשתמש שוב באותה שאלה שכבר שאלת.";
const CLINIC_BLOCKED_WARNING_LINE =
  "אזהרה קריטית: המתקן כבר קבע פעמיים שבקשה ישירה של המטופל לא נענתה. התשובה הזו חייבת להכיל, בשני משפטים רצופים בלבד ובסדר הזה: משפט ראשון - הכרה מפורשת שלא ענית קודם, במילים כמו \"אתה צודק, לא עניתי לך\". משפט שני, מיד אחריו, באותה תשובה - תשובה קונקרטית בפועל (הצעה קטנה אחת), או הסבר גבול כן למה אינך יכול לענות ישירות כרגע. אסור לעצור אחרי המשפט הראשון בלבד. אסור לשאול שאלה. אסור לשקף רגש. דוגמה למבנה שלם: \"אתה צודק, לא עניתי לך. דבר אחד קונקרטי שיכול לעזור עכשיו: [X].\"";
const CLINIC_ACK_TRIGGER_PHRASES = ["אתה צודק", "את צודקת", "לא עניתי", "לא ענית", "לא נתתי מענה", "לא נתתי לך מענה"] as const;
const CLINIC_QUESTION_DUE_WINDOW = 3;
const CLINIC_QUESTION_DUE_LINE =
  "בתור הזה: עצור ושאל שאלה פתוחה אחת — מה הכי חשוב למטופל שתבין, או מה הוא צריך ממך עכשיו. בלי להציע אפשרויות לבחירה. שיקוף קצר לפני השאלה מותר; תשובה בלי שאלה אינה מותרת בתור הזה.";
const CLINIC_OPTIONS_WARNING_LINE =
  "אזהרה קריטית: בתשובה הקודמת שלך הודית שלא ענית ישירות למטופל. התשובה הזו חייבת להציע 2-4 אפשרויות קצרות וברורות לבחירה, הנובעות ממה שהמטופל כבר אמר בשיחה - לא עוד שיקוף רגש, ולא עוד שאלה פתוחה יחידה. דוגמה למבנה: \"מה היית רוצה עכשיו - X, או Y?\" הצגת כמה אפשרויות למטופל אינה הפרת איסור הפיצול - האיסור ההוא חל על ניתוח שלך את המטופל, לא על הצעת בחירה מפורשת.";

// SIM v3: named corrector presets, so a long prompt need not travel in every request.
const CORRECTOR_PRESETS: Record<string, string> = {
  v6: "You are a Runtime Corrector for a Hebrew companion between clinical appointments. Review the accepted history through the current patient turn and one candidate response. Never use future turns. Return JSON only.\n\nPriority: system safety instructions; explicit patient boundaries and criticism; the current direct request; grounded accuracy; natural brevity. A lower priority rule cannot justify PASS on a higher priority failure.\n\nDefault is PASS. REWRITE only for a concrete failure you can name: the candidate misses a direct request, repeats a rejected direction, continues an interpretation after criticism, invents facts, motives or emotions, gives unwanted tasks, or sounds long, formulaic or clinical. A rewrite must be clearly better than the candidate; if you cannot name the failure, PASS. Preserve valid specific material. Prefer one or two short Hebrew sentences; extend only for a direct request or safety need.\n\nWhat counts as a direct request: the CURRENT patient message explicitly asks the companion a question, or explicitly asks for something (an answer, an explanation, a suggestion, a question). A statement of feeling, \"לא יודע\", a wish, agreement, or a boundary is NOT a direct request. Never use MISSES_DIRECT_REQUEST unless such an explicit request exists in the current message and the candidate does not answer it.\n\nQuestions in rewrites: a rewrite never adds a question the candidate did not contain, unless the current message is a direct request for a question. Never add a question about feelings, about what might help, or about how something feels. A rewrite may end without a question. Do not rewrite a candidate only because it contains one focused question grounded in the patient's own words. Such a question is valid specific material: keep it word for word in any rewrite. A rewrite never adds advice or a suggestion the patient did not request.\n\nAt the start of acquaintance, allow ordinary conversation and match the depth the patient invites. Do not convert every statement into a formulation, reassurance, list of choices, or probing question. If the patient says they do not know, the response contains no question. After criticism, acknowledge the concrete error at most once and change the response. Do not repeat \"אתה צודק\", an apology, or a repair line on later turns. If the candidate opens with \"אתה צודק\" or \"לא עניתי\" while no direct request was actually missed, remove that line. Respond to the latest patient message, not an earlier complaint. After criticism of over-explaining, do not add a new explanation of the patient's experience.\n\nInterpret a refusal by the rejected action or direction, not by every noun in it. Acknowledging a boundary is allowed; suggesting the same action in a softer form is not. When the patient limits a suggestion, do not restate the suggestion in any form in that turn; respond to what they feel instead. The patient may reopen it. Do not invent history, diagnosis, intervention or reassurance. REWRITE with REPEATS_REJECTED_IDEA when the candidate reassures that there is no proof, that it cannot be determined, or that it does not make something a fact, after the patient said such reassurance does not help.\n\nPrecision: REWRITE with UNSUPPORTED_INFERENCE when the candidate names an emotion the patient did not name, or raises a detail that appears only in the background and never in the patient's messages in this conversation; use the patient's own words instead. A detail the patient mentioned in this conversation, in any wording, is grounded. REWRITE with REDUNDANT_SUMMARY when the candidate reuses a metaphor or phrase the companion already used in this conversation. Use TOO_LONG only when the candidate has more than 35 words by count. Comforting generalizations count as formulaic.\n\nDo not diagnose or perform deep therapy. If the current turn signals acute distress, self-harm, suicide, harm to others or immediate danger, follow the system escalation instructions; do not invent contacts or infer current safety from background. Preserve Hebrew, correct gender, pronoun referents and continuity.\n\nFinal check before returning REWRITE: if final_response contains a question the candidate did not contain, delete that question. If the result is not clearly better than the candidate, return PASS instead.\n\nReturn one JSON object with exactly three fields: action, final_response, reason_codes. action is either PASS or REWRITE. On PASS, final_response must be identical to the candidate and reason_codes must be an empty array. On REWRITE, final_response is the replacement and reason_codes contains the most relevant one or two of: REPEATS_REJECTED_IDEA, VIOLATES_USER_CONSTRAINT, REDUNDANT_SUMMARY, NO_FORWARD_PROGRESS, UNSUPPORTED_INFERENCE, OVER_ANALYSIS, OVERLY_TASK_ORIENTED, TOO_LONG, CONTINUITY_ERROR, MISSES_DIRECT_REQUEST, TONE_MISMATCH, OTHER. No text outside JSON.",
};

const SB_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json; charset=utf-8", Accept: "application/json" });

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    const simSecret = Deno.env.get("DISPATCH_SECRET");
    if (!apiKey || !simSecret || !SB_URL || !SB_KEY) return json({ ok: false, error: "server_configuration_missing" }, 500);
    if (!constantTimeEqual(request.headers.get("x-sim-secret") ?? "", simSecret)) return json({ ok: false, error: "unauthorized" }, 401);

    const body = await request.json();
    const patientId = String(body?.patient_id ?? "").trim();
    const sessionId = String(body?.session_id ?? "").trim();
    const transcript: { q: string; a: string }[] = Array.isArray(body?.transcript) ? body.transcript : [];
    const rulesKey = String(body?.patient_rules_key ?? "nlp_sim_patient_rules").trim();
    if (!patientId || !sessionId) return json({ ok: false, error: "missing_patient_or_session" }, 400);

    const ctx = await rpc("get_last_users_thread_v2", { p_phone: patientId });
    const row = Array.isArray(ctx) && ctx.length === 1 ? ctx[0] : null;
    if (!row) return json({ ok: false, error: "patient_not_found" }, 400);
    if (String(row.therapy_track ?? "").trim() !== "CLINIC") return json({ ok: false, error: "not_clinic_patient" }, 400);
    const patientName = typeof row.name === "string" ? row.name.trim() : "";
    const patientBio = typeof row.user_text === "string" ? row.user_text.trim() : "";
    const patientGender = row.gender === "M" || row.gender === "F" ? row.gender : "";

    // 1. Simulated patient message (same framing as tools/sim_conversation.py).
    const rules = await fetchPromptByKey(rulesKey);
    const patientInput = transcript.length === 0
      ? "This is the opening message of a new conversation. Write the first thing the patient says today."
      : transcript.map((t, i) => `Round ${i + 1}\nPatient: ${t.q}\nTherapist: ${t.a}\n`).join("\n") +
        "\nWrite the next patient message, replying to the last therapist response.";
    const question = extractResponseText(await postOpenAI(apiKey, {
      model: Deno.env.get("SIM_PATIENT_MODEL") || DEFAULT_MODEL, store: false,
      instructions: rules + "\n\nPatient profile:\n" + patientBio, input: patientInput,
      temperature: 0.9, max_output_tokens: 300,
    })).trim();
    if (!question) return json({ ok: false, error: "empty_patient_message" }, 502);

    // 2. Therapist path - CLINIC branch of v64.
    const additions = str(body?.therapist_additions);
    const therapistPrompt = str(body?.therapist_prompt) ||
      ((await fetchPromptByKey("clinic_therapist")) + (additions ? "\n\n" + additions : ""));
    const prePatientPrompt = str(body?.pre_patient_prompt) || await fetchPromptByKey("clinic_pre_patient");
    const preset = str(body?.corrector_preset);
    const correctorPrompt = str(body?.corrector_prompt) || (preset && CORRECTOR_PRESETS[preset]) || await fetchPromptByKey("clinic_corrector");
    const excludeMoves: string[] = Array.isArray(body?.exclude_moves) ? body.exclude_moves.filter((m: unknown) => typeof m === "string") : [];

    const tz = await rpc("get_current_conversation_tzvira_v2", { p_phone: patientId });
    const tzvira = typeof tz?.tzvira === "string" ? tz.tzvira : "";
    const sm = await rpc("get_summarized_linked_talk_v2", { p_phone: patientId });
    const summary = typeof sm?.summarized_linked_talk === "string" ? sm.summarized_linked_talk : "";
    const response20 = transcript.length > 0 ? transcript[transcript.length - 1].a : "";

    const moveHistory = (await logRead("clinic_move_log", "move_type", sessionId)).filter((v) => typeof v === "string") as string[];
    const requiredMove = decideRequiredMove(moveHistory, excludeMoves);
    const fragmentWarning = decideWindow((await logRead("clinic_fragment_log", "fragmented", sessionId)) as boolean[], CLINIC_FRAGMENT_WINDOW_TURNS, CLINIC_FRAGMENT_WARNING_THRESHOLD);
    const ackHist = (await logRead("clinic_ack_log", "acknowledged", sessionId)) as boolean[];
    const optionsWarning = ackHist.length > 0 && ackHist[ackHist.length - 1] === true;
    const blockedWarning = decideWindow((await logRead("clinic_blocked_log", "blocked", sessionId)) as boolean[], CLINIC_BLOCKED_WINDOW_TURNS, CLINIC_BLOCKED_WARNING_THRESHOLD);
    const responseHistory = (await logRead("clinic_response_log", "response_text", sessionId)) as string[];
    const repeatWarning = decideRepeatWarning(responseHistory);
    const questionDue = decideQuestionDue(responseHistory, question);

    const instructions = buildTherapistInstructions({ therapistPrompt, prePatientPrompt, patient20: patientBio, patientName, patientGender, requiredMove, fragmentWarning, repeatWarning, blockedWarning, optionsWarning, questionDue });
    const candidateInput = ["summarized20:", summary, "", "tzvira:", tzvira, "", "response20:", response20, "", "question20:", question].join("\n");

    const raw = extractResponseText(await postOpenAI(apiKey, {
      model: Deno.env.get("THERAPIST_MODEL") || DEFAULT_MODEL, store: false, instructions, input: candidateInput,
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS, temperature: 0.7,
      metadata: { patient_id: patientId, session_id: sessionId },
    })).trim();
    if (!raw) return json({ ok: false, error: "candidate_generation_failed" }, 502);
    const parsed = parseClinicCandidate(raw);
    const candidate = parsed.response;

    let decision = "FALLBACK";
    let finalText = candidate;
    let reasons: string[] = [];
    try {
      const c = await runCorrector(apiKey, correctorPrompt, tzvira, summary, response20, question, candidate);
      decision = c.action;
      reasons = c.reason_codes;
      if (c.action === "REWRITE") {
        if (c.final_response.trim().length === 0) throw new Error("empty_rewrite");
        finalText = c.final_response.trim();
      }
    } catch (_e) {
      decision = "FALLBACK"; finalText = candidate; reasons = [];
    }

    const turn = moveHistory.length + 1;
    await logWrite("clinic_move_log", { session_id: sessionId, turn_number: turn, move_type: CLINIC_MOVE_TYPE_SET.has(parsed.move) ? parsed.move : "other" });
    await logWrite("clinic_fragment_log", { session_id: sessionId, turn_number: turn, fragmented: decision !== "FALLBACK" && reasons.includes("OVER_ANALYSIS") });
    await logWrite("clinic_blocked_log", { session_id: sessionId, turn_number: turn, blocked: decision !== "FALLBACK" && reasons.includes("MISSES_DIRECT_REQUEST") });
    await logWrite("clinic_ack_log", { session_id: sessionId, turn_number: turn, acknowledged: detectAcknowledgment(finalText) });
    await logWrite("clinic_response_log", { session_id: sessionId, turn_number: turn, response_text: finalText });

    return json({
      ok: true, turn, question, candidate, final: finalText, decision, reason_codes: reasons,
      required_move: requiredMove, move: parsed.move, json_ok: parsed.jsonOk,
      warnings: { fragment: fragmentWarning, repeat: repeatWarning, blocked: blockedWarning, options: optionsWarning, question_due: questionDue },
      prompt_source: { therapist: str(body?.therapist_prompt) ? "request" : (additions ? "table+additions" : "table"), pre_patient: str(body?.pre_patient_prompt) ? "request" : "table", corrector: str(body?.corrector_prompt) ? "request" : (preset && CORRECTOR_PRESETS[preset] ? "preset:" + preset : "table") },
      summary_len: summary.length, tzvira_len: tzvira.length,
    }, 200);
  } catch (error) {
    return json({ ok: false, error: "unexpected_error", detail: String(error).slice(0, 300) }, 500);
  }
});

function str(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

async function rpc(name: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: sbHeaders(), body: JSON.stringify(params) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`rpc_failed:${name}:${res.status}`); }
  return await res.json();
}

async function fetchPromptByKey(key: string): Promise<string> {
  const res = await fetch(`${SB_URL}/rest/v1/prompt_information_v2?select=user_text&prompt_key=eq.${encodeURIComponent(key)}&limit=2`, { headers: sbHeaders() });
  if (!res.ok) { await res.body?.cancel(); throw new Error("prompt_fetch_failed:" + key); }
  const data = await res.json();
  if (!Array.isArray(data) || data.length !== 1 || typeof data[0].user_text !== "string" || !data[0].user_text.trim()) throw new Error("missing_prompt:" + key);
  return data[0].user_text.trim();
}

async function logRead(table: string, col: string, session: string): Promise<unknown[]> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${col}&session_id=eq.${encodeURIComponent(session)}&order=turn_number.asc`, { headers: sbHeaders() });
    if (!res.ok) { await res.body?.cancel(); return []; }
    const data = await res.json();
    return Array.isArray(data) ? data.map((r) => r?.[col]) : [];
  } catch (_e) { return []; }
}

async function logWrite(table: string, row: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...sbHeaders(), Prefer: "return=minimal" }, body: JSON.stringify(row) });
    await res.body?.cancel();
  } catch (_e) { /* swallowed, as in v64 */ }
}

function decideWindow(flags: boolean[], window: number, threshold: number): boolean {
  return flags.slice(-window).filter((f) => f === true).length >= threshold;
}

function normalizeForRepeatCheck(text: string): string {
  return text.trim().replace(/[\s\u200f\u200e]+/g, " ").replace(/[.,!?"'\u05f3\u05f4]/g, "").toLowerCase();
}
function extractSignificantSentences(text: string): string[] {
  return text.split(/[.!?]+/).map(normalizeForRepeatCheck).filter((s) => s.length >= MIN_SENTENCE_LENGTH_FOR_REPEAT_CHECK);
}
function decideRepeatWarning(history: string[]): boolean {
  const w = history.filter((t) => typeof t === "string").slice(-CLINIC_REPEAT_CHECK_WINDOW);
  if (w.length < 2) return false;
  const sets = w.map(extractSignificantSentences);
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) for (const s of sets[i]) if (sets[j].includes(s)) return true;
  return false;
}
// SIM v2: a question is due when the last N accepted responses contain no question mark,
// unless the current patient message says "לא יודע".
function decideQuestionDue(history: string[], currentMessage: string): boolean {
  const w = history.filter((t) => typeof t === "string");
  if (w.length < CLINIC_QUESTION_DUE_WINDOW) return false;
  // SIM v4: exempt only a genuine "I don't know" reply - message opens with it, or is short and contains it.
  const msg = currentMessage.trim();
  const words = msg.split(/\s+/).filter(Boolean).length;
  const saysDontKnow = msg.includes("לא יודע") || msg.includes("לא יודעת");
  if (msg.startsWith("לא יודע") || (saysDontKnow && words <= 8)) return false;
  return w.slice(-CLINIC_QUESTION_DUE_WINDOW).every((t) => !t.includes("?"));
}
function detectAcknowledgment(text: string): boolean {
  return CLINIC_ACK_TRIGGER_PHRASES.some((p) => text.includes(p));
}
function decideRequiredMove(h: string[], exclude: string[] = []): string {
  if (h.length === 0) return "simple_presence";
  const last = h.lastIndexOf("echo");
  const since = last === -1 ? Number.POSITIVE_INFINITY : h.length - 1 - last;
  const base = since < CLINIC_ECHO_COOLDOWN_TURNS ? CLINIC_MOVES_WITHOUT_ECHO : CLINIC_MOVES_WITH_ECHO;
  const filtered = base.filter((m) => !exclude.includes(m));
  const pool = filtered.length > 0 ? filtered : [...base];
  return pool[Math.floor(Math.random() * pool.length)];
}
function parseClinicCandidate(rawText: string): { move: string; response: string; jsonOk: boolean } {
  const fb = { move: "other", response: rawText, jsonOk: false };
  let p: unknown;
  try { p = JSON.parse(rawText.trim()); } catch (_e) { return fb; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return fb;
  const r = p as Record<string, unknown>;
  const resp = typeof r.response === "string" ? r.response.trim() : "";
  if (!resp) return fb;
  const mv = typeof r.move === "string" ? r.move.trim() : "";
  return { move: CLINIC_MOVE_TYPE_SET.has(mv) ? mv : "other", response: resp, jsonOk: true };
}

// Identical to v64 buildTherapistInstructions, CLINIC branch (requiredMove is always set here).
function buildTherapistInstructions(a: {
  therapistPrompt: string; prePatientPrompt: string; patient20: string; patientName: string; patientGender: string;
  requiredMove: string; fragmentWarning: boolean; repeatWarning: boolean; blockedWarning: boolean; optionsWarning: boolean; questionDue: boolean;
}): string {
  const movePrefix: string[] = [`מהלך התשובה הזו: ${a.requiredMove}`];
  if (a.questionDue) movePrefix.push(CLINIC_QUESTION_DUE_LINE);
  if (a.fragmentWarning) movePrefix.push(CLINIC_FRAGMENT_WARNING_LINE);
  if (a.repeatWarning) movePrefix.push(CLINIC_REPEAT_WARNING_LINE);
  if (a.blockedWarning) movePrefix.push(CLINIC_BLOCKED_WARNING_LINE);
  if (a.optionsWarning) movePrefix.push(CLINIC_OPTIONS_WARNING_LINE);
  movePrefix.push("");
  const formatRule = "- Return one valid JSON object only, with the keys move and response. No Markdown and no text outside JSON.";
  const name = a.patientName;
  const g = a.patientGender.toUpperCase();
  const genderWord = g === "F" ? "female" : g === "M" ? "male" : "";
  let nameRule: string;
  if (genderWord) {
    const withName = name.length > 0 ? ` The patient's name is ${name}.` : "";
    nameRule = `- The patient's grammatical gender is ${genderWord}. This is recorded in the system and is authoritative - address the patient in that gender throughout, and do not infer gender from the name or from anything they write.${withName} Do not state the name back to the patient unless they use it themselves.`;
  } else {
    nameRule = name.length > 0
      ? `- Patient's name: ${name}. Infer grammatical gender from this name and address the patient consistently in that gender throughout. Do not state the name back to the patient unless they used it themselves.`
      : "- Patient's name is unknown for this request. Infer gender only from what the patient writes, and default to a gender-neutral phrasing where Hebrew allows it until a clear signal appears.";
  }
  return [
    ...movePrefix, a.therapistPrompt, a.prePatientPrompt, a.patient20, "",
    "Mandatory operational rules for this runtime request:",
    "- Reply in Hebrew only.", nameRule,
    "- Maintain gender consistency with the patient and prior context.", formatRule,
    "- Ask at most one question.",
    "- Do not repeat a proposal that was already rejected or did not fit.",
    "- Do not repeat the same empathy phrasing or emotional reflection from the previous therapist response.",
    "- Offer one practical suggestion only when the patient explicitly requests practical help.",
    "- Do not end a response with a generic closing question such as \"how can I help/support you now\". If you have no specific question that follows directly from what the patient just said, do not ask a closing question at all.",
    "- Safety rules override all other instructions.",
  ].join("\n");
}

async function runCorrector(apiKey: string, instr: string, history: string, summary: string, prev: string, current: string, candidate: string): Promise<CorrectorResult> {
  const payload = {
    experiment: "runtime_corrected_response_edge_function",
    no_look_ahead_contract: "runtime payload contains accepted prior history (current conversation only), a separate cross-session summary (prior conversations, may be empty), previous accepted therapist response, current patient message, and current candidate response only",
    response_format_instruction: "Return one valid JSON object only with action, final_response, and reason_codes. No Markdown and no text outside JSON.",
    accepted_prior_history: history, cross_session_summary: summary, previous_accepted_therapist_response: prev,
    current_patient_message: current, candidate_response: candidate,
  };
  const response = await postOpenAI(apiKey, {
    model: Deno.env.get("CORRECTOR_MODEL") || DEFAULT_MODEL, store: false, instructions: instr,
    input: JSON.stringify(payload), temperature: 0.1, max_output_tokens: 700,
    text: { format: { type: "json_schema", name: "runtime_corrector_response", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["action", "final_response", "reason_codes"],
      properties: { action: { type: "string", enum: ["PASS", "REWRITE"] }, final_response: { type: "string" },
        reason_codes: { type: "array", items: { type: "string", enum: REASON_CODES } } } } } },
  });
  const clean = extractResponseText(response).trim();
  if (!clean.startsWith("{") || !clean.endsWith("}")) throw new Error("corrector_not_json_object");
  const r = JSON.parse(clean) as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== 3 || !["action", "final_response", "reason_codes"].every((k) => keys.includes(k))) throw new Error("schema");
  if (r.action !== "PASS" && r.action !== "REWRITE") throw new Error("action");
  if (typeof r.final_response !== "string" || !Array.isArray(r.reason_codes)) throw new Error("fields");
  const codes = r.reason_codes.map((c) => { if (typeof c !== "string" || !REASON_CODE_SET.has(c)) throw new Error("code"); return c; });
  if (r.action === "PASS" && r.final_response !== candidate) throw new Error("pass_mismatch");
  return { action: r.action, final_response: r.final_response, reason_codes: codes };
}

async function postOpenAI(apiKey: string, body: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_RESPONSES_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`openai_http_${res.status}`); }
    return await res.json();
  } finally { clearTimeout(t); }
}

function extractResponseText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const rec = response as Record<string, unknown>;
  if (typeof rec.output_text === "string") return rec.output_text;
  if (!Array.isArray(rec.output)) return "";
  const chunks: string[] = [];
  for (const item of rec.output) {
    const content = (item as Record<string, unknown>)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (typeof p?.text === "string") chunks.push(p.text);
      else if (typeof p?.output_text === "string") chunks.push(p.output_text as string);
    }
  }
  return chunks.join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  const e = new TextEncoder(); const x = e.encode(a); const y = e.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
