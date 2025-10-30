// script_link.mjs — ריצה חד-פעמית: פתיחה, איתור "סיכום שיחות המטופלים", קליק, המתנה 60ש', סגירה
import { chromium } from 'playwright';

const URL = 'https://landbot.pro/v3/H-3207470-XRPDXMFVFDSCDXA5/index.html';
const TEXT_TO_FIND = 'סיכום שיחות המטופלים';

// אם רצים ב-GitHub Actions (CI), נפעיל headless אוטומטית
const isCI = process.env.CI === 'true';

// חיפוש אלמנט עם הטקסט בכל ה-frames: text= / :has-text() / XPath
async function findLocatorInFrames(page, text) {
  for (const f of page.frames()) {
    const a = f.locator('text=' + text).first();
    if (await a.count()) return a;
  }
  for (const f of page.frames()) {
    const b = f.locator(':has-text("' + text + '")').first();
    if (await b.count()) return b;
  }
  for (const f of page.frames()) {
    const c = f.locator('xpath=//*[contains(normalize-space(.), "' + text + '")]').first();
    if (await c.count()) return c;
  }
  return null;
}

(async () => {
  console.log('[once] launching chromium… (headless:', isCI ? 'true' : 'false', ')');
  const browser = await chromium.launch({ headless: isCI ? true : false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log('[once] goto landbot (domcontentloaded)…');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try { await page.waitForSelector('iframe', { timeout: 15000 }); } catch {}
  await page.waitForTimeout(1500);

  console.log('[once] locating cube…');
  let cube = await findLocatorInFrames(page, TEXT_TO_FIND);
  if (!cube) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(1500);
    cube = await findLocatorInFrames(page, TEXT_TO_FIND);
  }
  if (!cube) throw new Error('לא נמצא אלמנט עם הטקסט: ' + TEXT_TO_FIND);

  await cube.scrollIntoViewIfNeeded();
  try { await cube.hover({ timeout: 3000 }); } catch {}

  console.log('[once] click…');
  try {
    await cube.click({ timeout: 20000 });
  } catch (e) {
    // גיבוי: קליק לפי קואורדינטות
    const h = await cube.elementHandle();
    const box = h ? await h.boundingBox() : null;
    if (!box) throw e;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.up();
  }

  // זמן עבודה לבוט
  console.log('[once] waiting 60s for bot to progress…');
  await page.waitForTimeout(60000);

  console.log('[once] closing…');
  await browser.close();
  console.log('[once] done.');
})().catch(err => {
  console.error('[once] ERROR:', err?.message || err);
  process.exit(1);
});
