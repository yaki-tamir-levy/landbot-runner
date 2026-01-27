import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// 1. הגדרות - וודא שהפרמטרים תקינים בסביבה שלך
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://qcwimczsiuxkarwfiyai.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "your-service-key";
const FIXED_PHONE = "99999999";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function run(mode: number) {
  // שליפת השורה הספציפית מהטבלה
  const { data, error } = await supabase
    .from('users_information')
    .select('user_text_enc')
    .eq('phone', FIXED_PHONE)
    .single();

  if (error || !data) {
    console.error("שגיאה: לא נמצא נתון עבור הטלפון הקבוע.", error?.message);
    return;
  }

  const encryptedValue = data.user_text_enc;

  if (mode === 1) {
    // קוד 1: הצגת הנתון המוצפן כפי שהוא
    console.log("--- נתון מוצפן (קוד 1) ---");
    console.log(encryptedValue);
  } 
  else if (mode === 2) {
    // קוד 2: שליחה לפענוח
    console.log("--- מפענח נתון (קוד 2) ---");
    const decrypted = await decryptViaFunction(encryptedValue);
    console.log("תוצאה:", decrypted);
  }
}

async function decryptViaFunction(text: string) {
  const url = `$https://qcwimczsiuxkarwfiyai.supabase.co/functions/v1/crypto-tool`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer $eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjd2ltY3pzaXV4a2Fyd2ZpeWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1OTEwMzgsImV4cCI6MjA2OTE2NzAzOH0.zpMcORTD1voqZFj5QaPUc-EXf1juqnlTTP00jV6_TvI`,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ action: 'decrypt', text: text })
  });
  const json = await response.json();
  return json.result || json.error;
}

// קריאה לפרמטר מהטרמינל (1 או 2)
const mode = parseInt(Deno.args[0]);

if (mode !== 1 && mode !== 2) {
  console.log("יש להזין 1 (מוצפן) או 2 (מפוענח)");
} else {
  run(mode);
}
