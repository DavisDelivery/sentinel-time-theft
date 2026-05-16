// netlify/functions/sentinel-compute-baselines.js
// SENTINEL v4 Phase 3 — build per-driver baselines from all sentinelDriverDays.
//
// GET /api/sentinel-compute-baselines?secret=davis2026sentinel
//   → reads every sentinelDriverDays record, groups by driverSlug, builds a
//     baseline doc per driver, writes to /sentinelBaselines/{slug}.
//
// Filters: records with dataHealth containing shift_negative_clockout_before_clockin
// are excluded entirely (bad data). Only records where b600Matched || nuvizzMatched
// count toward the baseline (no data, no signal).

import { getDb } from './_firebase-admin.js';
import { buildDriverBaseline } from './_baselines.js';

const VERSION = 'v4.0.6-phase3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

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

function isUsableRecord(r) {
  const dh = Array.isArray(r.dataHealth) ? r.dataHealth : [];
  if (dh.some(d => String(d).includes('shift_negative_clockout_before_clockin'))) return false;
  return !!(r.b600Matched || r.nuvizzMatched);
}

async function writeBaselinesInBatches(db, baselines, batchSize = 10) {
  let written = 0;
  for (let i = 0; i < baselines.length; i += batchSize) {
    const batch = baselines.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(b => db.setDoc('sentinelBaselines', b._id, b))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') written++;
      else console.error('[compute-baselines] write failed:', r.reason?.message || r.reason);
    }
  }
  return written;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret');
    const expected = readEnv('SCAN_SECRET') || 'davis2026sentinel';
    if (secret !== expected) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    const t0 = Date.now();
    const db = getDb();

    // Pull all sentinelDriverDays — 12-day window across ~50 drivers is well
    // under 1000 records. Listdocs limit is plenty.
    const rows = await db.listDocs('sentinelDriverDays', { limit: 1000 });

    // Group by driverSlug
    const bySlug = {};
    let skippedBadData = 0;
    for (const r of rows) {
      if (!isUsableRecord(r)) { skippedBadData++; continue; }
      const slug = r.driverSlug;
      if (!slug) continue;
      if (!bySlug[slug]) bySlug[slug] = [];
      bySlug[slug].push(r);
    }

    // Build baselines (pure, fast)
    const baselines = Object.entries(bySlug).map(([slug, recs]) => buildDriverBaseline(slug, recs));

    // Write in 10-way parallel batches
    const written = await writeBaselinesInBatches(db, baselines, 10);

    // Confidence breakdown
    const byConfidence = { insufficient: 0, low: 0, medium: 0, high: 0 };
    for (const b of baselines) {
      const c = b.confidence || 'insufficient';
      byConfidence[c] = (byConfidence[c] || 0) + 1;
    }

    // Sample: a few baselines for quick visual sanity check
    const sample = baselines.slice(0, 3).map(b => ({
      driverSlug: b.driverSlug,
      displayName: b.displayName,
      daysAnalyzed: b.daysAnalyzed,
      confidence: b.confidence,
      morningGapP50: b.metrics.morningGapMin.p50,
      morningGapP90: b.metrics.morningGapMin.p90,
      afternoonGapP50: b.metrics.afternoonGapMin.p50,
      afternoonGapP90: b.metrics.afternoonGapMin.p90
    }));

    return new Response(JSON.stringify({
      version: VERSION,
      ok: true,
      wallMs: Date.now() - t0,
      totalDrivers: baselines.length,
      written,
      recordsScanned: rows.length,
      skippedBadData,
      byConfidence,
      sample
    }, null, 2), { status: 200, headers: CORS });
  } catch (err) {
    console.error('[sentinel-compute-baselines]', err);
    return new Response(JSON.stringify({
      error: err.message,
      stack: err.stack?.slice(0, 800)
    }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-compute-baselines' };
