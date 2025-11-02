// scripts/landbot_v2_trigger.mjs
// מפעיל את Landbot עם Playwright (headless/headed), לוחץ/שולח טקסט,
// שומר before/after/video/trace/payload, ומבצע המתנה “חכמה” לעדכון Supabase.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const LANDBOT_URL = process.env.LANDBOT_URL;
const BUTTON_TEXT  = process.env.LANDBOT_BUTTON_TEXT || 'סיכום שיחות המטופלים';
const TRIGGER_TEXT = process.env.TRIGGER_TEXT       || 'התחל סיכום שיחות';

const EXPECT_URLS = (process.env.EXPECT_URLS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const REQUIRE_NETWORK_CONFIRM =
  String(process.env.REQUIRE_NETWORK_CONFIRM || 'false').toLowerCase() === 'true';

const headless =
  !(process.env.PW_HEADLESS === '0' || String(process.env.HEADED).toLowerCase() === 'true');

const POST_ACTION_IDLE_MS = Number(process.env.POST_ACTION_IDLE_MS || 0);       // ⬅️ חדש
const SUPABASE_WAIT_MS    = Number(process.env.SUPABASE_WAIT_MS    || 60000);   // ⬅️ חדש

const ART_DIR = path.resolve('artifacts');
if (!fs.existsSync(ART_DIR)) fs.mkdirSync(ART_DIR, { recursive: true });

function log(msg, obj) {
  const line = `[landbot_v2] ${new Date().toISOString()} | ${msg} ${obj ? JSON.stringify(obj) : ''}`;
  console.log(line);
  fs.appendFileSync(path.join(ART_DIR, 'run.log'), line + '\n');
}

if (!LANDBOT_URL) {
  console.error('ENV LANDBOT_URL is required');
  process.exit(0);
}

// עזר
function selectorPatch(arr){ return Array.from(new Set(arr.filter(Boolean))); }
function EXPECT_LENGTH(a){ return Array.isArray(a) ? a.length : 0; }

(async () => {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: ART_DIR, size: { width: 1280, height: 800 } }
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await context.newPage();

  // לוג רשת מפורט + JSONL ל-Landbot ול-Supabase
  const netLog = [];
  const supaLog = fs.createWriteStream(path.join(ART_DIR, 'supabase_outbound.jsonl'));
  const landbotSendLog = fs.createWriteStream(path.join(ART_DIR, 'landbot_send.jsonl'));

  page.on('request', req => {
    const rec = { t: Date.now(), dir: 'req', url: req.url(), method: req.method(), postData: req.postData() };
    netLog.push(rec);
    if (rec.url.includes('supabase.co/rest/v1')) supaLog.write(JSON.stringify(rec) + '\n');
    if (rec.url.includes('messages.landbot.io/webchat/api/send')) landbotSendLog.write(JSON.stringify(rec) + '\n');
  });

  page.on('response', res => {
    const rec = { t: Date.now(), dir: 'res', url: res.url(), status: res.status() };
    netLog.push(rec);
    if (rec.url.includes('supabase.co/rest/v1')) supaLog.write(JSON.stringify(rec) + '\n');
    if (rec.url.includes('messages.landbot.io/webchat/api/send')) landbotSendLog.write(JSON.stringify(rec) + '\n');
  });

  try {
    log('Navigating to Landbot URL', { url: LANDBOT_URL, headless });
    await page.goto(LANDBOT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: path.join(ART_DIR, 'screenshot_before.png'), fullPage: true }).catch(() => {});
    const htmlBefore = await page.content().catch(() => '');
    fs.writeFileSync(path.join(ART_DIR, 'page_before.html'), htmlBefore || '', 'utf8');

    // חיפוש ולחיצה על כפתור; אם אין – שליחת טקסט
    let clicked = false;
    const selectorCandidates = [
      `role=button[name="${BUTTON_TEXT}"]`,
      `text="${BUTTON_TEXT}"`,
      `button:has-text("${BUTTON_TEXT}")`,
      `a:has-text("${BUTTON_TEXT}")`,
      `[role="button"]:has-text("${BUTTON_TEXT}")`
    ];

    for (const sel of selectorPatch(selectorCandidates)) {
      const el = page.locator(sel).first();
      if (await el.count().catch(() => 0)) {
        log('Found button candidate', { selector: sel });
        try {
          const handle = await el.elementHandle();
          await handle.evaluate((node) => {
            node.style.outline = '3px solid red';
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
          await page.waitForTimeout(600);
          await page.screenshot({ path: path.join(ART_DIR, 'screenshot_highlight.png') }).catch(() => {});
        } catch {}
        await el.click({ timeout: 10_000 }).catch(() => {});
        clicked = true;
        break;
      }
    }

    let payload = null;
    if (!clicked) {
      log('Button not found, sending trigger text', { TRIGGER_TEXT });
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
    if (payload) fs.writeFileSync(path.join(ART_DIR, 'msg_payload.json'), JSON.stringify(payload, null, 2));

    // אימות URLs של Landbot (רך/קשיח לפי ENV)
    if (EXPECT_LENGTH(EXPECT_URLS) > 0) {
      log('Waiting for expected URLs', { EXPECT_URLS, REQUIRE_NETWORK_CONFIRM });
      try {
        await Promise.all(EXPECT_URLS.map(u =>
          page.waitForResponse(res => res.url().includes(u) && res.status() >= 200 && res.status() < 300, { timeout: 25_000 })
        ));
        log('All expected URLs confirmed 2xx');
      } catch (e) {
        log('Expected URLs not all confirmed within 25s', { error: String(e) });
        if (REQUIRE_NETWORK_CONFIRM) throw new Error('REQUIRE_NETWORK_CONFIRM=true and not all expected URLs returned 2xx');
      }
    } else {
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }

    // ⬇️ חדש: המתנה יזומה אחרי הפעולה כדי לאפשר לבוט להגיב/לירות Webhook
    if (POST_ACTION_IDLE_MS > 0) {
      log('Post-action idle wait', { ms: POST_ACTION_IDLE_MS });
      await page.waitForTimeout(POST_ACTION_IDLE_MS);
    }

    // ⬇️ חדש: המתנה “חכמה” עד שנספור 2xx ל-Supabase (או עד מקסימום זמן)
    const supaOk = await waitEitherSupabaseOrTimeout(netLog, SUPABASE_WAIT_MS);
    log('Supabase wait result', { ok: supaOk, waitedMs: SUPABASE_WAIT_MS });
    if (!supaOk) log('No Supabase 2xx observed within window (informative; job continues unless REQUIRE_NETWORK_CONFIRM=true)');

    // צילום וסגירה
    await page.screenshot({ path: path.join(ART_DIR, 'screenshot_after.png'), fullPage: true }).catch(() => {});
    const htmlAfter = await page.content().catch(() => '');
    fs.writeFileSync(path.join(ART_DIR, 'page_after.html'), htmlAfter || '', 'utf8');

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
  process.exit(0);
});

// ===== helpers =====
function EXPECT_LENGTH(a){ return Array.isArray(a) ? a.length : 0; }
function selectorPatch(arr){ return Array.from(new Set(arr.filter(Boolean))); }

async function waitEitherSupabaseOrTimeout(netLog, maxMs=60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const hit = netLog.find(e =>
      e.dir === 'res' &&
      typeof e.url === 'string' &&
      e.url.includes('supabase.co/rest/v1') &&
      e.status >= 200 && e.status < 300
    );
    if (hit) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
