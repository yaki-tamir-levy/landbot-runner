/**
 * scripts/process_queue_worker.mjs
 *
 * Queue worker that:
 *  - claims ONE queue job at a time (FOR UPDATE SKIP LOCKED via RPC)
 *  - prints the claimed job details (queue_id, users_total_id, phone, name)
 *  - runs process_users_total.mjs for EXACTLY ONE row via ONLY_ID
 *  - marks queue DONE/ERROR (with last_error)
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

async function fetchUsersTotalMeta(usersTotalId) {
  const { data, error } = await supabase
    .from("users_total")
    .select("id,phone,name,processed")
    .eq("id", usersTotalId)
    .limit(1)
    .maybeSingle();

  if (error) {
    return { id: usersTotalId, phone: null, name: null, processed: null, meta_error: error.message };
  }
  if (!data) {
    return { id: usersTotalId, phone: null, name: null, processed: null, meta_error: "not_found" };
  }
  return { ...data, meta_error: null };
}

function runProcessUsersTotalOnlyId(usersTotalId) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/process_users_total.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        OPENAI_API_KEY,
        ONLY_ID: String(usersTotalId),
        MAX_ITEMS: "1",
      },
    });

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

    if (!job || !job.id) {
      console.log(`[QUEUE] no NEW jobs found (iteration=${i + 1}/${MAX_JOBS_PER_RUN})`);
      break;
    }

    const queueId = job.id;
    const usersTotalId = job.users_total_id;

    const meta = await fetchUsersTotalMeta(usersTotalId);

    console.log(
      `[QUEUE] CLAIM queue_id=${queueId} users_total_id=${usersTotalId} phone=${meta.phone ?? ""} name=${meta.name ?? ""} processed=${meta.processed ?? ""} meta_error=${meta.meta_error ?? ""}`
    );

    try {
      await runProcessUsersTotalOnlyId(usersTotalId);

      await finishQueue(queueId, "DONE", null);
      processedCount += 1;

      console.log(
        `[QUEUE] DONE queue_id=${queueId} users_total_id=${usersTotalId} phone=${meta.phone ?? ""} name=${meta.name ?? ""}`
      );
    } catch (err) {
      const msg = err?.message ? err.message : String(err);

      try {
        await finishQueue(queueId, "ERROR", msg.slice(0, 2000));
      } catch (e2) {
        console.error(`[QUEUE] ERROR finishing queue job queue_id=${queueId}: ${e2?.message ?? e2}`);
      }

      console.error(
        `[QUEUE] ERROR queue_id=${queueId} users_total_id=${usersTotalId} phone=${meta.phone ?? ""} name=${meta.name ?? ""} msg=${msg}`
      );
    }
  }

  console.log(JSON.stringify({ processedCount, maxJobsPerRun: MAX_JOBS_PER_RUN }));
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
