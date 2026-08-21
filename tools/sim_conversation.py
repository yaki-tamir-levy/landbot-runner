#!/usr/bin/env python3
"""Simulated therapy conversation runner.

Drives a full conversation between a simulated patient model and the live
therapist pipeline (runtime-corrected-response), writing each round into
conversations_prod_v2 exactly like a real Landbot conversation.

Configuration is read from the repository .env file and from the process
environment. The .env file wins only where the process environment is silent.
"""

import hashlib
import json
import os
import random
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


# One roster per therapy track. The draw is made separately for each track,
# so every cycle selects exactly one NLP_CBT patient AND, independently of it,
# exactly one CLINIC patient. The salt keeps the two draws uncorrelated; the
# empty NLP_CBT salt reproduces the seed used before CLINIC was added, so the
# existing three patients keep behaving exactly as they did.
RISK_ROSTER_BY_TRACK = {
    "NLP_CBT": {
        "salt": "",
        "phones": ["9990000002", "9990000003", "9990000004"],  # Uri, Shiran, Miri
    },
    "CLINIC": {
        "salt": "|CLINIC",
        "phones": ["8880000001", "8880000002", "8880000003"],
    },
}


def compute_risk_round_selected(patient_phone, track):
    """Deterministic per-cycle, per-track selection.

    Every script invocation within the same daily cycle (same UTC hour) and the
    same track independently computes the same seed, and they therefore agree
    on exactly one selected patient inside that track, with no coordination
    between the processes. Each track draws on its own, so an NLP_CBT run and a
    CLINIC run in the same cycle never influence one another.
    """
    now = datetime.now(timezone.utc)
    cycle_id = now.strftime("%Y-%m-%d-%H")
    normalized = (track or "").strip().upper()
    roster = RISK_ROSTER_BY_TRACK.get(normalized)
    if roster is None:
        print("risk_round_check: cycle_id={} track={!r} has no roster, selected=False".format(
            cycle_id, track), flush=True)
        return False
    phones = roster["phones"]
    seed_input = cycle_id + roster["salt"]
    seed_hex = hashlib.md5(seed_input.encode("utf-8")).hexdigest()
    chosen_index = int(seed_hex, 16) % len(phones)
    my_index = phones.index(patient_phone) if patient_phone in phones else None
    selected = my_index is not None and my_index == chosen_index
    print("risk_round_check: cycle_id={} track={} seed_input={} chosen_index={} my_index={} selected={}".format(
        cycle_id, normalized, seed_input, chosen_index, my_index, selected), flush=True)
    return selected

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env"


def load_env_file(path):
    """Load KEY=VALUE lines without overriding the real environment."""
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def require(*names):
    """Return the first name that is present, or exit with a clear message."""
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    raise SystemExit("missing configuration. expected one of: " + ", ".join(names))


load_env_file(ENV_FILE)

SUPABASE_URL = require("SUPABASE_URL").rstrip("/")
SUPABASE_KEY = require("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY")
OPENAI_API_KEY = require("OPENAI_API_KEY")
LANDBOT_SECRET = require("LANDBOT_WEBHOOK_SECRET")

PATIENT_PHONE = os.environ.get("SIM_PATIENT_PHONE", "0500000002")
ROUNDS = int(os.environ.get("SIM_ROUNDS", "10"))
SOURCE = os.environ.get("SIM_SOURCE", "A")
PATIENT_MODEL = os.environ.get("SIM_PATIENT_MODEL", "gpt-5.4")
ROUND_DELAY_SECONDS = float(os.environ.get("SIM_ROUND_DELAY", "3"))
SIM_THERAPIST_KEY_OVERRIDE = os.environ.get("SIM_THERAPIST_KEY", "").strip()
SIM_PRE_PATIENT_KEY = os.environ.get("SIM_PRE_PATIENT_KEY", "nlp_sim_pre_patient")
SIM_RULES_KEY = os.environ.get("SIM_RULES_KEY", "nlp_sim_patient_rules")
SIM_FOCUS_KEY = os.environ.get("SIM_FOCUS_KEY", "")
SIM_FOCUS_INDEX = os.environ.get("SIM_FOCUS_INDEX", "")
SIM_ARCS_KEY = os.environ.get("SIM_ARCS_KEY", "nlp_sim_arcs")
SIM_ARC_INDEX = os.environ.get("SIM_ARC_INDEX", "")
SIM_CORRECTOR_KEY_OVERRIDE = os.environ.get("SIM_CORRECTOR_KEY", "").strip()
SIM_RISK_INJECTION_KEY = os.environ.get("SIM_RISK_INJECTION_KEY", "nlp_sim_risk_injection")

TRACK_PROMPT_KEYS = {
    "NLP_CBT": {"therapist": "nlp_sim_therapist", "corrector": "nlp_sim_corrector"},
    "CLINIC": {"therapist": "clinic_sim_therapist", "corrector": "clinic_sim_corrector"},
}
DEFAULT_TRACK = "NLP_CBT"


def resolve_prompt_keys(track):
    """Pick therapist and corrector prompt keys from the patient therapy_track.

    An explicit environment variable always wins, so a manual run can still
    force any prompt key. An unknown track falls back to NLP_CBT, which keeps
    the pre-existing behaviour for every patient that is not CLINIC.
    """
    normalized = (track or "").strip().upper()
    keys = TRACK_PROMPT_KEYS.get(normalized)
    if keys is None:
        print("prompt_keys: unknown track {!r}, falling back to {}".format(track, DEFAULT_TRACK), flush=True)
        keys = TRACK_PROMPT_KEYS[DEFAULT_TRACK]
    therapist_key = SIM_THERAPIST_KEY_OVERRIDE or keys["therapist"]
    corrector_key = SIM_CORRECTOR_KEY_OVERRIDE or keys["corrector"]
    print("prompt_keys: track={} therapist={} corrector={} (env override: therapist={} corrector={})".format(
        normalized or "NONE", therapist_key, corrector_key,
        bool(SIM_THERAPIST_KEY_OVERRIDE), bool(SIM_CORRECTOR_KEY_OVERRIDE)), flush=True)
    return therapist_key, corrector_key


OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
RUNTIME_URL = SUPABASE_URL + "/functions/v1/runtime-corrected-response"
HTTP_TIMEOUT = 120


def http_json(url, method, headers, payload=None, retries=3):
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_error = ""
    for attempt in range(1, retries + 1):
        request = urllib.request.Request(url, data=data, method=method)
        for key, value in headers.items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
                body = response.read().decode("utf-8")
            if not body.strip():
                return None
            return json.loads(body)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            last_error = "HTTP {} on {}\n{}".format(error.code, url, detail)
            if error.code < 500 or attempt == retries:
                raise SystemExit(last_error)
        except urllib.error.URLError as error:
            last_error = "URLError on {}: {}".format(url, error)
            if attempt == retries:
                raise SystemExit(last_error)
        wait = 5 * attempt
        print("retry {} of {} in {}s: {}".format(attempt, retries, wait, last_error.splitlines()[0]), flush=True)
        time.sleep(wait)
    raise SystemExit(last_error)


def rpc(name, params):
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
    }
    return http_json(SUPABASE_URL + "/rest/v1/rpc/" + name, "POST", headers, params)


def fetch_risk_injection():
    """Return the injection block with the risk phrase substituted in.

    Returns an empty string on any failure. This fails closed: a failed fetch
    simply means no risk injection this round, never a crash.
    """
    try:
        template = rpc("get_prompt_v2", {"p_prompt_key": SIM_RISK_INJECTION_KEY, "p_therapy": None}) or ""
        if not template.strip():
            print("risk_injection: prompt row not found, skipping", flush=True)
            return ""
        phrase_data = rpc("get_random_active_risk_phrase", {})
        pattern = phrase_data.get("pattern") if isinstance(phrase_data, dict) else None
        if not pattern:
            print("risk_injection: no active phrase returned, skipping", flush=True)
            return ""
        return template.replace("__RISK_PHRASE__", pattern)
    except (Exception, SystemExit) as error:
        print("risk_injection: fetch failed ({}), skipping".format(error), flush=True)
        return ""


def openai_text(model, instructions, user_input, temperature, max_tokens):
    payload = {
        "model": model,
        "store": False,
        "instructions": instructions,
        "input": user_input,
        "temperature": temperature,
        "max_output_tokens": max_tokens,
    }
    headers = {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json; charset=utf-8",
    }
    response = http_json(OPENAI_RESPONSES_URL, "POST", headers, payload)
    text = response.get("output_text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    chunks = []
    for item in response.get("output", []) or []:
        for part in item.get("content", []) or []:
            if isinstance(part.get("text"), str):
                chunks.append(part["text"])
    joined = "".join(chunks).strip()
    if not joined:
        raise SystemExit("patient model returned empty output")
    return joined


def pick_from_list(raw, override):
    items = [line.strip() for line in raw.splitlines() if line.strip()]
    if not items:
        return ""
    if override.strip().isdigit():
        return items[int(override.strip()) % len(items)]
    return random.choice(items)


def build_patient_input(transcript, is_first):
    if is_first:
        return "This is the opening message of a new conversation. Write the first thing the patient says today."
    lines = []
    for index, (question, answer) in enumerate(transcript, start=1):
        lines.append("Round {}".format(index))
        lines.append("Patient: " + question)
        lines.append("Therapist: " + answer)
        lines.append("")
    lines.append("Write the next patient message, replying to the last therapist response.")
    return "\n".join(lines)


def build_tzvira(transcript):
    lines = []
    for question, answer in transcript:
        lines.append("מטופל: " + question)
        lines.append("מטפל: " + answer)
    return "\n".join(lines)


def main():
    thread = rpc("get_last_users_thread_v2", {"p_phone": PATIENT_PHONE})
    if not thread:
        raise SystemExit("patient not found for phone " + PATIENT_PHONE)
    row = thread[0]
    patient_name = row.get("name") or ""
    patient20 = row.get("user_text") or ""
    track = row.get("therapy_track") or "NLP_CBT"
    if not patient20.strip():
        raise SystemExit("patient profile (user_text) is empty")

    therapist_key, corrector_key = resolve_prompt_keys(track)

    prompt20 = rpc("get_prompt_v2", {"p_prompt_key": therapist_key, "p_therapy": None}) or ""
    pre_patient20 = rpc("get_prompt_v2", {"p_prompt_key": SIM_PRE_PATIENT_KEY, "p_therapy": None}) or ""
    patient_rules = rpc("get_prompt_v2", {"p_prompt_key": SIM_RULES_KEY, "p_therapy": None}) or ""
    focus_key = SIM_FOCUS_KEY.strip() or ("nlp_sim_focus_" + PATIENT_PHONE)
    focus_raw = rpc("get_prompt_v2", {"p_prompt_key": focus_key, "p_therapy": None}) or ""
    focus_topic = pick_from_list(focus_raw, SIM_FOCUS_INDEX)
    arcs_raw = rpc("get_prompt_v2", {"p_prompt_key": SIM_ARCS_KEY, "p_therapy": None}) or ""
    session_arc = pick_from_list(arcs_raw, SIM_ARC_INDEX)
    if not prompt20.strip() or not pre_patient20.strip():
        raise SystemExit("sim therapist or sim pre_patient prompt is empty: "
                         + therapist_key + " / " + SIM_PRE_PATIENT_KEY)
    if not patient_rules.strip():
        raise SystemExit("sim patient rules prompt is empty: " + SIM_RULES_KEY)

    summarized20 = ""

    conversation_id = rpc(
        "start_conversation_v2",
        {"p_phone": PATIENT_PHONE, "p_name": patient_name, "p_source": SOURCE},
    )
    if not conversation_id:
        raise SystemExit("start_conversation_v2 returned no conversation id")
    print("conversation_id: " + str(conversation_id))
    print("track: " + track + " | rounds: " + str(ROUNDS) + " | rules: " + SIM_RULES_KEY, flush=True)
    print("focus: " + (focus_topic or "NONE") + " | from: " + focus_key, flush=True)
    print("arc: " + (session_arc or "NONE"), flush=True)
    print("therapist: " + therapist_key, flush=True)
    print("corrector: " + corrector_key, flush=True)

    patient_instructions = patient_rules + "\n\nPatient profile:\n" + patient20
    if focus_topic:
        patient_instructions += (
            "\n\nFocus for this session:\n"
            + focus_topic
            + "\nThis is what is on your mind today. Bring it up in your own words, "
            "and let it stay the centre of gravity of the whole conversation. "
            "You may drift, but keep returning to it. Do not announce it as a topic."
        )
    if session_arc:
        patient_instructions += (
            "\n\nHow this session goes:\n"
            + session_arc
            + "\nLet this shape how you open and how the conversation develops. "
            "Do not state it directly; let it show in what you say and how you say it."
        )

    risk_mode_active = compute_risk_round_selected(PATIENT_PHONE, track)
    if risk_mode_active:
        injection = fetch_risk_injection()
        if injection:
            patient_instructions = patient_instructions + "\n\n" + injection
            print("risk_injection: ACTIVE for this run", flush=True)
        else:
            print("risk_injection: selected but fetch failed, running without it", flush=True)
    else:
        print("risk_injection: not selected this cycle", flush=True)

    transcript = []
    response20 = ""

    for round_index in range(1, ROUNDS + 1):
        question = openai_text(
            PATIENT_MODEL,
            patient_instructions,
            build_patient_input(transcript, round_index == 1),
            0.9,
            300,
        )

        payload = {
            "prompt20": prompt20,
            "pre_patient20": pre_patient20,
            "patient20": patient20,
            "summarized20": summarized20,
            "tzvira": build_tzvira(transcript),
            "response20": response20,
            "question20": question,
            "patient_id": PATIENT_PHONE,
            "session_id": str(conversation_id),
            "corrector_prompt_key": corrector_key,
        }
        result = http_json(
            RUNTIME_URL,
            "POST",
            {
                "Content-Type": "application/json; charset=utf-8",
                "x-landbot-secret": LANDBOT_SECRET,
            },
            payload,
        )
        if not result or not result.get("ok"):
            raise SystemExit("runtime function failed: " + json.dumps(result, ensure_ascii=False))

        answer = (result.get("corrected_answer") or "").strip()
        if not answer:
            raise SystemExit("corrected_answer is empty")

        rpc(
            "insert_conversation_v2",
            {
                "p_phone": PATIENT_PHONE,
                "p_conversation_id": str(conversation_id),
                "p_question": question,
                "p_answer": answer,
            },
        )

        transcript.append((question, answer))
        response20 = answer
        print("round {} | {} | q={} chars | a={} chars".format(
            round_index, result.get("corrector_decision"), len(question), len(answer)))
        if round_index < ROUNDS:
            time.sleep(ROUND_DELAY_SECONDS)

    print("done. rows written: " + str(len(transcript)))


if __name__ == "__main__":
    main()
