#!/usr/bin/env python3
"""
tools/risk_reviews_notify.py

Behavior (UPDATED):
- Fetch rows from Supabase table risk_reviews BUT ONLY those that are NOT reviewed.
- If >= 1 non-reviewed row exists -> send ONE Pushover notification (with count + short preview).
- If 0 non-reviewed rows -> exit quietly (no notification).

Uses tools/pushover_send.py for sending, so PUSHOVER_URL and PUSHOVER_USER_2 work automatically.

Required env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  PUSHOVER_TOKEN
  PUSHOVER_USER

Optional env vars:
  RISK_REVIEWS_TABLE   default: risk_reviews
  PAGE_SIZE            default: 500
  PREVIEW_ROWS         default: 5   (how many rows to include in preview)
  STATUS_FIELD         default: status
  REVIEWED_VALUE       default: reviewed
"""

import os
import sys
import json
import subprocess
from typing import Any, Dict, List, Optional

import requests


def env_required(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def _safe_str(x: Any) -> str:
    if x is None:
        return ""
    if isinstance(x, (dict, list)):
        return json.dumps(x, ensure_ascii=False)
    return str(x)


def _pick(row: Dict[str, Any], keys: List[str]) -> Optional[str]:
    for k in keys:
        if k in row and row[k] is not None:
            s = _safe_str(row[k]).strip()
            if s:
                return s
    return None


def fetch_all_non_reviewed_rows() -> List[Dict[str, Any]]:
    """
    Fetch only rows that are NOT reviewed.
    Implemented with PostgREST filter: <status_field>=neq.<reviewed_value>
    """
    supabase_url = env_required("SUPABASE_URL").rstrip("/")
    service_key = env_required("SUPABASE_SERVICE_ROLE_KEY")

    table = os.environ.get("RISK_REVIEWS_TABLE", "risk_reviews").strip() or "risk_reviews"
    page_size = int(os.environ.get("PAGE_SIZE", "500"))

    status_field = os.environ.get("STATUS_FIELD", "status").strip() or "status"
    reviewed_value = os.environ.get("REVIEWED_VALUE", "reviewed").strip() or "reviewed"

    endpoint = f"{supabase_url}/rest/v1/{table}"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
        "Prefer": "count=exact",
    }

    # PostgREST filter syntax: ?status=neq.reviewed
    params = {"select": "*", status_field: f"neq.{reviewed_value}"}

    out: List[Dict[str, Any]] = []
    start = 0

    while True:
        end = start + page_size - 1
        h = dict(headers)
        h["Range"] = f"{start}-{end}"

        resp = requests.get(endpoint, headers=h, params=params, timeout=30)
        if resp.status_code == 416:
            break
        resp.raise_for_status()

        batch = resp.json()
        if not isinstance(batch, list) or len(batch) == 0:
            break

        out.extend(batch)
        start += page_size

    return out


def format_one_line(row: Dict[str, Any]) -> str:
    # Try to be schema-agnostic + include status for clarity
    time_val = _pick(row, ["time", "created_at", "inserted_at", "ts", "time_key"])
    phone = _pick(row, ["phone", "user_phone", "patient_phone"])
    name = _pick(row, ["name", "patient_name", "db_name"])
    status = _pick(row, ["status", "state"])
    snippet = _pick(row, ["snippet_text", "pattern", "pattern_key", "risk_text", "match_text"])

    parts: List[str] = []
    if time_val:
        parts.append(time_val)
    if phone:
        parts.append(phone)
    if name:
        parts.append(name)
    if status:
        parts.append(f"status={status}")
    if snippet:
        parts.append(snippet)

    line = " | ".join(parts) if parts else "row"
    if len(line) > 160:
        line = line[:160] + "…"
    return line


def send_one_notification(total: int, rows: List[Dict[str, Any]]) -> None:
    preview_n = int(os.environ.get("PREVIEW_ROWS", "5"))
    preview = rows[: max(0, preview_n)]

    lines: List[str] = []
    lines.append(f"נמצאו {total} רשומות פתוחות (לא reviewed) ב-risk_reviews")
    if preview:
        lines.append("")
        lines.append("דוגמה:")
        for r in preview:
            lines.append(f"- {format_one_line(r)}")

    msg = "\n".join(lines)
    if len(msg) > 950:
        msg = msg[:950] + "…"

    cmd = [
        sys.executable,
        "tools/pushover_send.py",
        "--title",
        "🔴 RISK: רשומות פתוחות",
        "--message",
        msg,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(
            "pushover_send.py failed\n"
            f"STDOUT:\n{r.stdout}\n"
            f"STDERR:\n{r.stderr}\n"
        )


def main() -> int:
    rows = fetch_all_non_reviewed_rows()
    total = len(rows)

    if total <= 0:
        print("No NON-reviewed rows in risk_reviews. No notification sent.")
        return 0

    send_one_notification(total, rows)
    print(f"Sent ONE notification for {total} non-reviewed rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
