// scripts/landbot_v2_trigger.mjs
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.LANDBOT_HARDCODED_URL || process.env.LANDBOT_URL
  || 'https://landbot.pro/v3/H-3207470-XRPDXMFVFDSCDXA5/index.html';

const BUTTON_TEXT = process.env.LANDBOT_BUTTON_TEXT || 'סיכום שיחות המטופלים';

// רשימת תתי-כתובות לזיהוי תגובת 2xx אחרי הקליק (מופרדות בפסיקים); ריק = לא בודקים כלל
const URL_PARTS_RAW = (process.env.EXPECT_URLS || '').trim();
const REQUIRE_NETWORK_CONFIRM =
  String(process.env.REQUIRE_NETWORK_CONFIRM || 'false').toLowerCase() === 'true';

// ---- Watchdog למניעת ריצות אינסופיות (כ-120ש׳) ----
const watchdog = setTimeout(() => {
  console.error('[landbot-v2] ERROR: watchdog timeout');
  try { fs.writeFileSync('landbot_error.txt', 'Watchdog timeout'); } catch {}
  process.exit(1);
}, 120_000);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 864 };

try { fs.writeFileSync('landbot_debug_started.txt', new Date().toISOString()); } catch {}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: VIEWPORT,
    locale: 'he-IL',
    extraHTTPHeaders: {
      'Accept-Language':'he-IL,he;q=0.9,en-US;q=0.8',
      'Referer': URL,
      'Origin': 'https://landbot.pro'
    },
    recordVideo: { dir: 'videos', size: VIEWPORT }
  });

  // פתיחת shadowRoot ל-open והסוואת אוטומציה
  await context.addInitScript(() => {
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init){ try{return orig.call(this,{...init,mode:'open'})}catch{return orig.call(this,init)} };
    Object.defineProperty(navigator,'webdriver',{get:()=>false});
    window.chrome = { runtime:{} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['he-IL','he','en-US','en'] });
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  const video = page.video();
  page.setDefaultTimeout(35_000);
  page.setDefaultNavigationTimeout(35_000);

  page.on('console', m => console.log('[console]', m.type(), m.text()));
  page.on('requestfailed', r => console.log('FAILED', r.url(), r.failure()?.errorText));
  page.on('response', r => {
    const u = r.url(); const s = r.status();
    if (u.includes('landbot') || u.includes('webchat') || u.includes('supabase') || u.includes('messages.landbot.io')) {
      console.log('RESP', s, u);
    }
  });

  console.log('[landbot-v2] goto:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // צילומי דף ראשונים
  try { await page.screenshot({ path: 'landbot_before_click.png', fullPage: true }); } catch {}
  try { fs.writeFileSync('landbot_page_early.html', await page.content()); } catch {}

  // אם יש "Start the conversation" – נלחץ
  const startBtn = page.getByText(/Start the conversation/i);
  if (await startBtn.count().catch(()=>0)) {
    try { await startBtn.first().click({ timeout: 8_000 }); } catch {}
  }

  // לחיצה לפי טקסט (כולל Shadow DOM)
  async function clickByText(t){
    const byRole = page.getByRole('button', { name: t, exact: false });
    if (await byRole.count().catch(()=>0)) { await byRole.first().click({ timeout: 10_000 }); return true; }
    const byText = page.getByText(t, { exact: false });
    if (await byText.count().catch(()=>0)) { await byText.first().click({ timeout: 10_000 }); return true; }

    const handle = await page.evaluateHandle((txt) => {
      const clickable = (el)=>{
        if(!el) return null;
        const cs=getComputedStyle(el);
        const isBtn=['BUTTON','A'].includes(el.tagName)||el.getAttribute('role')==='button';
        if(isBtn || el.onclick || cs.cursor==='pointer') return el;
        const near=el.closest('button, [role="button"], a');
        return near||null;
      };
      const deepSearch=(root)=>{
        const all=root.querySelectorAll('*');
        for (const el of all){
          if((el.innerText||'').includes(txt)){
            const c = clickable(el);
            if(c) return c;
          }
          if(el.shadowRoot){
            const found = deepSearch(el.shadowRoot);
            if(found) return found;
          }
        }
        return null;
      };
      return deepSearch(document);
    }, t);
    const el = await handle.asElement();
    if (el) { await el.click({ timeout: 10_000 }); return true; }
    return false;
  }

  const clicked = await clickByText(BUTTON_TEXT);
  if (!clicked) {
    await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(()=>{});
    fs.writeFileSync('landbot_page.html', await page.content());
    throw new Error(`Button "${BUTTON_TEXT}" not found/clickable`);
  }

  // אימות־רשת "רך" על פי EXPECT_URLS (אם הוגדר)
  let networkOk = true;
  if (URL_PARTS_RAW) {
    networkOk = false;
    const parts = URL_PARTS_RAW.split(',').map(s => s.trim()).filter(Boolean);
    try {
      await page.waitForResponse(
        r => parts.some(p => r.url().includes(p)) && r.status() >= 200 && r.status() < 300,
        { timeout: 20_000 }
      );
      console.log('[landbot-v2] Verified: matched one of:', parts.join(' | '));
      networkOk = true;
    } catch {
      console.warn('[landbot-v2] WARNING: no 2xx match for any of:', parts.join(' | '));
    }
  } else {
    console.log('[landbot-v2] NOTE: no EXPECT_URLS provided; skipping network verification.');
  }

  try { await page.screenshot({ path: 'landbot_after_click.png', fullPage: true }); } catch {}
  await context.tracing.stop({ path: 'trace.zip' });

  // סגירה + שמירת הווידאו בשם קבוע
  const p = video ? await video.path() : null;
  await context.close();
  if (p) { try { fs.copyFileSync(p, 'landbot_run.webm'); } catch {} }
  await browser.close();

  clearTimeout(watchdog);

  if (!networkOk && REQUIRE_NETWORK_CONFIRM) {
    console.error('[landbot-v2] Enforcing failure: REQUIRE_NETWORK_CONFIRM=true and no expected 2xx seen');
    process.exit(1);
  }

  console.log('[landbot-v2] Success (button clicked' + (networkOk ? ' + network ok' : ' | network not observed') + ')');
  process.exit(0);
})().catch(async (err) => {
  console.error('[landbot-v2] ERROR:', err?.message || err);
  try { await (await import('fs')).promises.writeFile('landbot_error.txt', String(err?.stack||err)); } catch {}
  clearTimeout(watchdog);
  process.exit(1);
});
