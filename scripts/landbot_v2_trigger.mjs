// scripts/landbot_v2_trigger.mjs
// מפעיל את ה-Landbot בדפדפן Playwright במצב headless/headed (לפי ENV),
// לוחץ על כפתור לפי טקסט אם קיים, ואם לא — שולח טקסט טריגר לאינפוט.
// שומר screenshots לפני/אחרי, עותק HTML, וידאו, trace, ו-payload של ההודעה.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const LANDBOT_URL = process.env.LANDBOT_URL;
const BUTTON_TEXT = process.env.LANDBOT_BUTTON_TEXT || 'סיכום שיחות המטופלים';
const TRIGGER_TEXT = process.env.TRIGGER_TEXT || 'התחל סיכום שיחות';
const EXPECT_URLS = (process.env.EXPECT_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const REQUIRE_NETWORK_CONFIRM = String(process.env.REQUIRE_NETWORK_CONFIRM || 'false').toLowerCase() === 'true';

// אם PW_HEADLESS=0 או HEADED=true — נריץ לא־headless (תחת Xvfb בגיטהאב)
const headless = !(process.env.PW_HEADLESS === '0' || String(process.env.HEADED).toLowerCase() === 'true');

const ART_DIR = path.resolve('artifacts');
if (!fs.existsSync(ART_DIR)) fs.mkdirSync(ART_DIR, { recursive: true });

function log(msg, obj) {
  const line = `[landbot_v2] ${new Date().toISOString()} | ${msg} ${obj ? JSON.stringify(obj) : ''}`;
  console.log(line);
  fs.appendFileSync(path.join(ART_DIR, 'run.log'), line + '\n');
}

if (!LANDBOT_URL) {
  console.error('ENV LANDBOT_URL is required');
  process.exit(0); // לא מפיל ריצה בכוח, נשאיר ל-workflow להחליט
}

(async () => {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: ART_DIR, size: { width: 1280, height: 800 } }
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();

  // לוגינג של בקשות/תגובות כדי לזהות שליחת הודעה ל-Landbot
  const netLog = [];
  page.on('request', req => {
    netLog.push({ t: Date.now(), dir: 'req', url: req.url(), method: req.method() });
  });
  page.on('response', async (res) => {
    try {
      netLog.push({ t: Date.now(), dir: 'res', url: res.url(), status: res.status() });
    } catch {}
  });

  try {
    log('Navigating to Landbot URL', { url: LANDBOT_URL, headless });
    await page.goto(LANDBOT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // המתנה ליציבות ראשונית + צילום "לפני"
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: path.join(ART_DIR, 'screenshot_before.png'), fullPage: true }).catch(() => {});
    const htmlBefore = await page.content().catch(() => '');
    fs.writeFileSync(path.join(ART_DIR, 'page_before.html'), htmlBefore || '', 'utf8');

    // נסה למצוא כפתור לפי טקסט
    let clicked = false;
    const selectorCandidates = [
      `role=button[name="${BUTTON_TEXT}"]`,
      `text="${BUTTON_TEXT}"`,
      `button:has-text("${BUTTON_TEXT}")`,
      `a:has-text("${BUTTON_TEXT}")`,
      `[role="button"]:has-text("${BUTTON_TEXT}")`
    ];

    for (const sel of selectorPatch(selectorCandidates)) {
      const el = page.locator(sel);
      if (await el.first().count().catch(() => 0)) {
        log('Found button candidate', { selector: sel });
        // הדגש ויזואלי לפני לחיצה
        try {
          const handle = await el.first().elementHandle();
          await handle.evaluate((node) => {
            node.style.outline = '3px solid red';
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
          await page.waitForTimeout(600);
          await page.screenshot({ path: path.join(ART_DIR, 'screenshot_highlight.png') }).catch(() => {});
        } catch {}

        await el.first().click({ timeout: 10_000 }).catch(() => {});
        clicked = true;
        break;
      }
    }

    // אם אין כפתור — שולחים טקסט טריגר לאינפוט של הוובצ׳אט
    let payload = null;
    if (!clicked) {
      log('Button not found, trying to send trigger text', { TRIGGER_TEXT });
      // נסה לאתר שדה קלט של Landbot (לרוב contenteditable)
      const inputSelectors = [
        'div[contenteditable="true"]',
        'textarea',
        'input[type="text"]',
        '[role="textbox"]'
      ];
      let typed = false;
      for (const sel of inputSelectors) {
        const input = page.locator(sel).last();
        if (await input.count().catch(() => 0)) {
          await input.click({ timeout: 5_000 }).catch(() => {});
          await input.type(TRIGGER_TEXT, { delay: 30 }).catch(() => {});
          await page.keyboard.press('Enter').catch(() => {});
          typed = true;
          payload = { type: 'text', text: TRIGGER_TEXT, ts: Date.now() };
          break;
        }
      }
      if (!typed) log('Could not find input to type trigger text');
    } else {
      payload = { type: 'click', text: BUTTON_TEXT, ts: Date.now() };
    }

    if (payload) {
      fs.writeFileSync(path.join(ART_DIR, 'msg_payload.json'), JSON.stringify(payload, null, 2));
    }

    // המתנה לאישורי רשת אם הוגדרו
    if (EXPECT_LENGTH(EXPECT_URLS) > 0) {
      log('Waiting for expected network responses', { EXPECT_URLS, REQUIRE_NETWORK_CONFIRM });
      try {
        await Promise.all(EXPECT_URLS.map(u =>
          page.waitForResponse(res => res.url().includes(u) && res.status() >= 200 && res.status() < 300, { timeout: 25_000 })
        ));
        log('All expected URLs confirmed 2xx');
      } catch (e) {
        log('Expected URL(s) not all confirmed', { error: String(e) });
        if (REQUIRE_NETWORK_CONFIRM) {
          throw new Error('REQUIRE_NETWORK_CONFIRM=true and not all expected URLs returned 2xx');
        }
      }
    } else {
      // המתנת רשת כללית
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }

    // צילום "אחרי" ושמירת HTML
    await page.screenshot({ path: path.join(ART_DIR, 'screenshot_after.png'), fullPage: true }).catch(() => {});
    const htmlAfter = await page.content().catch(() => '');
    fs.writeFileSync(path.join(ART_DIR, 'page_after.html'), htmlAfter || '', 'utf8');

    // שמירת לוג רשת
    fs.writeFileSync(path.join(ART_DIR, 'network_log.json'), JSON.stringify(netLog, null, 2));

    log('Done successfully');
  } catch (err) {
    log('Run error', { error: String(err && err.stack ? err.stack : err) });
  } finally {
    await context.tracing.stop({ path: path.join(ART_DIR, 'trace.zip') }).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch(e => {
  console.error(e);
  process.exit(0); // לא מפילים את ה-Job בכח כדי שתראה ארטיפקטים גם בשגיאה
});

function selectorPatch(arr){ return Array.from(new Set(arr.filter(Boolean))); }
function EXPECT_LENGTH(a){ return Array.isArray(a) ? a.length : 0; }
