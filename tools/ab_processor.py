#!/usr/bin/env python3
"""
ab_processor - מהלך יומי שממזג סיכומי שיחות ישנים לסיכום-על אחד.

לכל מטופל שהצטברו לו יותר מ-KEEP סיכומים: הישנים נשלחים למודל יחד עם ה-ab
הקודם, והתוצאה נכתבת ל-ab. שדה הסיכומים מקוצץ ל-KEEP האחרונים.

הקיצוץ עצמו נעשה במסד, ב-ab_apply_v2, ונגזר מהשדה כפי שהוא ברגע הכתיבה -
לא ממה שהסקריפט קרא. שיחה שנכנסה בין הקריאה לכתיבה לא תיעלם.

כשל במטופל אחד אינו עוצר את השאר. כשל בקריאה למודל אינו כותב דבר:
ab ריק נדחה במסד, ולכן המצבור לעולם לא נמחק בלי תחליף.

משתני סביבה - אותם שלושה שכבר מוגדרים לתהליכים האחרים:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  OPENAI_API_KEY
  AB_MODEL   (רשות, ברירת מחדל gpt-5.4)
  AB_KEEP    (רשות, ברירת מחדל 3)
"""

import os
import sys

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_KEY   = os.environ["OPENAI_API_KEY"]
# משתנה ריק אינו חסר. or תופס גם ערך ריק, get עם ברירת מחדל לא היה תופס.
MODEL        = os.environ.get("AB_MODEL") or "gpt-5.4"
KEEP         = int(os.environ.get("AB_KEEP") or "3")

PROMPT_KEY   = "ab_summary"

# גבול רך על גודל הקלט למודל. מצבור של 63 סיכומים הוא כ-24 אלף תווים,
# ולכן חתך מלמעלה מבטיח שריצה אחת לא תתפח בלי גבול. החיתוך משאיר את
# הסוף - החומר העדכני - ולא את ההתחלה.
MAX_INPUT_CHARS = 60000


def rpc(fn, args=None):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/{fn}",
        headers={
            "Content-Type": "application/json",
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
        },
        json=args or {},
        timeout=60,
    )
    r.raise_for_status()
    return r.json() if r.text else None


def get_prompt(key):
    rows = requests.get(
        f"{SUPABASE_URL}/rest/v1/prompt_information_v2",
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Accept": "application/json",
        },
        params={"select": "user_text", "prompt_key": f"eq.{key}", "limit": "1"},
        timeout=60,
    )
    rows.raise_for_status()
    data = rows.json()
    if not isinstance(data, list) or not data:
        raise RuntimeError(f"prompt not found: {key}")
    text = (data[0].get("user_text") or "").strip()
    if not text:
        raise RuntimeError(f"prompt is empty: {key}")
    return text


def build_input(existing_ab, older_blocks):
    """שני החלקים מסומנים במפורש, כדי שהמודל יידע מה זיכרון רחוק ומה חדש."""
    prev = (existing_ab or "").strip()
    blocks = (older_blocks or "").strip()

    if len(blocks) > MAX_INPUT_CHARS:
        blocks = blocks[-MAX_INPUT_CHARS:]

    parts = ["## סיכום קודם", prev if prev else "(אין. זו הריצה הראשונה.)", "",
             "## סיכומי שיחות חדשים", blocks]
    return "\n".join(parts)


def summarise(prompt, text):
    """מחזיר את הסיכום, או None בכל כשל. None לעולם לא נכתב."""
    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {OPENAI_KEY}",
            },
            json={
                "model": MODEL,
                "instructions": prompt,
                "input": [{"role": "user", "content": text}],
                "temperature": 0.2,
                "max_output_tokens": 1200,
                "store": False,
            },
            timeout=180,
        )
        if not r.ok:
            print(f"  openai {r.status_code}: {r.text[:300]}", file=sys.stderr)
        r.raise_for_status()

        payload = r.json()
        raw = payload.get("output_text") or ""
        if not raw:
            parts = []
            for item in payload.get("output", []):
                for c in item.get("content", []):
                    if isinstance(c.get("text"), str):
                        parts.append(c["text"])
            raw = "\n".join(parts)
        raw = raw.strip()
        if not raw:
            raise ValueError("empty summary")
        return raw
    except Exception as e:                                   # noqa: BLE001
        print(f"  summary failed: {e}", file=sys.stderr)
        return None


def main():
    pending = rpc("ab_pending_v2", {"p_keep": KEEP}) or []
    print(f"candidates: {len(pending)} (keep={KEEP}, model={MODEL})")
    if not pending:
        return

    prompt = get_prompt(PROMPT_KEY)

    done = 0
    failed = 0

    for cand in pending:
        code = cand["patient_code"]
        short = str(code)[:8]
        blocks = cand.get("older_blocks") or ""
        prev = cand.get("existing_ab") or ""

        try:
            if not blocks.strip():
                print(f"  {short}: nothing older to summarise, skipped")
                continue

            text = build_input(prev, blocks)
            ab = summarise(prompt, text)

            if not ab:
                # לא כותבים דבר. המצבור נשאר שלם והמטופל ייתפס בריצה הבאה.
                failed += 1
                print(f"  {short}: SKIPPED - no summary produced", file=sys.stderr)
                continue

            result = rpc("ab_apply_v2", {
                "p_patient_code": code,
                "p_ab":           ab,
                "p_keep":         KEEP,
            })
            done += 1
            print(f"  {short}: blocks {cand.get('block_count')} -> "
                  f"{result.get('blocks_kept')}, ab {result.get('ab_length')} chars")

        except Exception as e:                               # noqa: BLE001
            failed += 1
            print(f"  {short}: ERROR {e}", file=sys.stderr)

    print(f"done: {done}, failed: {failed}")
    # יציאה תקינה גם בכשלים חלקיים: מטופל שנכשל נשאר מועמד לריצה הבאה,
    # ואין טעם לצבוע את כל הריצה באדום בגלל אחד.


if __name__ == "__main__":
    main()
