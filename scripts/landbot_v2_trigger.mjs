// scripts/landbot_v2_trigger.mjs
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.LANDBOT_URL
  || 'https://landbot.pro/v3/H-3207470-XRPDXMFVFDSCDXA5/index.html';
const BUTTON_TEXT = process.env.LANDBOT_BUTTON_TEXT || 'סיכום שיחות המטופלים';
const EXPECT_RESPONSE_URL_PART = process.env.EXPECT_RESPONSE_URL_PART || 'supabase.co/rest/v1';

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

  // 🎥 הקלטת וידאו
  const context = await browser.newContext({
    userAgent: UA,
    viewport: VIEWPORT,
    locale: 'he-IL',
    extraHTTPHeaders: {
      'Accept-Language':'he-IL,he;q=0.9,en-US;q=0.8',
      'Referer': URL,
      'Origin': 'https://landbot.pro'
    },
    recordVideo: { dir: 'videos', size: VIEWPORT }   // <-- כאן
  });

  // לפתוח shadow roots ל-open ולהפחית זיהוי בוט
  await context.addInitScript(() => {
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init){ try{return orig.call(this,{...init,mode:'open'})}catch{return orig.call(this,init)} };
    Object.defineProperty(navigator,'webdriver',{get:()=>false});
    window.chrome = { runtime:{} };
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();
  const video = page.video(); // נשמור רפרנס כדי להעתיק בסוף
  page.setDefaultTimeout(35_000);
  page.setDefaultNavigationTimeout(35_000);

  page.on('console', m => console.log('[console]', m.type(), m.text()));
  page.on('requestfailed', r => console.log('FAILED', r.url(), r.failure()?.errorText));
  page.on('response', r => {
    const u = r.url(); const s = r.status();
    if (u.includes('landbot') || u.includes('webchat') || u.includes('supabase')) {
      console.log('RESP', s, u);
    }
  });

  console.log('[landbot-v2] goto:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // צילום "לפני"
  try { await page.screenshot({ path: 'landbot_before_click.png', fullPage: true }); } catch {}
  try { fs.writeFileSync('landbot_page_early.html', await page.content()); } catch {}

  // אם יש "Start the conversation" – נלחץ
  const startBtn = page.getByText(/Start the conversation/i);
  if (await startBtn.count().catch(()=>0)) {
    try { await startBtn.first().click({ timeout: 8_000 }); } catch {}
  }

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

  // קליק על הכפתור הראשי
  const clicked = await clickByText(BUTTON_TEXT);
  if (!clicked) {
    await page.screenshot({ path: 'landbot_fail.png', fullPage: true }).catch(()=>{});
    fs.writeFileSync('landbot_page.html', await page.content());
    throw new Error(`Button "${BUTTON_TEXT}" not found/clickable`);
  }

  // אימות רשת: חייבת לצאת תגובת 2xx ליעד המצופה
  try {
    await page.waitForResponse(
      r => r.url().includes(EXPECT_RESPONSE_URL_PART) && r.status() >= 200 && r.status() < 300,
      { timeout: 20_000 }
    );
    console.log('[landbot-v2] Verified: expected network call observed');
  } catch {
    await page.screenshot({ path: 'landbot_after_click.png', fullPage: true }).catch(()=>{});
    fs.writeFileSync('landbot_page.html', await page.content());
    throw new Error(`No 2xx response to URL containing "${EXPECT_RESPONSE_URL_PART}" after click`);
  }

  // צילום "אחרי"
  try { await page.screenshot({ path: 'landbot_after_click.png', fullPage: true }); } catch {}

  console.log('[landbot-v2] Success (button clicked + network verified)');

  await context.tracing.stop({ path: 'trace.zip' });

  // סגירה והצלת הווידאו לקובץ קבוע
  const p = video ? await video.path() : null; // זמין אחרי close
  await context.close();
  if (p) { try { fs.copyFileSync(p, 'landbot_run.webm'); } catch {} }
  await browser.close();

  clearTimeout(watchdog);
  process.exit(0);
})().catch(async (err) => {
  console.error('[landbot-v2] ERROR:', err?.message || err);
  try { await (await import('fs')).promises.writeFile('landbot_error.txt', String(err?.stack||err)); } catch {}
  clearTimeout(watchdog);
  process.exit(1);
});
