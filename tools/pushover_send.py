#!/usr/bin/env python3
"""
tools/pushover_send.py
Send a single Pushover notification and exit.

Required env vars (set by GitHub Secrets via workflow env):
  PUSHOVER_TOKEN  - Pushover Application/API Token
  PUSHOVER_USER   - Pushover User Key (or Group Key)

Optional env vars (also via Secrets):
  PUSHOVER_URL        - default URL to attach
  PUSHOVER_URL_TITLE  - default URL title (default: "פתח פרטים")

Requires:
  pip install requests

Usage:
  python tools/pushover_send.py --message "טקסט ההודעה"
  python tools/pushover_send.py --title "🔴 התראה חשובה" --message "..." --priority 1 --sound siren
"""

import os
import argparse
import requests


PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json"


def send_pushover(*, title: str, message: str, priority: int, sound: str | None) -> None:
    token = os.environ.get("PUSHOVER_TOKEN")
    user = os.environ.get("PUSHOVER_USER")

    # URL comes from Secrets (env) by default
    url = os.environ.get("PUSHOVER_URL", "").strip()
    url_title = os.environ.get("PUSHOVER_URL_TITLE", "פתח פרטים").strip() or "פתח פרטים"

    if not token or not user:
        raise RuntimeError("Missing env vars: PUSHOVER_TOKEN and/or PUSHOVER_USER")

    data: dict[str, str] = {
        "token": token,
        "user": user,
        "title": title,
        "message": message,
        "priority": str(priority),
    }

    if sound:
        data["sound"] = sound

    # Attach URL only if provided
    if url:
        data["url"] = url
        data["url_title"] = url_title

    resp = requests.post(PUSHOVER_ENDPOINT, data=data, timeout=20)
    resp.raise_for_status()


def main() -> int:
    p = argparse.ArgumentParser(description="Send a Pushover push notification.")
    p.add_argument("-t", "--title", default="🔴 התראה חשובה", help="Notification title")
    p.add_argument("-m", "--message", required=True, help="Notification message/body")
    p.add_argument("--priority", type=int, default=1, choices=[-2, -1, 0, 1, 2],
                   help="Pushover priority (-2,-1,0,1,2). Default: 1")
    p.add_argument("--sound", default="siren",
                   help="Pushover sound (e.g. siren, pushover, etc.). Default: siren (set empty to omit)")

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
