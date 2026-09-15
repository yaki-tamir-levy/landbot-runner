type RequestPayload = {
  prompt20?: string;
  pre_patient20?: string;
  patient20?: string;
  summarized20?: string;
  tzvira?: string;
  response20?: string;
  question20: string;
  patient_id: string;
  session_id: string;
  corrector_prompt_key?: string;
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

const TRACK_PROMPT_KEYS: Record<string, { therapist: string; prePatient: string; corrector: string }> = {
  CLINIC: { therapist: "clinic_therapist", prePatient: "clinic_pre_patient", corrector: "clinic_corrector" },
  NLP_CBT: { therapist: "nlp_therapist", prePatient: "nlp_pre_patient", corrector: "corrector" },
};

const DEFAULT_THERAPY_TRACK = "NLP_CBT";

// Course mode is selected by the CONVERSATION, not by therapy_track: a
// patient can be both in therapy and on the course. The signal is a lesson
// attached to this conversation, and a lesson can only attach to a session
// whose source is 'D' - enforced in the database, not here.
const COURSE_PROMPT_KEY = "course_guide";

// The therapy budget is deliberately tight - short replies are a clinical
// rule on that path. Teaching is different: "summarise what I have learned
// so far" spans many lessons and was being cut off mid-sentence. This raise
// applies to the course path only; therapy keeps its 500.
const COURSE_MAX_OUTPUT_TOKENS = 1500;
const DEFAULT_MAX_OUTPUT_TOKENS = 500;

const CLINIC_TRACK = "CLINIC";

const CLINIC_MOVE_TYPES = [
  "echo",
  "simple_presence",
  "normalization",
  "widening",
  "deepening",
  "other",
] as const;

const CLINIC_MOVE_TYPE_SET = new Set<string>(CLINIC_MOVE_TYPES);

const CLINIC_MOVES_WITHOUT_ECHO = [
  "simple_presence",
  "normalization",
  "widening",
  "deepening",
] as const;

const CLINIC_MOVES_WITH_ECHO = [
  "echo",
  "simple_presence",
  "normalization",
  "widening",
  "deepening",
] as const;

const CLINIC_ECHO_COOLDOWN_TURNS = 3;

// CORS support - added so this function can be called directly from a
// browser (the new no-Landbot מיתר client), not only server-to-server from
// Landbot as before. Purely additive: does not change any POST behavior.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-landbot-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Fragmentation warning window: how many recent turns are inspected, and how
// many of them must be fragmented before the reinforced instruction is injected.
const CLINIC_FRAGMENT_WINDOW_TURNS = 3;
const CLINIC_FRAGMENT_WARNING_THRESHOLD = 2;

const CLINIC_FRAGMENT_WARNING_LINE =
  "אזהרה מוגברת: התשובות האחרונות שלך פיצלו לשני רכיבים יותר מדי. התשובה הזו חייבת להיות משפט יחיד, בלי שום חיבור מנוגד או משלים - לא \"לא X אלא Y\", לא \"גם...וגם\", לא \"בין...לבין\".";

// Self-repetition: how many of the most recent delivered responses are
// compared for a shared, substantial sentence. A window of 3 also catches a
// repeat with one different turn in between, not only immediately adjacent
// repeats. Comparison is at the SENTENCE level, not the full-response level:
// the real failure observed in production was a shared trailing sentence
// ("how can I help you now?") inside otherwise-different responses, which a
// full-string comparison would miss entirely.
const CLINIC_REPEAT_CHECK_WINDOW = 3;
const MIN_SENTENCE_LENGTH_FOR_REPEAT_CHECK = 12;

const CLINIC_REPEAT_WARNING_LINE =
  "אזהרה מוגברת: אחד המשפטים בתשובותיך הקודמות בשיחה הזו כבר הופיע כמעט מילה במילה. אסור לחזור על אותו משפט או על ניסוח קרוב אליו, גם לא כחלק מתשובה שונה בשאר תוכנה. אם המטופל ביקש עזרה בפועל ולא קיבל - ענה עכשיו בפועל (הצעה קטנה אחת) או הסבר בכנות שלא ענית קודם. אל תשקף, אל תשאל שאלה נגדית, ואל תשתמש שוב באותה שאלה שכבר שאלת.";

// Blocked-request detection: unlike the repeat check above (verbatim text
// comparison), this reads a direct signal already produced by the corrector
// itself (MISSES_DIRECT_REQUEST) - the corrector already judged, on a prior
// turn, that a direct request went unanswered. This is a mechanical fact
// already established, not something inferred fresh from context - closer in
// spirit to a command-word trigger than to pattern inference.
const CLINIC_BLOCKED_WINDOW_TURNS = 3;
const CLINIC_BLOCKED_WARNING_THRESHOLD = 2;

const CLINIC_BLOCKED_WARNING_LINE =
  "אזהרה קריטית: המתקן כבר קבע פעמיים שבקשה ישירה של המטופל לא נענתה. התשובה הזו חייבת להכיל, בשני משפטים רצופים בלבד ובסדר הזה: משפט ראשון - הכרה מפורשת שלא ענית קודם, במילים כמו \"אתה צודק, לא עניתי לך\". משפט שני, מיד אחריו, באותה תשובה - תשובה קונקרטית בפועל (הצעה קטנה אחת), או הסבר גבול כן למה אינך יכול לענות ישירות כרגע. אסור לעצור אחרי המשפט הראשון בלבד. אסור לשאול שאלה. אסור לשקף רגש. דוגמה למבנה שלם: \"אתה צודק, לא עניתי לך. דבר אחד קונקרטי שיכול לעזור עכשיו: [X].\"";

// Acknowledgment-without-followup detection: the previous mechanisms track
// multi-turn patterns; this one is single-turn lookback by design. In every
// live test run today, an acknowledgment phrase ("אתה צודק, לא עניתי")
// appeared and was immediately followed by a plain reflection on the very
// next turn, with no concrete offer. The check here is deliberately narrow -
// presence of a fixed phrase in the delivered text - not sentiment analysis.
const CLINIC_ACK_TRIGGER_PHRASES = [
  "אתה צודק",
  "את צודקת",
  "לא עניתי",
  "לא ענית",
  "לא נתתי מענה",
  "לא נתתי לך מענה",
] as const;

const CLINIC_OPTIONS_WARNING_LINE =
  "אזהרה קריטית: בתשובה הקודמת שלך הודית שלא ענית ישירות למטופל. התשובה הזו חייבת להציע 2-4 אפשרויות קצרות וברורות לבחירה, הנובעות ממה שהמטופל כבר אמר בשיחה - לא עוד שיקוף רגש, ולא עוד שאלה פתוחה יחידה. דוגמה למבנה: \"מה היית רוצה עכשיו - X, או Y?\" הצגת כמה אפשרויות למטופל אינה הפרת איסור הפיצול - האיסור ההוא חל על ניתוח שלך את המטופל, לא על הצעת בחירה מפורשת.";

/**
 * Normalizes text for repetition comparison: trims, collapses whitespace,
 * strips punctuation that carries no meaning for this comparison. Two
 * responses differing only in punctuation or spacing still count as the
 * same text.
 */
function normalizeForRepeatCheck(text: string): string {
  return text
    .trim()
    .replace(/[\s\u200f\u200e]+/g, " ")
    .replace(/[.,!?"'\u05f3\u05f4]/g, "")
    .toLowerCase();
}

/**
 * Splits a response into normalized sentences, discarding short ones (short
 * common phrases like "כן." would otherwise trigger false positives).
 */
function extractSignificantSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map(normalizeForRepeatCheck)
    .filter((s) => s.length >= MIN_SENTENCE_LENGTH_FOR_REPEAT_CHECK);
}

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
    if (request.method === "OPTIONS") {
      return new Response("ok", { headers: CORS_HEADERS });
    }
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
    const serverTzvira = await fetchCurrentConversationTzvira(
      correlationId,
      payload.value.patient_id,
    );
    const effectiveTzvira = serverTzvira?.tzvira ?? "";
    const effectiveSummary = await fetchAccumulatedSummary(
      correlationId,
      payload.value.patient_id,
    );

    const patientContext = await fetchPatientContext(correlationId, payload.value.patient_id);
    const keys = TRACK_PROMPT_KEYS[patientContext.therapyTrack]
      ?? TRACK_PROMPT_KEYS[DEFAULT_THERAPY_TRACK];

    const courseMaterial = await fetchCourseMaterial(
      correlationId,
      payload.value.session_id,
    );
    const isCourse = courseMaterial !== null;

    // A course conversation never enters the clinic machinery, even when the
    // patient's own track is CLINIC. Without this guard a CLINIC patient
    // taking the course would get a required move, the reinforced warnings
    // and a JSON output contract - none of which apply to teaching.
    const isClinicTrack = !isCourse && patientContext.therapyTrack === CLINIC_TRACK;
    let clinicMoveHistory: string[] = [];
    let clinicRequiredMove = "";
    let clinicFragmentWarning = false;
    let clinicRepeatWarning = false;
    let clinicBlockedWarning = false;
    let clinicOptionsWarning = false;
    if (isClinicTrack) {
      clinicMoveHistory = await fetchClinicMoveHistory(
        correlationId,
        payload.value.session_id,
      );
      clinicRequiredMove = decideRequiredMove(clinicMoveHistory);
      console.log(JSON.stringify({
        event: "clinic_move_decided",
        correlation_id: correlationId,
        history_length: clinicMoveHistory.length,
        required_move: clinicRequiredMove,
      }));

      const clinicFragmentHistory = await fetchClinicFragmentHistory(
        correlationId,
        payload.value.session_id,
      );
      clinicFragmentWarning = decideFragmentWarning(clinicFragmentHistory);
      console.log(JSON.stringify({
        event: "clinic_fragment_warning_decided",
        correlation_id: correlationId,
        history_length: clinicFragmentHistory.length,
        fragment_warning: clinicFragmentWarning,
      }));

      const clinicAckHistory = await fetchClinicAckHistory(
        correlationId,
        payload.value.session_id,
      );
      clinicOptionsWarning = decideOptionsWarning(clinicAckHistory);
      console.log(JSON.stringify({
        event: "clinic_options_warning_decided",
        correlation_id: correlationId,
        history_length: clinicAckHistory.length,
        options_warning: clinicOptionsWarning,
      }));

      const clinicBlockedHistory = await fetchClinicBlockedHistory(
        correlationId,
        payload.value.session_id,
      );
      clinicBlockedWarning = decideBlockedWarning(clinicBlockedHistory);
      console.log(JSON.stringify({
        event: "clinic_blocked_warning_decided",
        correlation_id: correlationId,
        history_length: clinicBlockedHistory.length,
        blocked_warning: clinicBlockedWarning,
      }));

      const clinicResponseHistory = await fetchClinicResponseHistory(
        correlationId,
        payload.value.session_id,
      );
      clinicRepeatWarning = decideRepeatWarning(clinicResponseHistory);
      console.log(JSON.stringify({
        event: "clinic_repeat_warning_decided",
        correlation_id: correlationId,
        history_length: clinicResponseHistory.length,
        repeat_warning: clinicRepeatWarning,
      }));
    }

    let therapistPrompt: string;
    let prePatientPrompt = "";
    let correctorPrompt = "";
    try {
      if (isCourse) {
        // Course mode fetches one prompt only. No corrector and no
        // pre-patient layer on this path, so neither is requested.
        therapistPrompt = await fetchPromptByKey(correlationId, COURSE_PROMPT_KEY);
      } else {
        therapistPrompt = await fetchPromptByKey(correlationId, keys.therapist);
        prePatientPrompt = await fetchPromptByKey(correlationId, keys.prePatient);
        correctorPrompt = await fetchPromptByKey(correlationId, keys.corrector);
      }
    } catch (error) {
      const typedError = toError(error);
      if (
        typedError.message === "runtime_corrector_prompt_fetch_failed" ||
        typedError.message === "missing_runtime_corrector_prompt"
      ) {
        httpStatus = 502;
        return jsonResponse({ ok: false, error: typedError.message }, httpStatus);
      }
      throw error;
    }

    const therapistInstructions = buildTherapistInstructions({
      therapistPrompt,
      prePatientPrompt,
      patient20: patientContext.patientBio,
      patientName: patientContext.patientName,
      requiredMove: clinicRequiredMove,
      fragmentWarning: clinicFragmentWarning,
      repeatWarning: clinicRepeatWarning,
      blockedWarning: clinicBlockedWarning,
      optionsWarning: clinicOptionsWarning,
    });
    const candidateInput = buildCandidateInput({
      ...payload.value,
      summarized20: effectiveSummary,
      tzvira: effectiveTzvira,
    }, courseMaterial);

    diagnosticTherapistModel = therapistModel;
    diagnosticTherapistInstructions = therapistInstructions;
    diagnosticCandidateInput = candidateInput;
    diagnosticPayload = {
      prompt20: payload.value.prompt20 ?? "",
      pre_patient20: payload.value.pre_patient20 ?? "",
      patient20: payload.value.patient20 ?? "",
      summarized20: payload.value.summarized20 ?? "",
      tzvira: payload.value.tzvira ?? "",
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
        prompt20: payload.value.prompt20 ?? "",
        pre_patient20: payload.value.pre_patient20 ?? "",
        patient20: payload.value.patient20 ?? "",
        summarized20: payload.value.summarized20 ?? "",
        tzvira: payload.value.tzvira ?? "",
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
        maxOutputTokens: isCourse
          ? COURSE_MAX_OUTPUT_TOKENS
          : DEFAULT_MAX_OUTPUT_TOKENS,
      });
    } finally {
      candidateElapsedMs = Date.now() - candidateStartedAt;
    }

    if (!candidateText) {
      httpStatus = 502;
      return jsonResponse({ ok: false, error: "candidate_generation_failed" }, httpStatus);
    }

    // CLINIC only. candidateText is reassigned to the extracted response so that
    // every downstream consumer - corrector, logs, HTTP body - sees the patient
    // facing text and never the raw JSON envelope.
    let clinicMove = "other";
    if (isClinicTrack) {
      const parsedCandidate = parseClinicCandidate(correlationId, candidateText);
      clinicMove = parsedCandidate.move;
      candidateText = parsedCandidate.response;
    }

    candidateSuccess = true;

    // COURSE only. No corrector on this path by decision: the course bot
    // teaches, and the corrector's rules are written for therapeutic replies.
    // The candidate is delivered as produced. Logged with decision NONE so
    // course turns stay visible for review alongside therapy turns.
    if (isCourse) {
      await appendTestLog({
        ts: new Date().toISOString(),
        correlation_id: correlationId,
        conversation_id: payload.value.session_id,
        phone: payload.value.patient_id,
        question: payload.value.question20,
        candidate_answer: candidateText,
        corrected_answer: candidateText,
        corrector_decision: "NONE",
        reason_codes: [],
      });
      return jsonResponse({
        ok: true,
        answer: candidateText,
        candidate_answer: candidateText,
        corrected_answer: candidateText,
        corrector_decision: "NONE",
        correction_action: "NONE",
        reason_codes: [],
        fallback_used: false,
      }, 200);
    }

    try {
      const correctorStartedAt = Date.now();
      let correctorResult: CorrectorResult;
      try {
        correctorResult = await runCorrector({
          apiKey: openAiApiKey,
          model: correctorModel,
          correctorInstructions: correctorPrompt,
          acceptedPriorHistory: effectiveTzvira,
          crossSessionSummary: effectiveSummary,
          previousAcceptedTherapistResponse: payload.value.response20 ?? "",
          currentPatientMessage: payload.value.question20,
          candidateResponse: candidateText,
        });
      } finally {
        correctorElapsedMs = Date.now() - correctorStartedAt;
      }

      if (correctorResult.action === "PASS") {
        correctorDecision = "PASS";
        await appendTestLog({
          ts: new Date().toISOString(),
          correlation_id: correlationId,
          conversation_id: payload.value.session_id,
          phone: payload.value.patient_id,
          question: payload.value.question20,
          candidate_answer: candidateText,
          corrected_answer: candidateText,
          corrector_decision: "PASS",
          reason_codes: [],
        });
        if (isClinicTrack) {
          await recordClinicMove(
            correlationId,
            payload.value.session_id,
            clinicMoveHistory.length + 1,
            clinicMove,
          );
          await recordClinicFragment(
            correlationId,
            payload.value.session_id,
            clinicMoveHistory.length + 1,
            correctorResult?.reason_codes?.includes("OVER_ANALYSIS") ?? false,
          );
          await recordClinicBlocked(
            correlationId,
            payload.value.session_id,
            clinicMoveHistory.length + 1,
            correctorResult?.reason_codes?.includes("MISSES_DIRECT_REQUEST") ?? false,
          );
          await recordClinicAck(
            correlationId,
            payload.value.session_id,
            clinicMoveHistory.length + 1,
            detectAcknowledgment(candidateText),
          );
          await recordClinicResponse(
            correlationId,
            payload.value.session_id,
            clinicMoveHistory.length + 1,
            candidateText,
          );
        }
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
      await appendTestLog({
        ts: new Date().toISOString(),
        correlation_id: correlationId,
        conversation_id: payload.value.session_id,
        phone: payload.value.patient_id,
        question: payload.value.question20,
        candidate_answer: candidateText,
        corrected_answer: rewrite,
        corrector_decision: "REWRITE",
        reason_codes: correctorResult.reason_codes,
      });
      if (isClinicTrack) {
        await recordClinicMove(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          clinicMove,
        );
        await recordClinicFragment(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          correctorResult?.reason_codes?.includes("OVER_ANALYSIS") ?? false,
        );
        await recordClinicBlocked(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          correctorResult?.reason_codes?.includes("MISSES_DIRECT_REQUEST") ?? false,
        );
        await recordClinicAck(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          detectAcknowledgment(rewrite),
        );
        await recordClinicResponse(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          rewrite,
        );
      }
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
      await appendTestLog({
        ts: new Date().toISOString(),
        correlation_id: correlationId,
        conversation_id: payload.value.session_id,
        phone: payload.value.patient_id,
        question: payload.value.question20,
        candidate_answer: candidateText,
        corrected_answer: candidateText,
        corrector_decision: "FALLBACK",
        reason_codes: [],
      });
      if (isClinicTrack) {
        await recordClinicMove(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          clinicMove,
        );
        // The corrector produced no verdict on this path, so there is no
        // OVER_ANALYSIS signal to read. Absence of evidence is logged as false.
        await recordClinicFragment(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          false,
        );
        // Same reasoning as the fragment write above - no corrector verdict
        // exists on this path, so there is no MISSES_DIRECT_REQUEST signal.
        await recordClinicBlocked(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          false,
        );
        // Unlike the two writes above, this is a plain text check on
        // candidateText itself, independent of whether the corrector ran -
        // so it is not defaulted to false on this path.
        await recordClinicAck(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          detectAcknowledgment(candidateText),
        );
        await recordClinicResponse(
          correlationId,
          payload.value.session_id,
          clinicMoveHistory.length + 1,
          candidateText,
        );
      }
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

async function fetchCurrentConversationTzvira(
  correlationId: string,
  patientId: string,
): Promise<{ tzvira: string; rowCount: number } | null> {
  const phone = (patientId ?? "").trim();
  if (!phone) return null;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return null;
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/get_current_conversation_tzvira_v2`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_phone: phone }),
    });
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "tzvira_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return null;
    }
    const data = await res.json();
    const value = data?.tzvira;
    const rowCount = typeof data?.row_count === "number" ? data.row_count : 0;
    return { tzvira: typeof value === "string" ? value : "", rowCount };
  } catch (_e) {
    console.error(JSON.stringify({
      event: "tzvira_fetch_exception",
      correlation_id: correlationId,
    }));
    return null;
  }
}

function maskPhoneForUsersInformation(rawPhone: string): string {
  const digits = (rawPhone ?? "").replace(/[^0-9]/g, "");
  if (digits.length === 0) return "";
  if (digits.length <= 6) return digits;
  return `${digits.slice(0, 3)}***${digits.slice(-3)}`;
}

async function fetchPatientContext(
  correlationId: string,
  patientId: string,
): Promise<{ therapyTrack: string; patientBio: string; patientName: string }> {
  const fallback = { therapyTrack: DEFAULT_THERAPY_TRACK, patientBio: "", patientName: "" };
  const phone = maskPhoneForUsersInformation(patientId ?? "");
  if (!phone) return fallback;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return fallback;

    // Name, decrypted server-side. Uses the same RPC the identification flow
    // already relies on; service_role still has EXECUTE on it (only anon and
    // authenticated were revoked). A failure here is non-fatal - the name is
    // an enrichment, not a requirement, so track/bio resolution proceeds
    // regardless.
    let patientName = "";
    try {
      const nameRes = await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/get_last_users_thread_v2`,
        {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_phone: patientId }),
        },
      );
      if (nameRes.ok) {
        const nameData = await nameRes.json();
        const nameRow = Array.isArray(nameData) && nameData.length === 1
          ? (nameData[0] as Record<string, unknown>)
          : null;
        if (nameRow && typeof nameRow.name === "string") {
          patientName = nameRow.name.trim();
        }
      } else {
        await nameRes.body?.cancel();
      }
    } catch (_nameError) {
      console.error(JSON.stringify({
        event: "patient_name_fetch_exception",
        correlation_id: correlationId,
      }));
    }

    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/users_information_v2?select=therapy_track,user_text&phone=eq.${encodeURIComponent(phone)}&limit=2`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "patient_context_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return { ...fallback, patientName };
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      console.error(JSON.stringify({
        event: "patient_context_not_found",
        correlation_id: correlationId,
      }));
      return { ...fallback, patientName };
    }
    if (data.length > 1) {
      console.error(JSON.stringify({
        event: "patient_context_ambiguous",
        correlation_id: correlationId,
        row_count: data.length,
      }));
      return { ...fallback, patientName };
    }
    const row = data[0] as Record<string, unknown>;
    const rawTrack = typeof row.therapy_track === "string" ? row.therapy_track.trim() : "";
    const rawBio = typeof row.user_text === "string" ? row.user_text.trim() : "";
    const therapyTrack = rawTrack.length > 0 ? rawTrack : DEFAULT_THERAPY_TRACK;
    console.log(JSON.stringify({
      event: "therapy_track_resolved",
      correlation_id: correlationId,
      therapy_track: therapyTrack,
      patient_bio_length: rawBio.length,
      patient_name_present: patientName.length > 0,
    }));
    return { therapyTrack, patientBio: rawBio, patientName };
  } catch (_e) {
    console.error(JSON.stringify({
      event: "patient_context_fetch_exception",
      correlation_id: correlationId,
    }));
    return fallback;
  }
}

async function fetchCourseMaterial(
  correlationId: string,
  sessionId: string,
): Promise<{ lessonNumber: number; lessonTitle: string; material: string } | null> {
  const session = (sessionId ?? "").trim();
  if (!session) return null;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return null;
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/get_course_material_v2`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_conversation_id: session }),
    });
    if (!res.ok) {
      await res.body?.cancel();
      console.error(JSON.stringify({
        event: "course_material_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length !== 1) return null;
    const row = data[0] as Record<string, unknown>;
    const lessonNumber = typeof row.lesson_number === "number" ? row.lesson_number : 0;
    const lessonTitle = typeof row.lesson_title === "string" ? row.lesson_title : "";
    const material = typeof row.material === "string" ? row.material : "";
    if (lessonNumber <= 0 || material.trim().length === 0) return null;
    console.log(JSON.stringify({
      event: "course_material_resolved",
      correlation_id: correlationId,
      lesson_number: lessonNumber,
      material_length: material.length,
    }));
    return { lessonNumber, lessonTitle, material };
  } catch (_e) {
    console.error(JSON.stringify({
      event: "course_material_fetch_exception",
      correlation_id: correlationId,
    }));
    return null;
  }
}

async function fetchAccumulatedSummary(
  correlationId: string,
  patientId: string,
): Promise<string> {
  const phone = (patientId ?? "").trim();
  if (!phone) return "";
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return "";
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/get_summarized_linked_talk_v2`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_phone: phone }),
    });
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "summary_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return "";
    }
    const data = await res.json();
    const value = data?.summarized_linked_talk;
    return typeof value === "string" ? value : "";
  } catch (_e) {
    console.error(JSON.stringify({
      event: "summary_fetch_exception",
      correlation_id: correlationId,
    }));
    return "";
  }
}

/**
 * CLINIC only. Returns the move_type values already logged for this session,
 * ordered by turn_number ascending. Never throws: any failure - configuration,
 * network, missing table - degrades to an empty history, which the decision
 * function reads as "first turn".
 */
async function fetchClinicMoveHistory(
  correlationId: string,
  sessionId: string,
): Promise<string[]> {
  const session = (sessionId ?? "").trim();
  if (!session) return [];
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return [];
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_move_log` +
      `?select=move_type&session_id=eq.${encodeURIComponent(session)}` +
      `&order=turn_number.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      console.error(JSON.stringify({
        event: "clinic_move_history_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const moves: string[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const moveType = (item as Record<string, unknown>).move_type;
      if (typeof moveType === "string") moves.push(moveType);
    }
    return moves;
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_move_history_fetch_exception",
      correlation_id: correlationId,
    }));
    return [];
  }
}

/**
 * CLINIC only. Returns the fragmented flags already logged for this session,
 * ordered by turn_number ascending. Never throws: any failure - configuration,
 * network, missing table - degrades to an empty history, which the decision
 * function reads as "no evidence of fragmentation".
 */
async function fetchClinicFragmentHistory(
  correlationId: string,
  sessionId: string,
): Promise<boolean[]> {
  const session = (sessionId ?? "").trim();
  if (!session) return [];
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return [];
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_fragment_log` +
      `?select=fragmented&session_id=eq.${encodeURIComponent(session)}` +
      `&order=turn_number.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      console.error(JSON.stringify({
        event: "clinic_fragment_history_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const flags: boolean[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const fragmented = (item as Record<string, unknown>).fragmented;
      if (typeof fragmented === "boolean") flags.push(fragmented);
    }
    return flags;
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_fragment_history_fetch_exception",
      correlation_id: correlationId,
    }));
    return [];
  }
}

/**
 * CLINIC only. Reads the last CLINIC_FRAGMENT_WINDOW_TURNS entries - fewer when
 * the history is shorter - and returns true when at least
 * CLINIC_FRAGMENT_WARNING_THRESHOLD of them were fragmented. An empty history
 * returns false.
 */
function decideFragmentWarning(fragmentHistory: boolean[]): boolean {
  const window = fragmentHistory.slice(-CLINIC_FRAGMENT_WINDOW_TURNS);
  let fragmented = 0;
  for (const flag of window) {
    if (flag) fragmented += 1;
  }
  return fragmented >= CLINIC_FRAGMENT_WARNING_THRESHOLD;
}

/**
 * CLINIC only. Returns the delivered response_text values already logged for
 * this session, ordered by turn_number ascending. Never throws: any failure
 * degrades to an empty history, which the decision function reads as "no
 * evidence of repetition".
 */
async function fetchClinicResponseHistory(
  correlationId: string,
  sessionId: string,
): Promise<string[]> {
  const session = (sessionId ?? "").trim();
  if (!session) return [];
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return [];
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_response_log` +
      `?select=response_text&session_id=eq.${encodeURIComponent(session)}` +
      `&order=turn_number.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      console.error(JSON.stringify({
        event: "clinic_response_history_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const texts: string[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const text = (item as Record<string, unknown>).response_text;
      if (typeof text === "string") texts.push(text);
    }
    return texts;
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_response_history_fetch_exception",
      correlation_id: correlationId,
    }));
    return [];
  }
}

/**
 * CLINIC only. True when at least one significant sentence appears in two
 * different responses within the last CLINIC_REPEAT_CHECK_WINDOW delivered
 * responses - the therapist has already said essentially the same thing
 * verbatim more than once in this conversation, even if the rest of each
 * response differs.
 */
function decideRepeatWarning(responseHistory: string[]): boolean {
  const window = responseHistory.slice(-CLINIC_REPEAT_CHECK_WINDOW);
  if (window.length < 2) return false;
  const sentenceSets = window.map(extractSignificantSentences);
  for (let i = 0; i < sentenceSets.length; i++) {
    for (let j = i + 1; j < sentenceSets.length; j++) {
      for (const sentence of sentenceSets[i]) {
        if (sentenceSets[j].includes(sentence)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * CLINIC only. Returns the blocked flags already logged for this session,
 * ordered by turn_number ascending. Never throws: any failure degrades to an
 * empty history, which the decision function reads as "no evidence of a
 * blocked request pattern".
 */
async function fetchClinicBlockedHistory(
  correlationId: string,
  sessionId: string,
): Promise<boolean[]> {
  const session = (sessionId ?? "").trim();
  if (!session) return [];
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return [];
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_blocked_log` +
      `?select=blocked&session_id=eq.${encodeURIComponent(session)}` +
      `&order=turn_number.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      console.error(JSON.stringify({
        event: "clinic_blocked_history_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const flags: boolean[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const blocked = (item as Record<string, unknown>).blocked;
      if (typeof blocked === "boolean") flags.push(blocked);
    }
    return flags;
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_blocked_history_fetch_exception",
      correlation_id: correlationId,
    }));
    return [];
  }
}

/**
 * CLINIC only. Reads the last CLINIC_BLOCKED_WINDOW_TURNS entries - fewer
 * when the history is shorter - and returns true when at least
 * CLINIC_BLOCKED_WARNING_THRESHOLD of them were flagged MISSES_DIRECT_REQUEST
 * by the corrector. An empty history returns false.
 */
function decideBlockedWarning(blockedHistory: boolean[]): boolean {
  const window = blockedHistory.slice(-CLINIC_BLOCKED_WINDOW_TURNS);
  let blockedCount = 0;
  for (const flag of window) {
    if (flag) blockedCount += 1;
  }
  return blockedCount >= CLINIC_BLOCKED_WARNING_THRESHOLD;
}

/**
 * CLINIC only. True when the delivered text contains any fixed acknowledgment
 * phrase. Deliberately a plain substring check, not sentiment analysis - the
 * phrases observed in production are consistent and narrow.
 */
function detectAcknowledgment(text: string): boolean {
  for (const phrase of CLINIC_ACK_TRIGGER_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  return false;
}

/**
 * CLINIC only. Returns the acknowledged flags already logged for this
 * session, ordered by turn_number ascending. Never throws: any failure
 * degrades to an empty history, which the decision function reads as "no
 * acknowledgment on the immediately preceding turn".
 */
async function fetchClinicAckHistory(
  correlationId: string,
  sessionId: string,
): Promise<boolean[]> {
  const session = (sessionId ?? "").trim();
  if (!session) return [];
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) return [];
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_ack_log` +
      `?select=acknowledged&session_id=eq.${encodeURIComponent(session)}` +
      `&order=turn_number.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      console.error(JSON.stringify({
        event: "clinic_ack_history_fetch_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const flags: boolean[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const acknowledged = (item as Record<string, unknown>).acknowledged;
      if (typeof acknowledged === "boolean") flags.push(acknowledged);
    }
    return flags;
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_ack_history_fetch_exception",
      correlation_id: correlationId,
    }));
    return [];
  }
}

/**
 * CLINIC only. True only when the single immediately preceding turn was
 * flagged as an acknowledgment. Deliberately a one-turn lookback, not a
 * window: this must fire on the very next turn only, and clear itself
 * afterward regardless of what that next turn contains.
 */
function decideOptionsWarning(ackHistory: boolean[]): boolean {
  if (ackHistory.length === 0) return false;
  return ackHistory[ackHistory.length - 1] === true;
}

/**
 * CLINIC only. Picks the move the model is ordered to perform this turn.
 * First turn is always simple_presence. Otherwise echo is barred while it
 * appeared in any of the last CLINIC_ECHO_COOLDOWN_TURNS turns.
 */
function decideRequiredMove(moveHistory: string[]): string {
  if (moveHistory.length === 0) {
    return "simple_presence";
  }

  // Turns elapsed after the last echo: 0 means the previous turn was echo, so
  // turnsSinceEcho < 3 is exactly "echo appeared in one of the last three turns".
  const lastEchoIndex = moveHistory.lastIndexOf("echo");
  const turnsSinceEcho = lastEchoIndex === -1
    ? Number.POSITIVE_INFINITY
    : moveHistory.length - 1 - lastEchoIndex;

  const pool = turnsSinceEcho < CLINIC_ECHO_COOLDOWN_TURNS
    ? CLINIC_MOVES_WITHOUT_ECHO
    : CLINIC_MOVES_WITH_ECHO;

  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * CLINIC only. Splits the model output into the logged move and the patient
 * facing response. A malformed envelope is never fatal: the whole raw text
 * becomes the response and the move is recorded as "other".
 */
function parseClinicCandidate(
  correlationId: string,
  rawText: string,
): { move: string; response: string } {
  const fallback = { move: "other", response: rawText };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_json_parse_failed",
      correlation_id: correlationId,
      reason: "not_json",
    }));
    return fallback;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(JSON.stringify({
      event: "clinic_json_parse_failed",
      correlation_id: correlationId,
      reason: "not_json_object",
    }));
    return fallback;
  }

  const record = parsed as Record<string, unknown>;
  const rawResponse = typeof record.response === "string" ? record.response.trim() : "";
  if (rawResponse.length === 0) {
    console.error(JSON.stringify({
      event: "clinic_json_parse_failed",
      correlation_id: correlationId,
      reason: "missing_response",
    }));
    return fallback;
  }

  const rawMove = typeof record.move === "string" ? record.move.trim() : "";
  const move = CLINIC_MOVE_TYPE_SET.has(rawMove) ? rawMove : "other";
  if (move !== rawMove) {
    console.error(JSON.stringify({
      event: "clinic_move_value_rejected",
      correlation_id: correlationId,
    }));
  }

  return { move, response: rawResponse };
}

/**
 * CLINIC only. Writes the move that was actually delivered, after the
 * corrector has run. A write failure is logged and swallowed: the patient
 * response is already decided and must not depend on this table.
 */
async function recordClinicMove(
  correlationId: string,
  sessionId: string,
  turnNumber: number,
  moveType: string,
): Promise<void> {
  const session = (sessionId ?? "").trim();
  if (!session) return;
  const safeMove = CLINIC_MOVE_TYPE_SET.has(moveType) ? moveType : "other";
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) {
      console.error(JSON.stringify({
        event: "clinic_move_log_skipped",
        correlation_id: correlationId,
        reason: "supabase_configuration_missing",
      }));
      return;
    }
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_move_log`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json; charset=utf-8",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          session_id: session,
          turn_number: turnNumber,
          move_type: safeMove,
        }),
      },
    );
    await res.body?.cancel();
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "clinic_move_log_insert_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return;
    }
    console.log(JSON.stringify({
      event: "clinic_move_logged",
      correlation_id: correlationId,
      turn_number: turnNumber,
      move_type: safeMove,
    }));
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_move_log_insert_exception",
      correlation_id: correlationId,
    }));
  }
}

/**
 * CLINIC only. Writes whether the delivered turn was flagged as fragmented,
 * using the corrector signal OVER_ANALYSIS. Mirrors recordClinicMove: a write
 * failure is logged and swallowed, because the patient response is already
 * decided and must not depend on this table.
 */
async function recordClinicFragment(
  correlationId: string,
  sessionId: string,
  turnNumber: number,
  fragmented: boolean,
): Promise<void> {
  const session = (sessionId ?? "").trim();
  if (!session) return;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) {
      console.error(JSON.stringify({
        event: "clinic_fragment_log_skipped",
        correlation_id: correlationId,
        reason: "supabase_configuration_missing",
      }));
      return;
    }
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_fragment_log`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json; charset=utf-8",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          session_id: session,
          turn_number: turnNumber,
          fragmented,
        }),
      },
    );
    await res.body?.cancel();
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "clinic_fragment_log_insert_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return;
    }
    console.log(JSON.stringify({
      event: "clinic_fragment_logged",
      correlation_id: correlationId,
      turn_number: turnNumber,
      fragmented,
    }));
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_fragment_log_insert_exception",
      correlation_id: correlationId,
    }));
  }
}

/**
 * CLINIC only. Writes the final delivered response text for this turn, used
 * by decideRepeatWarning on future turns. A write failure is logged and
 * swallowed, matching recordClinicMove/recordClinicFragment: the patient
 * response is already decided and must not depend on this table.
 */
async function recordClinicResponse(
  correlationId: string,
  sessionId: string,
  turnNumber: number,
  responseText: string,
): Promise<void> {
  const session = (sessionId ?? "").trim();
  if (!session) return;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) {
      console.error(JSON.stringify({
        event: "clinic_response_log_skipped",
        correlation_id: correlationId,
        reason: "supabase_configuration_missing",
      }));
      return;
    }
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_response_log`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json; charset=utf-8",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          session_id: session,
          turn_number: turnNumber,
          response_text: responseText,
        }),
      },
    );
    await res.body?.cancel();
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "clinic_response_log_insert_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return;
    }
    console.log(JSON.stringify({
      event: "clinic_response_logged",
      correlation_id: correlationId,
      turn_number: turnNumber,
    }));
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_response_log_insert_exception",
      correlation_id: correlationId,
    }));
  }
}

/**
 * CLINIC only. Writes whether this turn was flagged MISSES_DIRECT_REQUEST by
 * the corrector, used by decideBlockedWarning on future turns. A write
 * failure is logged and swallowed, matching the other clinic-tracking
 * writers: the patient response is already decided and must not depend on
 * this table.
 */
async function recordClinicBlocked(
  correlationId: string,
  sessionId: string,
  turnNumber: number,
  blocked: boolean,
): Promise<void> {
  const session = (sessionId ?? "").trim();
  if (!session) return;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) {
      console.error(JSON.stringify({
        event: "clinic_blocked_log_skipped",
        correlation_id: correlationId,
        reason: "supabase_configuration_missing",
      }));
      return;
    }
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_blocked_log`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json; charset=utf-8",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          session_id: session,
          turn_number: turnNumber,
          blocked,
        }),
      },
    );
    await res.body?.cancel();
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "clinic_blocked_log_insert_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return;
    }
    console.log(JSON.stringify({
      event: "clinic_blocked_logged",
      correlation_id: correlationId,
      turn_number: turnNumber,
      blocked,
    }));
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_blocked_log_insert_exception",
      correlation_id: correlationId,
    }));
  }
}

/**
 * CLINIC only. Writes whether the delivered text for this turn contained an
 * acknowledgment phrase, used by decideOptionsWarning on the single
 * immediately following turn. A write failure is logged and swallowed,
 * matching the other clinic-tracking writers.
 */
async function recordClinicAck(
  correlationId: string,
  sessionId: string,
  turnNumber: number,
  acknowledged: boolean,
): Promise<void> {
  const session = (sessionId ?? "").trim();
  if (!session) return;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_KEY")
      ?? "";
    if (!supabaseUrl || !serviceKey) {
      console.error(JSON.stringify({
        event: "clinic_ack_log_skipped",
        correlation_id: correlationId,
        reason: "supabase_configuration_missing",
      }));
      return;
    }
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/clinic_ack_log`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json; charset=utf-8",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          session_id: session,
          turn_number: turnNumber,
          acknowledged,
        }),
      },
    );
    await res.body?.cancel();
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "clinic_ack_log_insert_failed",
        correlation_id: correlationId,
        http_status: res.status,
      }));
      return;
    }
    console.log(JSON.stringify({
      event: "clinic_ack_logged",
      correlation_id: correlationId,
      turn_number: turnNumber,
      acknowledged,
    }));
  } catch (_e) {
    console.error(JSON.stringify({
      event: "clinic_ack_log_insert_exception",
      correlation_id: correlationId,
    }));
  }
}

const DEFAULT_CORRECTOR_KEY = "corrector";
const CORRECTOR_KEY_PATTERN = /^[a-z0-9_]{1,80}$/;

async function fetchRuntimeCorrectorPrompt(
  correlationId: string,
  requestedKey?: string,
): Promise<string> {
  let promptKey = DEFAULT_CORRECTOR_KEY;
  const candidateKey = (requestedKey ?? "").trim();
  if (candidateKey.length > 0) {
    if (CORRECTOR_KEY_PATTERN.test(candidateKey)) {
      promptKey = candidateKey;
    } else {
      console.error(JSON.stringify({
        event: "corrector_prompt_key_rejected",
        correlation_id: correlationId,
      }));
    }
  }
  return await fetchPromptByKey(correlationId, promptKey);
}

async function fetchPromptByKey(
  correlationId: string,
  key: string,
): Promise<string> {
  const promptKey = key;
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

  const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/prompt_information_v2?select=user_text&prompt_key=eq.${encodeURIComponent(promptKey)}&limit=1`;
  console.log(JSON.stringify({
    event: "prompt_selected",
    correlation_id: correlationId,
    prompt_key: promptKey,
  }));
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

function buildTherapistInstructions(args: {
  therapistPrompt: string;
  prePatientPrompt: string;
  patient20: string;
  patientName?: string;
  requiredMove?: string;
  fragmentWarning?: boolean;
  repeatWarning?: boolean;
  blockedWarning?: boolean;
  optionsWarning?: boolean;
}): string {
  // The move line is injected only for CLINIC. Every other track passes an
  // empty requiredMove and gets exactly the instructions it got before.
  const requiredMove = (args.requiredMove ?? "").trim();
  // Both reinforced warnings ride on the move line: they are added only when
  // the move line itself exists, so no other track can ever receive them.
  // Both can fire in the same turn - fragmentation and self-repetition are
  // independent signals.
  const movePrefix: string[] = [];
  if (requiredMove.length > 0) {
    movePrefix.push(`מהלך התשובה הזו: ${requiredMove}`);
    if (args.fragmentWarning === true) movePrefix.push(CLINIC_FRAGMENT_WARNING_LINE);
    if (args.repeatWarning === true) movePrefix.push(CLINIC_REPEAT_WARNING_LINE);
    if (args.blockedWarning === true) movePrefix.push(CLINIC_BLOCKED_WARNING_LINE);
    if (args.optionsWarning === true) movePrefix.push(CLINIC_OPTIONS_WARNING_LINE);
    movePrefix.push("");
  }
  const formatRule = requiredMove.length > 0
    ? "- Return one valid JSON object only, with the keys move and response. No Markdown and no text outside JSON."
    : "- Plain text only; no Markdown, numbering decorations, tables, or JSON.";

  // The patient's name is the only reliable, unambiguous signal for gender in
  // Hebrew before the patient has said much. Without it the model has no
  // basis to infer gender at all on early turns. Passed as a plain fact, not
  // as content to greet with directly (the client already handles the
  // opening greeting on its own).
  const patientName = (args.patientName ?? "").trim();
  const nameRule = patientName.length > 0
    ? `- Patient's name: ${patientName}. Infer grammatical gender from this name and address the patient consistently in that gender throughout. Do not state the name back to the patient unless they used it themselves.`
    : "- Patient's name is unknown for this request. Infer gender only from what the patient writes, and default to a gender-neutral phrasing where Hebrew allows it until a clear signal appears.";

  return [
    ...movePrefix,
    args.therapistPrompt,
    args.prePatientPrompt,
    args.patient20,
    "",
    "Mandatory operational rules for this runtime request:",
    "- Reply in Hebrew only.",
    nameRule,
    "- Maintain gender consistency with the patient and prior context.",
    formatRule,
    "- Ask at most one question.",
    "- Do not repeat a proposal that was already rejected or did not fit.",
    "- Do not repeat the same empathy phrasing or emotional reflection from the previous therapist response.",
    "- Offer one practical suggestion only when the patient explicitly requests practical help.",
    "- Do not end a response with a generic closing question such as \"how can I help/support you now\". If you have no specific question that follows directly from what the patient just said, do not ask a closing question at all.",
    "- Safety rules override all other instructions.",
  ].join("\n");
}

function buildCandidateInput(
  payload: RequestPayload,
  courseMaterial?: { lessonNumber: number; lessonTitle: string; material: string } | null,
): string {
  // COURSE only. The material is context the model may draw on, not an
  // instruction block - it sits with the other context fields, ahead of the
  // conversation itself, and is absent entirely on every other path.
  const coursePrefix = courseMaterial
    ? [
      "course_material:",
      `(lesson ${courseMaterial.lessonNumber}: ${courseMaterial.lessonTitle})`,
      courseMaterial.material,
      "",
    ]
    : [];

  return [
    ...coursePrefix,
    "summarized20:",
    payload.summarized20 ?? "",
    "",
    "tzvira:",
    payload.tzvira ?? "",
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
  maxOutputTokens?: number;
}): Promise<string | null> {
  const response = await postOpenAI({
    apiKey: args.apiKey,
    timeoutMs: CANDIDATE_TIMEOUT_MS,
    body: {
      model: args.model,
      store: false,
      instructions: args.instructions,
      input: args.input,
      max_output_tokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
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
  crossSessionSummary: string;
  previousAcceptedTherapistResponse: string;
  currentPatientMessage: string;
  candidateResponse: string;
}): Promise<CorrectorResult> {
  const correctorPayload = {
    experiment: "runtime_corrected_response_edge_function",
    no_look_ahead_contract:
      "runtime payload contains accepted prior history (current conversation only), a separate cross-session summary (prior conversations, may be empty), previous accepted therapist response, current patient message, and current candidate response only",
    response_format_instruction:
      "Return one valid JSON object only with action, final_response, and reason_codes. No Markdown and no text outside JSON.",
    accepted_prior_history: args.acceptedPriorHistory,
    cross_session_summary: args.crossSessionSummary,
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
      ...CORS_HEADERS,
    },
  });
}

function logDiagnostic(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

const TEST_LOG_TIMEOUT_MS = 5_000;

async function appendTestLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const bucket = Deno.env.get("TEST_LOG_BUCKET") || "corrector-test-log";

    if (!supabaseUrl || !supabaseKey) {
      console.error(JSON.stringify({
        event: "test_log_skipped",
        error: "supabase_configuration_missing",
      }));
      return;
    }

    try {
      const insertController = new AbortController();
      const insertTimeout = setTimeout(
        () => insertController.abort(),
        TEST_LOG_TIMEOUT_MS,
      );
      try {
        const inserted = await fetch(
          `${supabaseUrl.replace(/\/$/, "")}/rest/v1/corrector_test_log`,
          {
            method: "POST",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json; charset=utf-8",
              Prefer: "return=minimal",
            },
            body: JSON.stringify(entry),
            signal: insertController.signal,
          },
        );
        if (!inserted.ok) {
          console.error(JSON.stringify({
            event: "test_log_insert_failed",
            status: inserted.status,
            status_text: inserted.statusText,
          }));
        }
        await inserted.body?.cancel();
      } finally {
        clearTimeout(insertTimeout);
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "test_log_insert_exception",
        error_message: toError(error).message,
      }));
    }

    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const url =
      `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${bucket}/logs/${day}.jsonl`;

    let existing = "";
    const readController = new AbortController();
    const readTimeout = setTimeout(() => readController.abort(), TEST_LOG_TIMEOUT_MS);
    try {
      const current = await fetch(url, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
        signal: readController.signal,
      });
      if (current.ok) {
        existing = await current.text();
      } else {
        await current.body?.cancel();
      }
    } finally {
      clearTimeout(readTimeout);
    }

    const writeController = new AbortController();
    const writeTimeout = setTimeout(() => writeController.abort(), TEST_LOG_TIMEOUT_MS);
    try {
      const upload = await fetch(url, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "x-upsert": "true",
        },
        body: `${existing}${JSON.stringify(entry)}\n`,
        signal: writeController.signal,
      });

      if (!upload.ok) {
        console.error(JSON.stringify({
          event: "test_log_write_failed",
          status: upload.status,
          status_text: upload.statusText,
        }));
      }
    } finally {
      clearTimeout(writeTimeout);
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "test_log_write_exception",
      error_message: toError(error).message,
    }));
  }
}
