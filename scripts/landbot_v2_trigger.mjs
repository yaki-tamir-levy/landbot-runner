// scripts/landbot_v2_trigger.mjs
import { chromium, devices } from 'playwright';

const URL = process.env.LANDBOT_URL
  || 'https://landbot.pro/v3/H-3207470-XRPDXMFVFDSCDXA5/index.html';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 768 };

const INPUT_SELECTOR_CANDIDATES = [
  'textarea',
  'input[type="text"]',
  '[contenteditable="true"]',
  '[data-testid="chat-input"]',
  '.landbot-input',        // fallback כללי
  '.composer textarea',    // fallback נפוצים
];

async function tryDismissCookie(page) {
  const cookieButtons = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("הסכמה")',
    'button:has-text("קבל")',
    '#onetrust-accept-btn-handler',
    '.fc-cta-consent',
  ];
  for (const sel of cookieButtons) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      try { await btn.click({ delay: 50 }); } catch {}
    }
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: [
    '--disable-blink-features=AutomationControlled',
  ]});
  const context = await browser.newContext({
    userAgent: UA,
    viewport: VIEWPORT,
    locale: 'en-US',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(120_000);

  // לוגים שימושיים
  page.on('requestfailed', r => console.log('✗', r.url(), r.failure()?.errorText));
  page.on('console', msg => console.log('[console]', msg.type(), msg.text()));

  console.log('[landbot-v2] goto:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  // לפעמים צריך עוד שנייה כדי ש-widgets יתאפסו
  await page.waitForTimeout(1500);
  await tryDismissCookie(page);

  // --- נסה למצוא iframe כלשהו (לאו דווקא עם src של landbot) ---
  let iframeEl = await page.$('iframe').catch(() => null);
  if (!iframeEl) {
    // עוד קצת זמן לטעינה דינמית של iframe
    try {
      await page.waitForSelector('iframe', { timeout: 30_000, state: 'attached' });
      iframeEl = await page.$('iframe');
    } catch {}
  }

  if (iframeEl) {
    console.log('[landbot-v2] Found an iframe, entering it…');
    const frame = await iframeEl.contentFrame();
    if (!frame) {
      // שמור דיאגנוסטיקה
      await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(() => {});
      await page.content().then(html => require('fs').writeFileSync('landbot_page.html', html)).catch(() => {});
      throw new Error('Iframe found but no contentFrame() available');
    }

    // נסה לאתר שדה קלט בתוך ה-iframe
    let found = null;
    for (const sel of INPUT_SELECTOR_CANDIDATES) {
      try {
        await frame.waitForSelector(sel, { timeout: 20_000 });
        found = sel; break;
      } catch {}
    }
    if (!found) {
      // נסה עוד רגע + צילום מסך של ה-iframe דרך העמוד
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(() => {});
      await page.content().then(html => require('fs').writeFileSync('landbot_page.html', html)).catch(() => {});
      throw new Error('Chat input not found inside iframe');
    }

    // שלח הודעה קצרה
    try { await frame.fill(found, 'Ping from GitHub Actions'); }
    catch {
      await frame.click(found).catch(() => {});
      await frame.keyboard.type('Ping from GitHub Actions');
    }
    await frame.keyboard.press('Enter');

  } else {
    console.log('[landbot-v2] No iframe found — trying direct DOM');
    // ייתכן שהצ׳אט מוטמע בדומ הראשי בלי iframe
    let found = null;
    for (const sel of INPUT_SELECTOR_CANDIDATES) {
      try {
        await page.waitForSelector(sel, { timeout: 20_000 });
        found = sel; break;
      } catch {}
    }
    if (!found) {
      await tryDismissCookie(page);
      // עוד ניסיון קצר
      for (const sel of INPUT_SELECTOR_CANDIDATES) {
        try {
          await page.waitForSelector(sel, { timeout: 10_000 });
          found = sel; break;
        } catch {}
      }
    }
    if (!found) {
      await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(() => {});
      await page.content().then(html => require('fs').writeFileSync('landbot_page.html', html)).catch(() => {});
      throw new Error('Chat input not found on page DOM');
    }
    try { await page.fill(found, 'Ping from GitHub Actions'); }
    catch {
      await page.click(found).catch(() => {});
      await page.keyboard.type('Ping from GitHub Actions');
    }
    await page.keyboard.press('Enter');
  }

  console.log('[landbot-v2] Success');
  await browser.close();
})().catch(async (err) => {
  console.error('[landbot-v2] ERROR:', err?.message || err);
  // נסה לשמור דיאגנוסטיקה כללית
  try { const p = await import('fs'); } catch {}
  process.exit(1);
});
