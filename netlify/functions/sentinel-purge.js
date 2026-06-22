// netlify/functions/sentinel-purge.js
// Wipes Sentinel-owned Firestore collections so you can start fresh.
//
// Collections purged (SENTINEL-owned only):
//   - sentinelScans              (per-scan summary docs)
//   - sentinelDriverHistory      (per-driver aggregate stats)
//   - sentinelScanStatus         (in-progress/finished scan status docs)
//
// NOT purged: driverPerformanceDaily is an upstream v3 bootstrap input (the
// data source for sentinel-performance.js), so it is deliberately excluded.
//
// Auth: requires ?secret=<SCAN_SECRET>. This endpoint deletes data, so it must
// not be anonymously callable — the old "only callable from the deployed domain"
// assumption is false for public Netlify functions.
//
// Safety:
//   - Dry-run by default. Pass &confirm=YES to actually delete.
//   - Optional ?collection=name to purge just one (otherwise purges all owned).
//   - Returns counts so you can verify what was hit.
//
// GET  /api/sentinel-purge                                  → dry run, all owned
// GET  /api/sentinel-purge?confirm=YES                      → actually purge all owned
// GET  /api/sentinel-purge?collection=sentinelScans&confirm=YES
// POST /api/sentinel-purge { confirm:'YES', collection? }   → same

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
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

// NOTE: driverPerformanceDaily is intentionally NOT here. It is an upstream
// v3 bootstrap input (not SENTINEL-owned) and the sole data source for
// sentinel-performance.js — a default purge must never be able to wipe it.
const PURGEABLE = [
  'sentinelScans',
  'sentinelDriverHistory',
  'sentinelScanStatus'
];

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  // Auth gate — this endpoint deletes Firestore data; require the shared secret.
  const secret = new URL(req.url).searchParams.get('secret');
  if (secret !== (readEnv('SCAN_SECRET') || 'davis2026sentinel')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
  }

  try {
    let confirm, collection;
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      confirm = body.confirm;
      collection = body.collection;
    } else {
      const url = new URL(req.url);
      confirm = url.searchParams.get('confirm');
      collection = url.searchParams.get('collection');
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
        // For sentinelScans, also wipe each scan's driverDays subcollection
        // before deleting the parent — Firestore doesn't cascade. If a scan's
        // subcollection cleanup throws, we must NOT delete that scan's parent
        // doc: doing so would orphan the surviving subcollection. Collect the
        // failure and exclude that scanId from the parent delete batch.
        let subcolDeleted = 0;
        let deletableIds = ids;
        const subcolFailures = [];
        if (col === 'sentinelScans') {
          deletableIds = [];
          for (const scanId of ids) {
            try {
              const dayIds = await db.listAllDocIds(`sentinelScans/${scanId}/driverDays`);
              if (dayIds.length) {
                const r = await db.batchDelete(`sentinelScans/${scanId}/driverDays`, dayIds);
                subcolDeleted += r.ok;
              }
              deletableIds.push(scanId);
            } catch (e) {
              // Subcollection cleanup failed — keep the parent doc so the
              // surviving driverDays aren't orphaned, and surface the failure.
              console.error(`[sentinel-purge] driverDays cleanup failed for scan ${scanId}, keeping parent:`, e.message);
              subcolFailures.push({ scanId, error: e.message });
            }
          }
        }
        const r = await db.batchDelete(col, deletableIds);
        result.collections[col] = {
          found: ids.length,
          deleted: r.ok,
          failed: r.failed,
          ...(subcolDeleted > 0 ? { driverDaysDeleted: subcolDeleted } : {}),
          ...(subcolFailures.length ? { subcollectionFailures: subcolFailures, parentsKept: subcolFailures.length } : {})
        };
        result.totalDeleted += r.ok + subcolDeleted;
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
