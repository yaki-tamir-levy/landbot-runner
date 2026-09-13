import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ENCRYPTION_KEY = Deno.env.get("ENCRYPTION_KEY") || "your-32-char-secret-key-goes-here";
const IV_LENGTH = 16;

async function encrypt(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(ENCRYPTION_KEY),
    { name: "AES-CBC" }, false, ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(text));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

serve(async (req) => {
  try {
    const { action, payload } = await req.json();
    if (action !== 'encrypt_and_sync') throw new Error("Invalid action");

    const dataToSave = { ...payload };

    // הצפנה ושמירה בעמודה נפרדת, תוך שמירה על המקור גלוי
    if (dataToSave.user_text) {
      dataToSave.user_text_enc = await encrypt(String(dataToSave.user_text));
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // עדכון לפי טלפון - המקור והמוצפן יישמרו יחד
    const { error } = await supabase
      .from('users_information')
      .upsert(dataToSave, { onConflict: 'phone' });

    if (error) throw error;

    return new Response(JSON.stringify({ status: "success" }), { 
      headers: { "Content-Type": "application/json" }, status: 200 
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400 });
  }
})
