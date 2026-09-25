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

25.9.2026 additions: open risks older than 24 hours at the top of the report
(public.admin_report_open_risks_v2), Hebrew descriptions for pg_cron jobs and
GitHub workflows (table public.admin_report_labels, edited in the database),
schedules in words in Israel time, a summary of database-started workflow
runs (public.workflow_dispatch_log), and phones forced left-to-right so masked
numbers are not shown reversed inside the right-to-left report.

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


# ---------------------------------------------------------------- extras (25.9.2026)
def load_extra(db: Db, day: date) -> Dict[str, Any]:
    """Each part is optional: a failure is shown in the report, never fatal."""
    out: Dict[str, Any] = {}
    try:
        out["open_risks"] = db.rpc("admin_report_open_risks_v2", {})
    except Exception as ex:
        print(f"[WARN] open risks: {ex}", file=sys.stderr)
    try:
        labels: Dict[str, Dict[str, str]] = {"cron": {}, "workflow": {}}
        for r in db.select("admin_report_labels", {"select": "kind,key,label_he"}):
            labels.setdefault(r["kind"], {})[r["key"]] = r["label_he"]
        out["labels"] = labels
    except Exception as ex:
        print(f"[WARN] labels: {ex}", file=sys.stderr)
    try:
        start = datetime(day.year, day.month, day.day, tzinfo=IL)
        end = start + timedelta(days=1)
        rows = db.select("workflow_dispatch_log", {
            "select": "requested_at,workflow,http_status,ok,error,responded_at",
            "and": f"(requested_at.gte.{start.isoformat()},requested_at.lt.{end.isoformat()})",
            "order": "requested_at"})
        bad = [r for r in rows if r.get("ok") is not True]
        out["dispatch"] = {
            "total": len(rows),
            "ok": sum(1 for r in rows if r.get("ok") is True),
            "failed": sum(1 for r in rows if r.get("ok") is False),
            "no_answer": sum(1 for r in rows if r.get("responded_at") is None),
            "bad_items": bad,
        }
    except Exception as ex:
        print(f"[WARN] dispatch log: {ex}", file=sys.stderr)
    return out


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


LRM = "\u200e"
# Columns whose values are left-to-right tokens (masked phones, addresses).
# Without the marks, "050***123" inside the right-to-left report is shown as
# "123***050": the two digit runs are reordered around the neutral asterisks.
LTR_HEADERS = {"טלפון", "טלפון המטופל", "נמען", "מטופל"}


def ltr(v: Any) -> str:
    s = "" if v is None else str(v)
    return f"{LRM}{s}{LRM}" if s else s


def table(headers: List[str], rows: List[List[Any]]) -> str:
    if not rows:
        return "<p style='color:#777'>אין.</p>"
    th = "".join(f"<th style='border:1px solid #ccc;padding:4px 8px;background:#f3f3f3'>{e(h)}</th>" for h in headers)
    ltr_cols = {i for i, h in enumerate(headers) if h in LTR_HEADERS}
    trs = "".join("<tr>" + "".join(f"<td style='border:1px solid #ccc;padding:4px 8px;vertical-align:top;"
                                   f"white-space:pre-wrap'>{e(ltr(c) if i in ltr_cols else c)}</td>"
                                   for i, c in enumerate(r)) + "</tr>"
                  for r in rows)
    return f"<table style='border-collapse:collapse;font-size:13px'><tr>{th}</tr>{trs}</table>"


def il_offset_hours(day: date) -> int:
    noon = datetime(day.year, day.month, day.day, 12, tzinfo=IL)
    return int(noon.utcoffset().total_seconds() // 3600)


def cron_he(expr: str, day: date) -> str:
    """A pg_cron expression (UTC) in Hebrew words, in Israel time for `day`.
    Covers the shapes used in this project; anything else is returned as is."""
    parts = (expr or "").split()
    if len(parts) != 5 or parts[2:] != ["*", "*", "*"]:
        return expr or ""
    m, h = parts[0], parts[1]
    off = il_offset_hours(day)

    def il_h(x: int) -> int:
        return (x + off) % 24

    if m.startswith("*/") and h == "*":
        return f"כל {m[2:]} דקות"
    if h == "*":
        if m == "*":
            return "כל דקה"
        mins = m.split(",")
        if all(x.isdigit() for x in mins):
            return ("כל שעה בדקה " + mins[0].zfill(2)) if len(mins) == 1 else \
                   ("כל שעה בדקות " + ", ".join(x.zfill(2) for x in mins))
        return expr
    if not m.isdigit():
        return expr
    mm = m.zfill(2)
    if "-" in h and h.replace("-", "").isdigit():
        a, b = (int(x) for x in h.split("-"))
        return f"כל שעה בדקה {mm}, מ־{il_h(a):02d}:{mm} עד {il_h(b):02d}:{mm}"
    hours = h.split(",")
    if all(x.isdigit() for x in hours):
        times = ", ".join(f"{il_h(int(x)):02d}:{mm}" for x in hours)
        return f"כל יום ב־{times}"
    return expr


def d_il(iso: Optional[str]) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(IL).strftime("%d.%m.%Y %H:%M")
    except ValueError:
        return str(iso)


def kv(rows: List[List[Any]]) -> str:
    return "<table style='font-size:14px'>" + "".join(
        f"<tr><td style='padding:2px 10px 2px 0;color:#555'>{e(k)}</td><td><b>{v}</b></td></tr>" for k, v in rows
    ) + "</table>"


def h2(title: str) -> str:
    return f"<h3 style='margin:22px 0 6px;border-bottom:2px solid #333'>{e(title)}</h3>"


def render(d: Dict[str, Any], gh: Optional[Dict[str, Any]],
           extra: Optional[Dict[str, Any]] = None) -> (str, str):
    extra = extra or {}
    orisk = extra.get("open_risks") or {}
    labels = extra.get("labels") or {}
    disp = extra.get("dispatch")
    cron_labels = labels.get("cron") or {}
    wf_labels = labels.get("workflow") or {}
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
    overdue = int(orisk.get("overdue_total") or 0)
    if overdue:
        subject += f" · {overdue} סיכונים ממתינים מעל 24 שעות"
    disp_fail = int((disp or {}).get("failed") or 0) + int((disp or {}).get("no_answer") or 0)
    if cron_fails or gh_fail or disp_fail or int(m.get("system_failed") or 0):
        subject += " · יש כשלים"

    out: List[str] = []
    out.append(f"<h2 style='margin:0'>דוח פעילות יומי — {e(day_he)}</h2>")
    out.append(f"<p style='color:#777;margin:4px 0'>חלון: 00:00–24:00 שעון ישראל · רמת פירוט: "
               f"{'מלאה' if full else 'ספירות בלבד'}</p>")

    out.append(h2("סיכונים שלא טופלו יותר מ־24 שעות"))
    if not orisk:
        out.append("<p style='color:#a00'>לא נבדק — כשל בשליפת הסיכונים הפתוחים.</p>")
    else:
        out.append(kv([
            ["ממתינים מעל 24 שעות", e(orisk.get("overdue_total"))],
            ["פתוחים בסך הכול", e(orisk.get("open_total"))],
        ]))
        out.append(table(["פסיכולוג", "פתוחים", "מעל 24 שעות", "הוותיק ביותר (ימים)"],
                         [[x.get("psychologist"), x.get("open"), x.get("overdue"), x.get("oldest_days")]
                          for x in orisk.get("by_psychologist") or []]))
        if full and orisk.get("overdue_items") is not None:
            by_p: Dict[str, List[Dict[str, Any]]] = {}
            for x in orisk.get("overdue_items") or []:
                by_p.setdefault(x.get("psychologist") or "", []).append(x)
            for name, items in by_p.items():
                out.append(f"<p><b>{e(name)} — {len(items)} סיכונים ממתינים</b></p>")
                out.append(table(["סוג הסיכון", "טלפון", "תאריך זיהוי", "ימים בהמתנה"],
                                 [[" · ".join(v for v in [SEVERITY_HE.get(x.get("severity"), x.get("severity") or ""),
                                                          METHOD_HE.get(str(x.get("method")), "") ,
                                                          x.get("text") or ""] if v),
                                   x.get("phone"), d_il(x.get("at")), x.get("days")] for x in items]))
        out.append("<p style='color:#777;font-size:12px'>פתוח = סטטוס NEW בטבלת הסיכונים. "
                   "תאריך הזיהוי הוא זמן השיחה שבה נאמר הדבר — לטבלה אין עמודת זמן יצירה, "
                   "ולכן הזיהוי בפועל עשוי להיות מאוחר במעט.</p>")

    out.append(h2("תקציר"))
    out.append(kv([
        ["שיחות פעילות", e(c.get("active_sessions"))],
        ["תורות", e(c.get("turns"))],
        ["ממצאי סיכון ביום", e(rk.get("count"))],
        ["סיכונים ממתינים מעל 24 שעות", e(orisk.get("overdue_total")) if orisk else "לא נבדק"],
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
        out.append(table(["שעה", "שם", "פעיל", "אדמין", "מסלול", "ארגון"],
                         [[t_il(x.get("at")), x.get("name"), x.get("active"), x.get("is_admin"),
                           x.get("track"), x.get("organization")]
                          for x in p.get("new_psychologists") or []]))
        out.append("<p><b>מטופלים חדשים</b></p>")
        out.append(table(["שעה", "טלפון", "מקור", "סטטוס", "פעיל", "מסלול", "מגדר", "מטפל"],
                         [[t_il(x.get("at")), x.get("phone"), ORIGIN_HE.get(x.get("origin"), x.get("origin")),
                           x.get("status"), x.get("active"), x.get("track"), x.get("gender"), x.get("psychologist")]
                          for x in p.get("new_patients") or []]))
        out.append("<p><b>מטופלים שעודכנו</b></p>")
        out.append(table(["שעה", "טלפון", "מקור", "סטטוס", "פעיל", "מטפל"],
                         [[t_il(x.get("at")), x.get("phone"), ORIGIN_HE.get(x.get("origin"), x.get("origin")),
                           x.get("status"), x.get("active"), x.get("psychologist")]
                          for x in p.get("updated_patients") or []]))
        out.append("<p><b>מועמדי קבלה</b></p>")
        out.append(table(["נוצר", "הוכרע", "טלפון", "החלטה", "עיבוד", "סיכון", "שדות חסרים", "מגדר"],
                         [[t_il(x.get("created_at")), t_il(x.get("decided_at")), x.get("phone"), x.get("decision"),
                           x.get("processed"), "כן" if x.get("risk_flag") else "", 
                           ", ".join(x.get("missing_fields") or []) if isinstance(x.get("missing_fields"), list)
                           else (x.get("missing_fields") or ""), x.get("gender")]
                          for x in p.get("intake_candidates") or []]))

    out.append(h2("שיחות"))
    out.append(kv([
        ["שיחות שהתחילו", e(c.get("sessions_started"))],
        ["תורות בשיחות אמיתיות", e(c.get("turns"))],
        ["החלטות המנגנון המתקן", dict_line(c.get("corrector_decisions"))],
        ["קריאות בדיקה או סימולציה", e(c.get("test_or_sim_calls"))],
        ["שיחות קבלה", f"{e(c.get('intake_conversations'))} · תורות {e(c.get('intake_turns'))}"],
    ]))
    if full:
        out.append(table(["התחלה", "טלפון", "סוג", "שלב", "תורות ביום", "תורות סה\"כ"],
                         [[t_il(x.get("started_at")), x.get("phone"), SOURCE_HE.get(x.get("source"), x.get("source")),
                           x.get("stage"), x.get("turns_day"), x.get("turns_total")] for x in c.get("sessions") or []]))
        for x in c.get("sessions") or []:
            items = x.get("items") or []
            if not items:
                continue
            out.append(f"<p><b>תוכן השיחה — {e(ltr(x.get('phone')))} · {e(SOURCE_HE.get(x.get('source'), x.get('source')))} · "
                       f"התחילה {e(t_il(x.get('started_at')))}</b></p>")
            out.append(table(["שעה", "שאלת המטופל", "תשובת הבוט", "מתקן", "סיבות"],
                             [[t_il(i.get("at")), i.get("q"), i.get("a"), i.get("decision"),
                               ", ".join(i.get("reasons") or [])] for i in items]))
        if c.get("test_or_sim_items"):
            out.append("<p><b>קריאות בדיקה או סימולציה</b></p>")
            out.append(table(["שעה", "טלפון", "שאלה", "מתקן"],
                             [[t_il(i.get("at")), i.get("phone"), i.get("q"), i.get("decision")]
                              for i in c.get("test_or_sim_items") or []]))
        if c.get("intake_items"):
            out.append("<p><b>שיחות קבלה</b></p>")
            out.append(table(["שעה", "טלפון", "שאלה", "תשובה"],
                             [[t_il(i.get("at")), i.get("phone"), i.get("q"), i.get("a")]
                              for i in c.get("intake_items") or []]))
        out.append("<p style='color:#777;font-size:12px'>שאלות ותשובות מקוצרות ל־500 תווים.</p>")

    out.append(h2("סיכונים"))
    out.append(kv([
        ["ממצאים ביום", e(rk.get("count"))],
        ["פתוחים כעת, מכל הימים", e(orisk.get("open_total")) if orisk else "לא נבדק"],
        ["לפי חומרה", dict_line(rk.get("by_severity"), SEVERITY_HE)],
        ["לפי דרך זיהוי", dict_line(rk.get("by_method"), METHOD_HE)],
    ]))
    if full:
        out.append(table(["זמן בשיחה", "טלפון", "חומרה", "זיהוי", "סטטוס", "סיבות", "נוסח", "שורה", "בודק", "הערות"],
                         [[t_il(x.get("at")), x.get("phone"), SEVERITY_HE.get(x.get("severity"), x.get("severity")),
                           METHOD_HE.get(str(x.get("method")), x.get("method")), x.get("status"),
                           x.get("reasons"), x.get("text"), x.get("line"), x.get("reviewer"), x.get("notes")]
                          for x in rk.get("items") or []]))
    out.append("<p style='color:#777;font-size:12px'>ממצא משויך ליום לפי זמן השיחה שבה נאמר. "
               "סיכונים פתוחים מימים קודמים מופיעים בראש הדוח.</p>")

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
        out.append("<p><b>חיפושי אדמין</b></p>")
        out.append(table(["שעה", "מחפש", "תוצאה", "חיפוש", "מטופל"],
                         [[t_il(x.get("at")), x.get("by"), x.get("outcome"), x.get("query"), x.get("patient")]
                          for x in a.get("admin_lookup_items") or []]))
        out.append("<p><b>סימוני נקרא</b></p>")
        out.append(table(["שעה", "מסמן", "הוסתר", "מטופל", "שיחה"],
                         [[t_il(x.get("at")), x.get("by"), x.get("hidden"), x.get("patient"), x.get("talk")]
                          for x in a.get("read_flag_items") or []]))
        out.append("<p><b>טלפונים שקיבלו קוד</b></p>")
        out.append(table(["שליחה אחרונה", "טלפון", "סה\"כ שליחות אי־פעם"],
                         [[t_il(x.get("last_sent")), x.get("phone"), x.get("count_total")]
                          for x in a.get("otp_items") or []]))
        out.append("<p><b>ניסיונות קוד שגויים</b></p>")
        out.append(table(["אחרון", "טלפון", "ניסיונות", "ראשון"],
                         [[t_il(x.get("last")), x.get("phone"), x.get("fails"), t_il(x.get("first_fail"))]
                          for x in a.get("wrong_code_items") or []]))
    out.append("<p style='color:#777;font-size:12px'>כניסה בלי קוד אינה נרשמת במסד ואינה מופיעה כאן.</p>")

    out.append(h2("מיילים"))
    out.append(kv([
        ["מיילי מערכת האימות", f"{e(m.get('auth_count'))} · {dict_line(m.get('auth_by_action'), AUTH_HE)}"],
        ["מיילי הסקריפטים", f"{e(m.get('system_count'))} · נכשלו {e(m.get('system_failed'))}"],
        ["לפי סקריפט", dict_line(m.get("system_by_sender"))],
    ]))
    if full:
        out.append("<p><b>מיילי מערכת האימות</b></p>")
        out.append(table(["שעה", "סוג", "נמען", "טלפון המטופל"],
                         [[t_il(x.get("at")), AUTH_HE.get(x.get("action"), x.get("action")),
                           x.get("to"), x.get("patient") or ""] for x in m.get("auth_items") or []]))
        out.append("<p><b>מיילי הסקריפטים</b></p>")
        out.append(table(["שעה", "סקריפט", "סוג", "נמען", "נושא", "תוכן", "הצליח"],
                         [[t_il(x.get("at")), x.get("sender"), x.get("kind"), x.get("to"), x.get("subject"),
                           x.get("body") or "", "כן" if x.get("ok") else f"לא — {x.get('error') or ''}"]
                          for x in m.get("system_items") or []]))
    if m.get("system_log_note"):
        out.append("<p style='color:#777;font-size:12px'>יומן מיילי הסקריפטים פעיל מ־23.9.2026; "
                   "השולחים הקיימים עדיין לא כותבים אליו, פרט לדוח הזה. "
                   "תוכן מיילי מערכת האימות הוא התבנית עם קוד חד־פעמי, ואינו נשמר.</p>")

    out.append(h2("אוטומציה"))
    out.append("<p><b>משימות תזמון במסד</b></p>")
    out.append(table(["משימה", "תיאור", "מתי (שעון ישראל)", "הרצות", "כשלים"],
                     [[j.get("job"), cron_labels.get(j.get("job"), "אין תיאור"),
                       cron_he(j.get("schedule") or "", day), j.get("runs"), j.get("fails")] for j in cron]))
    g = au.get("guarded_runs") or {}
    out.append(kv([
        ["מחזור ההעברה", f"{e(g.get('runs'))} הרצות · עובדו {e(g.get('processed'))} · דולגו {e(g.get('skipped'))}"],
        ["תור העיבוד עכשיו", dict_line(au.get("queue_now"))],
        ["הפעלות תהליכים מהמסד", "לא נבדק" if disp is None else
            f"{e(disp.get('total'))} · הצליחו {e(disp.get('ok'))} · נכשלו {e(disp.get('failed'))}"
            f" · בלי תשובה {e(disp.get('no_answer'))}"],
        ["שגיאות בתור ביום", e(au.get("queue_errors_day"))],
        ["סיכומים שנכתבו", e(au.get("summaries_written"))],
        ["תמונות מצב שעודכנו", e(au.get("ab_updated"))],
    ]))
    out.append("<p style='color:#777;font-size:12px'>תור העיבוד עכשיו: ספירת הרשומות בטבלה process_queue_v2 "
               "לפי מצב, ברגע הפקת הדוח. זה התור שממנו מעבד התור יוצר סיכומי שיחה. "
               "DONE = עובדה; NEW או ERROR שמצטברים = משהו תקוע.<br>"
               "הפעלות תהליכים מהמסד: הפעלות GitHub Actions שיצאו ממשימות pg_cron דרך workflow_dispatch_log. "
               "בלי תשובה = הבקשה לא הגיעה לפונקציה או שהפונקציה קרסה.</p>")
    if full and disp and disp.get("bad_items"):
        out.append("<p><b>הפעלות מהמסד שנכשלו או לא נענו</b></p>")
        out.append(table(["שעה", "תהליך", "קוד", "שגיאה"],
                         [[t_il(x.get("requested_at")), x.get("workflow"), x.get("http_status"), x.get("error")]
                          for x in disp.get("bad_items")]))
    if full:
        out.append("<p><b>כשלי תזמון במסד</b></p>")
        out.append(table(["שעה", "משימה", "סטטוס", "הודעה"],
                         [[t_il(x.get("at")), x.get("job"), x.get("status"), x.get("message")]
                          for x in au.get("cron_failures") or []]))
        out.append("<p><b>הרצות מחזור ההעברה שטיפלו ברשומות</b></p>")
        out.append(table(["שעה", "עובדו", "דולגו", "משך במ\"ש", "הודעה"],
                         [[t_il(x.get("at")), x.get("processed"), x.get("skipped"), x.get("ms"), x.get("message")]
                          for x in au.get("guarded_items") or []]))
        out.append("<p><b>שגיאות בתור העיבוד</b></p>")
        out.append(table(["שעה", "סטטוס", "מטופל", "שגיאה"],
                         [[t_il(x.get("at")), x.get("status"), x.get("patient"), x.get("error")]
                          for x in au.get("queue_error_items") or []]))
        out.append("<p><b>סיכומים שנכתבו</b></p>")
        out.append(table(["שעה", "מטופל", "עיבוד", "סיכון", "סיכום מקוצר"],
                         [[t_il(x.get("at")), x.get("patient"), x.get("processed"), x.get("risk"), x.get("short")]
                          for x in au.get("summary_items") or []]))
        out.append("<p><b>תמונות מצב שעודכנו</b></p>")
        out.append(table(["שעה", "מטופל", "תמונת מצב"],
                         [[t_il(x.get("at")), x.get("patient"), x.get("ab")] for x in au.get("ab_items") or []]))
    out.append("<p><b>GitHub Actions</b></p>")
    if not gh:
        out.append("<p style='color:#777'>לא נבדק — אין אסימון בסביבה.</p>")
    elif "error" in gh:
        out.append(f"<p style='color:#a00'>כשל בשליפה: {e(gh['error'])}</p>")
    else:
        out.append(table(["תהליך", "תיאור", "תוצאות"],
                         [[name, wf_labels.get(name, "אין תיאור"), dict_line(res)]
                          for name, res in sorted(gh["by_workflow"].items())]))

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
        subject, body = render(data, None, data.get("_extra"))
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
    extra = load_extra(db, day)
    subject, body = render(data, gh, extra)

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
