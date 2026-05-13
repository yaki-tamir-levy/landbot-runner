#!/usr/bin/env python3
"""
tools/pushover_send.py
Send one or more Pushover notifications and exit.

Required env vars (GitHub Secrets):
  PUSHOVER_TOKEN   - Pushover Application/API Token
  PUSHOVER_USER    - Primary Pushover User Key (or Group Key)

Optional env vars:
  PUSHOVER_USER_2      - Optional second User Key (another phone/person)
  PUSHOVER_URL         - Default URL to attach
  PUSHOVER_URL_TITLE   - Default URL title (default: "פתח פרטים")

Requires:
  pip install requests

Usage:
  python tools/pushover_send.py --message "טקסט ההודעה"
  python tools/pushover_send.py --title "🔴 התראה חשובה" --message "..." --priority 1 --sound siren
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

import requests


PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json"


def _mask_secret(value: Optional[str]) -> str:
    """Return a safe masked representation for logs."""
    if not value:
        return "<missing>"

    value = value.strip()
    if len(value) <= 8:
        return f"<set:length={len(value)}>"

    return f"{value[:4]}...{value[-4:]} (length={len(value)})"


def _safe_json(payload: Any) -> str:
    """Format response safely for GitHub Actions logs."""
    try:
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)
    except Exception:
        return str(payload)


def _parse_response(resp: requests.Response) -> Dict[str, Any]:
    """Parse Pushover response as JSON when possible."""
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            return payload
        return {"raw": payload}
    except Exception:
        return {"raw_text": resp.text}


def _raise_for_pushover_failure(resp: requests.Response, payload: Dict[str, Any], recipient_label: str) -> None:
    """Fail clearly on HTTP errors or Pushover application-level errors."""
    if resp.status_code >= 400:
        print(
            f"[ERROR] Pushover HTTP failure for {recipient_label}: "
            f"http_status={resp.status_code}, response={_safe_json(payload)}",
            file=sys.stderr,
        )
        resp.raise_for_status()

    pushover_status = payload.get("status")
    if pushover_status != 1:
        print(
            f"[ERROR] Pushover API rejected message for {recipient_label}: "
            f"http_status={resp.status_code}, response={_safe_json(payload)}",
            file=sys.stderr,
        )
        raise RuntimeError(f"Pushover API rejected message for {recipient_label}")


def send_pushover(
    *,
    title: str,
    message: str,
    priority: int,
    sound: Optional[str],
) -> None:
    token = os.environ.get("PUSHOVER_TOKEN")
    user1 = os.environ.get("PUSHOVER_USER")
    user2 = os.environ.get("PUSHOVER_USER_2")

    url = os.environ.get("PUSHOVER_URL", "").strip()
    url_title = os.environ.get("PUSHOVER_URL_TITLE", "פתח פרטים").strip() or "פתח פרטים"

    if not token or not user1:
        raise RuntimeError("Missing env vars: PUSHOVER_TOKEN and/or PUSHOVER_USER")

    recipients: List[tuple[str, str]] = [("PUSHOVER_USER", user1)]
    if user2:
        recipients.append(("PUSHOVER_USER_2", user2))

    base_data: Dict[str, str] = {
        "token": token,
        "title": title,
        "message": message,
        "priority": str(priority),
    }

    if sound:
        base_data["sound"] = sound

    if url:
        base_data["url"] = url
        base_data["url_title"] = url_title

    print(
        "[INFO] Sending Pushover notification: "
        f"recipients={len(recipients)}, "
        f"title_length={len(title)}, "
        f"message_length={len(message)}, "
        f"priority={priority}, "
        f"sound={sound or '<none>'}, "
        f"url_attached={'yes' if url else 'no'}"
    )
    print(f"[INFO] PUSHOVER_TOKEN={_mask_secret(token)}")

    for recipient_label, user_key in recipients:
        data = dict(base_data)
        data["user"] = user_key

        print(f"[INFO] Sending to {recipient_label}={_mask_secret(user_key)}")

        resp = requests.post(PUSHOVER_ENDPOINT, data=data, timeout=20)
        payload = _parse_response(resp)

        _raise_for_pushover_failure(resp, payload, recipient_label)

        request_id = payload.get("request", "<none>")
        print(
            f"[OK] Pushover accepted message for {recipient_label}: "
            f"http_status={resp.status_code}, status={payload.get('status')}, request={request_id}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a Pushover push notification.")
    parser.add_argument("-t", "--title", default="🔴 התראה חשובה", help="Notification title")
    parser.add_argument("-m", "--message", required=True, help="Notification message/body")
    parser.add_argument(
        "--priority",
        type=int,
        default=1,
        choices=[-2, -1, 0, 1, 2],
        help="Pushover priority (-2,-1,0,1,2). Default: 1",
    )
    parser.add_argument(
        "--sound",
        default="siren",
        help="Pushover sound (e.g. siren, pushover, etc.). Default: siren (set empty to omit)",
    )

    args = parser.parse_args()

    sound = args.sound.strip() if args.sound is not None else None
    if sound == "":
        sound = None

    send_pushover(
        title=args.title,
        message=args.message,
        priority=args.priority,
        sound=sound,
    )

    print("Sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
