#!/usr/bin/env python3
"""
tools/risk_reviews_notify.py  (v03)

Purpose
-------
Fetch rows from a Supabase table (default: risk_reviews). If there are rows that appear "pending review",
send ONE Pushover notification with:
- total count
- a short preview of up to PREVIEW_ROWS items (Name / Phone + truncated Risk Reasons)

This script is defensive against schema changes:
- It first tries common lowercase field names: name, phone, risk_reasons
- If the API reports unknown columns, it retries with uppercase: NAME, PHONE, RISK_REASONS
- It will try to filter out "reviewed" rows using STATUS_FIELD/REVIEWED_VALUE, but if that column doesn't exist,
  it falls back to no status filter.

Env vars
--------
Required:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  PUSHOVER_TOKEN
  PUSHOVER_USER

Optional:
  RISK_REVIEWS_TABLE   default: risk_reviews
  PAGE_SIZE            default: 500
  PREVIEW_ROWS         default: 5
  STATUS_FIELD         default: status
  REVIEWED_VALUE       default: reviewed
  NAME_FIELD           default: name
  PHONE_FIELD          default: phone
  RISK_REASONS_FIELD   default: risk_reasons

Pushover integration uses tools/pushover_send.py, so these optional envs are also supported:
  PUSHOVER_USER_2
  PUSHOVER_URL
  PUSHOVER_URL_TITLE
"""

import os
import sys
import json
import subprocess
from typing import Any, Dict, List, Tuple, Optional

import requests


def env_required(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        print(f"[ERROR] Missing required env var: {name}", file=sys.stderr)
        sys.exit(2)
    return v


def env_int(name: str, default: int) -> int:
    v = os.environ.get(name, "").strip()
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        print(f"[WARN] Invalid int for {name}={v!r}; using default {default}", file=sys.stderr)
        return default


def supabase_get(
    base_url: str,
    service_key: str,
    table: str,
    select_fields: List[str],
    status_field: str,
    reviewed_value: str,
    use_status_filter: bool,
    offset: int,
    limit: int,
) -> Tuple[int, Any, str]:
    """
    Returns (status_code, json_or_text, content_type)
    """
    url = f"{base_url.rstrip('/')}/rest/v1/{table}"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
    }

    params = {
        "select": ",".join(select_fields),
        "limit": str(limit),
        "offset": str(offset),
    }

    # Always prefer only rows with non-empty-ish risk reasons.
    # Server-side null filter where possible; empty-string will be filtered client-side.
    # PostgREST: risk_reasons=not.is.null
    # We'll add it only if the field exists; if it doesn't, the call will fail and we retry with alternate fields.
    # Here we assume field name is in select_fields[-1] maybe, but caller provides correct name.
    risk_field = select_fields[-1]
    params[f"{risk_field}"] = "not.is.null"

    if use_status_filter:
        # Exclude reviewed rows. If status_field doesn't exist, Supabase will return 400 and we will retry.
        params[f"{status_field}"] = f"neq.{reviewed_value}"

    r = requests.get(url, headers=headers, params=params, timeout=30)
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


def looks_like_unknown_column(err: Any) -> bool:
    """
    Supabase/PostgREST error shapes vary. We'll do best-effort detection.
    """
    s = ""
    if isinstance(err, dict):
        s = json.dumps(err, ensure_ascii=False)
    else:
        s = str(err)
    s_low = s.lower()
    return ("column" in s_low and "does not exist" in s_low) or ("unknown" in s_low and "column" in s_low)


def normalize_str(x: Any) -> str:
    if x is None:
        return ""
    return str(x).strip()


def truncate(s: str, n: int) -> str:
    s = s.replace("\r", " ").replace("\n", " ").strip()
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)].rstrip() + "…"


def send_pushover(message: str, title: str) -> None:
    """
    Delegate sending to tools/pushover_send.py so existing env support stays consistent.
    """
    cmd = [sys.executable, "tools/pushover_send.py", "--title", title, "--message", message]
    # pushover_send.py may read env vars directly (token/user/url, etc.)
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        print("[ERROR] pushover_send.py failed", file=sys.stderr)
        if p.stdout:
            print(p.stdout, file=sys.stderr)
        if p.stderr:
            print(p.stderr, file=sys.stderr)
        sys.exit(p.returncode)


def main() -> int:
    base_url = env_required("SUPABASE_URL")
    service_key = env_required("SUPABASE_SERVICE_ROLE_KEY")

    table = os.environ.get("RISK_REVIEWS_TABLE", "risk_reviews").strip() or "risk_reviews"
    page_size = env_int("PAGE_SIZE", 500)
    preview_rows = env_int("PREVIEW_ROWS", 5)

    status_field = os.environ.get("STATUS_FIELD", "status").strip() or "status"
    reviewed_value = os.environ.get("REVIEWED_VALUE", "reviewed").strip() or "reviewed"

    # Allow overriding field names, but keep safe defaults.
    name_field_default = os.environ.get("NAME_FIELD", "name").strip() or "name"
    phone_field_default = os.environ.get("PHONE_FIELD", "phone").strip() or "phone"
    risk_field_default = os.environ.get("RISK_REASONS_FIELD", "risk_reasons").strip() or "risk_reasons"

    # We'll try a couple of field-name variants to survive schema casing changes.
    field_variants: List[Tuple[str, str, str]] = [
        (name_field_default, phone_field_default, risk_field_default),
        ("name", "phone", "risk_reasons"),
        ("NAME", "PHONE", "RISK_REASONS"),
    ]

    rows: List[Dict[str, Any]] = []
    used_fields: Optional[Tuple[str, str, str]] = None
    used_status_filter = True  # try first, fallback if status column missing

    # We'll attempt: (fields variant) x (status filter on/off) with pagination.
    last_err: Any = None
    for fields in field_variants:
        for status_filter in (True, False):
            # Only try status_filter=False after trying True (unless we already had to disable it globally)
            if not used_status_filter and status_filter:
                continue

            all_rows: List[Dict[str, Any]] = []
            offset = 0
            while True:
                code, payload, _ctype = supabase_get(
                    base_url=base_url,
                    service_key=service_key,
                    table=table,
                    select_fields=[fields[0], fields[1], fields[2]],
                    status_field=status_field,
                    reviewed_value=reviewed_value,
                    use_status_filter=status_filter,
                    offset=offset,
                    limit=page_size,
                )

                if code >= 400:
                    last_err = payload
                    # If status filter caused unknown column, retry without it for same fields.
                    if status_filter and looks_like_unknown_column(payload):
                        used_status_filter = False
                        break  # break pagination; outer loop will try status_filter=False
                    # If field names are wrong, try next variant
                    if looks_like_unknown_column(payload):
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
            if all_rows:
                rows = all_rows
                used_fields = fields
                used_status_filter = status_filter
                break

            # If we didn't get rows but also didn't hit a fatal error, we still accept the schema and stop
            # (means there are simply zero pending items)
            if last_err is None:
                rows = []
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
        reasons = normalize_str(r.get(risk_f))
        if not reasons:
            continue
        pending.append(r)

    if len(pending) == 0:
        # Exit quietly - no notification
        print("[INFO] No pending risk reviews. Exiting quietly.")
        return 0

    # Build preview
    preview_lines: List[str] = []
    for r in pending[: max(1, preview_rows)]:
        nm = normalize_str(r.get(name_f)) or "-"
        ph = normalize_str(r.get(phone_f)) or "-"
        rr = truncate(normalize_str(r.get(risk_f)), 120) or "-"
        preview_lines.append(f"- {nm} | {ph} | {rr}")

    title = f"Risk reviews pending: {len(pending)}"
    msg = "יש רשומות שמחכות לבדיקה:\n" + "\n".join(preview_lines)

    send_pushover(message=msg, title=title)
    print(f"[OK] Sent notification. count={len(pending)} (status_filter={used_status_filter}, fields={used_fields})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
