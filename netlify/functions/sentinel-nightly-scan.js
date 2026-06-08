// netlify/functions/sentinel-nightly-scan.js
// SENTINEL v4 Phase 3c — scheduled trigger that fires the nightly background scan.
//
// Schedule: every day at 09:00 UTC (≈ 04:00 ET in winter / 05:00 ET in summer).
// Computes target = today (ET) − 7 days, then POSTs to the background worker
// with { date: target }. The 7-day lag is intentional cushion to ensure the
// weekly NuVizz email has landed and B600 punches are settled.

const VERSION = 'v4.1.0-phase3c';
const T_MINUS_DAYS = 7;

function easternYMD(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return easternYMD(dt);
}

// Day-of-week (0=Sun .. 6=Sat) for a YYYY-MM-DD string, computed in UTC so it
// can't drift across a TZ boundary. The ymd is a calendar date with no time,
// so anchoring it at UTC midnight is exact.
function dayOfWeekUTC(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function siteOrigin(req) {
  // Scheduled functions get a synthetic request whose URL may be a localhost
  // sentinel ("http://localhost/.netlify/functions/..."). Prefer Netlify's
  // canonical site URL env var so the background fetch hits the public host.
  try {
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      const u = Netlify.env.get('URL') || Netlify.env.get('DEPLOY_URL');
      if (u) return u.replace(/\/$/, '');
    }
  } catch (_) {}
  if (typeof process !== 'undefined' && process?.env) {
    const u = process.env.URL || process.env.DEPLOY_URL;
    if (u) return u.replace(/\/$/, '');
  }
  return new URL(req.url).origin;
}

function bgUrlFromReq(req) {
  return `${siteOrigin(req)}/.netlify/functions/sentinel-nightly-scan-background`;
}

export default async (req, context) => {
  const todayET = easternYMD(new Date());
  const targetDate = addDays(todayET, -T_MINUS_DAYS);
  const bgUrl = bgUrlFromReq(req);

  // The fleet doesn't run on weekends, so a Sat/Sun target would always come
  // back as a fully-empty day — indistinguishable from a real pipeline outage.
  // Skip those targets explicitly with a clear status instead of scanning.
  const dow = dayOfWeekUTC(targetDate);
  if (dow === 0 || dow === 6) {
    const weekday = dow === 0 ? 'Sunday' : 'Saturday';
    console.log(`[nightly-scan] target date=${targetDate} is ${weekday} — skipping weekend scan (todayET=${todayET})`);
    return new Response(JSON.stringify({
      version: VERSION,
      ok: true,
      skipped: 'weekend',
      weekday,
      targetDate,
      todayET
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  console.log(`[nightly-scan] firing background for date=${targetDate} (todayET=${todayET})`);

  const fire = fetch(bgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: targetDate })
  }).catch(e => console.error('[nightly-scan] bg invoke failed:', e.message));

  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(fire);
  } else {
    await fire;
  }

  return new Response(JSON.stringify({
    version: VERSION,
    ok: true,
    targetDate,
    todayET,
    bgUrl
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '0 9 * * *' };
