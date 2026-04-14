// netlify/functions/totalpass-scraper.js
// Scrapes the TotalPass B600 web interface to pull punch data for a given date
// The B600 has a built-in web UI accessible via Cloudflare Tunnel — no official API exists
// We log in via form POST, then hit the Reports/Timecard CSV export endpoint

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

async function fetchTimeclockData(targetDate, env) {
  const CLOCK_IP = env.get('TOTALPASS_IP') || 'b600.atlantafreightquotes.com';
  const CLOCK_PASSWORD = env.get('TOTALPASS_PASSWORD') || 'admin12345';
  const CLOCK_PORT = parseInt(env.get('TOTALPASS_PORT') || '443');
  const IS_TUNNEL = CLOCK_IP.includes('.') && !CLOCK_IP.match(/^\d+\.\d+\.\d+\.\d+$/);
  const EFFECTIVE_PORT = IS_TUNNEL ? 443 : CLOCK_PORT;
  const PROTO = (IS_TUNNEL || EFFECTIVE_PORT === 443) ? 'https' : 'http';
  const BASE = `${PROTO}://${CLOCK_IP}${EFFECTIVE_PORT !== 443 && EFFECTIVE_PORT !== 80 ? ':' + EFFECTIVE_PORT : ''}`;

  const logs = [];
  function log(msg) { logs.push(msg); console.log(`[B600] ${msg}`); }

  log(`Connecting to ${CLOCK_IP}:${EFFECTIVE_PORT} (tunnel:${IS_TUNNEL})`);

  // Step 1: Login
  let cookie = '';
  try {
    const loginResp = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=admin&password=${encodeURIComponent(CLOCK_PASSWORD)}`,
      redirect: 'manual'
    });

    log(`Login response: ${loginResp.status}`);
    const setCookies = loginResp.headers.getSetCookie?.() || [];
    cookie = setCookies.map(c => c.split(';')[0]).join('; ');

    if (loginResp.status === 302 || loginResp.status === 200) {
      log('Login successful');
    } else {
      log(`Login returned ${loginResp.status}`);
    }
  } catch (err) {
    log(`Login failed: ${err.message}`);
    return { success: false, error: `Cannot reach B600: ${err.message}`, logs };
  }

  // Step 2: Try to access report/export pages
  const reportPaths = [
    '/reports/timecard',
    '/reports/payroll',
    '/reports',
    '/export',
    '/api/punches',
    '/api/timecard'
  ];

  const customPath = env.get('TOTALPASS_EXPORT_PATH');
  if (customPath) reportPaths.unshift(customPath);

  for (const path of reportPaths) {
    try {
      log(`Trying ${path}...`);
      const sep = path.includes('?') ? '&' : '?';
      const resp = await fetch(`${BASE}${path}${sep}date=${targetDate}`, {
        headers: { 'Cookie': cookie },
        redirect: 'follow'
      });

      const body = await resp.text();
      log(`${path}: HTTP ${resp.status} (${body.length} bytes)`);

      // If we get CSV data, parse it
      if (body.includes(',') && (body.includes('Name') || body.includes('Employee') || body.includes('In Time'))) {
        log('Found CSV-like data!');
        const records = parseCSV(body);
        if (records.length > 0) {
          return { success: true, records, date: targetDate, source: 'B600 Live', logs };
        }
      }

      // If HTML with table, try to parse table
      if (body.includes('<table') && body.includes('<tr')) {
        log('Found HTML table, attempting parse...');
        const records = parseHTMLTable(body);
        if (records.length > 0) {
          return { success: true, records, date: targetDate, source: 'B600 Live (HTML)', logs };
        }
      }
    } catch (err) {
      log(`${path}: ${err.message}`);
    }
  }

  return {
    success: false,
    error: 'Could not find export data — upload CSV manually from B600 web UI',
    logs,
    hint: 'Go to http://192.168.20.94 → Reports → Export CSV, then upload to SENTINEL',
    tried_paths: reportPaths
  };
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  }).filter(r => r.name || r.employee || r['display name']);
}

function parseHTMLTable(html) {
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let match;
  while ((match = trRegex.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    while ((cellMatch = tdRegex.exec(match[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length >= 3) rows.push(cells);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase());
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i] || '');
    return obj;
  });
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: CORS });
  }

  const url = new URL(req.url);
  const targetDate = url.searchParams.get('date') || new Date().toISOString().split('T')[0];

  console.log(`[Sentinel] TotalPass scrape for: ${targetDate}`);

  try {
    const result = await fetchTimeclockData(targetDate, Netlify.env);
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
