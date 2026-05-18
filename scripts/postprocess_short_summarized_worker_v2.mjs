// scripts/postprocess_short_summarized_worker_v2.mjs
// Dequeues 1 item from users_total_v2_postprocess_queue, runs OpenAI on users_total_v2.summarized_linked_talk,
// writes result to users_total_v2.short_summarized, then marks queue item DONE.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  console.error("Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY");
  process.exit(1);
}

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function supaRpc(fnName, body = {}) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: supaHeaders,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`RPC ${fnName} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function supaSelectUsersTotalV2ById(id) {
  const url =
    `${SUPABASE_URL}/rest/v1/users_total_v2` +
    `?select=id,patient_code,phone,summarized_linked_talk` +
    `&id=eq.${encodeURIComponent(id)}` +
    `&limit=1`;

  const res = await fetch(url, { headers: supaHeaders });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SELECT users_total_v2 failed (${res.status}): ${text}`);
  }
  const rows = text ? JSON.parse(text) : [];
  return rows[0] || null;
}

async function supaSelectPromptUserText() {
  const promptPhone = "55555555";
  const url =
    `${SUPABASE_URL}/rest/v1/users_information` +
    `?select=user_text` +
    `&phone=eq.${encodeURIComponent(promptPhone)}` +
    `&limit=1`;

  const res = await fetch(url, { headers: supaHeaders });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SELECT users_information.user_text failed (${res.status}): ${text}`);
  }
  const rows = text ? JSON.parse(text) : [];
  const userText = rows?.[0]?.user_text;
  const prompt = typeof userText === "string" ? userText.trim() : "";
  return prompt ? prompt : "NONE";
}

async function supaUpdateUsersTotalV2Short(id, shortSummarized) {
  const url =
    `${SUPABASE_URL}/rest/v1/users_total_v2` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,short_summarized`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...supaHeaders,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ short_summarized: shortSummarized }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`UPDATE users_total_v2.short_summarized failed (${res.status}): ${text}`);
  }

  const rows = text ? JSON.parse(text) : [];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`UPDATE users_total_v2.short_summarized matched 0 rows for id=${id} (returned ${rows.length})`);
  }
  return String(rows[0]?.short_summarized ?? "");
}

async function supaMarkQueue(queueId, status, last_error = null) {
  const url = `${SUPABASE_URL}/rest/v1/users_total_v2_postprocess_queue?id=eq.${encodeURIComponent(queueId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...supaHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      last_error,
      updated_at: new Date().toISOString(),
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`UPDATE queue failed (${res.status}): ${text}`);
  }
}

function sanitizeResult(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function openaiSummarize(promptText, inputText) {
  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: promptText },
      { role: "user", content: inputText || "" },
    ],
    max_output_tokens: 600,
    temperature: 0.3,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`OpenAI failed (${res.status}): ${JSON.stringify(data)}`);
  }

  let out = sanitizeResult(data?.output_text || "");
  if (!out) {
    const parts = [];
    const outputArr = data?.output;
    if (Array.isArray(outputArr)) {
      for (const item of outputArr) {
        const contentArr = item?.content;
        if (Array.isArray(contentArr)) {
          for (const c of contentArr) {
            if (typeof c?.text === "string") parts.push(c.text);
            else if (typeof c?.content === "string") parts.push(c.content);
            else if (typeof c === "string") parts.push(c);
          }
        }
      }
    }
    out = sanitizeResult(parts.join("\n"));
  }

  if (!out) {
    const dbg = {
      id: data?.id,
      model: data?.model,
      output_len: Array.isArray(data?.output) ? data.output.length : null,
      output_text_len: (data?.output_text || "").length,
    };
    throw new Error(`OpenAI returned empty text. Debug=${JSON.stringify(dbg)}`);
  }

  return out;
}

async function main() {
  const MAX_TASKS_PER_RUN = 10;
  let processed = 0;

  while (processed < MAX_TASKS_PER_RUN) {
    const picked = await supaRpc("dequeue_users_total_v2_postprocess");
    const rows = Array.isArray(picked) ? picked : [];
    
    if (rows.length === 0) {
      if (processed === 0) console.log("No NEW tasks. Exiting.");
      else console.log(`No more tasks. Processed=${processed}. Exiting.`);
      return;
    }

    const task = rows[0];
    const queueId = task.id;
    const usersTotalV2Id = task.users_total_v2_id;
    const phone = task.phone;

    console.log(`Picked task queueId=${queueId} users_total_v2_id=${usersTotalV2Id} phone=${phone}`);

    try {
      const row = await supaSelectUsersTotalV2ById(usersTotalV2Id);
      if (!row) throw new Error(`users_total_v2 not found for id=${usersTotalV2Id}`);

      const src = row.summarized_linked_talk || "";
      if (!src.trim()) {
        const saved = await supaUpdateUsersTotalV2Short(usersTotalV2Id, "");
        console.log(`summarized_linked_talk empty; saved len=${saved.length}`);
        await supaMarkQueue(queueId, "DONE", null);
        processed += 1;
        continue;
      }

      const promptText = await supaSelectPromptUserText();
      const shortSummarized = await openaiSummarize(promptText, src);
      console.log(`OpenAI output length=${shortSummarized.length}`);

      const saved = await supaUpdateUsersTotalV2Short(usersTotalV2Id, shortSummarized);
      console.log(`Saved short_summarized length=${saved.length}`);

      await supaMarkQueue(queueId, "DONE", null);
      console.log("DONE");
    } catch (err) {
      const msg = err?.stack ? String(err.stack) : String(err);
      console.error("ERROR:", msg);
      try {
        await supaMarkQueue(queueId, "ERROR", msg.slice(0, 4000));
      } catch (e) {
        console.error("Failed to mark ERROR:", e);
      }
    }

    processed += 1;
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
