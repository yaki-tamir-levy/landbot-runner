/**
 * scripts/process_queue_worker.mjs
 *
 * A single, "uniform" worker that ONLY processes work via process_queue.
 * Safe under parallel runs:
 * - Queue claim is atomic in DB: fn_process_queue_claim_one() uses FOR UPDATE SKIP LOCKED.
 * - GitHub Actions concurrency (workflow) can additionally enforce 1 active runner at a time.
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (required; needs to call SECURITY DEFINER RPCs and update tables)
 *
 * Optional:
 *   MAX_JOBS_PER_RUN (default 50)
 *   SLEEP_MS_WHEN_EMPTY (default 0)  // for "run once" mode; keep 0 in Actions
 *
 * Behavior:
 * - Claim one job.
 * - Mark users_total.processed = 'PROCESSING' (optional but recommended).
 * - Run your existing ChatGPT pipeline hook (placeholder).
 * - On success: users_total.processed = 'DONE'  ; queue job = DONE
 * - On failure: users_total.processed = 'ERROR' ; queue job = ERROR (last_error saved)
 */

import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const MAX_JOBS_PER_RUN = Number(process.env.MAX_JOBS_PER_RUN || "50");
const SLEEP_MS_WHEN_EMPTY = Number(process.env.SLEEP_MS_WHEN_EMPTY || "0");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * PLACEHOLDER: plug your existing "Process users_total (NEW → DONE/ERROR)" logic here.
 * Return { ok: true } on success, or throw on error.
 */
async function processOneUsersTotal(usersTotalId) {
  // TODO: Replace with your actual processing logic.
  // For now, just simulate success.
  return { ok: true };
}

async function setUsersTotalProcessed(usersTotalId, value) {
  const { error } = await supabase
    .from("users_total")
    .update({ processed: value })
    .eq("id", usersTotalId);

  if (error) throw new Error(`users_total update failed (id=${usersTotalId}): ${error.message}`);
}

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
  // If nothing to claim, data will be null
  return data;
}

async function main() {
  let processedCount = 0;

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    const job = await claimOne();

    if (!job || !job.id) {
      if (SLEEP_MS_WHEN_EMPTY > 0) {
        await sleep(SLEEP_MS_WHEN_EMPTY);
        continue;
      }
      break;
    }

    const queueId = job.id;
    const usersTotalId = job.users_total_id;

    try {
      // Optional "in-flight" mark on users_total
      await setUsersTotalProcessed(usersTotalId, "PROCESSING");

      await processOneUsersTotal(usersTotalId);

      await setUsersTotalProcessed(usersTotalId, "DONE");
      await finishQueue(queueId, "DONE", null);

      processedCount += 1;
      console.log(`DONE users_total.id=${usersTotalId} (queue.id=${queueId})`);
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);

      try {
        await setUsersTotalProcessed(usersTotalId, "ERROR");
      } catch (e2) {
        console.error(`Failed to set users_total ERROR for id=${usersTotalId}:`, e2?.message || e2);
      }

      try {
        await finishQueue(queueId, "ERROR", msg.slice(0, 2000));
      } catch (e3) {
        console.error(`Failed to finish queue ERROR for queue.id=${queueId}:`, e3?.message || e3);
      }

      console.error(`ERROR users_total.id=${usersTotalId} (queue.id=${queueId}): ${msg}`);
    }
  }

  console.log(JSON.stringify({ processedCount, maxJobsPerRun: MAX_JOBS_PER_RUN }));
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
