/**
 * scripts/process_queue_worker.mjs
 *
 * Uniform worker that ONLY processes work via process_queue.
 * It claims ONE queue job at a time via DB RPC (FOR UPDATE SKIP LOCKED),
 * then runs the existing business logic script process_users_total.mjs
 * for exactly ONE users_total row using ONLY_ID.
 *
 * IMPORTANT:
 * - This worker DOES NOT update users_total.processed directly.
 *   process_users_total.mjs owns the transition: NEW -> processing -> DONE/ERROR.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OPENAI_API_KEY
 *
 * Optional:
 *   MAX_JOBS_PER_RUN (default 50)
 */

import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");

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
  return data; // null if none
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

    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`process_users_total.mjs exited with code ${code}`));
    });
  });
}

async function main() {
  let processedCount = 0;

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    const job = await claimOne();

    if (!job || !job.id) break;

    const queueId = job.id;
    const usersTotalId = job.users_total_id;

    try {
      await runProcessUsersTotalOnlyId(usersTotalId);

      await finishQueue(queueId, "DONE", null);
      processedCount += 1;

      console.log(`QUEUE DONE users_total.id=${usersTotalId} (queue.id=${queueId})`);
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
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
