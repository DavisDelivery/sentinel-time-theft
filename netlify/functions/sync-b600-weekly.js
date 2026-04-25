// netlify/functions/sync-b600-weekly.js
// Runs every Monday at 6 AM Eastern — pulls last week's B600 punches
// and appends them to public/b600-history.json via GitHub API
//
// Uses: TOTALPASS_IP, TOTALPASS_PASSWORD, GITHUB_TOKEN env vars

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// Parse B600 CSV punch data into standardized records
function parseB600CSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIdx = header.findIndex(h => h.includes('name') || h.includes('employee'));
  const dateIdx = header.findIndex(h => h === 'date' || h.includes('date'));
  const inIdx = header.findIndex(h => h.includes('clock in') || h.includes('clockin') || h === 'in');
  const outIdx = header.findIndex(h => h.includes('clock out') || h.includes('clockout') || h === 'out');
  const totIdx = header.findIndex(h => h.includes('total') || h.includes('hours'));

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const name = cells[nameIdx] || '';
    const date = cells[dateIdx] || '';
    if (!name || !date) continue;
    // Normalize date to YYYY-MM-DD
    let normalDate = date;
    const m = date.match(/(\d+)\/(\d+)\/(\d+)/);
    if (m) {
      let [_, mo, d, y] = m;
      if (y.length === 2) y = '20' + y;
      normalDate = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
    out.push({
      name,
      date: normalDate,
      clockIn: cells[inIdx] || '',
      clockOut: cells[outIdx] || '',
      totalHrs: parseFloat(cells[totIdx]) || 0
    });
  }
  return out;
}

// Fetch existing b600-history.json from GitHub
async function getExistingHistory(token, owner, repo, path) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    headers: { Authorization: `token ${token}`, 'User-Agent': 'SENTINEL-Sync' }
  });
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);
  const data = await res.json();
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  return { content, sha: data.sha };
}

// Push updated b600-history.json back to GitHub
async function updateHistory(token, owner, repo, path, newContent, sha, message) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'SENTINEL-Sync'
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(newContent)).toString('base64'),
      sha
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT failed: ${res.status} ${err}`);
  }
  return await res.json();
}

export default async (req) => {
  const logs = [];
  function log(msg) { logs.push(msg); console.log(`[SYNC-B600] ${msg}`); }

  try {
    const token = Netlify.env.get('GITHUB_TOKEN');
    if (!token) throw new Error('GITHUB_TOKEN env var not set');

    // Step 1: Determine last week's date range (Mon-Sun of previous week)
    const now = new Date();
    const dow = now.getUTCDay(); // 0=Sun, 1=Mon
    // Find last Monday
    const daysBack = dow === 0 ? 7 : dow + 6; // if today is Mon, go back 7 days
    const lastMonday = new Date(now);
    lastMonday.setUTCDate(now.getUTCDate() - daysBack);
    const lastSunday = new Date(lastMonday);
    lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);

    const startDate = lastMonday.toISOString().split('T')[0];
    const endDate = lastSunday.toISOString().split('T')[0];
    log(`Pulling B600 data for ${startDate} → ${endDate}`);

    // Step 2: Scrape B600 — call our own deployed function via HTTP
    const siteUrl = Netlify.env.get('URL') || 'https://sentinel-time-theft.netlify.app';
    const scrapeRes = await fetch(`${siteUrl}/api/totalpass-scraper?startDate=${startDate}&endDate=${endDate}`);
    const scrapeData = await scrapeRes.json();

    if (!scrapeData.success || !scrapeData.csv) {
      throw new Error(`B600 scrape failed: ${scrapeData.error || 'no CSV data'}`);
    }
    log(`B600 returned ${scrapeData.csv.length} chars of CSV`);

    // Step 3: Parse new punches
    const newPunches = parseB600CSV(scrapeData.csv);
    log(`Parsed ${newPunches.length} punches from CSV`);

    if (newPunches.length === 0) {
      return new Response(JSON.stringify({ success: true, added: 0, message: 'No punches to add', logs }), { headers: CORS });
    }

    // Step 4: Fetch existing history from GitHub
    const owner = 'DavisDelivery';
    const repo = 'sentinel-time-theft';
    const path = 'public/b600-history.json';

    const { content: existing, sha } = await getExistingHistory(token, owner, repo, path);
    log(`Existing history: ${existing.length} punches`);

    // Step 5: Dedupe — skip any punches that already exist
    const existingKeys = new Set(existing.map(r => `${r.name}|${r.date}|${r.clockIn}`));
    const toAdd = newPunches.filter(r => !existingKeys.has(`${r.name}|${r.date}|${r.clockIn}`));
    log(`Adding ${toAdd.length} new punches (deduped ${newPunches.length - toAdd.length})`);

    if (toAdd.length === 0) {
      return new Response(JSON.stringify({ success: true, added: 0, message: 'All punches already in history', logs }), { headers: CORS });
    }

    // Step 6: Merge + sort by date
    const merged = [...existing, ...toAdd].sort((a, b) => a.date.localeCompare(b.date));
    log(`Total history after merge: ${merged.length}`);

    // Step 7: Push back to GitHub
    await updateHistory(token, owner, repo, path, merged,  sha,
      `Auto-sync: B600 punches for ${startDate}→${endDate} (+${toAdd.length})`);
    log('GitHub updated successfully');

    return new Response(JSON.stringify({
      success: true,
      added: toAdd.length,
      total: merged.length,
      range: `${startDate} to ${endDate}`,
      logs
    }), { headers: CORS });

  } catch (err) {
    log(`ERROR: ${err.message}`);
    return new Response(JSON.stringify({ success: false, error: err.message, logs }), { status: 500, headers: CORS });
  }
};

// Netlify Scheduled Function config — runs every Monday at 6 AM ET (11:00 UTC)
export const config = {
  path: '/api/sync-b600-weekly'
  // schedule: '0 11 * * 1' — disabled until build stabilizes
};
