// scripts/landbot_v2_trigger.mjs
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.LANDBOT_URL
  || 'https://landbot.pro/v3/H-3207470-XRPDXMFVFDSCDXA5/index.html';

// UA/viewport "רגילים" כדי לצמצם חסימות בוט
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 768 };

// רשימת סלקטורים אפשריים לשדה ההקלדה (עדכן/הרחב לפי מה שתראה ב-HTML)
const INPUT_SELECTOR_CANDIDATES = [
  'textarea',
  'textarea[placeholder]',
  'input[type="text"]',
  'input[type="text"][placeholder]',
  '[contenteditable="true"]',
  '[data-testid="chat-input"]',
  '.composer textarea',
  '.landbot-input'
];

// תמיד נשאיר “עקבות” לדיבוג
try { fs.writeFileSync('landbot_debug_started.txt', new Date().toISOString()); } catch {}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: VIEWPORT,
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': URL,
      'Origin': 'https://landbot.pro'
    }
  });

  // מעט “הסוואה” עדינה
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  page.setDefaultNavigationTimeout(45_000);

  // לוג רשת/קונסול ממוקד ל-landbot/config
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('landbot') || url.includes('config')) {
      const s = resp.status();
      console.log('RESP', s, url);
      if (s >= 400) {
        try { console.log('BODY', (await resp.text()).slice(0, 200)); } catch {}
      }
    }
  });
  page.on('requestfailed', r => {
    const u = r.url();
    if (u.includes('landbot') || u.includes('config')) {
      console.log('FAILED', u, r.failure()?.errorText);
    }
  });
  page.on('console', msg => console.log('[console]', msg.type(), msg.text()));

  console.log('[landbot-v2] goto:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40_000 });

  // נשמור snapshot מוקדם לדיבוג
  try { fs.writeFileSync('landbot_page_early.html', await page.content()); } catch {}

  // לעתים צריך גלילה קצרה כדי לדרבן טעינה עצלה
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 3));
  await page.waitForTimeout(800);

  // ננסה לזהות הזרקת widget (סקריפט/קונטיינר)
  await page.waitForFunction(() => {
    const hasScript = !![...document.scripts].find(s => (s.src || '').includes('landbot'));
    const hasContainer = !!document.querySelector('iframe, [class*="landbot"], [id*="landbot"], [data-qa*="chat"], [role="textbox"]');
    return hasScript || hasContainer;
  }, { timeout: 15_000 }).catch(() => {});

  // לפעמים הווידג'ט ללא iframe → ננסה תחילה למצוא iframe, ואם אין – לעבוד על ה-DOM הראשי
  let iframe = null;
  try {
    await page.waitForSelector('iframe', { timeout: 6_000, state: 'attached' });
    iframe = await page.$('iframe');
  } catch {}

  if (iframe) {
    console.log('[landbot-v2] Found iframe, using it');
    const frame = await iframe.contentFrame();
    if (!frame) {
      await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(()=>{});
      fs.writeFileSync('landbot_page.html', await page.content());
      throw new Error('Iframe found but contentFrame() is null');
    }

    let found = null;
    for (const sel of INPUT_SELECTOR_CANDIDATES) {
      try { await frame.waitForSelector(sel, { timeout: 8_000 }); found = sel; break; } catch {}
    }
    if (!found) {
      await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(()=>{});
      fs.writeFileSync('landbot_page.html', await page.content());
      throw new Error('Chat input not found inside iframe');
    }

    try { await frame.fill(found, 'Ping from GitHub Actions'); }
    catch { await frame.click(found).catch(()=>{}); await frame.keyboard.type('Ping from GitHub Actions'); }
    await frame.keyboard.press('Enter');

  } else {
    console.log('[landbot-v2] No iframe — working on main DOM');
    let found = null;
    for (const sel of INPUT_SELECTOR_CANDIDATES) {
      try { await page.waitForSelector(sel, { timeout: 8_000 }); found = sel; break; } catch {}
    }
    if (!found) {
      await page.waitForTimeout(800);
      for (const sel of INPUT_SELECTOR_CANDIDATES) {
        try { await page.waitForSelector(sel, { timeout: 6_000 }); found = sel; break; } catch {}
      }
    }
    if (!found) {
      await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(()=>{});
      fs.writeFileSync('landbot_page.html', await page.content());
      throw new Error('Chat input not found on main DOM');
    }

    try { await page.fill(found, 'Ping from GitHub Actions'); }
    catch { await page.click(found).catch(()=>{}); await page.keyboard.type('Ping from GitHub Actions'); }
    await page.keyboard.press('Enter');
  }

  console.log('[landbot-v2] Success');
  await browser.close();
})().catch(async (err) => {
  console.error('[landbot-v2] ERROR:', err?.message || err);
  try { await (await import('fs')).promises.writeFile('landbot_error.txt', String(err?.stack || err)); } catch {}
  process.exit(1);
});
