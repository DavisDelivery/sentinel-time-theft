// netlify/functions/sentinel-day-scan.js
// SENTINEL v4 — single driver-day scan orchestrator.
//
// On first ever invocation, this function bootstraps two config docs:
//   /sentinelConfig/truckTypeMap   (derived from /driverPerformanceDaily/ — read-once)
//   /sentinelConfig/defaults
// After that, those docs are read but not overwritten (operator can edit them).
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
import { travelFromYard, travelToYard } from './_distance.js';
import { scoreDriverDay, parseNuvizzDeliveryEnd, runSelfTest } from './_sentinel-engine.js';
import { getDrivingPeriods, classifyDestinations, summarizePeriods, parseZipFromAddress } from './_motive.js';

const VERSION = 'v4.0.4-phase1c-preview';

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

const DEFAULT_DEFAULTS = {
  loadPrepMin: 15,
  wrapUpMin: 15,
  wageRates: { tractor: 27.50, straight: 23.00, unknown: 25.00 },
  morningGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  afternoonGapStaticThresholds: { ok: 30, warn: 60, flag: 90 }
};

// ---------- Config bootstrap ----------

async function loadOrBootstrapDefaults(db) {
  let doc;
  try { doc = await db.getDoc('sentinelConfig', 'defaults'); } catch (e) { doc = null; }
  if (doc && doc.loadPrepMin != null) return doc;
  const fresh = {
    ...DEFAULT_DEFAULTS,
    generatedAt: new Date().toISOString(),
    version: 1
  };
  await db.setDoc('sentinelConfig', 'defaults', fresh);
  return fresh;
}

async function loadOrBootstrapTruckTypeMap(db) {
  let doc;
  try { doc = await db.getDoc('sentinelConfig', 'truckTypeMap'); } catch (e) { doc = null; }
  if (doc && doc.trucks) return doc;

  // Bootstrap from driverPerformanceDaily — read a wide sample and dedupe by truck
  const rows = await db.listDocs('driverPerformanceDaily', {
    limit: 1000,
    fields: ['truck', 'driverType', 'updatedAt']
  });
  const trucks = {};
  for (const r of rows) {
    const t = r.truck;
    const ty = r.driverType;
    if (!t || !ty) continue;
    // Skip junk values like "Service Truck 1  #7206"
    if (!/^\d{3,5}$/.test(String(t).trim())) continue;
    // Last-write wins (we're not deduping by date, just first-seen)
    if (!trucks[String(t).trim()]) trucks[String(t).trim()] = String(ty).toLowerCase();
  }
  const fresh = {
    trucks,
    derivedFrom: 'driverPerformanceDaily',
    sampleSize: rows.length,
    distinctTrucks: Object.keys(trucks).length,
    generatedAt: new Date().toISOString(),
    version: 1
  };
  await db.setDoc('sentinelConfig', 'truckTypeMap', fresh);
  return fresh;
}

function resolveTruckType(defaultTruck, truckTypeMap) {
  if (!defaultTruck) return 'unknown';
  const key = String(defaultTruck).trim();
  const type = truckTypeMap?.trucks?.[key];
  if (type === 'tractor' || type === 'straight') return type;
  return 'unknown';
}

// ---------- Data gathering ----------

async function getEmployee(db, driverSlug) {
  try {
    const emp = await db.getDoc('employees', driverSlug);
    if (!emp) throw new Error(`employee not found: ${driverSlug}`);
    return emp;
  } catch (e) {
    throw new Error(`employee fetch failed for ${driverSlug}: ${e.message}`);
  }
}

async function getB600Punch(db, employee, date) {
  // Query all timeclock rows for the date, match in memory
  const rows = await db.listDocs('timeclock_daily', {
    where: [{ field: 'date', op: '==', value: date }],
    limit: 200
  });
  const b600Name = employee?.externalIds?.b600;
  const candidates = [b600Name, employee?.fullName, `${employee?.firstName} ${employee?.lastName}`].filter(Boolean);

  for (const r of rows) {
    const candidates2 = [r.display_id, r.display_name, r.payroll_id].filter(Boolean);
    // Check any candidate matches any row name (case-insensitive)
    const hit = candidates.some(c1 => candidates2.some(c2 => c1.toLowerCase() === c2.toLowerCase()));
    if (hit) {
      // Prefer punches[0].in / punches[last].out if available — they reflect actual
      // worked time better than top-level when there are lunch breaks.
      let clockIn = r.clock_in;
      let clockOut = r.clock_out;
      if (Array.isArray(r.punches) && r.punches.length > 0) {
        clockIn = r.punches[0]?.in || clockIn;
        clockOut = r.punches[r.punches.length - 1]?.out || clockOut;
      }
      return { clockIn, clockOut, totalHours: r.total_hours, matchedOn: r.display_id, rawRow: r };
    }
  }
  return null;
}

async function getNuvizzStops(db, employee, date) {
  const rows = await db.listDocs('nuvizz_rows_raw', {
    where: [{ field: 'delivery_date', op: '==', value: date }],
    limit: 2000
  });
  const nuvizzName = employee?.externalIds?.nuvizz || employee?.fullName;
  const diag = {
    rowsScannedForDate: rows.length,
    driverNameMatches: 0,
    statusBreakdown: {},
    countedAsComplete: 0,
    skippedNoTime: 0,
    manualCompletions: 0
  };
  if (!nuvizzName) return { matches: [], diag: { ...diag, reason: 'no nuvizz external ID on employee' } };

  // Normalize for fuzzy matching: collapse whitespace, lowercase
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const target = norm(nuvizzName);

  const matches = [];
  for (const r of rows) {
    const raw = r.raw || {};
    if (norm(raw['driver name']) !== target) continue;
    diag.driverNameMatches++;

    const status = raw['stop status'] || '(none)';
    diag.statusBreakdown[status] = (diag.statusBreakdown[status] || 0) + 1;

    // Treat anything with "complet" in the status as a delivered stop.
    // Covers "Completed" (auto-completed by driver) and "Manually Completed"
    // (closed by dispatch when driver has device trouble) and any other variant.
    if (!status.toLowerCase().includes('complet')) continue;

    const deliveryEnd = parseNuvizzDeliveryEnd(raw['delivery end']);
    if (!deliveryEnd) {
      diag.skippedNoTime++;
      continue;
    }

    if (status.toLowerCase() !== 'completed') diag.manualCompletions++;
    diag.countedAsComplete++;

    matches.push({
      pro: r.pro,
      deliveryEnd,
      shipTo: raw['ship to'],
      shipToName: raw['ship to name'],
      city: raw['ship to - city'],
      zip: raw['ship to - zip code'],
      status
    });
  }
  matches.sort((a, b) => a.deliveryEnd - b.deliveryEnd);
  return { matches, diag };
}

// ---------- Main scan ----------

async function scanOneDriverDay({ driverSlug, date, scanId }) {
  const db = getDb();

  // Bootstrap config if needed
  const defaults = await loadOrBootstrapDefaults(db);
  const truckTypeMap = await loadOrBootstrapTruckTypeMap(db);

  // Employee
  const employee = await getEmployee(db, driverSlug);
  const truckType = resolveTruckType(employee.defaultTruck, truckTypeMap);

  // B600 timeclock
  const punch = await getB600Punch(db, employee, date);

  // NuVizz stops
  const { matches: allStops, diag: nuvizzDiag } = await getNuvizzStops(db, employee, date);

  // Partition stops by whether their deliveryEnd is within the B600 shift window.
  // Out-of-window stops are tracked separately and surfaced in dataHealth — they
  // happen when dispatch manually closes stops after the driver has clocked out
  // (Aaron Mitchell 2026-04-29 case), or pre-clockin GPS firings.
  const [yy, mo, dd] = date.split('-').map(Number);
  const buildDt = (hhmm) => {
    if (!hhmm) return null;
    const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(yy, mo - 1, dd, +m[1], +m[2], 0));
  };
  const clockInDt = buildDt(punch?.clockIn);
  const clockOutDt = buildDt(punch?.clockOut);

  let onShiftStops = allStops;
  let preClockinStops = [];
  let postClockoutStops = [];
  if (clockInDt) {
    preClockinStops = allStops.filter(s => s.deliveryEnd < clockInDt);
  }
  if (clockOutDt) {
    postClockoutStops = allStops.filter(s => s.deliveryEnd > clockOutDt);
  }
  if (clockInDt || clockOutDt) {
    onShiftStops = allStops.filter(s =>
      (!clockInDt || s.deliveryEnd >= clockInDt) &&
      (!clockOutDt || s.deliveryEnd <= clockOutDt)
    );
  }

  const firstStop = onShiftStops[0] || null;
  const lastStop = onShiftStops.length > 0 ? onShiftStops[onShiftStops.length - 1] : null;

  // Travel times — only fetch if we have addresses
  let travelToFirst = { minutes: null, source: 'skipped' };
  let travelFromLast = { minutes: null, source: 'skipped' };
  if (firstStop?.shipTo) {
    travelToFirst = await travelFromYard(firstStop.shipTo);
  }
  if (lastStop?.shipTo) {
    travelFromLast = await travelToYard(lastStop.shipTo);
  }

  // Score
  const result = scoreDriverDay({
    driverSlug,
    displayName: employee.fullName,
    date,
    scanId,
    truckType,

    clockIn: punch?.clockIn || null,
    clockOut: punch?.clockOut || null,
    b600Matched: !!punch,

    firstDeliveryTime: firstStop?.deliveryEnd || null,
    firstDeliveryAddr: firstStop?.shipTo || null,
    firstDeliveryCustomer: firstStop?.shipToName || null,
    lastDeliveryTime: (lastStop && lastStop !== firstStop) ? lastStop.deliveryEnd : null,
    lastDeliveryAddr: (lastStop && lastStop !== firstStop) ? lastStop.shipTo : null,
    lastDeliveryCustomer: (lastStop && lastStop !== firstStop) ? lastStop.shipToName : null,
    completedStops: allStops.length,
    nuvizzMatched: allStops.length > 0,

    expectedTravelMinToFirst: travelToFirst.minutes,
    expectedTravelMinToFirstSource: travelToFirst.source,
    expectedTravelMinFromLast: travelFromLast.minutes,
    expectedTravelMinFromLastSource: travelFromLast.source,

    defaults
  });

  // Write
  // Post-engine: append dataHealth notes for non-theft signals
  if (nuvizzDiag.manualCompletions > 0) {
    result.dataHealth.push(`manual_completions:${nuvizzDiag.manualCompletions}`);
  }
  if (nuvizzDiag.skippedNoTime > 0) {
    result.dataHealth.push(`stops_with_unparseable_time:${nuvizzDiag.skippedNoTime}`);
  }
  if (preClockinStops.length > 0) {
    result.dataHealth.push(`pre_clockin_completions:${preClockinStops.length}`);
  }
  if (postClockoutStops.length > 0) {
    result.dataHealth.push(`post_clockout_completions:${postClockoutStops.length}`);
  }

  // ---------- Phase 1c preview: Motive in-route (Flag Class 3) ----------
  // For this iteration we FETCH and CLASSIFY Motive driving periods, then
  // surface the off-route destinations in result.motive AND debug output.
  // We do NOT yet fold the signal into riskScore — operator eyeball pass first.
  const motiveId = employee?.externalIds?.motive;
  const yardZip = '30518'; // Davis Delivery yard (Buford GA)
  let motiveDebug = { skipped: true, reason: 'no motive id on employee' };
  if (motiveId) {
    try {
      const { periods: rawPeriods, raw } = await getDrivingPeriods(motiveId, date);
      const customerZipSet = new Set(allStops.map(s => s.zip).filter(Boolean));
      const classified = classifyDestinations(rawPeriods, yardZip, customerZipSet);
      const summary = summarizePeriods(classified);

      result.motive = {
        driverId: motiveId,
        periodsCount: classified.length,
        totalMi: summary.totalMi,
        totalDriveMin: summary.totalDriveMin,
        offRouteVisits: summary.offRouteVisits,
        offRouteZips: summary.offRouteZips,
        customerZips: [...customerZipSet],
        yardZip
      };
      if (summary.offRouteCount > 0) {
        result.dataHealth.push(`motive_off_route_visits:${summary.offRouteCount}`);
      }
      motiveDebug = {
        skipped: false,
        motiveDriverId: motiveId,
        rawTotalReported: raw.total,
        fetched: raw.fetched,
        periodsClassified: classified.map(p => ({
          startET: p.startDt?.toISOString().slice(11, 16),
          endET: p.endDt?.toISOString().slice(11, 16),
          durMin: p.durationMin,
          mi: p.distanceMi,
          origin: p.originAddr?.slice(0, 45),
          dest: p.destAddr?.slice(0, 45),
          destZip: p.destZip,
          destClass: p.destClass
        })),
        summary
      };
    } catch (err) {
      motiveDebug = { skipped: true, reason: `motive fetch failed: ${err.message}` };
      result.dataHealth.push('motive_fetch_failed');
    }
  } else {
    result.dataHealth.push('no_motive_id_on_employee');
  }

  await db.setDoc('sentinelDriverDays', result._id, result);

  return {
    result,
    debug: {
      employeeFound: true,
      truckType,
      truckTypeMapSize: Object.keys(truckTypeMap.trucks).length,
      b600Match: punch ? { matchedOn: punch.matchedOn, clockIn: punch.clockIn, clockOut: punch.clockOut } : null,
      nuvizzDiag,
      stopsSummary: allStops.map(s => ({
        pro: s.pro, time: s.deliveryEnd.toISOString().slice(11, 16),
        customer: s.shipToName, zip: s.zip, status: s.status,
        onShift: (!clockInDt || s.deliveryEnd >= clockInDt) && (!clockOutDt || s.deliveryEnd <= clockOutDt)
      })),
      partitionCounts: {
        allStops: allStops.length,
        onShiftStops: onShiftStops.length,
        preClockinStops: preClockinStops.length,
        postClockoutStops: postClockoutStops.length
      },
      anchors: {
        firstUsedForAnchor: firstStop ? { pro: firstStop.pro, time: firstStop.deliveryEnd.toISOString().slice(11, 16), customer: firstStop.shipToName } : null,
        lastUsedForAnchor: (lastStop && lastStop !== firstStop) ? { pro: lastStop.pro, time: lastStop.deliveryEnd.toISOString().slice(11, 16), customer: lastStop.shipToName } : null
      },
      travelToFirst,
      travelFromLast,
      motive: motiveDebug
    }
  };
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
      error: err.message,
      stack: err.stack?.slice(0, 800)
    }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-day-scan' };
