// scripts/landbot_v2_trigger.mjs
import { chromium } from 'playwright';

const URL = process.env.LANDBOT_URL
  || 'https://landbot.pro/v3/H-3207470-XRPDXMFVFDSCDXA5/index.html';

const IFRAME_SELECTOR = 'iframe[src*="landbot"]';
const INPUT_SELECTOR_CANDIDATES = [
  'textarea',
  'input[type="text"]',
  '[contenteditable="true"]',
  '[data-testid="chat-input"]',
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // (אופציונלי) Trace לדיבוג:
  // await context.tracing.start({ screenshots: true, snapshots: true });

  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(120_000);

  page.on('requestfailed', r => console.log('✗', r.url(), r.failure()?.errorText));
  page.on('console', msg => console.log('[console]', msg.type(), msg.text()));

  console.log('[landbot-v2] goto:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const iframeEl = await page.waitForSelector(IFRAME_SELECTOR, { timeout: 60_000 });
  const landbotFrame = await iframeEl.contentFrame();
  if (!landbotFrame) throw new Error('Iframe content not available');

  let foundSelector = null;
  for (const sel of INPUT_SELECTOR_CANDIDATES) {
    try {
      await landbotFrame.waitForSelector(sel, { timeout: 20_000 });
      foundSelector = sel;
      break;
    } catch {}
  }
  if (!foundSelector) {
    await page.screenshot({ path: 'landbot_fail.png', fullPage: true });
    throw new Error('Chat input not found inside Landbot iframe');
  }

  // דוגמה לאינטרקציה קצרה:
  try {
    await landbotFrame.fill(foundSelector, 'Ping from GitHub Actions');
  } catch {
    await landbotFrame.click(foundSelector);
    await landbotFrame.keyboard.type('Ping from GitHub Actions');
  }
  await landbotFrame.keyboard.press('Enter');

  console.log('[landbot-v2] Success');

  // (אופציונלי) לעצור trace ולשמור:
  // await context.tracing.stop({ path: 'traces/trace.zip' });

  await browser.close();
})().catch(async (err) => {
  console.error('[landbot-v2] ERROR:', err?.message || err);
  process.exit(1);
});
