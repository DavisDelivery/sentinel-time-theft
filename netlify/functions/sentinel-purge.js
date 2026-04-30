// netlify/functions/sentinel-purge.js
// Wipes Sentinel-owned Firestore collections so you can start fresh.
//
// Collections purged:
//   - sentinelScans              (per-scan summary docs)
//   - sentinelDriverHistory      (per-driver aggregate stats)
//   - driverPerformanceDaily     (per-driver-per-day performance records)
//   - sentinelScanStatus         (in-progress/finished scan status docs)
//
// Auth: requires SCAN_SECRET env var. The endpoint will not run without it.
//
// Safety:
//   - Dry-run by default. Pass &confirm=YES to actually delete.
//   - Optional ?collection=name to purge just one (otherwise purges all four).
//   - Returns counts so you can verify what was hit.
//
// GET  /api/sentinel-purge?secret=xxx                       → dry run, all four
// GET  /api/sentinel-purge?secret=xxx&confirm=YES           → actually purge all four
// GET  /api/sentinel-purge?secret=xxx&collection=sentinelScans&confirm=YES
// POST /api/sentinel-purge { secret, confirm:'YES', collection? }   → same

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

const SCAN_SECRET = () => Netlify.env.get('SCAN_SECRET') || 'sentinel2026';

const PURGEABLE = [
  'sentinelScans',
  'sentinelDriverHistory',
  'driverPerformanceDaily',
  'sentinelScanStatus'
];

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    let secret, confirm, collection;
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      secret = body.secret;
      confirm = body.confirm;
      collection = body.collection;
    } else {
      const url = new URL(req.url);
      secret = url.searchParams.get('secret');
      confirm = url.searchParams.get('confirm');
      collection = url.searchParams.get('collection');
    }

    if (secret !== SCAN_SECRET()) {
      return new Response(JSON.stringify({ error: 'Unauthorized — wrong or missing secret' }), { status: 401, headers: CORS });
    }

    const targets = collection
      ? (PURGEABLE.includes(collection) ? [collection] : null)
      : PURGEABLE;
    if (!targets) {
      return new Response(JSON.stringify({
        error: `Unknown collection '${collection}'. Allowed: ${PURGEABLE.join(', ')}`
      }), { status: 400, headers: CORS });
    }

    const db = getDb();
    const dryRun = confirm !== 'YES';
    const result = { dryRun, collections: {}, totalFound: 0, totalDeleted: 0 };

    for (const col of targets) {
      const ids = await db.listAllDocIds(col);
      result.totalFound += ids.length;
      if (dryRun) {
        result.collections[col] = { found: ids.length, deleted: 0, sample: ids.slice(0, 5) };
      } else {
        const r = await db.batchDelete(col, ids);
        result.collections[col] = { found: ids.length, deleted: r.ok, failed: r.failed };
        result.totalDeleted += r.ok;
      }
    }

    if (dryRun) {
      result.note = "DRY RUN — nothing deleted. Add &confirm=YES to actually purge.";
    } else {
      result.note = `Purged ${result.totalDeleted} documents across ${targets.length} collection(s).`;
    }

    return new Response(JSON.stringify(result, null, 2), { status: 200, headers: CORS });

  } catch (err) {
    console.error('[sentinel-purge]', err);
    return new Response(JSON.stringify({
      error: err.message,
      stack: err.stack?.slice(0, 400)
    }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-purge' };
