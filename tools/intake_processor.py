#!/usr/bin/env python3
"""
intake_processor — המהלך המושהה של מסלול הקבלה.

רץ אחת לרבע שעה מתוך GitHub Actions ומבצע, בסדר הזה:
  1. איסוף שיחות שהסתיימו (15 דקות ללא הודעה)
  2. לכל מועמד ממתין: קריאה למודל עם פרומפט ההכרעה
  3. ספירת חוסרים בקוד -> קבלה או פסילה
  4. יישום ההכרעה במסד
  5. התראות: אדמין על הכול, יונתן על מי שהתקבל

הכרעה נעשית בקוד. המודל מחלץ בלבד.
כשל בקריאה או בפענוח = מבנה ריק = חסר = פסילה. לעולם לא אישור.

משתני סביבה נדרשים:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
  GMAIL_USER, GMAIL_APP_PASSWORD
  INTAKE_MODEL (רשות, ברירת מחדל gpt-5.4)

כתובות הנמענים נשלפות מהמסד: האדמין מטבלת הפסיכולוגים,
והמטפל לפי ההגדרה intake_psychologist_phone.
"""

import json
import os
import smtplib
import sys
from email.mime.text import MIMEText
from email.utils import formataddr

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_KEY   = os.environ["OPENAI_API_KEY"]
# משתנה ריק אינו חסר. or תופס גם ערך ריק, get עם ברירת מחדל לא היה תופס.
MODEL        = os.environ.get("INTAKE_MODEL") or "gpt-5.4"

GMAIL_USER   = os.environ["GMAIL_USER"]
GMAIL_PASS   = os.environ["GMAIL_APP_PASSWORD"]

# הנמענים אינם הגדרה. הם נתון במסד, ונשלפים בזמן ריצה.
ADMIN_EMAIL = None
THERAPIST_EMAIL = None
PATIENT_LINK = ""

IDLE_MINUTES = 15

# שדות החובה. שינוי כאן משנה את קריטריון הקבלה.
REQUIRED = [
    "age", "family_status", "household", "area", "occupation",
    "reason_for_coming", "duration", "daily_impact",
]

ALL_FIELDS = REQUIRED + [
    "duration", "daily_impact", "prior_therapy", "support", "expectations",
]

BACKGROUND_MAX = 900

FIELD_HE = {
    "age":               "גיל",
    "family_status":     "מצב משפחתי",
    "household":         "עם מי אתה גר",
    "area":              "אזור מגורים",
    "occupation":        "במה אתה עוסק",
    "reason_for_coming": "מה הביא אותך לפנות",
    "duration":          "כמה זמן זה נמשך",
    "daily_impact":      "איך זה משפיע על היומיום",
    "prior_therapy":     "טיפול קודם",
    "support":           "מי נמצא סביבך",
    "expectations":      "מה היית רוצה לקבל מהתהליך",
}


# ---------------------------------------------------------------- מסד

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
    """דרך הפונקציה הרגילה בלבד. אין שאילתה ישירה לטבלת הפרומפטים."""
    text = rpc("get_prompt_v2", {"p_prompt_key": key})
    if not text:
        raise RuntimeError(f"prompt '{key}' missing or empty")
    return text


# ---------------------------------------------------------------- מודל

EMPTY = {f: "" for f in ALL_FIELDS}
EMPTY.update({"missing": list(ALL_FIELDS), "background": "", "explicit_risk_statement": False})


def extract(prompt, talk):
    """מחזיר תמיד מבנה תקין. כשל מכל סוג -> מבנה ריק."""
    try:
        # Responses API - אותו מסלול שבו משתמשות שאר הפונקציות בפרויקט.
        # chat/completions נדחה על ידי הדגם.
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {OPENAI_KEY}",
            },
            json={
                "model": MODEL,
                "instructions": prompt,
                "input": [{"role": "user", "content": talk}],
                "temperature": 0,
                "max_output_tokens": 1500,
                "store": False,
            },
            timeout=120,
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
        raw = raw.replace("```json", "").replace("```", "").strip()
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("not an object")
    except Exception as e:                                   # noqa: BLE001
        print(f"  extraction failed -> treated as empty: {e}", file=sys.stderr)
        return dict(EMPTY)

    out = {f: str(data.get(f, "") or "").strip() for f in ALL_FIELDS}
    out["background"] = str(data.get("background", "") or "").strip()[:BACKGROUND_MAX]
    out["explicit_risk_statement"] = bool(data.get("explicit_risk_statement", False))

    # רשימת החוסרים נגזרת בקוד, לא מהמודל. הוא עלול לטעות בה.
    out["missing"] = [f for f in ALL_FIELDS if not out[f]]
    return out


def decide(fields):
    """דטרמיניסטי. כל שדות החובה מלאים -> קבלה."""
    return all(fields[f] for f in REQUIRED)


# ---------------------------------------------------------------- התראות

def send_mail(to_addr, subject, body, hash8=None, who=""):
    """שולח, ורושם ליומן בכל מקרה. כשל בשליחה אינו מפיל את הקורא."""
    try:
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = formataddr(("Intake", GMAIL_USER))
        msg["To"] = to_addr
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
            smtp.login(GMAIL_USER, GMAIL_PASS)
            smtp.send_message(msg)
        log_event("mail_sent", hash8, f"{who} -> {to_addr}")
        return True
    except Exception as e:                                   # noqa: BLE001
        print(f"  mail to {to_addr} failed: {e}", file=sys.stderr)
        log_event("mail_failed", hash8, f"{who} -> {to_addr}: {str(e)[:200]}")
        return False


def log_event(stage, hash8=None, detail=None):
    try:
        rpc("intake_log", {
            "p_stage": stage,
            "p_phone_hash": hash8,
            "p_conversation_id": None,
            "p_detail": detail,
        })
    except Exception:                                        # noqa: BLE001
        pass


def notify(result, accepted, missing, risk):
    name  = result.get("name") or "(ללא שם)"
    phone = result.get("phone") or "(ללא טלפון)"
    email = result.get("email") or "(ללא דוא\"ל)"

    status = "התקבל" if accepted else "נפסל"
    lines = [
        f"מועמד {status}",
        "",
        f"שם: {name}",
        f"טלפון: {phone}",
        f'דוא"ל: {email}',
    ]
    if not accepted and missing:
        lines += ["", "פרטים חסרים: " + ", ".join(missing)]
    if risk:
        lines += ["", "*** נאמרה אמירה מפורשת על פגיעה עצמית ***"]

    body = "\n".join(lines)

    hash8 = (result.get("phone") or "")[-4:]

    if ADMIN_EMAIL:
        send_mail(ADMIN_EMAIL, f"[Intake] מועמד {status}: {name}", body,
                  hash8, "admin")
    if accepted and THERAPIST_EMAIL:
        send_mail(THERAPIST_EMAIL, f"[Intake] מטופל חדש: {name}", body,
                  hash8, "therapist")

    # והודעה למועמד עצמו
    cand_mail = result.get("email")
    if cand_mail and accepted:
        lines = [
            f"שלום {name},",
            "",
            "תודה על השיחה. הפרטים שמסרת התקבלו, ואפשר להתחיל.",
            "",
            "המטפל הווירטואלי כבר מכיר את מה שסיפרת, כך שלא תצטרך להתחיל מההתחלה.",
        ]
        if PATIENT_LINK:
            lines += ["", "הכניסה לשיחה:", PATIENT_LINK]
        lines += ["", "מאחלים לך הצלחה."]
        send_mail(cand_mail, "התקבלת — אפשר להתחיל", "\n".join(lines),
                  hash8, "candidate")

    if cand_mail and not accepted:
        # רק שדות החובה החסרים. השאר רצויים, ואין טעם לבקש אותם כתנאי.
        needed = [f for f in REQUIRED if f in (missing or [])]

        lines = [
            f"שלום {name},",
            "",
            "תודה על השיחה. כדי להשלים את הבדיקה חסרים עוד כמה פרטים.",
        ]
        if needed:
            lines += ["", "מה שנשאר להשלים:"]
            lines += [f"— {FIELD_HE.get(f, f)}" for f in needed]
        lines += [
            "",
            "אפשר לחזור לאותו קישור ולהשלים אותם — השיחה תמשיך מהנקודה שבה הפסקת,",
            "ולא תצטרך לספר הכול שוב.",
        ]
        send_mail(cand_mail, "נשארו כמה פרטים להשלים", "\n".join(lines),
                  hash8, "candidate")


# ---------------------------------------------------------------- ראשי

def mail_ready():
    return bool(GMAIL_USER and GMAIL_PASS)


def notify_new_candidates():
    """התראה לאדמין על כל מועמד שנכנס, לפני ובלי קשר להכרעה."""
    if not mail_ready():
        print("WARNING: GMAIL_USER or GMAIL_APP_PASSWORD missing - no mail sent",
              file=sys.stderr)
        return
    fresh = rpc("intake_new_candidates") or []
    for c in fresh:
        body = "\n".join([
            "מועמד חדש נכנס לשיחת היכרות",
            "",
            f"שם: {c.get('name') or '(ללא שם)'}",
            f"טלפון: {c.get('phone') or '(ללא טלפון)'}",
            "דוא\"ל: " + (c.get("email") or "(ללא דוא\"ל)"),
            f"נכנס: {c.get('at')}",
            "",
            "טרם הוכרע. הודעה נפרדת תישלח עם התוצאה.",
        ])
        if ADMIN_EMAIL:
            send_mail(ADMIN_EMAIL,
                      f"[Intake] מועמד חדש: {c.get('name') or c.get('hash8')}",
                      body, c.get("hash8"), "admin-new")
    print(f"new candidate notices: {len(fresh)}")


def load_recipients():
    """שליפת הנמענים מהמסד. חסר נמען אינו עוצר את העיבוד — רק את ההתראה."""
    global ADMIN_EMAIL, THERAPIST_EMAIL, PATIENT_LINK
    r = rpc("intake_recipients") or {}
    ADMIN_EMAIL = r.get("admin_email")
    THERAPIST_EMAIL = r.get("therapist_email")
    PATIENT_LINK = (r.get("patient_link") or "").strip()
    if not ADMIN_EMAIL:
        print("WARNING: no active admin with an email in psychologists_v2", file=sys.stderr)
    if not THERAPIST_EMAIL:
        print("WARNING: no email for the configured intake psychologist", file=sys.stderr)


def main():
    load_recipients()
    notify_new_candidates()

    swept = rpc("intake_sweep", {"p_idle_minutes": IDLE_MINUTES})
    print(f"swept conversations: {swept}")

    pending = rpc("intake_pending") or []
    print(f"pending candidates: {len(pending)}")
    if not pending:
        return

    prompt = get_prompt("intake_decision")

    for cand in pending:
        phone_hash = cand["phone_hash"]
        talk = cand.get("talk") or ""
        short = phone_hash[:8]

        try:
            fields = extract(prompt, talk)
            accepted = decide(fields)
            decision = "ACCEPTED" if accepted else "REJECTED"

            result = rpc("intake_apply_decision", {
                "p_phone_hash": phone_hash,
                "p_decision":   decision,
                "p_missing":    fields["missing"],
                "p_background": fields["background"],
                "p_risk":       fields["explicit_risk_statement"],
            })

            print(f"  {short}: {decision} (missing: {len(fields['missing'])})")

            try:
                notify(result, accepted, fields["missing"], fields["explicit_risk_statement"])
            except Exception as mail_err:                    # noqa: BLE001
                # ההכרעה כבר נרשמה. כשל בדואר אינו הופך אותה לשגיאה.
                print(f"  {short}: mail failed: {mail_err}", file=sys.stderr)

        except Exception as e:                               # noqa: BLE001
            # כשל אינו מותיר מועמד תקוע בהמתנה נצחית — הוא מסומן לבדיקה
            print(f"  {short}: ERROR {e}", file=sys.stderr)
            try:
                rpc("intake_mark_error", {"p_phone_hash": phone_hash})
            except Exception:                                # noqa: BLE001
                pass


if __name__ == "__main__":
    main()
