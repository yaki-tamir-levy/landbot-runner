// supabase/functions/auth-code-notify/index.ts
// Created 2.10.2026.
//
// Purpose: one email to the admin for every login/registration code that the
// Supabase Auth service is asked to send, to answer "the code never arrived".
// The mail says WHEN a code was requested, for WHICH address, the role
// (psychologist / patient) and a masked phone. It never contains the code.
// It proves the request reached the auth service, not delivery to the inbox.
//
// Flow: trigger on auth.audit_log_entries (actions user_recovery_requested,
// user_confirmation_requested) -> pg_net POST {audit_id} -> this function ->
// rpc auth_code_notify_claim(audit_id) -> SMTP smtp.gmail.com:465 -> email_send_log.
//
// No shared secret: the claim RPC only answers for a real auth event younger
// than 10 minutes, and only once per event (unique index on meta->>'audit_id').
// A forged call can at most re-trigger nothing.
//
// Port 465 only: Supabase blocks outgoing 25 and 587 (official limits page).
// Secrets: AUTH_NOTIFY_SMTP_USER, AUTH_NOTIFY_SMTP_PASSWORD.
// Deploy: supabase functions deploy auth-code-notify --project-ref qcwimczsiuxkarwfiyai --no-verify-jwt
// Logs never contain the address, the phone or the password.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SMTP_USER = Deno.env.get("AUTH_NOTIFY_SMTP_USER") ?? "";
const SMTP_PASS = Deno.env.get("AUTH_NOTIFY_SMTP_PASSWORD") ?? "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTION_HE: Record<string, string> = {
  user_recovery_requested: "כניסה — קוד למשתמש קיים",
  user_confirmation_requested: "הרשמה ראשונה — קוד אישור",
};
const ROLE_HE: Record<string, string> = {
  psychologist: "פסיכולוג",
  patient: "מטופל",
  both: "פסיכולוג וגם מטופל",
  unknown: "לא מזוהה במסד",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function wrap76(s: string): string {
  return s.replace(/(.{76})/g, "$1\r\n");
}

function ilTime(iso: string): { full: string; hm: string } {
  const d = new Date(iso);
  const full = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(d);
  const hm = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return { full, hm };
}

async function rest(path: string, init: RequestInit): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function smtpSend(to: string, subject: string, html: string): Promise<void> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const conn = await Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 });
  let buf = "";
  const chunk = new Uint8Array(4096);

  async function readSome(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), ms); });
    const n = await Promise.race([conn.read(chunk), t]);
    clearTimeout(timer);
    if (n === "timeout") throw new Error("smtp_timeout");
    if (n === null) throw new Error("smtp_closed");
    buf += dec.decode(chunk.subarray(0, n as number));
  }

  async function reply(): Promise<number> {
    const deadline = Date.now() + 20000;
    while (true) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          buf = lines.slice(i + 1).join("\r\n");
          return parseInt(lines[i].slice(0, 3), 10);
        }
      }
      if (Date.now() > deadline) throw new Error("smtp_timeout");
      await readSome(deadline - Date.now());
    }
  }

  async function step(line: string | null, expect: number[], label: string): Promise<void> {
    if (line !== null) await conn.write(enc.encode(line + "\r\n"));
    const code = await reply();
    if (!expect.includes(code)) throw new Error(`smtp_${label}_${code}`);
  }

  try {
    await step(null, [220], "greeting");
    await step("EHLO meitar-auth-notify", [250], "ehlo");
    await step("AUTH LOGIN", [334], "auth");
    await step(b64(SMTP_USER), [334], "auth_user");
    await step(b64(SMTP_PASS), [235], "auth_pass");
    await step(`MAIL FROM:<${SMTP_USER}>`, [250], "mail_from");
    await step(`RCPT TO:<${to}>`, [250, 251], "rcpt_to");
    await step("DATA", [354], "data");
    const msg = [
      `From: =?UTF-8?B?${b64("מיתר — התראות אימות")}?= <${SMTP_USER}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@meitar-auth-notify>`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(b64(html)),
      ".",
    ].join("\r\n");
    await step(msg, [250], "body");
    try { await conn.write(enc.encode("QUIT\r\n")); } catch (_) { /* ignore */ }
  } finally {
    try { conn.close(); } catch (_) { /* ignore */ }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let auditId = "";
  try {
    const body = await req.json();
    auditId = String(body?.audit_id ?? "");
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  if (!UUID_RE.test(auditId)) return json({ ok: false, error: "invalid_audit_id" }, 400);
  if (!SUPABASE_URL || !SERVICE_KEY || !SMTP_USER || !SMTP_PASS) {
    console.error("auth-code-notify: missing env");
    return json({ ok: false, error: "missing_env" }, 500);
  }

  const claimRes = await rest("rpc/auth_code_notify_claim", {
    method: "POST",
    body: JSON.stringify({ p_audit_id: auditId }),
  });
  if (!claimRes.ok) {
    await claimRes.body?.cancel();
    console.error("auth-code-notify: claim failed", claimRes.status);
    return json({ ok: false, error: "claim_failed" }, 502);
  }
  const c = await claimRes.json();
  if (!c || !c.log_id) return json({ ok: true, skipped: true });

  const t = ilTime(c.created_at);
  const role = ROLE_HE[c.role] ?? ROLE_HE.unknown;
  const action = ACTION_HE[c.action] ?? c.action;
  const subject = `מיתר — נשלח קוד אימות · ${role} · ${t.hm}`;
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;background:#f7f7f7"><b>${esc(k)}</b></td>` +
    `<td style="padding:6px 10px;border:1px solid #ddd">${v}</td></tr>`;
  const html =
    `<div dir="rtl" style="font-family:Arial,sans-serif;text-align:right;max-width:640px">` +
    `<h3 style="margin:0 0 10px">נשלחה בקשה לקוד אימות</h3>` +
    `<table style="border-collapse:collapse">` +
    row("שעה (שעון ישראל)", esc(t.full)) +
    row("סוג", esc(action)) +
    row("תפקיד", esc(role)) +
    row("כתובת הדוא\"ל", `<span dir="ltr">${esc(c.email)}</span>`) +
    row("טלפון", `<span dir="ltr">${esc(c.phone || "לא נמצא")}</span>`) +
    `</table>` +
    `<p style="color:#777;font-size:12px;margin-top:12px">המייל מאשר שמערכת האימות קיבלה בקשה לשלוח קוד לכתובת הזו. ` +
    `הוא אינו מאשר שהמייל הגיע לתיבת הנמען. הקוד עצמו אינו נכלל.</p></div>`;

  let ok = true;
  let error: string | null = null;
  try {
    if (!c.admin_email) throw new Error("no_admin_email");
    await smtpSend(c.admin_email, subject, html);
  } catch (e) {
    ok = false;
    error = String((e as Error)?.message ?? e).slice(0, 200);
    console.error("auth-code-notify: send failed", error);
  }

  const upd = await rest(`email_send_log?id=eq.${encodeURIComponent(String(c.log_id))}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ok, error, subject }),
  });
  await upd.body?.cancel();
  if (!upd.ok) console.error("auth-code-notify: log update failed", upd.status);

  return json({ ok, error });
});
