// supabase/functions/dispatch-workflow/index.ts
//
// 25.9.2026 - Starts a GitHub Actions workflow through workflow_dispatch.
// Called by public.dispatch_workflow() from pg_cron, replacing the GitHub
// "schedule" trigger, which was measured on 25.9.2026 to run 4-6 hours late
// (daily workflows) and to drop about 80% of runs (hourly workflows).
//
// Security:
//   - Requires header x-dispatch-secret == env DISPATCH_SECRET (constant time).
//   - Only workflows and input values in ALLOWED can be started.
//   - The GitHub token stays in the edge function secrets (GITHUB_TOKEN,
//     shared with trigger-process-worker). It never enters the database.
//
// Logging:
//   - Every call ends with one row in public.workflow_dispatch_log.
//   - When the caller passes log_id (the row created by dispatch_workflow()),
//     that row is updated. Otherwise a new row is inserted (source=direct).
//   - A row with responded_at = null means the call never reached this
//     function or it crashed before logging.
//
// Deploy:
//   supabase functions deploy dispatch-workflow --project-ref qcwimczsiuxkarwfiyai --no-verify-jwt

type InputRule = string[] | RegExp;

const ALLOWED: Record<string, Record<string, InputRule>> = {
  "ab-processor.yml": {},
  "admin-daily-report.yml": {
    dry_run: ["0", "1"],
    skip_hour_gate: ["0", "1"],
    report_day: /^(\d{4}-\d{2}-\d{2})?$/,
  },
  "intake-processor.yml": {},
  "process-queue-worker-v2.yml": {},
  "psychologist_notify.yml": {
    mode: ["risk", "daily"],
    dry_run: ["0", "1"],
    skip_hour_gate: ["0", "1"],
  },
  "pushover_notify.yml": {},
  "reconcile-new-to-queue-v2.yml": {},
};

const OWNER = "yaki-tamir-levy";
const REPO = "landbot-runner";
const REF = "main";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function validateInputs(
  workflow: string,
  inputs: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const rules = ALLOWED[workflow];
  if (inputs === undefined || inputs === null) return { ok: true, value: {} };
  if (typeof inputs !== "object" || Array.isArray(inputs)) {
    return { ok: false, error: "inputs_not_object" };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs as Record<string, unknown>)) {
    const rule = rules[k];
    if (!rule) return { ok: false, error: `input_not_allowed:${k}` };
    if (typeof v !== "string") return { ok: false, error: `input_not_string:${k}` };
    const pass = Array.isArray(rule) ? rule.includes(v) : rule.test(v);
    if (!pass) return { ok: false, error: `input_value_not_allowed:${k}` };
    out[k] = v;
  }
  return { ok: true, value: out };
}

async function writeLog(
  logId: number | null,
  row: Record<string, unknown>,
): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("[dispatch-workflow] log skipped: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return;
  }
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  const base = `${url}/rest/v1/workflow_dispatch_log`;
  try {
    const res = logId !== null
      ? await fetch(`${base}?id=eq.${logId}`, { method: "PATCH", headers, body: JSON.stringify(row) })
      : await fetch(base, { method: "POST", headers, body: JSON.stringify({ source: "direct", ...row }) });
    if (!res.ok) console.error("[dispatch-workflow] log write failed", res.status, await res.text());
  } catch (e) {
    console.error("[dispatch-workflow] log write error", String(e));
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("DISPATCH_SECRET");
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!secret || !token) return json({ ok: false, error: "server_configuration_missing" }, 500);

  const supplied = req.headers.get("x-dispatch-secret") ?? "";
  if (!constantTimeEqual(supplied, secret)) return json({ ok: false, error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const workflow = typeof body.workflow === "string" ? body.workflow : "";
  const logId = Number.isInteger(body.log_id) ? (body.log_id as number) : null;

  if (!(workflow in ALLOWED)) {
    await writeLog(logId, {
      workflow: workflow || "(none)",
      responded_at: new Date().toISOString(),
      ok: false,
      error: "workflow_not_allowed",
    });
    return json({ ok: false, error: "workflow_not_allowed" }, 400);
  }

  const inputs = validateInputs(workflow, body.inputs);
  if (!inputs.ok) {
    await writeLog(logId, {
      workflow,
      responded_at: new Date().toISOString(),
      ok: false,
      error: inputs.error,
    });
    return json({ ok: false, error: inputs.error }, 400);
  }

  const ghUrl = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflow}/dispatches`;
  let status = 0;
  let errorText: string | null = null;
  let runId: number | null = null;
  try {
    const gh = await fetch(ghUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF, inputs: inputs.value, return_run_details: true }),
    });
    status = gh.status;
    if (gh.ok) {
      // 200 with run details (return_run_details, GitHub API Feb 2026); 204 on older behaviour.
      if (status === 200) {
        try {
          const d = await gh.json();
          if (Number.isInteger(d?.workflow_run_id)) runId = d.workflow_run_id;
        } catch { /* body unreadable: dispatch still succeeded */ }
      }
    } else {
      errorText = (await gh.text()).slice(0, 500);
    }
  } catch (e) {
    errorText = String(e).slice(0, 500);
  }

  const ok = status === 200 || status === 204;
  await writeLog(logId, {
    workflow,
    inputs: inputs.value,
    responded_at: new Date().toISOString(),
    http_status: status || null,
    run_id: runId,
    ok,
    error: ok ? null : errorText ?? `unexpected_status_${status}`,
  });

  return json({ ok, http_status: status, run_id: runId, error: ok ? undefined : errorText }, ok ? 200 : 502);
});
