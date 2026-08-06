#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
psychologist_notify.py

Sends per-psychologist email notifications about their own patients only.

Two modes, selected by NOTIFY_MODE:

  risk   - hourly. New risk findings created since the last send.
  daily  - once a day, 20:00 Israel time. New conversations since the last
           send, PLUS every currently open risk finding (state, not event).

Message content is deliberately minimal: masked phone + counts.
No patient name, no risk text, no link. Full detail requires logging in.

Patients with no assigned psychologist are routed to the admin account.

Environment variables
---------------------
  NOTIFY_MODE                 required: "risk" or "daily"
  SUPABASE_URL                required
  SUPABASE_SERVICE_ROLE_KEY   required
  GMAIL_SMTP_USER             required unless DRY_RUN
  GMAIL_APP_PASSWORD          required unless DRY_RUN
  EMAIL_FROM                  optional, defaults to GMAIL_SMTP_USER
  SMTP_HOST                   optional, default smtp.gmail.com
  SMTP_PORT                   optional, default 587
  DAILY_HOUR_IL               optional, default 20
  DRY_RUN                     optional, "1" prints instead of sending
  SKIP_HOUR_GATE              optional, "1" ignores the Israel-hour gate
"""

from __future__ import annotations

import html
import os
import smtplib
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests

# ----------------------------------------------------------------------------
# constants
# ----------------------------------------------------------------------------

WATERMARK_TABLE = "notification_watermark"
UNASSIGNED_SCOPE = "__unassigned__"
OPEN_RISK_STATUSES = ("NEW", "REVIEWED", "VIEWED")
LRM = "\u200e"  # left-to-right mark, keeps masked phones from flipping
HTTP_TIMEOUT = 30
PAGE_SIZE = 1000

IL_TZ = ZoneInfo("Asia/Jerusalem")


# ----------------------------------------------------------------------------
# env helpers
# ----------------------------------------------------------------------------

def _env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    if v is None or not str(v).strip():
        return default
    return str(v).strip()


def _env_required(name: str) -> str:
    v = _env(name)
    if not v:
        print(f"[FATAL] missing required env var: {name}", file=sys.stderr)
        sys.exit(2)
    return v


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"[WARN] {name}={raw!r} is not an int, using {default}", file=sys.stderr)
        return default


def _env_flag(name: str) -> bool:
    return _env(name) == "1"


# ----------------------------------------------------------------------------
# Hebrew formatting
# ----------------------------------------------------------------------------

_FINDING_WORDS = {
    1: "ממצא אחד",
    2: "שני ממצאים",
    3: "שלושה ממצאים",
    4: "ארבעה ממצאים",
    5: "חמישה ממצאים",
    6: "שישה ממצאים",
    7: "שבעה ממצאים",
    8: "שמונה ממצאים",
    9: "תשעה ממצאים",
    10: "עשרה ממצאים",
}

_TALK_WORDS = {
    1: "שיחה אחת",
    2: "שתי שיחות",
    3: "שלוש שיחות",
    4: "ארבע שיחות",
    5: "חמש שיחות",
    6: "שש שיחות",
    7: "שבע שיחות",
    8: "שמונה שיחות",
    9: "תשע שיחות",
    10: "עשר שיחות",
}


def _findings_he(n: int) -> str:
    return _FINDING_WORDS.get(n, f"{n} ממצאים")


def _talks_he(n: int) -> str:
    return _TALK_WORDS.get(n, f"{n} שיחות")


def _subj_findings(n: int) -> str:
    return "ממצא אחד חדש" if n == 1 else f"{n} ממצאים חדשים"


def _subj_talks(n: int) -> str:
    return "שיחה אחת" if n == 1 else f"{n} שיחות"


def _subj_open_risk(n: int) -> str:
    return "סיכון אחד פתוח" if n == 1 else f"{n} סיכונים פתוחים"


def _mask_line(masked_phone: str) -> str:
    """Phone on its own line, wrapped in LRM so it renders left-to-right."""
    return f"{LRM}{masked_phone}{LRM}"


def _parse_time_key(tk: str) -> Optional[datetime]:
    if not tk:
        return None
    raw = tk.strip().replace(" ", "T")
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _date_he(tk: str) -> str:
    dt = _parse_time_key(tk)
    if dt is None:
        return ""
    local = dt.astimezone(IL_TZ)
    return f"{local.day}.{local.month}.{local.year}"


# ----------------------------------------------------------------------------
# PostgREST
# ----------------------------------------------------------------------------

class Rest:
    def __init__(self, base_url: str, service_key: str) -> None:
        self.base = base_url.rstrip("/")
        self.key = service_key

    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def select(self, table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
        """Paged SELECT. Returns all rows."""
        out: List[Dict[str, Any]] = []
        offset = 0
        while True:
            q = dict(params)
            q["limit"] = str(PAGE_SIZE)
            q["offset"] = str(offset)
            url = f"{self.base}/rest/v1/{table}"
            r = requests.get(url, headers=self._headers(), params=q, timeout=HTTP_TIMEOUT)
            if r.status_code >= 400:
                raise RuntimeError(f"GET {table} failed {r.status_code}: {r.text[:400]}")
            batch = r.json()
            if not isinstance(batch, list):
                raise RuntimeError(f"GET {table} returned non-list: {str(batch)[:200]}")
            out.extend(batch)
            if len(batch) < PAGE_SIZE:
                return out
            offset += PAGE_SIZE

    def upsert(self, table: str, rows: List[Dict[str, Any]], on_conflict: str) -> None:
        if not rows:
            return
        url = f"{self.base}/rest/v1/{table}"
        r = requests.post(
            url,
            headers=self._headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            params={"on_conflict": on_conflict},
            json=rows,
            timeout=HTTP_TIMEOUT,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"UPSERT {table} failed {r.status_code}: {r.text[:400]}")


# ----------------------------------------------------------------------------
# data loading
# ----------------------------------------------------------------------------

def load_recipients(rest: Rest) -> Tuple[Dict[str, Dict[str, str]], Optional[Dict[str, str]]]:
    """
    Returns (by_phone, admin).
    by_phone maps psychologists_v2.phone -> {name, email, phone}
    Only active psychologists with a non-empty email are included.
    """
    rows = rest.select(
        "psychologists_v2",
        {"select": "phone,email,name,active,is_admin"},
    )
    by_phone: Dict[str, Dict[str, str]] = {}
    admin: Optional[Dict[str, str]] = None
    for r in rows:
        phone = (r.get("phone") or "").strip()
        email = (r.get("email") or "").strip()
        name = (r.get("name") or "").strip()
        if not phone or not email or not r.get("active"):
            continue
        entry = {"phone": phone, "email": email, "name": name}
        by_phone[phone] = entry
        if r.get("is_admin") and admin is None:
            admin = entry
    return by_phone, admin


def load_patient_scope(rest: Rest, by_phone: Dict[str, Dict[str, str]]) -> Dict[str, str]:
    """patient_code -> scope. Scope is the psychologist phone, or UNASSIGNED_SCOPE."""
    rows = rest.select(
        "users_information_v2",
        {"select": "patient_code,psychologist"},
    )
    out: Dict[str, str] = {}
    for r in rows:
        pc = (r.get("patient_code") or "").strip()
        if not pc:
            continue
        psy = (r.get("psychologist") or "").strip()
        out[pc] = psy if psy in by_phone else UNASSIGNED_SCOPE
    return out


def load_masked_phones(rest: Rest) -> Dict[str, str]:
    """patient_code -> masked phone. Falls back to a placeholder when malformed."""
    rows = rest.select("patient_identity_map", {"select": "patient_code,phone"})
    out: Dict[str, str] = {}
    for r in rows:
        pc = (r.get("patient_code") or "").strip()
        if not pc:
            continue
        ph = (r.get("phone") or "").strip()
        out[pc] = ph if ph else "מספר חסר"
    return out


def load_watermarks(rest: Rest, channel: str) -> Dict[str, str]:
    rows = rest.select(
        WATERMARK_TABLE,
        {"select": "scope,last_time_key,channel", "channel": f"eq.{channel}"},
    )
    return {
        (r.get("scope") or ""): (r.get("last_time_key") or "")
        for r in rows
        if r.get("scope")
    }


# ----------------------------------------------------------------------------
# grouping
# ----------------------------------------------------------------------------

def group_rows(
    rows: List[Dict[str, Any]],
    patient_scope: Dict[str, str],
    watermarks: Optional[Dict[str, str]],
) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """
    scope -> patient_code -> {"count": int, "max_tk": str, "min_tk": str}

    When watermarks is given, a row is skipped if its time_key is not strictly
    greater than that scope's watermark. When it is None, every row counts.
    """
    grouped: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for r in rows:
        pc = (r.get("patient_code") or "").strip()
        if not pc:
            continue
        tk = (r.get("time_key") or "").strip()
        if not tk:
            continue
        scope = patient_scope.get(pc, UNASSIGNED_SCOPE)
        if watermarks is not None:
            mark = watermarks.get(scope, "")
            if mark and tk <= mark:
                continue
        bucket = grouped.setdefault(scope, {}).setdefault(
            pc, {"count": 0, "max_tk": tk, "min_tk": tk}
        )
        bucket["count"] += 1
        if tk > bucket["max_tk"]:
            bucket["max_tk"] = tk
        if tk < bucket["min_tk"]:
            bucket["min_tk"] = tk
    return grouped


# ----------------------------------------------------------------------------
# message building
# ----------------------------------------------------------------------------

def _greeting(name: str, is_admin_scope: bool) -> str:
    if is_admin_scope:
        return "שלום,"
    return f"שלום {name}," if name else "שלום,"


def build_risk_message(
    name: str,
    is_admin_scope: bool,
    patients: Dict[str, Dict[str, Any]],
    masked: Dict[str, str],
) -> Tuple[str, str]:
    total = sum(p["count"] for p in patients.values())
    subject = f"התראת סיכון — {_subj_findings(total)}"

    lines: List[str] = [_greeting(name, is_admin_scope), ""]
    if is_admin_scope:
        lines.append("הפריטים הבאים אינם משויכים לאף מטפל:")
    else:
        lines.append("נרשמו ממצאי סיכון חדשים במטופלים שלך:")
    lines.append("")

    for pc, info in sorted(patients.items(), key=lambda kv: kv[1]["max_tk"], reverse=True):
        lines.append(_mask_line(masked.get(pc, "מספר חסר")))
        lines.append(f"{_findings_he(info['count'])}.")
        lines.append("")

    if is_admin_scope:
        lines.append("יש לשייך מטפל.")
    else:
        lines.append("לצפייה בפרטים ובתוכן השיחה, יש להיכנס למערכת.")
        lines.append("")
        lines.append("הודעה זו נשלחת אוטומטית. אין להשיב עליה.")

    return subject, "\n".join(lines).rstrip() + "\n"


def build_daily_message(
    name: str,
    is_admin_scope: bool,
    talks: Dict[str, Dict[str, Any]],
    open_risk: Dict[str, Dict[str, Any]],
    masked: Dict[str, str],
) -> Tuple[str, str]:
    talk_total = sum(p["count"] for p in talks.values())
    risk_total = sum(p["count"] for p in open_risk.values())
    subject = f"דוח יומי — {_subj_talks(talk_total)}, {_subj_open_risk(risk_total)}"

    lines: List[str] = [_greeting(name, is_admin_scope), ""]

    if talks:
        if is_admin_scope:
            lines.append("שיחות שאינן משויכות לאף מטפל:")
        else:
            lines.append("שיחות שהתקיימו מאז הדוח הקודם:")
        lines.append("")
        for pc, info in sorted(talks.items(), key=lambda kv: kv[1]["max_tk"], reverse=True):
            lines.append(_mask_line(masked.get(pc, "מספר חסר")))
            lines.append(f"{_talks_he(info['count'])}.")
            lines.append("")

    if open_risk:
        if is_admin_scope:
            lines.append("סיכונים פתוחים שאינם משויכים לאף מטפל:")
        else:
            lines.append("סיכונים פתוחים הממתינים לטיפול:")
        lines.append("")
        for pc, info in sorted(open_risk.items(), key=lambda kv: kv[1]["min_tk"]):
            lines.append(_mask_line(masked.get(pc, "מספר חסר")))
            when = _date_he(info["min_tk"])
            count = info["count"]
            verb = "נרשם" if count == 1 else "נרשמו"
            if when:
                lines.append(f"{_findings_he(count)}, {verb} {when}.")
            else:
                lines.append(f"{_findings_he(count)}.")
            lines.append("")

    if is_admin_scope:
        lines.append("יש לשייך מטפל.")
    else:
        lines.append("לצפייה בתוכן, יש להיכנס למערכת.")
        lines.append("")
        lines.append("הודעה זו נשלחת אוטומטית. אין להשיב עליה.")

    return subject, "\n".join(lines).rstrip() + "\n"


# ----------------------------------------------------------------------------
# sending
# ----------------------------------------------------------------------------

def _html_rtl(body: str) -> str:
    """
    Right-to-left HTML alternative of the plain-text body.

    white-space: pre-wrap preserves the exact line breaks of the text part, so
    the two alternatives stay identical in content. The masked phone lines
    already carry LRM marks, which keep them left-to-right inside the RTL block.
    """
    escaped = html.escape(body)
    return (
        "<html><body>"
        '<div dir="rtl" style="text-align:right;white-space:pre-wrap;'
        'font-family:Arial,Helvetica,sans-serif;font-size:14px;'
        'line-height:1.6">'
        f"{escaped}"
        "</div></body></html>"
    )


class Mailer:
    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.host = _env("SMTP_HOST", "smtp.gmail.com")
        self.port = _env_int("SMTP_PORT", 587)
        if dry_run:
            self.user = _env("GMAIL_SMTP_USER", "dry-run@example.com")
            self.password = ""
        else:
            self.user = _env_required("GMAIL_SMTP_USER")
            self.password = _env_required("GMAIL_APP_PASSWORD")
        self.sender = _env("EMAIL_FROM") or self.user

    def send(self, to_addr: str, subject: str, body: str) -> None:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = self.sender
        msg["To"] = to_addr
        msg.set_content(body)
        msg.add_alternative(_html_rtl(body), subtype="html")

        if self.dry_run:
            print("=" * 60)
            print(f"[DRY_RUN] To: {to_addr}")
            print(f"[DRY_RUN] Subject: {subject}")
            print(body)
            print("=" * 60)
            return

        with smtplib.SMTP(self.host, self.port, timeout=HTTP_TIMEOUT) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(self.user, self.password)
            server.send_message(msg)
        print(f"[OK] sent to {to_addr}: {subject}")


# ----------------------------------------------------------------------------
# modes
# ----------------------------------------------------------------------------

def run_risk(rest: Rest, mailer: Mailer) -> int:
    by_phone, admin = load_recipients(rest)
    patient_scope = load_patient_scope(rest, by_phone)
    masked = load_masked_phones(rest)
    watermarks = load_watermarks(rest, "risk")

    rows = rest.select(
        "risk_reviews_v2",
        {"select": "patient_code,time_key,status", "order": "time_key.asc"},
    )
    grouped = group_rows(rows, patient_scope, watermarks)

    if not grouped:
        print("[INFO] risk: nothing new since last send.")
        return 0

    sent = 0
    marks: List[Dict[str, Any]] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for scope, patients in grouped.items():
        recipient = _resolve_recipient(scope, by_phone, admin)
        if recipient is None:
            print(f"[WARN] risk: no recipient for scope {scope!r}, skipped.", file=sys.stderr)
            continue
        subject, body = build_risk_message(
            recipient["name"], scope == UNASSIGNED_SCOPE, patients, masked
        )
        mailer.send(recipient["email"], subject, body)
        sent += 1
        marks.append({
            "scope": scope,
            "channel": "risk",
            "last_time_key": max(p["max_tk"] for p in patients.values()),
            "last_sent_at": now_iso,
            "updated_at": now_iso,
        })

    if marks and not mailer.dry_run:
        rest.upsert(WATERMARK_TABLE, marks, "scope,channel")
    print(f"[INFO] risk: {sent} email(s) sent.")
    return 0


def run_daily(rest: Rest, mailer: Mailer) -> int:
    by_phone, admin = load_recipients(rest)
    patient_scope = load_patient_scope(rest, by_phone)
    masked = load_masked_phones(rest)
    watermarks = load_watermarks(rest, "daily")

    talk_rows = rest.select(
        "users_tzvira_v2",
        {"select": "patient_code,time_key", "order": "time_key.asc"},
    )
    talks_by_scope = group_rows(talk_rows, patient_scope, watermarks)

    status_filter = "in.(" + ",".join(OPEN_RISK_STATUSES) + ")"
    risk_rows = rest.select(
        "risk_reviews_v2",
        {
            "select": "patient_code,time_key,status",
            "status": status_filter,
            "order": "time_key.asc",
        },
    )
    # State, not event: no watermark filter here.
    risk_by_scope = group_rows(risk_rows, patient_scope, None)

    scopes = sorted(set(talks_by_scope) | set(risk_by_scope))
    if not scopes:
        print("[INFO] daily: nothing to report.")
        return 0

    sent = 0
    marks: List[Dict[str, Any]] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for scope in scopes:
        talks = talks_by_scope.get(scope, {})
        risks = risk_by_scope.get(scope, {})
        if not talks and not risks:
            continue
        recipient = _resolve_recipient(scope, by_phone, admin)
        if recipient is None:
            print(f"[WARN] daily: no recipient for scope {scope!r}, skipped.", file=sys.stderr)
            continue
        subject, body = build_daily_message(
            recipient["name"], scope == UNASSIGNED_SCOPE, talks, risks, masked
        )
        mailer.send(recipient["email"], subject, body)
        sent += 1
        if talks:
            marks.append({
                "scope": scope,
                "channel": "daily",
                "last_time_key": max(p["max_tk"] for p in talks.values()),
                "last_sent_at": now_iso,
                "updated_at": now_iso,
            })

    if marks and not mailer.dry_run:
        rest.upsert(WATERMARK_TABLE, marks, "scope,channel")
    print(f"[INFO] daily: {sent} email(s) sent.")
    return 0


def _resolve_recipient(
    scope: str,
    by_phone: Dict[str, Dict[str, str]],
    admin: Optional[Dict[str, str]],
) -> Optional[Dict[str, str]]:
    if scope == UNASSIGNED_SCOPE:
        return admin
    return by_phone.get(scope) or admin


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------

def main() -> int:
    mode = _env_required("NOTIFY_MODE").lower()
    if mode not in ("risk", "daily"):
        print(f"[FATAL] NOTIFY_MODE must be 'risk' or 'daily', got {mode!r}", file=sys.stderr)
        return 2

    dry_run = _env_flag("DRY_RUN")

    if mode == "daily" and not _env_flag("SKIP_HOUR_GATE"):
        target = _env_int("DAILY_HOUR_IL", 20)
        now_il = datetime.now(IL_TZ)
        if now_il.hour != target:
            print(
                f"[INFO] daily: Israel local hour is {now_il.hour}, "
                f"target is {target}. Exiting without sending."
            )
            return 0

    base_url = _env_required("SUPABASE_URL")
    service_key = _env_required("SUPABASE_SERVICE_ROLE_KEY")

    rest = Rest(base_url, service_key)
    mailer = Mailer(dry_run)

    if mode == "risk":
        return run_risk(rest, mailer)
    return run_daily(rest, mailer)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"[FATAL] {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
