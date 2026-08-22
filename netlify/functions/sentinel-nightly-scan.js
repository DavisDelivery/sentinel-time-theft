// netlify/functions/sentinel-nightly-scan.js
// SENTINEL v4 Phase 3c — scheduled trigger that fires the nightly background scan.
//
// Schedule: every day at 09:00 UTC (≈ 04:00 ET in winter / 05:00 ET in summer).
//
// Scans a ROLLING WINDOW of recent weekdays, T−1 back through T−7, firing one
// background invocation per date.
//
// It used to scan exactly one day — today − 7 — as "intentional cushion to
// ensure the weekly NuVizz email has landed and B600 punches are settled".
// That cushion also put a hard floor under how current the dashboard could
// ever be: a day was never scored until it was a week old, no matter how
// early its data arrived. Scanning the window instead means a day is scored
// as soon as its data lands, and re-scanned on each of the following nights
// so late-arriving punches or deliveries correct it in place. The scan is
// idempotent — one doc per driver-day, rewritten — so a re-scan is a
// correction, not a duplicate.
//
// Cost: ~5 weekday dates × roster instead of 1. Each date is still its own
// background invocation doing exactly what it did before, so no single run
// gets closer to the 15-minute limit; we simply fire several.
const VERSION = 'v5.1.0-rolling-window';
const WINDOW_START_DAYS = 1;   // T−1: yesterday, the freshest scannable day
const WINDOW_END_DAYS = 7;     // T−7: the old cushion, now the tail of the window

function easternYMD(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

// Pure calendar-date arithmetic in UTC. The old version formatted the UTC
// midnight through easternYMD, which lands 4-5h BEHIND UTC and returned the
// previous day for every input (verified: addDays('2026-07-07', -7) gave
// '2026-06-29', and even n=0 shifted a day back). Net effect: the nightly scan
// targeted T-8, not the documented T-7. Same fix the backfill worker carries.
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
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
  const bgUrl = bgUrlFromReq(req);

  // Build the window, newest first so the freshest day is scanned first and
  // shows up soonest. The fleet doesn't run weekends, so a Sat/Sun target
  // would always come back fully empty — indistinguishable from a real
  // pipeline outage — and is dropped rather than scanned.
  const targets = [];
  const skippedWeekend = [];
  for (let back = WINDOW_START_DAYS; back <= WINDOW_END_DAYS; back++) {
    const d = addDays(todayET, -back);
    const dow = dayOfWeekUTC(d);
    if (dow === 0 || dow === 6) { skippedWeekend.push(d); continue; }
    targets.push(d);
  }

  if (targets.length === 0) {
    console.log(`[nightly-scan] no weekday targets in window (todayET=${todayET})`);
    return new Response(JSON.stringify({
      version: VERSION, ok: true, skipped: 'no-weekday-targets',
      todayET, skippedWeekend
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  console.log(`[nightly-scan] firing ${targets.length} background scans for ${targets.join(', ')} (todayET=${todayET})`);

  // One invocation per date. Each is the same single-day job as before, so no
  // run approaches the 15-minute background limit. Failures are logged per
  // date rather than aborting the rest of the window.
  const fire = Promise.all(targets.map(date =>
    fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date })
    }).catch(e => console.error(`[nightly-scan] bg invoke failed for ${date}:`, e.message))
  ));

  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(fire);
  } else {
    await fire;
  }

  return new Response(JSON.stringify({
    version: VERSION,
    ok: true,
    window: { fromDaysBack: WINDOW_END_DAYS, toDaysBack: WINDOW_START_DAYS },
    targets,
    skippedWeekend,
    todayET,
    bgUrl
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '0 9 * * *' };
