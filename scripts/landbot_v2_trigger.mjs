// scripts/landbot_v2_trigger.mjs
import { chromium } from "playwright";

const URL = process.env.LAND_BOT_URL || "https://landbot.pro/v3/H-3211152-NZNA5NPAWJPGHQMV/index.html";
const SELECTOR = process.env.CLICK_SELECTOR || ""; // למשל: button:has-text("עדכון מטופלים שנבחרו (V)")
const CLICK_X = Number(process.env.CLICK_X || 0);
const CLICK_Y = Number(process.env.CLICK_Y || 0);

const HEADLESS = process.env.CI === "true" ? true : true; // ב-CI תמיד headless

function log(msg) { console.log(`[landbot-v2] ${msg}`); }

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });
  const page = await ctx.newPage();

  try {
    log(`goto: ${URL}`);
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // המתן לבוט להיטען
    await page.waitForLoadState("networkidle", { timeout: 60_000 });
    await page.waitForTimeout(1500);

    if (SELECTOR && SELECTOR.trim()) {
      log(`click by selector: ${SELECTOR}`);
      const btn = page.locator(SELECTOR);
      await btn.first().click({ timeout: 30_000 });
    } else if (CLICK_X && CLICK_Y) {
      log(`click by coordinates: ${CLICK_X}, ${CLICK_Y}`);
      await page.mouse.click(CLICK_X, CLICK_Y, { timeout: 10_000 });
    } else {
      throw new Error("No CLICK_SELECTOR and no CLICK_X/CLICK_Y were provided.");
    }

    // המתנה קצרה לאימות
    await page.waitForTimeout(1500);
    log("done.");
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error("[landbot-v2] ERROR:", err?.message || err);
    try { await page.screenshot({ path: "landbot_v2_error.png", fullPage: true }); } catch {}
    await browser.close();
    process.exit(1);
  }
})();
