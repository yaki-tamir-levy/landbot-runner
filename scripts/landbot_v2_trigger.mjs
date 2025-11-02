// scripts/landbot_v2_trigger.mjs
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.LANDBOT_URL
  || 'https://landbot.pro/v3/H-3207470-XRPDXMFVFDSCDXA5/index.html';

const BUTTON_TEXT = process.env.LANDBOT_BUTTON_TEXT || 'סיכום שיחות המטופלים';

// --- Watchdog: חותך ריצה תקועה אחרי 110 שניות ---
const watchdog = setTimeout(() => {
  console.error('[landbot-v2] ERROR: watchdog timeout');
  try { fs.writeFileSync('landbot_error.txt', 'Watchdog timeout'); } catch {}
  process.exit(1);
}, 110_000);

// UA/viewport "רגילים"
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 864 };

// שורת דיבוג כדי שתמיד יהיה משהו להעלות
try { fs.writeFileSync('landbot_debug_started.txt', new Date().toISOString()); } catch {}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ]
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: VIEWPORT,
    locale: 'he-IL',
    extraHTTPHeaders: {
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': URL,
      'Origin': 'https://landbot.pro'
    }
  });

  // לפתוח Shadow DOM ל"open" כדי לאפשר גישה פנימה
  await context.addInitScript(() => {
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      try { return orig.call(this, Object.assign({}, init, { mode: 'open' })); }
      catch { return orig.call(this, init); }
    };
    // הסוואה עדינה
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['he-IL','he','en-US','en'] });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  page.setDefaultNavigationTimeout(35_000);

  // לוגים שימושיים
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('landbot') || url.includes('webchat') || url.includes('config')) {
      const s = resp.status();
      console.log('RESP', s, url);
      if (s >= 400) {
        try { console.log('BODY', (await resp.text()).slice(0, 200)); } catch {}
      }
    }
  });
  page.on('requestfailed', r => {
    const u = r.url();
    if (u.includes('landbot') || u.includes('webchat') || u.includes('config')) {
      console.log('FAILED', u, r.failure()?.errorText);
    }
  });
  page.on('console', msg => console.log('[console]', msg.type(), msg.text()));

  console.log('[landbot-v2] goto:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // snapshot מוקדם
  try { fs.writeFileSync('landbot_page_early.html', await page.content()); } catch {}

  // גלילה קלה לדרבן טעינה עצלה
  await page.evaluate(() => window.scrollTo(0, Math.floor(window.innerHeight * 0.5)));
  await page.waitForTimeout(800);

  // המתן לסימנים שהווידג’ט נטען
  await page.waitForFunction(() => {
    const scripts = [...document.scripts].some(s => (s.src||'').includes('landbot'));
    const hasBtnText = document.documentElement.innerText.includes('סיכום שיחות המטופלים');
    const anyShadow = [...document.querySelectorAll('*')].some(el => el.shadowRoot);
    return scripts || hasBtnText || anyShadow;
  }, { timeout: 10_000 }).catch(() => {});

  // --- פונקציה: מציאת ולחיצה על כפתור לפי טקסט (כולל Shadow DOM) ---
  async function clickButtonByText(text) {
    // 1) נסיון ישיר: getByRole('button', { name: text })
    const byRole = page.getByRole('button', { name: text, exact: false });
    if (await byRole.count().catch(() => 0)) {
      await byRole.first().click({ timeout: 10_000 });
      return true;
    }

    // 2) נסיון טקסט כללי (יכול לתפוס div/a עם טקסט הכפתור)
    const byText = page.getByText(text, { exact: false });
    if (await byText.count().catch(() => 0)) {
      await byText.first().click({ timeout: 10_000 });
      return true;
    }

    // 3) חיפוש ידני עמוק בתוך כל ה-Shadow DOM והחזרת אלמנט קליקבילי
    const handle = await page.evaluateHandle((t) => {
      const clickable = (el) => {
        if (!el) return null;
        const styles = window.getComputedStyle(el);
        const clickableTag = ['BUTTON','A'].includes(el.tagName);
        const looksClickable = clickableTag || el.onclick || styles.cursor === 'pointer' || el.getAttribute('role') === 'button';
        return looksClickable ? el : null;
      };

      const findInRoot = (root) => {
        const all = root.querySelectorAll('*');
        for (const el of all) {
          if ((el.innerText || '').includes(t)) {
            const c = clickable(el) || clickable(el.closest('button, a, [role="button"]'));
            if (c) return c;
          }
          if (el.shadowRoot) {
            const found = findInRoot(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };

      // 3a) נסה בכל shadowRoot
      const fromShadow = findInRoot(document);
      if (fromShadow) return fromShadow;

      // 3b) נסה ב-DOM הראשי
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
      for (const el of candidates) {
        if ((el.innerText || '').includes(t)) return el;
      }
      return null;
    }, text);

    const el = await handle.asElement();
    if (el) {
      await el.click({ timeout: 10_000 });
      return true;
    }
    return false;
  }

  // --- לחיצה על הכפתור ---
  const clicked = await clickButtonByText(BUTTON_TEXT);
  if (!clicked) {
    await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(()=>{});
    fs.writeFileSync('landbot_page.html', await page.content());
    throw new Error(`Button with text "${BUTTON_TEXT}" not found/clickable`);
  }

  // צילום אחרי לחיצה (לראות שקרה משהו)
  try { await page.screenshot({ path: 'landbot_after_click.png', fullPage: true }); } catch {}

  console.log('[landbot-v2] Success (button clicked)');
  clearTimeout(watchdog);
  await browser.close();
  process.exit(0);
})().catch(async (err) => {
  console.error('[landbot-v2] ERROR:', err?.message || err);
  try { await (await import('fs')).promises.writeFile('landbot_error.txt', String(err?.stack || err)); } catch {}
  try { await (await import('fs')).promises.writeFile('landbot_page.html', await (await (await chromium.launch()).newContext()).newPage().content()); } catch {}
  clearTimeout(watchdog);
  process.exit(1);
});
