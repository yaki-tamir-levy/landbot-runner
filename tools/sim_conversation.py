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

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
RUNTIME_URL = SUPABASE_URL + "/functions/v1/runtime-corrected-response"
HTTP_TIMEOUT = 120


def http_json(url, method, headers, payload=None):
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    for key, value in headers.items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise SystemExit("HTTP {} on {}\n{}".format(error.code, url, detail))
    if not body.strip():
        return None
    return json.loads(body)


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
    print("track: " + track + " | rounds: " + str(ROUNDS) + " | rules: " + SIM_RULES_KEY)

    patient_instructions = patient_rules + "\n\nPatient profile:\n" + patient20
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
