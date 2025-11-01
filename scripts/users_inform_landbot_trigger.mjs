// scripts/users_inform_landbot_trigger.mjs
import { chromium } from 'playwright';

const BOT_URL = 'https://landbot.pro/v3/H-3211152-NZNA5NPAWJPGHQMV/index.html';
const TARGET_TEXT = 'עדכון מטופלים שנבחרו (V)';

// נקודת הקליק שמצאת בקונסול:
const FALLBACK_POINT = { x: 552, y: 414 };

(async () => {
  const browser = await chromium.launch({
    headless: process.env.CI ? true : false,
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  try {
    console.log('➡️ open bot page…');
    await page.goto(BOT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    // 1) נסיון לפי טקסט (יציב יותר)
    const locator = page.locator(`button:has-text("${TARGET_TEXT}")`);
    const count = await locator.count().catch(() => 0);

    if (count > 0) {
      console.log('✅ found button via locator, clicking…');
      await locator.first().click({ timeout: 5000 });
    } else {
      console.log('⚠️ locator not found, trying fallback mouse click…');
      await page.mouse.click(FALLBACK_POINT.x, FALLBACK_POINT.y);
    }

    await page.waitForTimeout(1500);
    console.log('🎉 done');
  } catch (err) {
    console.error('❌ error:', err?.message || err);
    process.exitCode = 1;
  } finally {
    await ctx.close();
    await browser.close();
  }
})();
