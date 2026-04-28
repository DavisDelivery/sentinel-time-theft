// netlify/functions/totalpass-scraper.js
// Scrapes the TotalPass B600 web interface to pull punch data for a given date.
//
// v2 (Apr 2026 rewrite — Chad's session): Previous version blindly tried 6 wrong
// URLs and returned 0 records. Reverse-engineered the actual login + export flow:
//
//   Login:    POST /login.html  with body: username=admin&password=...&buttonClicked=Submit
//             (NOT just username/password — the buttonClicked=Submit field is required)
//             Returns 301 + Set-Cookie: _appwebSessionId_=...
//
//   Export:   GET /report.html?rt=2&from=MM/DD/YY&to=MM/DD/YY&eid=0&stdexport=1
//             rt=2     → Timecard Report
//             eid=0    → ALL employees (eid=ss returns just one — the previously selected one)
//             stdexport=1 → standard CSV download (vs export=1 which is "extended")
//             Date format MUST be MM/DD/YY (2-digit year)
//             Referer header must be set or the export gates to 0 bytes
//
// CSV columns returned:
//   Display Name, Display ID, Payroll ID, Date, In Day, In Time, Out Day, Out Time,
//   Department, Dept. Code, Lunch, ADJ, REG, OT1, OT2, VAC, SICK, PER, HOL, Total,
//   Input, In Flags, Out Flags, In Note, Out Note

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// Convert YYYY-MM-DD → MM/DD/YY (TotalPass requires 2-digit year format)
function toClockDate(isoDate) {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate; // pass through unrecognized formats
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}

// Parse the standard TotalPass CSV.
// Quoted fields with commas, CRLF line endings, time format like "06:33a" / "11:34p".
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (lines.length < 2) return [];

  // Tokenize one row respecting quoted fields
  function tokenize(line) {
    const cells = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuote = !inQuote; continue; }
      if (c === ',' && !inQuote) { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells;
  }

  const header = tokenize(lines[0]).map(h => h.trim().toLowerCase());
  const idx = (key) => header.findIndex(h => h === key);
  const iName    = idx('display name');
  const iDispId  = idx('display id');
  const iPayId   = idx('payroll id');
  const iDate    = idx('date');
  const iInTime  = idx('in time');
  const iOutTime = idx('out time');
  const iTotal   = idx('total');

  // Convert "06:33a" / "11:34p" → "06:33" / "23:34" (24h, used by SENTINEL t2m())
  function to24h(s) {
    if (!s) return '';
    const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])$/i);
    if (!m) return s; // already 24h or unrecognized
    let hh = parseInt(m[1], 10);
    const mm = m[2];
    const ap = m[3].toLowerCase();
    if (ap === 'p' && hh < 12) hh += 12;
    if (ap === 'a' && hh === 12) hh = 0;
    return `${String(hh).padStart(2,'0')}:${mm}`;
  }

  // Convert MM/DD/YY → YYYY-MM-DD
  function isoDate(d) {
    if (!d) return '';
    const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return d;
    let [_, mo, da, yr] = m;
    if (yr.length === 2) yr = '20' + yr;
    return `${yr}-${String(mo).padStart(2,'0')}-${String(da).padStart(2,'0')}`;
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = tokenize(lines[i]);
    const name = (c[iName] || '').trim();
    const date = isoDate((c[iDate] || '').trim());
    const inT  = to24h((c[iInTime] || '').trim());
    const outT = to24h((c[iOutTime] || '').trim());
    if (!name || !date) continue;
    out.push({
      name,
      display_id: (c[iDispId] || '').trim(),
      payroll_id: (c[iPayId] || '').trim(),
      date,
      clock_in: inT,
      clock_out: outT,
      total_hrs: parseFloat(c[iTotal] || '0') || 0
    });
  }
  return out;
}

async function fetchTimeclockData(startDate, endDate, env) {
  const CLOCK_HOST = env.get('TOTALPASS_IP') || 'b600.atlantafreightquotes.com';
  const CLOCK_PASSWORD = env.get('TOTALPASS_PASSWORD') || 'admin12345';
  const CLOCK_USERNAME = env.get('TOTALPASS_USERNAME') || 'admin';
  const IS_TUNNEL = !CLOCK_HOST.match(/^\d+\.\d+\.\d+\.\d+$/);
  const PROTO = IS_TUNNEL ? 'https' : 'http';
  const BASE = `${PROTO}://${CLOCK_HOST}`;

  const logs = [];
  function log(msg) { logs.push(msg); console.log(`[B600] ${msg}`); }

  log(`Connecting to ${CLOCK_HOST} (tunnel:${IS_TUNNEL})`);

  // ── Step 1: Login (POST /login.html with buttonClicked=Submit) ──
  let cookie = '';
  try {
    const body = `username=${encodeURIComponent(CLOCK_USERNAME)}&password=${encodeURIComponent(CLOCK_PASSWORD)}&buttonClicked=Submit`;
    const loginResp = await fetch(`${BASE}/login.html`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual'
    });
    log(`Login: HTTP ${loginResp.status}`);
    // Successful login is 301 → /index.html with Set-Cookie: _appwebSessionId_
    const setCookies = loginResp.headers.getSetCookie?.() || [];
    cookie = setCookies.map(c => c.split(';')[0]).join('; ');
    if (!cookie) {
      // Fallback: try plain Set-Cookie header (some runtimes)
      const sc = loginResp.headers.get('set-cookie');
      if (sc) cookie = sc.split(',').map(s => s.split(';')[0].trim()).join('; ');
    }
    if (!cookie) {
      log('No session cookie returned — login may have failed');
      return { success: false, error: 'B600 login: no session cookie returned', logs };
    }
    if (loginResp.status !== 301 && loginResp.status !== 302 && loginResp.status !== 200) {
      log(`Unexpected login status ${loginResp.status}`);
    }
  } catch (err) {
    log(`Login error: ${err.message}`);
    return { success: false, error: `Cannot reach B600: ${err.message}`, logs };
  }

  // ── Step 2: Pull CSV export (eid=0 = All Employees, type=7 = Custom Date Range) ──
  // type=7 is REQUIRED. Without it the B600 silently ignores from/to and dumps
  // current-week-to-date data, even though the export looks successful (200, real
  // CSV body). Symptom: requesting 04/10/26 returns 04/26-04/28 punches instead.
  const fromMD = toClockDate(startDate);
  const toMD = toClockDate(endDate);
  const reportUrl = `${BASE}/report.html?rt=2&type=7&from=${fromMD}&to=${toMD}`;
  const exportUrl = `${reportUrl}&eid=0&stdexport=1`;

  log(`Fetching CSV: ${fromMD} → ${toMD} (eid=0 / all employees, type=7 / custom range)`);
  let csvText = '';
  try {
    const resp = await fetch(exportUrl, {
      headers: {
        'Cookie': cookie,
        'Referer': reportUrl,
        'User-Agent': 'Mozilla/5.0 SENTINEL-B600-Scraper'
      },
      redirect: 'follow'
    });
    log(`CSV: HTTP ${resp.status}, content-type=${resp.headers.get('content-type') || 'none'}`);
    csvText = await resp.text();
    log(`CSV body: ${csvText.length} bytes`);
    if (resp.status !== 200) {
      return { success: false, error: `CSV export returned HTTP ${resp.status}`, logs };
    }
  } catch (err) {
    log(`CSV fetch error: ${err.message}`);
    return { success: false, error: `CSV fetch failed: ${err.message}`, logs };
  }

  // Empty body = no records in date range (not an error — just no punches)
  if (!csvText.trim()) {
    log('CSV body is empty — no punches in date range');
    return { success: true, records: [], date: startDate, source: 'B600 Live (empty)', logs };
  }

  // ── Step 3: Parse ──
  const records = parseCSV(csvText);
  log(`Parsed ${records.length} punch records`);

  // Sanity check: if more than half the parsed dates are outside the requested
  // window, the B600 ignored type=7 / from / to and is dumping a different scope.
  // Fail loudly rather than silently returning wrong-week data.
  if (records.length > 0) {
    const winStart = startDate;
    const winEnd = endDate;
    const offRange = records.filter(r => r.date && (r.date < winStart || r.date > winEnd));
    if (offRange.length > records.length / 2) {
      const sample = [...new Set(records.slice(0, 5).map(r => r.date))].join(', ');
      log(`⚠ B600 returned data outside requested window — ${offRange.length}/${records.length} rows off-range, sample dates: ${sample}`);
      return {
        success: false,
        error: `B600 returned data outside requested window ${startDate} to ${endDate}; got dates: ${sample}. Likely missing type=7 param or session-side scope override.`,
        logs
      };
    }
  }

  return {
    success: true,
    records,
    csv: csvText, // keep raw CSV available for client-side parsers
    date: startDate,
    endDate,
    source: 'B600 Live',
    logs
  };
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: CORS });
  }

  const url = new URL(req.url);
  // Accept either ?date=YYYY-MM-DD (single day) or ?startDate=&endDate= (range)
  const single = url.searchParams.get('date');
  const startDate = url.searchParams.get('startDate') || single || new Date().toISOString().split('T')[0];
  const endDate = url.searchParams.get('endDate') || single || startDate;

  console.log(`[Sentinel] TotalPass scrape: ${startDate} → ${endDate}`);

  try {
    const result = await fetchTimeclockData(startDate, endDate, Netlify.env);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 503,
      headers: CORS
    });
  } catch (err) {
    console.error('[Sentinel] Scraper error:', err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: CORS
    });
  }
};

export const config = {
  path: '/api/totalpass-scraper'
};
