// netlify/functions/sentinel-nightly-scan-background.js
// SENTINEL v4 Phase 3c — nightly catch-up worker.
//
// Invoked once per night (T-7) by sentinel-nightly-scan with body { date }.
// Loads the current active driver roster, then runs scanOneDriverDay for each
// driver on that date with Motive ON (recent days → reliable Class-3 signal).
// Writes a single summary doc to sentinelConfig/nightlyScanStatus.
//
// Roughly ~49 drivers × ~3-5 s each = well under one 15-minute background
// invocation, no chaining required.

import { getDb } from './_firebase-admin.js';
import {
  scanOneDriverDay,
  loadOrBootstrapDefaults,
  loadOrBootstrapTruckTypeMap
} from './_sentinel-scan.js';

const VERSION = 'v4.1.0-phase3c';
const STATUS_COLLECTION = 'sentinelConfig';
const STATUS_DOC = 'nightlyScanStatus';
const MAX_ERROR_SAMPLES = 25;

async function loadActiveDriverSlugs(db) {
  const rows = await db.listDocs('employees', {
    where: [{ field: 'status', op: '==', value: 'active' }],
    limit: 500,
    fields: ['role']
  });
  return rows
    .filter(r => r.role === 'driver' || r.role === 'owner_op')
    .map(r => r.id)
    .sort();
}

export default async (req) => {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const db = getDb();

  let body = {};
  try {
    const text = await req.text();
    if (text && text.trim()) body = JSON.parse(text);
  } catch (_) {}

  const date = body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const err = `nightly-scan-bg: invalid or missing date in body: ${JSON.stringify(body)}`;
    console.error(err);
    try {
      await db.setDoc(STATUS_COLLECTION, STATUS_DOC, {
        lastRunAt: startedAt, targetDate: date || null,
        scanned: 0, written: 0, empty: 0, errors: 0,
        error: err, version: VERSION
      });
    } catch (_) {}
    return new Response(JSON.stringify({ error: err }), { status: 400 });
  }

  const scanId = `nightly_${date}_${Date.now()}`;
  console.log(`[nightly-bg] start date=${date} scanId=${scanId}`);

  const [defaults, truckTypeMap, driverSlugs] = await Promise.all([
    loadOrBootstrapDefaults(db),
    loadOrBootstrapTruckTypeMap(db),
    loadActiveDriverSlugs(db)
  ]);
  const config = { defaults, truckTypeMap };

  let scanned = 0, written = 0, empty = 0, errors = 0;
  const errorSamples = [];

  for (const driverSlug of driverSlugs) {
    try {
      const { result } = await scanOneDriverDay({
        driverSlug,
        date,
        scanId,
        skipMotive: false,
        skipWriteIfNoData: true,
        config
      });
      scanned++;
      if (result._written) written++;
      else empty++;
    } catch (err) {
      errors++;
      if (errorSamples.length < MAX_ERROR_SAMPLES) {
        errorSamples.push({
          driverSlug,
          message: String(err?.message || err).slice(0, 200)
        });
      }
      console.warn(`[nightly-bg] scan failed ${driverSlug} ${date}: ${err.message}`);
    }
  }

  const wallMs = Date.now() - t0;
  const summary = {
    lastRunAt: startedAt,
    targetDate: date,
    scanId,
    rosterSize: driverSlugs.length,
    scanned, written, empty, errors,
    errorSamples,
    wallMs,
    version: VERSION
  };
  try { await db.setDoc(STATUS_COLLECTION, STATUS_DOC, summary); } catch (e) {
    console.error('[nightly-bg] status write failed:', e.message);
  }
  console.log(`[nightly-bg] done date=${date} scanned=${scanned} written=${written} empty=${empty} errors=${errors} wallMs=${wallMs}`);

  return new Response(JSON.stringify(summary, null, 2), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};
