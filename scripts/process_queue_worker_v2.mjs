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
  const { error } = await supabase.rpc("fn_process_queue_finish_v2", {
    p_queue_id: queueId,
    p_status: status,
    p_last_error: lastError,
  });
  if (error) throw new Error(`fn_process_queue_finish_v2 failed: ${error.message}`);
}

async function claimOne() {
  const { data, error } = await supabase.rpc("fn_process_queue_claim_one_v2");
  if (error) throw new Error(`fn_process_queue_claim_one_v2 failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function runProcessUsersTotalV2OnlyId(usersTotalId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["scripts/process_users_total_v2.mjs"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY,
          OPENAI_API_KEY,
          ONLY_ID: String(usersTotalId),
          MAX_ITEMS: "1",
          DRY_RUN: "false",
        },
      }
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`process_users_total_v2.mjs exited with code ${code}`));
    });
  });
}

async function main() {
  let processedCount = 0;

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    const job = await claimOne();
    if (!job || !job.id) break;

    const queueId = job.id;
    const usersTotalV2Id = job.users_total_v2_id;

    try {
      await runProcessUsersTotalV2OnlyId(usersTotalV2Id);
      await finishQueue(queueId, "DONE", null);
      processedCount += 1;
      console.log(`QUEUE DONE users_total_v2.id=${usersTotalV2Id} (queue.id=${queueId})`);
    } catch (err) {
      const msg = err?.message || String(err);
      await finishQueue(queueId, "ERROR", msg.slice(0, 2000));
      console.error(`QUEUE ERROR users_total_v2.id=${usersTotalV2Id} (queue.id=${queueId}): ${msg}`);
    }
  }

  console.log(JSON.stringify({ processedCount, maxJobsPerRun: MAX_JOBS_PER_RUN }));
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
