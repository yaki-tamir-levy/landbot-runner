// intake-status — מסך מעקב לשלב הבדיקות.
// נפרד מפונקציית השיחה במכוון: כלי תצוגה בלבד, ואינו יכול לשבור את המסלול.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rpc(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn}: ${res.status} ${await res.text()}`);
  return await res.json();
}

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

const STAGE_HE: Record<string, string> = {
  candidate_created:        "נוצר מועמד",
  conversation_resumed:     "שיחה חודשה",
  turn_saved:               "תור נרשם",
  turn_rejected:            "תור נדחה",
  conversation_collected:   "השיחה נאספה",
  decision_accepted:        "הוחלט לקבל",
  decision_rejected:        "הוחלט לפסול",
  patient_created:          "נוצר מטופל",
  risk_flagged:             "סימון סיכון",
  processing_error:         "כשל בעיבוד",
  decision_failed:          "כשל בהכרעה",
  blocked_already_patient:  "נחסם — כבר מטופל",
  blocked_pending_decision: "נחסם — בהמתנה",
  blocked_already_accepted: "נחסם — התקבל",
};

const STATE_HE: Record<string, string> = {
  OPEN: "בשיחה", NEW: "ממתין לעיבוד", DONE: "הוכרע", ERROR: "כשל",
};

function page(data: any) {
  const cands = (data.candidates ?? []).map((c: any) => `<tr>
<td class="m">${esc(c.hash8)}</td>
<td><span class="p s-${esc(c.state)}">${esc(STATE_HE[c.state] ?? c.state)}</span></td>
<td>${c.decision === "ACCEPTED" ? "התקבל" : c.decision === "REJECTED" ? "נפסל" : "—"}</td>
<td>${esc(c.turns)}</td>
<td>${c.patient ? "✓" : "—"}</td>
<td>${c.risk ? '<span class="r">●</span>' : ""}</td>
<td class="d">${esc(c.missing)}</td>
<td class="d">${esc(c.updated)}</td></tr>`).join("");

  const evts = (data.events ?? []).map((e: any) => `<tr>
<td class="d m">${esc(e.at)}</td>
<td>${esc(STAGE_HE[e.stage] ?? e.stage)}</td>
<td class="m">${esc(e.hash8)}</td>
<td class="d">${esc(e.detail)}</td></tr>`).join("");

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="20">
<title>מעקב מועמדים</title>
<style>
:root{--g:#1E1C22;--c:#2A272F;--i:#E8E4DE;--d:#948E9C;--l:#3D3944;--ok:#7FB08A;--w:#D08A6E;--a:#A99BD1}
*{box-sizing:border-box}
body{margin:0;background:var(--g);color:var(--i);font-family:"Segoe UI",system-ui,sans-serif;font-size:15px;padding:1.1rem}
.w{max-width:64rem;margin:0 auto}
h1{font-size:1.25rem;margin:0 0 .2rem}
.s{color:var(--d);font-size:.8rem;margin-bottom:1.4rem}
h2{font-size:1rem;margin:1.6rem 0 .5rem;color:var(--a)}
table{width:100%;border-collapse:collapse;background:var(--c);border:1px solid var(--l)}
th{text-align:right;font-size:.72rem;color:var(--d);padding:.5rem .55rem;border-bottom:1px solid var(--l)}
td{padding:.5rem .55rem;border-bottom:1px solid var(--l);vertical-align:top}
tr:last-child td{border-bottom:0}
.d{color:var(--d);font-size:.82rem}
.m{font-family:ui-monospace,Consolas,monospace;font-size:.76rem;color:var(--d)}
.p{display:inline-block;padding:.05rem .45rem;font-size:.78rem;border:1px solid var(--l)}
.s-OPEN{color:var(--a);border-color:var(--a)}
.s-NEW{color:var(--w);border-color:var(--w)}
.s-DONE{color:var(--ok);border-color:var(--ok)}
.s-ERROR{color:#E06C5A;border-color:#E06C5A}
.r{color:#E06C5A}
.e{padding:1.1rem;color:var(--d);background:var(--c);border:1px solid var(--l)}
</style>
</head>
<body><div class="w">
<h1>מעקב מועמדים</h1>
<div class="s">מתרענן כל 20 שניות · שעון ישראל</div>
<h2>מועמדים</h2>
${cands ? `<table><thead><tr><th>מזהה</th><th>מצב</th><th>הכרעה</th><th>תורים</th><th>מטופל</th><th>סיכון</th><th>חסר</th><th>עודכן</th></tr></thead><tbody>${cands}</tbody></table>` : `<div class="e">אין מועמדים.</div>`}
<h2>יומן השלבים — 24 שעות</h2>
${evts ? `<table><thead><tr><th>מתי</th><th>שלב</th><th>מזהה</th><th>פרטים</th></tr></thead><tbody>${evts}</tbody></table>` : `<div class="e">אין אירועים.</div>`}
</div></body></html>`;
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") ?? "";

  try {
    const data = await rpc("intake_status", { p_token: token, p_hours: 24 });

    if (!data?.ok) {
      return new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const body = new TextEncoder().encode(page(data));
    const h = new Headers();
    h.set("content-type", "text/html; charset=utf-8");
    h.set("cache-control", "no-store");
    return new Response(body, { status: 200, headers: h });
  } catch (err) {
    console.error("intake-status", String(err));
    return new Response("error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
});
