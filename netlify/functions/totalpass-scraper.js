// netlify/functions/totalpass-scraper.js
// Scrapes the TotalPass B600 web interface to pull punch data for a given date
// The B600 has a built-in web UI accessible via IP — no official API exists
// We log in via form POST, then hit the Reports/Timecard CSV export endpoint

const https = require('https');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CLOCK_IP       = process.env.TOTALPASS_IP       || 'b600.atlantafreightquotes.com';
const CLOCK_PASSWORD = process.env.TOTALPASS_PASSWORD  || 'admin12345';
const CLOCK_PORT     = parseInt(process.env.TOTALPASS_PORT || '443');

// Detect if using Cloudflare Tunnel (hostname instead of IP)
const IS_TUNNEL = CLOCK_IP.includes('.') && !CLOCK_IP.match(/^\d+\.\d+\.\d+\.\d+$/);
const EFFECTIVE_PORT = IS_TUNNEL ? 443 : CLOCK_PORT;
const USE_HTTPS = IS_TUNNEL || EFFECTIVE_PORT === 443;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function httpRequest(options, postBody = null) {
  return new Promise((resolve, reject) => {
    const lib = USE_HTTPS ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (postBody) req.write(postBody);
    req.end();
  });
}

// ─── MAIN SCRAPER ─────────────────────────────────────────────────────────────

async function fetchTimeclockData(targetDate) {
  const logs = [];
  function log(msg) { logs.push(msg); console.log(`[B600] ${msg}`); }

  log(`Connecting to ${CLOCK_IP}:${EFFECTIVE_PORT} (tunnel:${IS_TUNNEL})`);

  // Step 1: Login
  const loginBody = `username=admin&password=${encodeURIComponent(CLOCK_PASSWORD)}`;
  let cookie = '';
  try {
    const loginResp = await httpRequest({
      hostname: CLOCK_IP,
      port: EFFECTIVE_PORT,
      path: '/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(loginBody)
      },
      rejectUnauthorized: false
    }, loginBody);

    log(`Login response: ${loginResp.status}`);
    cookie = (loginResp.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    if (loginResp.status === 302 || loginResp.status === 200) {
      log('Login successful');
    } else {
      log(`Login returned ${loginResp.status}`);
    }
  } catch(err) {
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

  // Also try custom export path if set
  const customPath = process.env.TOTALPASS_EXPORT_PATH;
  if (customPath) reportPaths.unshift(customPath);

  for (const path of reportPaths) {
    try {
      log(`Trying ${path}...`);
      const resp = await httpRequest({
        hostname: CLOCK_IP,
        port: EFFECTIVE_PORT,
        path: path + (path.includes('?') ? '&' : '?') + `date=${targetDate}`,
        method: 'GET',
        headers: { 'Cookie': cookie },
        rejectUnauthorized: false
      });

      log(`${path}: HTTP ${resp.status} (${resp.body.length} bytes)`);

      // If we get CSV data, parse it
      if (resp.body.includes(',') && (resp.body.includes('Name') || resp.body.includes('Employee') || resp.body.includes('In Time'))) {
        log('Found CSV-like data!');
        const records = parseCSV(resp.body);
        if (records.length > 0) {
          return { success: true, records, date: targetDate, source: 'B600 Live', logs };
        }
      }

      // If HTML with table, try to parse table
      if (resp.body.includes('<table') && resp.body.includes('<tr')) {
        log('Found HTML table, attempting parse...');
        const records = parseHTMLTable(resp.body);
        if (records.length > 0) {
          return { success: true, records, date: targetDate, source: 'B600 Live (HTML)', logs };
        }
      }
    } catch(err) {
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
  // Basic HTML table parser
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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  let targetDate = new Date().toISOString().split('T')[0];
  if (event.queryStringParameters?.date) {
    targetDate = event.queryStringParameters.date;
  }

  console.log(`[Sentinel] TotalPass scrape for: ${targetDate}`);

  try {
    const result = await fetchTimeclockData(targetDate);
    return {
      statusCode: result.success ? 200 : 503,
      headers,
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error('[Sentinel] Scraper error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
