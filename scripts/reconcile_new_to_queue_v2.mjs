import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  const TARGET_PROCESSED_VALUES = ["NEW", "ERROR", "IN_PROGRESS"];

  const { data: rows, error } = await supabase
    .from("users_total_v2")
    .select("id, patient_code, processed")
    .in("processed", TARGET_PROCESSED_VALUES)
    .limit(500);

  if (error) throw new Error(`users_total_v2 select failed: ${error.message}`);

  let inserted = 0;
  let skipped = 0;

  for (const r of rows || []) {
    try {
      await supabase
        .from("process_queue_v2")
        .insert({ users_total_v2_id: r.id, patient_code: r.patient_code, status: "NEW" });
      inserted += 1;
    } catch (e) {
      skipped += 1;
    }
  }

  console.log(
    JSON.stringify({
      targetProcessed: TARGET_PROCESSED_VALUES,
      found: (rows || []).length,
      inserted,
      skipped,
    })
  );
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
