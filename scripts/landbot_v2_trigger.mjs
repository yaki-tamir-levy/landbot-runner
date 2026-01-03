/**
 * scripts/landbot_v2_trigger.mjs
 *
 * מטרות:
 * 1) לפתוח את LANDBOT_URL
 * 2) ללחוץ על כפתור/להזרים trigger_text
 * 3) להמתין שהבוט יסיים (באמצעות "שקט" ב-DOM של הודעות)
 * 4) לחלץ הודעות בוט מה-DOM
 * 5) לכתוב:
 *    - artifacts/bot_last_message.txt
 *    - artifacts/bot_messages_all.txt
 * 6) לשמור screenshot_after.png
 */

import fs from "fs";
import path from "path";
import process from "process";
import { chromium } from "playwright";

const ART_DIR = "artifacts";

function mustEnv(name, fallback = "") {
  const v = process.env[name] ?? fallback;
  return v;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * מחזיר טקסט של כל ההודעות הרלוונטיות בדף (בוט+יוזר),
 * כדי שנוכל לזהות אם המצב "נרגע" (לא משתנה) לאורך זמן.
 */
async function snapshotMessagesText(page) {
  // Multi-selector "סביר" ללנדבוטים שונים.
  // אם אצלך DOM שונה, תוכל לעדכן כאן לסלקטור מדויק (Inspect על הודעת בוט).
  const selector = [
    '[data-message-author="bot"]',
    '[data-message-author="agent"]',
    ".message--bot",
    ".lb-message--bot",
    ".message.bot",
    ".landbot-message.bot",
    ".lb-message",
    ".message",
  ].join(",");

  return page.$$eval(selector, (els) =>
    els
      .map((e) => (e.innerText || "").trim())
      .filter(Boolean)
      .join("\n\n---\n\n")
  ).catch(() => "");
}

/**
 * מחכה עד שההודעות מפסיקות להשתנות למשך quietMs.
 * זה המפתח למניעת "תשובה חלקית".
 */
async function waitUntilMessagesQuiet(page, { quietMs = 6000, timeoutMs = 180000, pollMs = 1000 }) {
  const start = Date.now();
  let lastText = await snapshotMessagesText(page);
  let lastChange = Date.now();

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(pollMs);
    const cur = await snapshotMessagesText(page);

    if (cur !== lastText) {
      lastText = cur;
      lastChange = Date.now();
      continue;
    }

    if (Date.now() - lastChange >= quietMs) {
      return { ok: true, lastText };
    }
  }

  return { ok: false, lastText };
}

/**
 * מחלץ רק הודעות בוט (וגם מחזיר "אחרונה").
 */
async function extractBotMessages(page) {
  // נסיון לכמה וריאנטים נפוצים.
  const botSelector = [
    '[data-message-author="bot"]',
    '[data-message-author="agent"]',
    ".message--bot",
    ".lb-message--bot",
    ".message.bot",
    ".landbot-message.bot",
  ].join(",");

  const msgs = await page.$$eval(botSelector, (els) =>
    els
      .map((e) => (e.innerText || "").trim())
      .filter(Boolean)
  ).catch(() => []);

  const last = msgs.length ? msgs[msgs.length - 1] : "";
  return { msgs, last };
}

async function main() {
  ensureDir(ART_DIR);

  const LANDBOT_URL = mustEnv("LANDBOT_URL");
  const LANDBOT_BUTTON_TEXT = mustEnv("LANDBOT_BUTTON_TEXT", "סיכום שיחות המטופלים");
  const TRIGGER_TEXT = mustEnv("TRIGGER_TEXT", "התחל סיכום שיחות");

  const POST_ACTION_IDLE_MS = parseInt(mustEnv("POST_ACTION_IDLE_MS", "300000"), 10);
  const REQUIRE_NETWORK_CONFIRM = (mustEnv("REQUIRE_NETWORK_CONFIRM", "false") + "").toLowerCase() === "true";

  // כמה זמן של "שקט" בדומ לפני שאומרים שהבוט סיים
  const QUIET_MS = 7000;
  const QUIET_TIMEOUT_MS = Math.max(60000, Math.min(300000, POST_ACTION_IDLE_MS)); // clamp סביר

  if (!LANDBOT_URL) {
    console.error("LANDBOT_URL is missing");
    process.exit(1);
  }

  const headed = (mustEnv("HEADED", "true") + "").toLowerCase() === "true";

  // מגדירים הקלטות/trace אם תרצה, כאן זה מינימלי. (אפשר להרחיב לפי setup שלך)
  const browser = await chromium.launch({
    headless: !headed, // אם headed=true אתה כבר רץ עם Xvfb
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    console.log(`[${nowIso()}] Opening Landbot: ${LANDBOT_URL}`);
    await page.goto(LANDBOT_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(1500);

    // נסיון ללחיצה על כפתור לפי טקסט (LANDBOT_BUTTON_TEXT)
    // שים לב: סלקטור טקסט איננו מושלם אם הטקסט מפוצל/לא בדיוק זהה.
    // אפשר להחליף לסלקטור CSS מדויק לפי הכפתור אצלך.
    const buttonLocator = page.getByRole("button", { name: LANDBOT_BUTTON_TEXT }).first();
    if (await buttonLocator.count().catch(() => 0)) {
      console.log(`[${nowIso()}] Clicking button: ${LANDBOT_BUTTON_TEXT}`);
      await buttonLocator.click({ timeout: 15000 });
    } else {
      console.log(`[${nowIso()}] Button not found by role+name: "${LANDBOT_BUTTON_TEXT}" (will try trigger text input)`);
    }

    // נסיון להזרים trigger_text לאינפוט (אם יש)
    // Landbot לפעמים משתמש ב-textarea/input. ננסה שניהם.
    const input = page.locator("textarea, input[type='text']").first();
    if (await input.count().catch(() => 0)) {
      console.log(`[${nowIso()}] Typing trigger text: ${TRIGGER_TEXT}`);
      await input.click({ timeout: 10000 }).catch(() => {});
      await input.fill(TRIGGER_TEXT, { timeout: 10000 }).catch(async () => {
        await input.type(TRIGGER_TEXT, { delay: 15 });
      });

      // נסיון לשלוח Enter
      await input.press("Enter").catch(() => {});
    } else {
      console.log(`[${nowIso()}] No obvious text input found; continuing.`);
    }

    // אם דורשים "network confirm" אצלך, כאן היית מוסיף לוגיקה של wait for response.
    // כרגע אתה שולח REQUIRE_NETWORK_CONFIRM=false, אז לא ננעל על זה.
    if (REQUIRE_NETWORK_CONFIRM) {
      console.log(`[${nowIso()}] REQUIRE_NETWORK_CONFIRM=true but not implemented in this minimal script.`);
    }

    // עכשיו החלק החשוב: לחכות שההודעות יפסיקו להשתנות => מונע תשובה חלקית
    console.log(`[${nowIso()}] Waiting for messages to become quiet (quiet=${QUIET_MS}ms, timeout=${QUIET_TIMEOUT_MS}ms)...`);
    const quietRes = await waitUntilMessagesQuiet(page, {
      quietMs: QUIET_MS,
      timeoutMs: QUIET_TIMEOUT_MS,
      pollMs: 1200,
    });

    console.log(`[${nowIso()}] Quiet result: ok=${quietRes.ok}`);

    // חילוץ הודעות בוט
    const { msgs, last } = await extractBotMessages(page);

    // לוג לריצה
    console.log("===== LAND BOT LAST MESSAGE =====");
    console.log(last || "[no bot message found]");

    // כתיבה לקבצים (אלו יוצגו ב-summary ויעלו כ-artifacts)
    const lastPath = path.join(ART_DIR, "bot_last_message.txt");
    const allPath = path.join(ART_DIR, "bot_messages_all.txt");

    fs.writeFileSync(lastPath, last || "", "utf8");
    fs.writeFileSync(allPath, msgs.join("\n\n---\n\n"), "utf8");

    // screenshot אחרי
    await page.screenshot({ path: path.join(ART_DIR, "screenshot_after.png"), fullPage: true }).catch(() => {});

    // אפשר גם להוסיף dump של snapshot אם תרצה debugging:
    fs.writeFileSync(path.join(ART_DIR, "messages_snapshot.txt"), quietRes.lastText || "", "utf8");

    console.log(`[${nowIso()}] Done. Wrote:\n- ${lastPath}\n- ${allPath}\n- artifacts/screenshot_after.png`);
  } catch (e) {
    console.error("ERROR in landbot_v2_trigger:", e?.stack || e?.message || e);
    // בכל מקרה ננסה צילום מסך לתחקור
    try {
      await page.screenshot({ path: path.join(ART_DIR, "screenshot_error.png"), fullPage: true });
    } catch {}
    // לא מפילים את ה-workflow בכוח (אצלך כבר יש || true), אבל נשאיר exit code 0 כדי לא לשבור
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main();
