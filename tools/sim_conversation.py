#!/usr/bin/env python3
"""Simulated therapy conversation runner.

Drives a full conversation between a simulated patient model and the live
therapist pipeline (runtime-corrected-response), writing each round into
conversations_prod_v2 exactly like a real Landbot conversation.

Configuration is read from the repository .env file and from the process
environment. The .env file wins only where the process environment is silent.
"""

import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path

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
SIM_THERAPIST_KEY = os.environ.get("SIM_THERAPIST_KEY", "nlp_sim_therapist")
SIM_PRE_PATIENT_KEY = os.environ.get("SIM_PRE_PATIENT_KEY", "nlp_sim_pre_patient")
SIM_RULES_KEY = os.environ.get("SIM_RULES_KEY", "nlp_sim_patient_rules")
SIM_FOCUS_KEY = os.environ.get("SIM_FOCUS_KEY", "")
SIM_FOCUS_INDEX = os.environ.get("SIM_FOCUS_INDEX", "")
SIM_ARCS_KEY = os.environ.get("SIM_ARCS_KEY", "nlp_sim_arcs")
SIM_ARC_INDEX = os.environ.get("SIM_ARC_INDEX", "")
SIM_CORRECTOR_KEY = os.environ.get("SIM_CORRECTOR_KEY", "nlp_sim_corrector")

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

    prompt20 = rpc("get_prompt_v2", {"p_prompt_key": SIM_THERAPIST_KEY, "p_therapy": None}) or ""
    pre_patient20 = rpc("get_prompt_v2", {"p_prompt_key": SIM_PRE_PATIENT_KEY, "p_therapy": None}) or ""
    patient_rules = rpc("get_prompt_v2", {"p_prompt_key": SIM_RULES_KEY, "p_therapy": None}) or ""
    focus_key = SIM_FOCUS_KEY.strip() or ("nlp_sim_focus_" + PATIENT_PHONE)
    focus_raw = rpc("get_prompt_v2", {"p_prompt_key": focus_key, "p_therapy": None}) or ""
    focus_topic = pick_from_list(focus_raw, SIM_FOCUS_INDEX)
    arcs_raw = rpc("get_prompt_v2", {"p_prompt_key": SIM_ARCS_KEY, "p_therapy": None}) or ""
    session_arc = pick_from_list(arcs_raw, SIM_ARC_INDEX)
    if not prompt20.strip() or not pre_patient20.strip():
        raise SystemExit("sim therapist or sim pre_patient prompt is empty")
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
    print("corrector: " + SIM_CORRECTOR_KEY, flush=True)

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
            "corrector_prompt_key": SIM_CORRECTOR_KEY,
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
