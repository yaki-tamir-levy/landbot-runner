#!/usr/bin/env python3
"""
pushover_send.py
Send a single Pushover push notification and exit.

Requirements:
  pip install requests

Environment variables:
  PUSHOVER_TOKEN  - your Pushover Application/API Token
  PUSHOVER_USER   - your Pushover User Key (or Group Key)

Usage examples:
  python pushover_send.py --title "🔴 התראה חשובה" --message "בדיקה: הודעה מהמערכת" --priority 1 --sound siren
  python pushover_send.py -t "Hello" -m "World"
"""

import os
import argparse
import requests


PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json"


def send_pushover(*, title: str, message: str, priority: int = 0, sound: str | None = None,
                  url: str | None = None, url_title: str | None = None) -> None:
    token = os.environ.get("PUSHOVER_TOKEN")
    user = os.environ.get("PUSHOVER_USER")
    if not token or not user:
        raise RuntimeError("Missing env vars: PUSHOVER_TOKEN and/or PUSHOVER_USER")

    data = {
        "token": token,
        "user": user,
        "title": title,
        "message": message,
        "priority": str(priority),
    }
    if sound:
        data["sound"] = sound
    if url:
        data["url"] = url
    if url_title:
        data["url_title"] = url_title

    resp = requests.post(PUSHOVER_ENDPOINT, data=data, timeout=20)
    resp.raise_for_status()


def main() -> int:
    p = argparse.ArgumentParser(description="Send a Pushover push notification.")
    p.add_argument("-t", "--title", default="🔴 התראה חשובה", help="Notification title")
    p.add_argument("-m", "--message", required=True, help="Notification message/body")
    p.add_argument("--priority", type=int, default=1, choices=[-2, -1, 0, 1, 2],
                   help="Pushover priority (-2,-1,0,1,2). Default: 1")
    p.add_argument("--sound", default="siren", help="Pushover sound (e.g. siren, pushover, etc.). Default: siren")
    p.add_argument("--url", default=None, help="Optional URL to attach to the notification")
    p.add_argument("--url-title", default=None, help="Optional URL title")

    args = p.parse_args()

    send_pushover(
        title=args.title,
        message=args.message,
        priority=args.priority,
        sound=args.sound,
        url=args.url,
        url_title=args.url_title,
    )
    print("Sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
