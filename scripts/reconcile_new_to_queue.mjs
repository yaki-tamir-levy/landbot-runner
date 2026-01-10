/**
 * scripts/reconcile_new_to_queue.mjs
 *
 * Hourly safety net:
 * - Finds users_total rows with processed='NEW'
 * - Ensures they exist in process_queue as an active job (NEW/PROCESSING)
 *
 * This does NOT process conversations. It only ensures queue coverage.
 */

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
  // Pull NEW items (cap to avoid huge hourly jobs; adjust if needed)
  const { data: rows, error } = await supabase
    .from("users_total")
    .select("id")
    .eq("processed", "NEW")
    .limit(500);

  if (error) throw new Error(`users_total select failed: ${error.message}`);

  let inserted = 0;
  let skipped = 0;

  for (const r of rows || []) {
    try {
      // Use the DB partial unique index to avoid duplicates (active NEW/PROCESSING)
      await supabase
        .from("process_queue")
        .insert({ users_total_id: r.id, status: "NEW" })
        .throwOnError();

      inserted += 1;
    } catch (e) {
      // Most common: duplicate due to unique partial index -> treat as "skipped"
      skipped += 1;
    }
  }

  console.log(JSON.stringify({ foundNew: (rows || []).length, inserted, skipped }));
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
