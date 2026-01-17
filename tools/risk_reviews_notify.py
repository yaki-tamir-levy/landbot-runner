#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""risk_reviews_notify.py

גרסה מאוחדת ותקינה שמבוססת על v03 (שמות ENV/התנהגות קיימת) ומוסיפה שליחת מייל.

מה הסקריפט עושה
---------------
1) מושך רשומות מ-Supabase מתוך הטבלה (ברירת מחדל: risk_reviews).
2) מאתר רשומות "ממתינות" לפי:
   - status=NEW אם עמודת הסטטוס קיימת (פילטר שרת). אם העמודה לא קיימת -> ממשיך בלי פילטר סטטוס.
   - risk_reasons אינו NULL בצד השרת, וריק/רווחים מסונן בצד לקוח.
3) אם יש ממתינות:
   - שולח הודעת Pushover אחת (סיכום + תצוגה מקדימה) דרך tools/pushover_send.py
   - ואם EMAIL_ENABLED="1" שולח גם מייל דרך Gmail SMTP (App Password).

ENV
---
חובה (Supabase):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

חובה (Pushover) - לפי v03:
  PUSHOVER_TOKEN
  PUSHOVER_USER

אופציונלי (כמו v03):
  RISK_REVIEWS_TABLE   ברירת מחדל: risk_reviews
  PAGE_SIZE            ברירת מחדל: 500
  PREVIEW_ROWS         ברירת מחדל: 5
  STATUS_FIELD         ברירת מחדל: status
  REVIEWED_VALUE       נשמר לתאימות (לא בשימוש בלוגיקה הנוכחית). ברירת מחדל: reviewed
  NAME_FIELD           ברירת מחדל: name
  PHONE_FIELD          ברירת מחדל: phone
  RISK_REASONS_FIELD   ברירת מחדל: risk_reasons

תאימות לכלי השליחה הקיים tools/pushover_send.py (למשל):
  PUSHOVER_USER_2
  PUSHOVER_URL
  PUSHOVER_URL_TITLE

מייל (כמו v04):
  EMAIL_ENABLED        "1" כדי להפעיל
  GMAIL_SMTP_USER
  GMAIL_APP_PASSWORD
  EMAIL_TO

אופציונלי למייל:
  EMAIL_FROM           ברירת מחדל: GMAIL_SMTP_USER
  EMAIL_SUBJECT_PREFIX ברירת מחדל: [RISK]
  SMTP_HOST            ברירת מחדל: smtp.gmail.com
  SMTP_PORT            ברירת מחדל: 587

אחר:
  DRY_RUN              "1" לא שולח בפועל, רק מדפיס מה היה נשלח

הערה חשובה:
- הסקריפט לא משנה סטטוסים ב-DB; הוא רק מתריע (כמו v03).
"""

from __future__ import annotations

import json
import os
import smtplib
import subprocess
import sys
import time
from email.message import EmailMessage
from typing import Any, Dict, List, Optional, Tuple

import requests


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.environ.get(name)
    if v is None:
        return default
    v = v.strip()
    return v if v != "" else default


def _env_required(name: str) -> str:
    v = _env(name)
    if not v:
        print(f"[ERROR] Missing required env var: {name}", file=sys.stderr)
        sys.exit(2)
    return v


def _env_int(name: str, default: int) -> int:
    v = _env(name)
    if v is None:
        return default
    try:
        return int(v)
    except ValueError:
        print(f"[WARN] Invalid int for {name}={v!r}; using default {default}", file=sys.stderr)
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    v = _env(name)
    if v is None:
        return default
    return v.lower() in ("1", "true", "yes", "y", "on")


def _normalize_str(x: Any) -> str:
    if x is None:
        return ""
    return str(x).strip()


def _truncate(s: str, n: int) -> str:
    s = s.replace("\r", " ").replace("\n", " ").strip()
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)].rstrip() + "…"


def _looks_like_unknown_column(err: Any) -> bool:
    """Best-effort detection for PostgREST unknown column errors."""
    try:
        if isinstance(err, dict):
            s = json.dumps(err, ensure_ascii=False)
        else:
            s = str(err)
    except Exception:
        s = str(err)

    s_low = s.lower()
    return (
        ("column" in s_low and "does not exist" in s_low)
        or ("unknown" in s_low and "column" in s_low)
        or ("could not find the" in s_low and "column" in s_low)
    )


def _supabase_get(
    base_url: str,
    service_key: str,
    table: str,
    select_fields: List[str],
    status_field: str,
    use_status_filter: bool,
    offset: int,
    limit: int,
    timeout_seconds: int = 30,
) -> Tuple[int, Any, str]:
    """Returns (status_code, json_or_text, content_type)."""

    url = f"{base_url.rstrip('/')}/rest/v1/{table}"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
    }

    params: Dict[str, str] = {
        "select": ",".join(select_fields),
        "limit": str(limit),
        "offset": str(offset),
    }

    # Prefer only rows with non-null-ish risk reasons.
    # PostgREST: risk_reasons=not.is.null
    risk_field = select_fields[-1]
    params[risk_field] = "not.is.null"

    if use_status_filter:
        # v03 behavior: filter only NEW
        params[status_field] = "eq.NEW"

    r = requests.get(url, headers=headers, params=params, timeout=timeout_seconds)
    ctype = r.headers.get("content-type", "")

    if r.status_code >= 400:
        try:
            return r.status_code, r.json(), ctype
        except Exception:
            return r.status_code, r.text, ctype

    try:
        return r.status_code, r.json(), ctype
    except Exception:
        return r.status_code, r.text, ctype


def _send_pushover_via_tool(title: str, message: str, dry_run: bool) -> None:
    """Delegate sending to tools/pushover_send.py so existing env support stays consistent."""

    cmd = [sys.executable, "tools/pushover_send.py", "--title", title, "--message", message]

    if dry_run:
        print("[DRY_RUN] Would run:", " ".join(cmd))
        print("[DRY_RUN] Pushover title:", title)
        print("[DRY_RUN] Pushover message:\n", message)
        return

    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        print("[ERROR] tools/pushover_send.py failed", file=sys.stderr)
        if p.stdout:
            print(p.stdout, file=sys.stderr)
        if p.stderr:
            print(p.stderr, file=sys.stderr)
        sys.exit(p.returncode)


def _send_email(
    subject: str,
    body: str,
    dry_run: bool,
) -> None:
    enabled = (_env("EMAIL_ENABLED", "") or "").strip() == "1"
    if not enabled:
        print("[INFO] EMAIL_ENABLED is not '1' -> email disabled.")
        return

    gmail_user = _env_required("GMAIL_SMTP_USER")
    gmail_app_password = _env_required("GMAIL_APP_PASSWORD")
    email_to = _env_required("EMAIL_TO")

    email_from = _env("EMAIL_FROM") or gmail_user
    smtp_host = _env("SMTP_HOST", "smtp.gmail.com") or "smtp.gmail.com"
    smtp_port = _env_int("SMTP_PORT", 587)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = email_from
    msg["To"] = email_to
    msg.set_content(body)

    if dry_run:
        print("[DRY_RUN] Would send Email:")
        print("To:", email_to)
        print("From:", email_from)
        print("Subject:", subject)
        print("Body preview:\n", body[:1200])
        return

    with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(gmail_user, gmail_app_password)
        server.send_message(msg)


def _build_email_body(pending: List[Dict[str, Any]], name_f: str, phone_f: str, risk_f: str) -> str:
    now_utc = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    lines: List[str] = []
    lines.append(f"Pending risk reviews: {len(pending)}")
    lines.append(f"Generated: {now_utc}")
    lines.append("")

    for i, r in enumerate(pending, start=1):
        nm = _normalize_str(r.get(name_f))
        ph = _normalize_str(r.get(phone_f))
        rr = _normalize_str(r.get(risk_f))

        lines.append(f"{i})")
        if nm:
            lines.append(f"  name: {nm}")
        if ph:
            lines.append(f"  phone: {ph}")
        if rr:
            lines.append(f"  risk_reasons: {rr}")
        lines.append("")

    return "\n".join(lines).strip() + "\n"


def main() -> int:
    dry_run = _env_bool("DRY_RUN", False)

    base_url = _env_required("SUPABASE_URL")
    service_key = _env_required("SUPABASE_SERVICE_ROLE_KEY")

    # v03 pushover env names
    if not dry_run:
        _env_required("PUSHOVER_TOKEN")
        _env_required("PUSHOVER_USER")

    table = (_env("RISK_REVIEWS_TABLE", "risk_reviews") or "risk_reviews").strip()
    page_size = _env_int("PAGE_SIZE", 500)
    preview_rows = _env_int("PREVIEW_ROWS", 5)

    status_field = (_env("STATUS_FIELD", "status") or "status").strip()
    # kept for compatibility; not used in logic
    _ = (_env("REVIEWED_VALUE", "reviewed") or "reviewed").strip()

    name_field_default = (_env("NAME_FIELD", "name") or "name").strip()
    phone_field_default = (_env("PHONE_FIELD", "phone") or "phone").strip()
    risk_field_default = (_env("RISK_REASONS_FIELD", "risk_reasons") or "risk_reasons").strip()

    field_variants: List[Tuple[str, str, str]] = [
        (name_field_default, phone_field_default, risk_field_default),
        ("name", "phone", "risk_reasons"),
        ("NAME", "PHONE", "RISK_REASONS"),
    ]

    used_fields: Optional[Tuple[str, str, str]] = None
    used_status_filter = True
    last_err: Any = None

    rows: List[Dict[str, Any]] = []

    # Try: (fields variant) x (status filter on/off) with pagination.
    for fields in field_variants:
        for status_filter in (True, False):
            if not used_status_filter and status_filter:
                continue

            all_rows: List[Dict[str, Any]] = []
            offset = 0

            while True:
                code, payload, _ctype = _supabase_get(
                    base_url=base_url,
                    service_key=service_key,
                    table=table,
                    select_fields=[fields[0], fields[1], fields[2]],
                    status_field=status_field,
                    use_status_filter=status_filter,
                    offset=offset,
                    limit=page_size,
                )

                if code >= 400:
                    last_err = payload

                    # If status filter caused unknown column, retry without it for same fields.
                    if status_filter and _looks_like_unknown_column(payload):
                        used_status_filter = False
                        break

                    # If field names are wrong, try next variant.
                    if _looks_like_unknown_column(payload):
                        break

                    print(f"[ERROR] Supabase request failed ({code}): {payload}", file=sys.stderr)
                    return 1

                if not isinstance(payload, list):
                    print(f"[ERROR] Unexpected response type: {type(payload)} => {payload}", file=sys.stderr)
                    return 1

                all_rows.extend(payload)

                if len(payload) < page_size:
                    break
                offset += page_size

            # If we got rows without errors, accept and stop.
            # NOTE: even if 0 rows, if last_err is None, we also accept.
            if last_err is None:
                rows = all_rows
                used_fields = fields
                used_status_filter = status_filter
                break

            if all_rows:
                rows = all_rows
                used_fields = fields
                used_status_filter = status_filter
                break

        if used_fields is not None:
            break

    if used_fields is None:
        print(f"[ERROR] Could not query table {table}. Last error: {last_err}", file=sys.stderr)
        return 1

    name_f, phone_f, risk_f = used_fields

    # Client-side filtering of empty risk reasons
    pending: List[Dict[str, Any]] = []
    for r in rows:
        reasons = _normalize_str(r.get(risk_f))
        if not reasons:
            continue
        pending.append(r)

    if len(pending) == 0:
        print("[INFO] No pending risk reviews. Exiting quietly.")
        return 0

    # Build push preview
    preview_lines: List[str] = []
    for r in pending[: max(1, preview_rows)]:
        nm = _normalize_str(r.get(name_f)) or "-"
        ph = _normalize_str(r.get(phone_f)) or "-"
        rr = _truncate(_normalize_str(r.get(risk_f)), 120) or "-"
        preview_lines.append(f"- {nm} | {ph} | {rr}")

    title = f"Risk reviews pending: {len(pending)}"
    msg = "יש רשומות שמחכות לבדיקה:\n" + "\n".join(preview_lines)

    _send_pushover_via_tool(title=title, message=msg, dry_run=dry_run)
    print(f"[OK] Pushover notification processed. count={len(pending)} (status_filter={used_status_filter}, fields={used_fields})")

    # Email (optional)
    subject_prefix = _env("EMAIL_SUBJECT_PREFIX", "[RISK]") or "[RISK]"
    email_subject = f"{subject_prefix} {len(pending)} pending risk reviews"
    email_body = _build_email_body(pending, name_f=name_f, phone_f=phone_f, risk_f=risk_f)

    _send_email(subject=email_subject, body=email_body, dry_run=dry_run)
    if (_env("EMAIL_ENABLED", "") or "").strip() == "1":
        print("[OK] Email processed.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
