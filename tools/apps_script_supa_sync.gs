/**
 * apps_script_supa_sync.gs
 *
 * Google Apps Script bound to the BOT operations spreadsheet.
 * Pushes rows marked "V" in the `update` column to Supabase through the
 * `supa-sync` Edge Function, then writes DONE / FAIL / NO_PHONE back to
 * that same column.
 *
 * Source: copied verbatim from the live spreadsheet on 20.9.2026.
 * This is a BACKUP COPY for continuity. The authoritative copy lives in the
 * spreadsheet; editing this file does not change the running script.
 *
 * Required Script Properties: SUPABASE_URL, FUNCTION_SHARED_SECRET.
 * Auth header sent to the Edge Function: x-shared-secret.
 *
 * See PROJECT_GUIDE.md section 12 (sheet sync) and section 6 (supa-sync).
 */

/*** SUPA Sync – Apps Script via Edge Function (quiet UI, detailed toast 10s)
 * סנכרון ידני מ-Google Sheet ל-Supabase דרך Edge Function: supa-sync
 *
 * Script Properties (חובה):
 * - SUPABASE_URL                 לדוגמה: https://qcwimczsiuxkarwfiyai.supabase.co
 * - FUNCTION_SHARED_SECRET       בדיוק כפי שהוגדר ב-Edge Function (x-shared-secret)
 ***/

const CFG = {
  FUNCTION_NAME: 'supa-sync',
  TABLES: ['users_information_v2'],
  PHONE_COL: 'phone',
  UPDATE_COL: 'update',
  PROP_URL: 'SUPABASE_URL',
  PROP_SHARED: 'FUNCTION_SHARED_SECRET',
  TOAST_OK_SECS: 10,
  TOAST_ERR_SECS: 12,
  BATCH_SIZE: 25,
};

/* ---------- Menu ---------- */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SUPA')
    .addItem('בדיקת חיבור ל-Edge Function', 'edgeSelfTest')
    .addItem('סנכרן שורות מסומנות (V/v)', 'syncMarkedRowsToSupabaseViaEdge')
    .addToUi();
}
function onInstall() { onOpen(); }

/* ---------- Utils ---------- */
function toast_(msg, secs) {
  SpreadsheetApp.getActive().toast(msg, 'SUPA', secs);
}
function normalize_(s) {
  return String(s ?? '').trim().toLowerCase();
}
function getProps_() {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty(CFG.PROP_URL) || '').trim();
  const shared = (p.getProperty(CFG.PROP_SHARED) || '').trim();
  if (!url || !shared) {
    throw new Error('חסר SUPABASE_URL או FUNCTION_SHARED_SECRET ב-Script Properties.');
  }
  return { url, shared };
}
function baseUrl_(url) {
  return url.replace(/\/+$/, '');
}
function edgeUrl_(baseUrl) {
  return `${baseUrl_(baseUrl)}/functions/v1/${encodeURIComponent(CFG.FUNCTION_NAME)}`;
}

/* ---------- Header helpers ---------- */
function getHeaderMap_(sheet) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  header.forEach((name, idx) => {
    const key = String(name || '').trim();
    if (key) map[key] = idx;
  });

  let phoneName = null, updateName = null;
  for (const k of Object.keys(map)) {
    const kNorm = normalize_(k);
    if (kNorm === CFG.PHONE_COL) phoneName = k;
    if (kNorm === CFG.UPDATE_COL) updateName = k;
  }
  if (!phoneName || !updateName) {
    throw new Error('לא נמצאו עמודות חובה: phone ו/או update בשורת הכותרת.');
  }
  return { map, phoneName, updateName };
}

/* ---------- Edge call ---------- */
function callEdgeSync_(edgeUrl, sharedSecret, table, keyCol, updateCol, rows) {
  const payload = { table, key_col: keyCol, update_col: updateCol, rows };

  const res = UrlFetchApp.fetch(edgeUrl, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: { 'x-shared-secret': sharedSecret },
    payload: JSON.stringify(payload),
  });

  const code = res.getResponseCode();
  const txt = res.getContentText() || '';
  if (code >= 200 && code < 300) return JSON.parse(txt || '{}');
  throw new Error(`EDGE נכשל: CODE=${code} BODY=${txt}`);
}

/* ---------- Public: self test ---------- */
function edgeSelfTest() {
  try {
    const { url, shared } = getProps_();
    const endpoint = edgeUrl_(url);

    const resultsByTable = {};
    CFG.TABLES.forEach((t) => {
      resultsByTable[t] = callEdgeSync_(endpoint, shared, t, CFG.PHONE_COL, CFG.UPDATE_COL, [
        { phone: '00000000', _ping: '1' },
      ]);
    });

    toast_('בדיקת חיבור הצליחה ✔ (כל הטבלאות ענו)', 6);
    Logger.log('edgeSelfTest responses: %s', JSON.stringify(resultsByTable));
  } catch (e) {
    toast_('❌ שגיאת חיבור: ' + (e.message || e), CFG.TOAST_ERR_SECS);
    Logger.log('edgeSelfTest error: %s', (e && e.message) ? e.message : e);
  }
}

/* ---------- Public: main sync ---------- */
function syncMarkedRowsToSupabaseViaEdge() {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const { map, phoneName, updateName } = getHeaderMap_(sheet);

    const values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      toast_('אין נתונים לסנכרון (אין שורות מעבר לכותרת).', 6);
      return;
    }

    const { url, shared } = getProps_();
    const endpoint = edgeUrl_(url);

    let processed = 0, ok = 0, skipped = 0, failed = 0;
    const updatesToWrite = []; // {r,c,val}

    const batch = []; // { sheetRowIndex, rowObj, phone }

    const flushBatch = () => {
      if (batch.length === 0) return;

      const rowsPayload = batch.map(b => b.rowObj);

      // מבצעים עדכון לכל טבלה. רק אם כולן הצליחו לכל שורה -> DONE
      const resultsByTable = {};
      CFG.TABLES.forEach((t) => {
        const resp = callEdgeSync_(endpoint, shared, t, CFG.PHONE_COL, CFG.UPDATE_COL, rowsPayload);
        resultsByTable[t] = Array.isArray(resp?.results) ? resp.results : [];
      });

      for (let i = 0; i < batch.length; i++) {
        const b = batch[i];
        const r = b.sheetRowIndex;

        processed++;

        const allOk = CFG.TABLES.every((t) => {
          const result = resultsByTable[t].find(x => Number(x.index) === i) || null;
          if (!(result && result.ok === true)) {
            Logger.log('Row %s (phone=%s) FAILED in table=%s: %s', r + 1, b.phone, t, JSON.stringify(result));
            return false;
          }
          return true;
        });

        if (allOk) {
          ok++;
          updatesToWrite.push({ r, c: map[updateName], val: 'DONE' });
        } else {
          failed++;
          updatesToWrite.push({ r, c: map[updateName], val: 'FAIL' });
        }
      }

      batch.length = 0;
    };

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const mark = normalize_(row[map[updateName]]);
      if (mark !== 'v') continue;

      const phone = String(row[map[phoneName]] || '').trim();
      if (!phone) {
        skipped++;
        updatesToWrite.push({ r, c: map[updateName], val: 'NO_PHONE' });
        continue;
      }

      const rowObj = {};
        for (const colName of Object.keys(map)) {
      if (colName === updateName) continue;

       // users_information_v2 לא מכילה name

      const v = row[map[colName]];
     if (v === '' || v === null) continue;
     rowObj[colName] = v;
     }
      rowObj[phoneName] = phone;

      batch.push({ sheetRowIndex: r, rowObj, phone });

      if (batch.length >= CFG.BATCH_SIZE) flushBatch();
    }

    flushBatch();

    updatesToWrite.forEach(({ r, c, val }) => sheet.getRange(r + 1, c + 1).setValue(val));

    const msg =
`✅ הסנכרון הושלם (דרך Edge Function)
שורות שטופלו: ${processed}
הצלחות: ${ok}
דולגו (ללא phone): ${skipped}
כשלים: ${failed}`;
    toast_(msg, CFG.TOAST_OK_SECS);

  } catch (e) {
    Logger.log('GLOBAL ERROR in syncMarkedRowsToSupabaseViaEdge: %s', (e && e.message) ? e.message : e);
    toast_('❌ שגיאה: ' + (e.message || e), CFG.TOAST_ERR_SECS);
  }
}


 
