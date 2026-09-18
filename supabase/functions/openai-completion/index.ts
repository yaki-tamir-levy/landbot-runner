import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

serve(async () => {
  const { data: jobs } = await supabase
    .from("ai_jobs")
    .select("*")
    .eq("status", "NEW")
    .limit(3);

  for (const j of jobs ?? []) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: "ענה בעברית קצר וברור." },
          { role: "user", content: j.prompt },
        ],
      }),
    });
    const js = await r.json();
    const content = js?.choices?.[0]?.message?.content ?? null;

    await supabase
      .from("ai_jobs")
      .update({
        answer: content,
        status: content ? "DONE" : "ERROR",
        updated_at: new Date().toISOString(),
      })
      .eq("id", j.id);
  }

  return new Response("OK");
});
