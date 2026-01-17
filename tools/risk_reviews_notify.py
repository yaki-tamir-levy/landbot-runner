#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
risk_reviews_notify_v04.py

Purpose:
- Fetch NEW risk review rows from Supabase (status = 'NEW')
- Send notification via Pushover
- Optionally send email via Gmail SMTP (App Password) when EMAIL_ENABLED="1"

Designed for GitHub Actions (env vars), but also works locally.

Required env vars (Supabase):
- SUPABASE_URL                      e.g. https://xxxx.supabase.co
- SUPABASE_SERVICE_ROLE_KEY         service_role key (recommended for server-side scripts)

Optional env vars (Supabase):
- SUPABASE_SCHEMA                   default: public
- RISK_REVIEWS_TABLE                default: risk_reviews
- SUPABASE_TIMEOUT_SECONDS          default: 20
- SUPABASE_SELECT                   default: id,time_key,phone,name,severity,short_risk,risk_reasons,line_num,created_at,status

Required env vars (Pushover):
- PUSHOVER_APP_TOKEN
- PUSHOVER_USER_KEY

Email env vars (Gmail SMTP):
- EMAIL_ENABLED                     "1" to enable (anything else disables)
- GMAIL_SMTP_USER
- GMAIL_APP_PASSWORD
- EMAIL_TO                          e.g. yonatan10.bot@gmail.com

Optional email env vars:
- EMAIL_FROM                        default: GMAIL_SMTP_USER
- EMAIL_SUBJECT_PREFIX              default: [RISK]
- SMTP_HOST                         default: smtp.gmail.com
- SMTP_PORT                         default: 587
- EMAIL_MAX_ITEMS                   default: 50

Other optional env vars:
- DRY_RUN                           "1" to not send anything (prints what it would do)
- PUSHOVER_TITLE                    default: Risk Reviews
- PUSHOVER_PRIORITY                 default: 0
- PUSHOVER_SOUND                    default: pushover
"""

from __future__ import annotations

import os
import sys
import json
import time
import smtplib
import traceback
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any, Dict, List, Optional, Tuple

import requests


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    if v is None or v == "":
        return default
    return v


def _env_int(name: str, default: int) -> int:
    v = _env(name)
    if v is None:
        return default
    try:
        return int(v)
    except Exception:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    v = _env(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "y", "on")


@dataclass
class Config:
    # Supabase
    supabase_url: str
    supabase_service_role_key: str
    supabase_schema: str = "public"
    risk_reviews_table: str = "risk_reviews"
    supabase_timeout_seconds: int = 20
    supabase_select: str = "id,time_key,phone,name,severity,short_risk,risk_reasons,line_num,created_at,status"

    # Pushover
    pushover_app_token: str = ""
    pushover_user_key: str = ""
    pushover_title: str = "Risk Reviews"
    pushover_priority: str = "0"
    pushover_sound: str = "pushover"

    # Email
    email_enabled: bool = False
    gmail_smtp_user: str = ""
    gmail_app_password: str = ""
    email_to: str = ""
    email_from: str = ""
    email_subject_prefix: str = "[RISK]"
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    email_max_items: int = 50

    # Other
    dry_run: bool = False


def load_config() -> Config:
    supabase_url = _env("SUPABASE_URL")
    supabase_key = _env("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not supabase_key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    cfg = Config(
        supabase_url=supabase_url.rstrip("/"),
        supabase_service_role_key=supabase_key,
        supabase_schema=_env("SUPABASE_SCHEMA", "public") or "public",
        risk_reviews_table=_env("RISK_REVIEWS_TABLE", "risk_reviews") or "risk_reviews",
        supabase_timeout_seconds=_env_int("SUPABASE_TIMEOUT_SECONDS", 20),
        supabase_select=_env("SUPABASE_SELECT", "id,time_key,phone,name,severity,short_risk,risk_reasons,line_num,created_at,status")
        or "id,time_key,phone,name,severity,short_risk,risk_reasons,line_num,created_at,status",
        pushover_app_token=_env("PUSHOVER_APP_TOKEN", "") or "",
        pushover_user_key=_env("PUSHOVER_USER_KEY", "") or "",
        pushover_title=_env("PUSHOVER_TITLE", "Risk Reviews") or "Risk Reviews",
        pushover_priority=_env("PUSHOVER_PRIORITY", "0") or "0",
        pushover_sound=_env("PUSHOVER_SOUND", "pushover") or "pushover",
        email_enabled=_env("EMAIL_ENABLED", "").strip() == "1",
        gmail_smtp_user=_env("GMAIL_SMTP_USER", "") or "",
        gmail_app_password=_env("GMAIL_APP_PASSWORD", "") or "",
        email_to=_env("EMAIL_TO", "") or "",
        email_from=_env("EMAIL_FROM", "") or "",
        email_subject_prefix=_env("EMAIL_SUBJECT_PREFIX", "[RISK]") or "[RISK]",
        smtp_host=_env("SMTP_HOST", "smtp.gmail.com") or "smtp.gmail.com",
        smtp_port=_env_int("SMTP_PORT", 587),
        email_max_items=_env_int("EMAIL_MAX_ITEMS", 50),
        dry_run=_env_bool("DRY_RUN", False),
    )

    # Validate Pushover vars (only if not dry-run and we intend to send pushover)
    if not cfg.dry_run:
        if not cfg.pushover_app_token or not cfg.pushover_user_key:
            raise RuntimeError("Missing PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY")

    # Email defaults
    if cfg.email_enabled:
        if not cfg.gmail_smtp_user or not cfg.gmail_app_password or not cfg.email_to:
            raise RuntimeError("EMAIL_ENABLED=1 but missing one of: GMAIL_SMTP_USER, GMAIL_APP_PASSWORD, EMAIL_TO")
        if not cfg.email_from:
            cfg.email_from = cfg.gmail_smtp_user

    return cfg


def supabase_headers(cfg: Config) -> Dict[str, str]:
    return {
        "apikey": cfg.supabase_service_role_key,
        "Authorization": f"Bearer {cfg.supabase_service_role_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def fetch_new_rows(cfg: Config) -> List[Dict[str, Any]]:
    """
    Fetch rows with status=NEW only (hard filter).
    """
    url = f"{cfg.supabase_url}/rest/v1/{cfg.risk_reviews_table}"
    params = {
        "select": cfg.supabase_select,
        "status": "eq.NEW",
        "order": "created_at.desc",
        "limit": str(cfg.email_max_items),  # cap for safety
    }

    r = requests.get(url, headers=supabase_headers(cfg), params=params, timeout=cfg.supabase_timeout_seconds)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase GET failed: {r.status_code} {r.text}")

    data = r.json()
    if not isinstance(data, list):
        raise RuntimeError(f"Unexpected Supabase response (expected list): {type(data)}")

    # Normalize
    cleaned: List[Dict[str, Any]] = []
    for row in data:
        if isinstance(row, dict) and str(row.get("status", "")).upper() == "NEW":
            cleaned.append(row)
    return cleaned


def _safe(s: Any) -> str:
    if s is None:
        return ""
    return str(s).strip()


def build_summary(rows: List[Dict[str, Any]], max_lines: int = 10) -> Tuple[str, str]:
    """
    Returns: (short_text_for_pushover, full_text_for_email)
    """
    total = len(rows)
    if total == 0:
        return ("No NEW rows.", "No NEW rows.")

    # Sort: newest first if created_at exists, else keep as-is
    def keyfunc(r: Dict[str, Any]) -> str:
        return _safe(r.get("created_at")) or _safe(r.get("time_key"))

    rows_sorted = sorted(rows, key=keyfunc, reverse=True)

    # Short lines (pushover)
    lines: List[str] = []
    for i, r in enumerate(rows_sorted[:max_lines], start=1):
        sev = _safe(r.get("severity"))
        phone = _safe(r.get("phone"))
        name = _safe(r.get("name"))
        line_num = _safe(r.get("line_num"))
        short_risk = _safe(r.get("short_risk"))
        risk_reasons = _safe(r.get("risk_reasons"))

        who = name or phone or "unknown"
        suffix = []
        if sev:
            suffix.append(f"sev={sev}")
        if line_num:
            suffix.append(f"line={line_num}")
        suffix_txt = (" (" + ", ".join(suffix) + ")") if suffix else ""

        main = short_risk or risk_reasons or ""
        if len(main) > 120:
            main = main[:117] + "..."

        lines.append(f"{i}. {who}{suffix_txt}: {main}".strip())

    if total > max_lines:
        lines.append(f"...and {total - max_lines} more")

    pushover_text = f"NEW risk reviews: {total}\n" + "\n".join(lines)

    # Full email body
    now_utc = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    full_lines: List[str] = []
    full_lines.append(f"NEW risk reviews: {total}")
    full_lines.append(f"Generated: {now_utc}")
    full_lines.append("")
    for i, r in enumerate(rows_sorted, start=1):
        parts = {
            "id": _safe(r.get("id")),
            "time_key": _safe(r.get("time_key")),
            "phone": _safe(r.get("phone")),
            "name": _safe(r.get("name")),
            "severity": _safe(r.get("severity")),
            "line_num": _safe(r.get("line_num")),
            "created_at": _safe(r.get("created_at")),
            "short_risk": _safe(r.get("short_risk")),
            "risk_reasons": _safe(r.get("risk_reasons")),
            "status": _safe(r.get("status")),
        }
        full_lines.append(f"{i})")
        for k, v in parts.items():
            if v != "":
                full_lines.append(f"  {k}: {v}")
        full_lines.append("")

    email_text = "\n".join(full_lines).strip() + "\n"
    return pushover_text, email_text


def send_pushover(cfg: Config, message: str) -> None:
    url = "https://api.pushover.net/1/messages.json"
    payload = {
        "token": cfg.pushover_app_token,
        "user": cfg.pushover_user_key,
        "title": cfg.pushover_title,
        "message": message,
        "priority": cfg.pushover_priority,
        "sound": cfg.pushover_sound,
    }

    if cfg.dry_run:
        print("[DRY_RUN] Would send Pushover:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    r = requests.post(url, data=payload, timeout=20)
    if r.status_code >= 400:
        raise RuntimeError(f"Pushover send failed: {r.status_code} {r.text}")


def send_email(cfg: Config, subject: str, body: str) -> None:
    if not cfg.email_enabled:
        print("EMAIL_ENABLED is not '1' -> email disabled.")
        return

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg.email_from
    msg["To"] = cfg.email_to
    msg.set_content(body)

    if cfg.dry_run:
        print("[DRY_RUN] Would send Email:")
        print("To:", cfg.email_to)
        print("From:", cfg.email_from)
        print("Subject:", subject)
        print("Body preview:\n", body[:800])
        return

    with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=30) as server:
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(cfg.gmail_smtp_user, cfg.gmail_app_password)
        server.send_message(msg)


def main() -> int:
    try:
        cfg = load_config()
        rows = fetch_new_rows(cfg)

        if len(rows) == 0:
            print("No NEW rows found. Nothing to notify.")
            return 0

        pushover_text, email_text = build_summary(rows, max_lines=10)

        # Pushover
        send_pushover(cfg, pushover_text)
        print(f"Sent Pushover for {len(rows)} NEW rows.")

        # Email
        subject = f"{cfg.email_subject_prefix} {len(rows)} NEW risk reviews"
        send_email(cfg, subject, email_text)
        if cfg.email_enabled:
            print(f"Sent Email to {cfg.email_to} for {len(rows)} NEW rows.")
        else:
            print("Email disabled.")

        return 0

    except Exception as e:
        print("ERROR:", str(e))
        traceback.print_exc()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
