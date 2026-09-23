#!/usr/bin/env python3
"""
tools/admin_daily_report.py — the admin daily activity report (23.9.2026).

Sends the admin one email with the previous Israel calendar day's activity:
people, conversations, risks, logins and access, emails, and automation
(pg_cron jobs from the database, GitHub Actions runs from the GitHub API).

All data comes from public.admin_daily_report_v2(p_day), which is read-only
and callable by service_role only. The detail level (masked phones, risk
wording, recipients) is controlled in the database by app_config key
'admin_daily_report_detail': 'full' or anything else for counts only.
No code change is needed to drop the detail.

Scheduling: the workflow fires twice (06:00 and 07:00 UTC) because GitHub
cron is UTC-only and Israel shifts between UTC+2 and UTC+3. The script sends
only when the Israel hour is >= REPORT_HOUR_IL and no successful report for
that day is already in email_send_log. So a delayed run still sends, and the
second run of the same morning does nothing.

Every send (success or failure) is written to public.email_send_log.

Environment
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
  GMAIL_SMTP_USER, GMAIL_APP_PASSWORD       required unless DRY_RUN=1
  EMAIL_FROM                                optional, defaults to GMAIL_SMTP_USER
  SMTP_HOST / SMTP_PORT                     optional, smtp.gmail.com / 587
  REPORT_HOUR_IL                            optional, default 9
  REPORT_DAY                                optional YYYY-MM-DD, default yesterday (Israel)
  SKIP_HOUR_GATE=1                          ignore hour gate and the already-sent check
  DRY_RUN=1                                 build the email, send nothing, log nothing;
                                            prints sizes only (Actions logs are public)
  GITHUB_TOKEN, GITHUB_REPOSITORY           optional, for the GitHub Actions section
  REPORT_JSON_FILE                          optional, offline render test (no network)
"""

import html
import json
import os
import smtplib
import sys
from datetime import date, datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import requests

IL = ZoneInfo("Asia/Jerusalem")
HTTP_TIMEOUT = 30
SENDER = "admin_daily_report"


# ---------------------------------------------------------------- env
def env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return v.strip() if v and v.strip() else default


def env_required(name: str) -> str:
    v = env(name)
    if not v:
        print(f"[FATAL] missing env {name}", file=sys.stderr)
        sys.exit(2)
    return v


def flag(name: str) -> bool:
    return env(name) in ("1", "true", "yes")


# ---------------------------------------------------------------- supabase
class Db:
    def __init__(self) -> None:
        self.base = env_required("SUPABASE_URL").rstrip("/")
        key = env_required("SUPABASE_SERVICE_ROLE_KEY")
        self.h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def rpc(self, fn: str, body: Dict[str, Any]) -> Any:
        r = requests.post(f"{self.base}/rest/v1/rpc/{fn}", headers=self.h, json=body, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def select(self, table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
        r = requests.get(f"{self.base}/rest/v1/{table}", headers=self.h, params=params, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def insert(self, table: str, row: Dict[str, Any]) -> None:
        h = dict(self.h, Prefer="return=minimal")
        r = requests.post(f"{self.base}/rest/v1/{table}", headers=h, json=row, timeout=HTTP_TIMEOUT)
        r.raise_for_status()


def load_admin(db: Db) -> Optional[Dict[str, str]]:
    rows = db.select("psychologists_v2", {"select": "email,name,active,is_admin", "is_admin": "eq.true"})
    for r in rows:
        if r.get("active") and (r.get("email") or "").strip():
            return {"email": r["email"].strip(), "name": r.get("name") or ""}
    return None


def already_sent(db: Db, day: str) -> bool:
    rows = db.select("email_send_log", {
        "select": "id", "sender": f"eq.{SENDER}", "ok": "eq.true",
        "meta->>day": f"eq.{day}", "limit": "1"})
    return len(rows) > 0


# ---------------------------------------------------------------- github
def github_runs(day: date) -> Optional[Dict[str, Any]]:
    token = env("GITHUB_TOKEN")
    repo = env("GITHUB_REPOSITORY")
    if not token or not repo:
        return None
    start = datetime(day.year, day.month, day.day, tzinfo=IL)
    end = start + timedelta(days=1)
    q = f"{start.astimezone(ZoneInfo('UTC')).strftime('%Y-%m-%dT%H:%M:%SZ')}..{end.astimezone(ZoneInfo('UTC')).strftime('%Y-%m-%dT%H:%M:%SZ')}"
    h = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    by_wf: Dict[str, Dict[str, int]] = {}
    total = 0
    page = 1
    try:
        while page <= 20:
            r = requests.get(f"https://api.github.com/repos/{repo}/actions/runs",
                             headers=h, params={"created": q, "per_page": "100", "page": str(page)},
                             timeout=HTTP_TIMEOUT)
            r.raise_for_status()
            runs = r.json().get("workflow_runs", [])
            for run in runs:
                name = run.get("name") or "(unnamed)"
                c = run.get("conclusion") or run.get("status") or "unknown"
                by_wf.setdefault(name, {})
                by_wf[name][c] = by_wf[name].get(c, 0) + 1
                total += 1
            if len(runs) < 100:
                break
            page += 1
    except Exception as e:  # the report must still go out
        return {"error": str(e)}
    return {"total": total, "by_workflow": by_wf}


# ---------------------------------------------------------------- render
def e(v: Any) -> str:
    return html.escape("" if v is None else str(v))


def t_il(iso: Optional[str]) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(IL).strftime("%H:%M")
    except ValueError:
        return str(iso)


SOURCE_HE = {"C": "טיפול", "D": "קורס"}
ORIGIN_HE = {"SHEET": "גיליון", "INTAKE": "קבלה"}
METHOD_HE = {"1": "מודל", "2": "ביטוי"}
SEVERITY_HE = {"high": "גבוהה", "medium": "בינונית", "low": "נמוכה"}
AUTH_HE = {"user_recovery_requested": "קוד כניסה", "user_confirmation_requested": "אישור הרשמה עם קוד",
           "user_repeated_signup": "הרשמה חוזרת", "user_invited": "הזמנה",
           "user_reauthenticate_requested": "אימות חוזר"}


def dict_line(d: Optional[Dict[str, Any]], names: Optional[Dict[str, str]] = None) -> str:
    if not d:
        return "—"
    names = names or {}
    return " · ".join(f"{e(names.get(str(k), k))}: {e(v)}" for k, v in d.items())


def table(headers: List[str], rows: List[List[Any]]) -> str:
    if not rows:
        return "<p style='color:#777'>אין.</p>"
    th = "".join(f"<th style='border:1px solid #ccc;padding:4px 8px;background:#f3f3f3'>{e(h)}</th>" for h in headers)
    trs = "".join("<tr>" + "".join(f"<td style='border:1px solid #ccc;padding:4px 8px'>{e(c)}</td>" for c in r) + "</tr>"
                  for r in rows)
    return f"<table style='border-collapse:collapse;font-size:13px'><tr>{th}</tr>{trs}</table>"


def kv(rows: List[List[Any]]) -> str:
    return "<table style='font-size:14px'>" + "".join(
        f"<tr><td style='padding:2px 10px 2px 0;color:#555'>{e(k)}</td><td><b>{v}</b></td></tr>" for k, v in rows
    ) + "</table>"


def h2(title: str) -> str:
    return f"<h3 style='margin:22px 0 6px;border-bottom:2px solid #333'>{e(title)}</h3>"


def render(d: Dict[str, Any], gh: Optional[Dict[str, Any]]) -> (str, str):
    day = date.fromisoformat(d["day"])
    day_he = f"{day.day}.{day.month}.{day.year}"
    full = d.get("detail") == "full"
    p, c, rk, a, m, au = (d.get(k) or {} for k in ("people", "conversations", "risks", "access", "emails", "automation"))

    cron = au.get("cron") or []
    cron_fails = sum(int(j.get("fails") or 0) for j in cron)
    gh_fail = 0
    if gh and "by_workflow" in gh:
        gh_fail = sum(v.get("failure", 0) for v in gh["by_workflow"].values())

    subject = f"מיתר — דוח פעילות יומי {day_he}"
    if int(rk.get("count") or 0) > 0:
        subject += f" · {rk['count']} ממצאי סיכון"
    if cron_fails or gh_fail or int(m.get("system_failed") or 0):
        subject += " · יש כשלים"

    out: List[str] = []
    out.append(f"<h2 style='margin:0'>דוח פעילות יומי — {e(day_he)}</h2>")
    out.append(f"<p style='color:#777;margin:4px 0'>חלון: 00:00–24:00 שעון ישראל · רמת פירוט: "
               f"{'מלאה' if full else 'ספירות בלבד'}</p>")

    out.append(h2("תקציר"))
    out.append(kv([
        ["שיחות פעילות", e(c.get("active_sessions"))],
        ["תורות", e(c.get("turns"))],
        ["ממצאי סיכון", e(rk.get("count"))],
        ["כניסות מטפלים", e(a.get("psychologist_logins"))],
        ["כניסות מטופלים עם קוד", e(a.get("patient_code_logins"))],
        ["מטופלים חדשים", e(p.get("new_patients_count"))],
        ["מטפלים חדשים", e(p.get("new_psychologists_count"))],
        ["מיילים", e(int(m.get("auth_count") or 0) + int(m.get("system_count") or 0))],
        ["כשלי תזמון במסד", e(cron_fails)],
        ["כשלי GitHub Actions", e(gh_fail) if gh and "by_workflow" in gh else "לא נבדק"],
    ]))

    out.append(h2("אנשים"))
    out.append(kv([
        ["מטופלים שעודכנו", e(p.get("updated_patients_count"))],
        ["מועמדי קבלה חדשים", e(p.get("intake_new_candidates"))],
        ["החלטות קבלה", dict_line(p.get("intake_decided"))],
        ["מועמדי קבלה שסומנו בסיכון", e(p.get("intake_risk_flagged"))],
    ]))
    if full:
        out.append("<p><b>מטפלים חדשים</b></p>")
        out.append(table(["שעה", "שם", "פעיל", "אדמין"],
                         [[t_il(x.get("at")), x.get("name"), x.get("active"), x.get("is_admin")]
                          for x in p.get("new_psychologists") or []]))
        out.append("<p><b>מטופלים חדשים</b></p>")
        out.append(table(["שעה", "טלפון", "מקור", "סטטוס", "פעיל", "מטפל"],
                         [[t_il(x.get("at")), x.get("phone"), ORIGIN_HE.get(x.get("origin"), x.get("origin")),
                           x.get("status"), x.get("active"), x.get("psychologist")]
                          for x in p.get("new_patients") or []]))

    out.append(h2("שיחות"))
    out.append(kv([
        ["שיחות שהתחילו", e(c.get("sessions_started"))],
        ["תורות בשיחות אמיתיות", e(c.get("turns"))],
        ["החלטות המנגנון המתקן", dict_line(c.get("corrector_decisions"))],
        ["קריאות בדיקה או סימולציה", e(c.get("test_or_sim_calls"))],
        ["שיחות קבלה", f"{e(c.get('intake_conversations'))} · תורות {e(c.get('intake_turns'))}"],
    ]))
    if full:
        out.append(table(["התחלה", "טלפון", "סוג", "תורות ביום", "תורות סה\"כ"],
                         [[t_il(x.get("started_at")), x.get("phone"), SOURCE_HE.get(x.get("source"), x.get("source")),
                           x.get("turns_day"), x.get("turns_total")] for x in c.get("sessions") or []]))

    out.append(h2("סיכונים"))
    out.append(kv([
        ["ממצאים", e(rk.get("count"))],
        ["לפי חומרה", dict_line(rk.get("by_severity"), SEVERITY_HE)],
        ["לפי דרך זיהוי", dict_line(rk.get("by_method"), METHOD_HE)],
    ]))
    if full:
        out.append(table(["זמן בשיחה", "טלפון", "חומרה", "זיהוי", "סטטוס", "סיבות", "נוסח"],
                         [[t_il(x.get("at")), x.get("phone"), SEVERITY_HE.get(x.get("severity"), x.get("severity")),
                           METHOD_HE.get(str(x.get("method")), x.get("method")), x.get("status"),
                           x.get("reasons"), x.get("text")] for x in rk.get("items") or []]))
    out.append("<p style='color:#777;font-size:12px'>ממצא משויך ליום לפי זמן השיחה שבה נאמר.</p>")

    out.append(h2("כניסות וגישה"))
    out.append(kv([
        ["כניסות מטפלים", e(a.get("psychologist_logins"))],
        ["כניסות מטופלים עם קוד", e(a.get("patient_code_logins"))],
        ["חיפושי אדמין", dict_line(a.get("admin_lookups"))],
        ["סימוני נקרא", e(a.get("read_flag_toggles"))],
        ["טלפונים שקיבלו קוד", e(a.get("otp_phones_sent"))],
        ["ניסיונות קוד שגויים", f"{e(a.get('wrong_code_total'))} ב־{e(a.get('wrong_code_phones'))} טלפונים"],
    ]))
    if full:
        out.append("<p><b>כניסות מטפלים</b></p>")
        out.append(table(["שעה", "מטפל"], [[t_il(x.get("at")), x.get("name")]
                                           for x in a.get("psychologist_login_list") or []]))
        out.append("<p><b>כניסות מטופלים עם קוד</b></p>")
        out.append(table(["שעה", "טלפון"], [[t_il(x.get("at")), x.get("phone")]
                                            for x in a.get("patient_code_login_list") or []]))
        if a.get("read_flag_by"):
            out.append(f"<p>סימוני נקרא לפי מסמן: {dict_line(a.get('read_flag_by'))}</p>")
    out.append("<p style='color:#777;font-size:12px'>כניסה בלי קוד אינה נרשמת במסד ואינה מופיעה כאן.</p>")

    out.append(h2("מיילים"))
    out.append(kv([
        ["מיילי מערכת האימות", f"{e(m.get('auth_count'))} · {dict_line(m.get('auth_by_action'), AUTH_HE)}"],
        ["מיילי הסקריפטים", f"{e(m.get('system_count'))} · נכשלו {e(m.get('system_failed'))}"],
        ["לפי סקריפט", dict_line(m.get("system_by_sender"))],
    ]))
    if full:
        out.append("<p><b>מיילי מערכת האימות</b></p>")
        out.append(table(["שעה", "סוג", "נמען"], [[t_il(x.get("at")), AUTH_HE.get(x.get("action"), x.get("action")),
                                                   x.get("to")] for x in m.get("auth_items") or []]))
        out.append("<p><b>מיילי הסקריפטים</b></p>")
        out.append(table(["שעה", "סקריפט", "סוג", "נמען", "נושא", "הצליח"],
                         [[t_il(x.get("at")), x.get("sender"), x.get("kind"), x.get("to"), x.get("subject"),
                           "כן" if x.get("ok") else f"לא — {x.get('error') or ''}"]
                          for x in m.get("system_items") or []]))
    if m.get("system_log_note"):
        out.append("<p style='color:#777;font-size:12px'>יומן מיילי הסקריפטים פעיל מ־23.9.2026; "
                   "השולחים הקיימים עדיין לא כותבים אליו, פרט לדוח הזה.</p>")

    out.append(h2("אוטומציה"))
    out.append("<p><b>משימות תזמון במסד</b></p>")
    out.append(table(["משימה", "תזמון", "הרצות", "כשלים"],
                     [[j.get("job"), j.get("schedule"), j.get("runs"), j.get("fails")] for j in cron]))
    g = au.get("guarded_runs") or {}
    out.append(kv([
        ["מחזור ההעברה", f"{e(g.get('runs'))} הרצות · עובדו {e(g.get('processed'))} · דולגו {e(g.get('skipped'))}"],
        ["תור העיבוד עכשיו", dict_line(au.get("queue_now"))],
        ["שגיאות בתור ביום", e(au.get("queue_errors_day"))],
        ["סיכומים שנכתבו", e(au.get("summaries_written"))],
        ["תמונות מצב שעודכנו", e(au.get("ab_updated"))],
    ]))
    out.append("<p><b>GitHub Actions</b></p>")
    if not gh:
        out.append("<p style='color:#777'>לא נבדק — אין אסימון בסביבה.</p>")
    elif "error" in gh:
        out.append(f"<p style='color:#a00'>כשל בשליפה: {e(gh['error'])}</p>")
    else:
        out.append(table(["תהליך", "תוצאות"],
                         [[name, dict_line(res)] for name, res in sorted(gh["by_workflow"].items())]))

    body = ("<div dir='rtl' style='font-family:Arial,sans-serif;text-align:right;max-width:900px'>"
            + "".join(out) + "</div>")
    return subject, body


# ---------------------------------------------------------------- send
def send(to_addr: str, subject: str, body_html: str) -> None:
    user = env_required("GMAIL_SMTP_USER")
    pwd = env_required("GMAIL_APP_PASSWORD")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = env("EMAIL_FROM", user)
    msg["To"] = to_addr
    msg.attach(MIMEText(body_html, "html", "utf-8"))
    with smtplib.SMTP(env("SMTP_HOST", "smtp.gmail.com"), int(env("SMTP_PORT", "587")), timeout=HTTP_TIMEOUT) as s:
        s.starttls()
        s.login(user, pwd)
        s.send_message(msg)


def main() -> int:
    dry = flag("DRY_RUN")
    now_il = datetime.now(IL)
    day = date.fromisoformat(env("REPORT_DAY")) if env("REPORT_DAY") else now_il.date() - timedelta(days=1)

    offline = env("REPORT_JSON_FILE")
    if offline:
        with open(offline, encoding="utf-8") as f:
            data = json.load(f)
        subject, body = render(data, None)
        print(subject)
        print(body)
        return 0

    db = Db()
    if not flag("SKIP_HOUR_GATE"):
        target = int(env("REPORT_HOUR_IL", "9"))
        if now_il.hour < target:
            print(f"[SKIP] Israel hour {now_il.hour} < {target}")
            return 0
        if already_sent(db, day.isoformat()):
            print(f"[SKIP] report for {day} already sent")
            return 0

    data = db.rpc("admin_daily_report_v2", {"p_day": day.isoformat()})
    gh = github_runs(day)
    subject, body = render(data, gh)

    admin = load_admin(db)
    if not admin:
        print("[FATAL] no active admin with an email in psychologists_v2", file=sys.stderr)
        return 1

    if dry:
        # The repository is public, so Actions logs are public: never print
        # the body, the recipient or any patient data here.
        print(f"[DRY_RUN] would send report for {day}: detail={data.get('detail')} "
              f"body_chars={len(body)} subject_chars={len(subject)}")
        return 0

    ok, err = True, None
    try:
        send(admin["email"], subject, body)
    except Exception as ex:
        ok, err = False, str(ex)[:500]
    try:
        db.insert("email_send_log", {"sender": SENDER, "kind": "admin_daily", "recipient": admin["email"],
                                     "subject": subject, "ok": ok, "error": err,
                                     "meta": {"day": day.isoformat(), "detail": data.get("detail")}})
    except Exception as ex:
        print(f"[WARN] email_send_log insert failed: {ex}", file=sys.stderr)
    if not ok:
        print(f"[FATAL] send failed: {err}", file=sys.stderr)
        return 1
    print(f"[OK] sent report for {day} to admin")
    return 0


if __name__ == "__main__":
    sys.exit(main())
