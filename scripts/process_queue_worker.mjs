/**
 * scripts/process_queue_worker.mjs  (v02)
 *
 * Trigger GitHub Actions workflow immediately after successful processing
 * that may insert RISK rows into RISK_REVIEWS.
 *
 * Repo: yaki-tamir-levy/landbot-runner
 * Workflow: .github/workflows/pushover_notify.yml
 *
 * Required additional env:
 *   GITHUB_WORKFLOW_TOKEN (repo-scoped, actions:write)
 */

import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import https from "node:https";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const GITHUB_WORKFLOW_TOKEN = requireEnv("GITHUB_WORKFLOW_TOKEN");

const MAX_JOBS_PER_RUN = Number(process.env.MAX_JOBS_PER_RUN || "50");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function finishQueue(queueId, status, lastError = null) {
  const { error } = await supabase.rpc("fn_process_queue_finish", {
    p_queue_id: queueId,
    p_status: status,
    p_last_error: lastError,
  });
  if (error) throw new Error(`fn_process_queue_finish failed: ${error.message}`);
}

async function claimOne() {
  const { data, error } = await supabase.rpc("fn_process_queue_claim_one");
  if (error) throw new Error(`fn_process_queue_claim_one failed: ${error.message}`);
  return data;
}

function runProcessUsersTotalOnlyId(usersTotalId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["scripts/process_users_total.mjs"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY,
          OPENAI_API_KEY,
          ONLY_ID: String(usersTotalId),
          MAX_ITEMS: "1",
        },
      }
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`process_users_total.mjs exited with code ${code}`));
    });
  });
}

function triggerPushoverWorkflow() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ref: "main" });

    const req = https.request(
      {
        method: "POST",
        hostname: "api.github.com",
        path: "/repos/yaki-tamir-levy/landbot-runner/actions/workflows/pushover_notify.yml/dispatches",
        headers: {
          "Authorization": `Bearer ${GITHUB_WORKFLOW_TOKEN}`,
          "User-Agent": "landbot-runner",
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode === 204) {
          console.log("GitHub workflow_dispatch triggered");
          resolve();
        } else {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () =>
            reject(new Error(`GitHub dispatch failed ${res.statusCode}: ${data}`))
          );
        }
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  let processedCount = 0;
  let triggered = false;

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    const job = await claimOne();
    if (!job || !job.id) break;

    const queueId = job.id;
    const usersTotalId = job.users_total_id;

    try {
      await runProcessUsersTotalOnlyId(usersTotalId);

      if (!triggered) {
        try {
          await triggerPushoverWorkflow();
          triggered = true;
        } catch (e) {
          console.error("Workflow trigger failed:", e.message);
        }
      }

      await finishQueue(queueId, "DONE", null);
      processedCount += 1;
      console.log(`QUEUE DONE users_total.id=${usersTotalId} (queue.id=${queueId})`);
    } catch (err) {
      const msg = err?.message || String(err);
      await finishQueue(queueId, "ERROR", msg.slice(0, 2000));
      console.error(`QUEUE ERROR users_total.id=${usersTotalId} (queue.id=${queueId}): ${msg}`);
    }
  }

  console.log(JSON.stringify({ processedCount, maxJobsPerRun: MAX_JOBS_PER_RUN }));
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
