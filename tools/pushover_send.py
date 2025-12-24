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

import os
import argparse
import requests
from typing import Optional, List


PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json"


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

    # URL comes from Secrets (env) by default
    url = os.environ.get("PUSHOVER_URL", "").strip()
    url_title = os.environ.get("PUSHOVER_URL_TITLE", "פתח פרטים").strip() or "פתח פרטים"

    if not token or not user1:
        raise RuntimeError("Missing env vars: PUSHOVER_TOKEN and/or PUSHOVER_USER")

    recipients: List[str] = [user1]
    if user2:
        recipients.append(user2)

    base_data = {
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

    for user_key in recipients:
        data = dict(base_data)
        data["user"] = user_key

        resp = requests.post(PUSHOVER_ENDPOINT, data=data, timeout=20)
        resp.raise_for_status()


def main() -> int:
    p = argparse.ArgumentParser(description="Send a Pushover push notification.")
    p.add_argument("-t", "--title", default="🔴 התראה חשובה", help="Notification title")
    p.add_argument("-m", "--message", required=True, help="Notification message/body")
    p.add_argument(
        "--priority",
        type=int,
        default=1,
        choices=[-2, -1, 0, 1, 2],
        help="Pushover priority (-2,-1,0,1,2). Default: 1",
    )
    p.add_argument(
        "--sound",
        default="siren",
        help="Pushover sound (e.g. siren, pushover, etc.). Default: siren (set empty to omit)",
    )

    args = p.parse_args()

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
