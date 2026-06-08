// netlify/functions/sentinel-day-scan.js
// SENTINEL v4 — single driver-day scan orchestrator (HTTP entry point).
//
// The scan core (data gathering, scoring, Motive integration, write) lives in
// _sentinel-scan.js and is shared with the historical-backfill and
// nightly-scan background workers.
//
// API:
//   GET /api/sentinel-day-scan?secret=<S>&driverSlug=<slug>&date=<YYYY-MM-DD>
//     → scores one driver-day, writes /sentinelDriverDays/{slug}_{date}, returns the scored doc
//
//   GET /api/sentinel-day-scan?secret=<S>&test=true
//     → runs _sentinel-engine self-test (no I/O), returns pass/fail
//
//   GET /api/sentinel-day-scan?secret=<S>&listDrivers=true
//     → returns first 100 active driver slugs (for finding test targets)

import { getDb } from './_firebase-admin.js';
import { runSelfTest } from './_sentinel-engine.js';
import { scanOneDriverDay } from './_sentinel-scan.js';

const VERSION = 'v4.1.0-phase3c';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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

// ---------- HTTP handler ----------

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret');
    const expected = readEnv('SCAN_SECRET') || 'davis2026sentinel';
    if (secret !== expected) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    // Self-test mode
    if (url.searchParams.get('test') === 'true') {
      const r = runSelfTest();
      return new Response(JSON.stringify({ version: VERSION, selfTest: r }, null, 2),
        { status: r.passed ? 200 : 500, headers: CORS });
    }

    // Data coverage probe — what dates do we actually have in MarginIQ?
    if (url.searchParams.get('coverage') === 'true') {
      const db = getDb();
      const [nvOldest, nvNewest, tcOldest, tcNewest] = await Promise.all([
        db.listDocs('nuvizz_rows_raw', { orderBy: { field: 'delivery_date', direction: 'asc' }, limit: 1, fields: ['delivery_date', 'ingested_at'] }),
        db.listDocs('nuvizz_rows_raw', { orderBy: { field: 'delivery_date', direction: 'desc' }, limit: 1, fields: ['delivery_date', 'ingested_at'] }),
        db.listDocs('timeclock_daily', { orderBy: { field: 'date', direction: 'asc' }, limit: 1, fields: ['date'] }),
        db.listDocs('timeclock_daily', { orderBy: { field: 'date', direction: 'desc' }, limit: 1, fields: ['date'] })
      ]);
      return new Response(JSON.stringify({
        nuvizz_rows_raw: {
          oldest: nvOldest[0]?.delivery_date || null,
          newest: nvNewest[0]?.delivery_date || null,
          newestIngestedAt: nvNewest[0]?.ingested_at || null
        },
        timeclock_daily: {
          oldest: tcOldest[0]?.date || null,
          newest: tcNewest[0]?.date || null
        }
      }, null, 2), { status: 200, headers: CORS });
    }

    // List active drivers (for finding test targets)
    if (url.searchParams.get('listDrivers') === 'true') {
      const db = getDb();
      const rows = await db.listDocs('employees', {
        where: [{ field: 'status', op: '==', value: 'active' }],
        limit: 100,
        fields: ['fullName', 'defaultTruck', 'role', 'externalIds']
      });
      const drivers = rows
        .filter(r => r.role === 'driver' || r.role === 'owner_op')
        .map(r => ({
          slug: r.id,
          fullName: r.fullName,
          defaultTruck: r.defaultTruck || null,
          nuvizz: r.externalIds?.nuvizz || null,
          b600: r.externalIds?.b600 || null
        }));
      return new Response(JSON.stringify({ count: drivers.length, drivers }, null, 2),
        { status: 200, headers: CORS });
    }

    // Single-day scan
    const driverSlug = url.searchParams.get('driverSlug');
    const date = url.searchParams.get('date');
    if (!driverSlug || !date) {
      return new Response(JSON.stringify({
        error: 'Missing driverSlug and/or date. Usage: ?driverSlug=che_roberts&date=2026-04-27'
      }), { status: 400, headers: CORS });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'date must be YYYY-MM-DD' }),
        { status: 400, headers: CORS });
    }

    const scanId = `dayscan_${date}_${Date.now()}`;
    const t0 = Date.now();
    const { result, debug } = await scanOneDriverDay({ driverSlug, date, scanId });
    const wallMs = Date.now() - t0;

    return new Response(JSON.stringify({
      version: VERSION,
      ok: true,
      wallMs,
      driverSlug,
      date,
      scanId,
      writtenTo: `sentinelDriverDays/${result._id}`,
      result,
      debug
    }, null, 2), { status: 200, headers: CORS });

  } catch (err) {
    console.error('[sentinel-day-scan]', err);
    return new Response(JSON.stringify({
      error: 'Internal error',
      message: err.message
    }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-day-scan' };
