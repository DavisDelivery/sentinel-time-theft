// netlify/functions/sentinel-weekly-baselines.js
// SENTINEL v4 Phase 3c — scheduled weekly baseline refresh.
//
// Mondays at 09:30 UTC, calls /api/sentinel-compute-baselines so the per-driver
// distributions in /sentinelBaselines/* stay current as the nightly scan
// accumulates new sentinelDriverDays records. This does NOT re-classify the
// existing scored records — applying refreshed baselines to historical data
// stays a deliberate operator action (the Re-score All button in the UI).

const VERSION = 'v4.1.0-phase3c';

function readEnv(key) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      const v = Netlify.env.get(key);
      if (v) return v;
    }
  } catch (_) {}
  if (typeof process !== 'undefined' && process?.env?.[key]) return process.env[key];
  return null;
}

function siteOrigin(req) {
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

export default async (req) => {
  const startedAt = new Date().toISOString();
  const targetUrl = `${siteOrigin(req)}/api/sentinel-compute-baselines`;

  console.log(`[weekly-baselines] firing ${targetUrl}`);

  try {
    const res = await fetch(targetUrl, { method: 'POST' });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) { payload = { raw: text.slice(0, 500) }; }
    console.log(`[weekly-baselines] compute-baselines responded ${res.status}: drivers=${payload?.totalDrivers ?? '?'} written=${payload?.written ?? '?'} wallMs=${payload?.wallMs ?? '?'}`);
    return new Response(JSON.stringify({
      version: VERSION,
      ok: res.ok,
      startedAt,
      computeBaselineStatus: res.status,
      summary: payload
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[weekly-baselines] compute-baselines call failed:', err.message);
    return new Response(JSON.stringify({
      version: VERSION,
      ok: false,
      error: err.message,
      startedAt
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { schedule: '30 9 * * 1' };
