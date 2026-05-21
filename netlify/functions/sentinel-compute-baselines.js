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

const VERSION = 'v4.1.2-readers';

// Per-driver query limit. Each driver has at most one record per day; 17 months
// of backfill ≈ 374 working days. 2000 is ~5 years of headroom under the
// listDocs single-page cap, so per-driver reads never truncate in practice.
const PER_DRIVER_LIMIT = 2000;
// Parallel per-driver reads. 10 concurrent runQuery calls keeps us well under
// Firestore's rate-limit ceiling while completing 49-driver fanout in ~5 hops.
const READ_PARALLELISM = 10;

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

    // Load the active roster, then fan out one per-driver query each. Two reasons
    // this beats a single big listDocs:
    //   1. A single listDocs caps at one page (~1000 records, alphabetical by docId).
    //      After the 17-month backfill ~14k records exist; the single-page read
    //      only saw the first 4 drivers (aaron→ben), so 45 drivers got no baseline.
    //   2. The per-driver group IS the natural unit — we never need a cross-driver
    //      aggregate here. Querying with `where driverSlug == X` returns ~300-400
    //      rows per driver (well under any single-page limit) and we skip the
    //      group-by step entirely.
    const employees = await db.listDocs('employees', {
      where: [{ field: 'status', op: '==', value: 'active' }],
      limit: 500,
      fields: ['role']
    });
    const slugs = employees
      .filter(r => r.role === 'driver' || r.role === 'owner_op')
      .map(r => r.id);
    console.log(`[compute-baselines] read ${employees.length} employees, ${slugs.length} active drivers/owner_ops`);

    const bySlug = {};
    let skippedBadData = 0;
    let totalRecordsRead = 0;
    let driversWithNoData = 0;
    for (let i = 0; i < slugs.length; i += READ_PARALLELISM) {
      const batch = slugs.slice(i, i + READ_PARALLELISM);
      const results = await Promise.all(batch.map(slug =>
        db.listDocs('sentinelDriverDays', {
          where: [{ field: 'driverSlug', op: '==', value: slug }],
          limit: PER_DRIVER_LIMIT
        }).then(rows => ({ slug, rows }))
      ));
      for (const { slug, rows } of results) {
        totalRecordsRead += rows.length;
        if (rows.length === 0) { driversWithNoData++; continue; }
        if (rows.length >= PER_DRIVER_LIMIT) {
          console.warn(`[compute-baselines] driver ${slug} hit PER_DRIVER_LIMIT=${PER_DRIVER_LIMIT} — likely truncated, bump the cap`);
        }
        const usable = [];
        for (const r of rows) {
          if (isUsableRecord(r)) usable.push(r);
          else skippedBadData++;
        }
        if (usable.length > 0) bySlug[slug] = usable;
      }
    }
    console.log(`[compute-baselines] read ${totalRecordsRead} records across ${slugs.length} drivers (skippedBadData=${skippedBadData}, driversWithNoData=${driversWithNoData})`);

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
      activeRoster: slugs.length,
      recordsScanned: totalRecordsRead,
      skippedBadData,
      driversWithNoData,
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
