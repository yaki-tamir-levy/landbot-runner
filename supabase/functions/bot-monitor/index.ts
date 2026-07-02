import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type EventRow = {
  conversation_suffix: string;
  source_table: string;
  event_name: string;
  patient_code: string;
  created_at: string;
  source_id: string;
  details: Record<string, unknown> | null;
  id: string;
  phone_masked: string | null;
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

function eventTitle(eventName: string): string {
  switch (eventName) {
    case "conversation_started":
      return "Conversation Started";
    case "users_total_updated":
      return "Users Total Updated";
    case "process_queue_created":
      return "Process Queue Created";
    case "users_tzvira_updated":
      return "Users Tzvira Updated";
    case "postprocess_completed":
      return "Postprocess Completed";
    default:
      return eventName;
  }
}

function safeText(value: string): string {
  return value
    .replaceAll("└─", "->")
    .replaceAll("─", "-")
    .replaceAll("·", "-")
    .replaceAll("Â·", "-")
    .replaceAll("â””â”€", "->")
    .replaceAll("â”€", "-");
}

function businessOrder(eventName: string): number {
  switch (eventName) {
    case "conversation_started":
      return 10;
    case "users_total_updated":
      return 20;
    case "process_queue_created":
      return 30;
    case "users_tzvira_updated":
      return 40;
    case "postprocess_completed":
      return 50;
    default:
      return 999;
  }
}

function buildPayload(rows: EventRow[]) {
  const groups = new Map<string, EventRow[]>();

  for (const row of rows) {
    if (!groups.has(row.conversation_suffix)) {
      groups.set(row.conversation_suffix, []);
    }
    groups.get(row.conversation_suffix)!.push(row);
  }

  const conversations = Array.from(groups.entries()).map(([conversation_suffix, events]) => {
    const sortedEvents = events
      .slice()
      .sort((a, b) => businessOrder(a.event_name) - businessOrder(b.event_name));

    const completed = sortedEvents.some((event) => event.event_name === "postprocess_completed");

    return {
      conversation_suffix,
      status: completed ? "Completed" : "Running",
      completed,
      events: sortedEvents.map((event) => ({
        event_name: event.event_name,
        event_title: eventTitle(event.event_name),
        source_table: safeText(event.source_table),
        created_at: event.created_at,
        patient_code: event.patient_code,
        phone_masked: event.phone_masked,
        source_id: event.source_id,
        id: event.id,
      })),
    };
  });

  return {
    version: "1.0",
    refreshed_at: new Date().toISOString(),
    count: conversations.length,
    conversations,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
      },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
      },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const { data, error } = await supabase
    .from("conversation_events_v2_view")
    .select("*")
    .limit(200);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "content-type": "application/json; charset=utf-8",
      },
    });
  }

  return new Response(JSON.stringify(buildPayload((data ?? []) as EventRow[]), null, 2), {
    status: 200,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});
