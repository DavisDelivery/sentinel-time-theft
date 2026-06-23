// netlify/functions/_sentinel-scan.js
// SENTINEL v4 — shared scan core, used by sentinel-day-scan (interactive),
// sentinel-historical-backfill-background (one-time sweep), and
// sentinel-nightly-scan-background (daily T-7 catch-up).
//
// Exports:
//   scanOneDriverDay({ driverSlug, date, scanId, skipMotive?, skipWriteIfNoData?, config? })
//   loadOrBootstrapDefaults(db)
//   loadOrBootstrapTruckTypeMap(db)
//
// Behavior is the same as the original sentinel-day-scan implementation; the
// three optional knobs only narrow what work runs:
//   skipMotive: true       → skip Motive/Class 3 entirely, dataHealth gets 'motive_skipped'
//   skipWriteIfNoData: true → if !b600Matched && !nuvizzMatched, return without writing
//                             and set result._written = false
//   config: { defaults, truckTypeMap } → reuse pre-loaded config, skip bootstrap reads
//
// When the write does happen, result._written = true.

import { getDb } from './_firebase-admin.js';
import { travelFromYard, travelToYard } from './_distance.js';
import { scoreDriverDay, parseNuvizzDeliveryEnd } from './_sentinel-engine.js';
import { getDrivingPeriods, summarizePeriods } from './_motive.js';

export const DEFAULT_DEFAULTS = {
  loadPrepMin: 15,
  wrapUpMin: 15,
  wageRates: { tractor: 27.50, straight: 23.00, unknown: 25.00 },
  morningGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  afternoonGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  yardZips: ['30518', '30542'],
  inRouteStaticThresholds: { ok: 15, warn: 30, flag: 60 }
};

// ---------- Config bootstrap ----------

export async function loadOrBootstrapDefaults(db) {
  let doc;
  try { doc = await db.getDoc('sentinelConfig', 'defaults'); } catch (e) { doc = null; }
  if (!doc || doc.loadPrepMin == null) {
    const fresh = {
      ...DEFAULT_DEFAULTS,
      generatedAt: new Date().toISOString(),
      version: 1
    };
    await db.setDoc('sentinelConfig', 'defaults', fresh);
    return fresh;
  }
  let needsUpdate = false;
  const merged = { ...doc };
  for (const [key, value] of Object.entries(DEFAULT_DEFAULTS)) {
    if (merged[key] == null) {
      merged[key] = value;
      needsUpdate = true;
    } else if (value && typeof value === 'object' && !Array.isArray(value)
               && merged[key] && typeof merged[key] === 'object') {
      // Deep-backfill nested config (wageRates, *StaticThresholds): a partial
      // operator-edited object must not drop the default sub-keys, otherwise a
      // missing wage rate yields NaN stolenDollars.
      const sub = { ...merged[key] };
      for (const [k2, v2] of Object.entries(value)) {
        if (sub[k2] == null) { sub[k2] = v2; needsUpdate = true; }
      }
      merged[key] = sub;
    }
  }
  if (needsUpdate) {
    merged.lastMigrated = new Date().toISOString();
    await db.setDoc('sentinelConfig', 'defaults', merged);
  }
  return merged;
}

export async function loadOrBootstrapTruckTypeMap(db) {
  let doc;
  try { doc = await db.getDoc('sentinelConfig', 'truckTypeMap'); } catch (e) { doc = null; }
  if (doc && doc.trucks) return doc;

  const rows = await db.listDocs('driverPerformanceDaily', {
    limit: 1000,
    fields: ['truck', 'driverType', 'updatedAt']
  });
  const trucks = {};
  for (const r of rows) {
    const t = r.truck;
    const ty = r.driverType;
    if (!t || !ty) continue;
    if (!/^\d{3,5}$/.test(String(t).trim())) continue;
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

function resolveTruckType(employee, truckTypeMap) {
  // Per-driver override on /employees wins. This is the operator's manual
  // assignment via the Driver Config UI — used for owner_ops (who carry no
  // company truck number, so defaultTruck → truckTypeMap fails) and for any
  // driver whose truckTypeMap entry is wrong or missing.
  const ov = employee?.truckType;
  if (ov === 'tractor' || ov === 'straight') return ov;
  const defaultTruck = employee?.defaultTruck;
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
  const rows = await db.listDocs('timeclock_daily', {
    where: [{ field: 'date', op: '==', value: date }],
    limit: 200
  });
  const b600Name = employee?.externalIds?.b600;
  const candidates = [b600Name, employee?.fullName, `${employee?.firstName} ${employee?.lastName}`].filter(Boolean);

  for (const r of rows) {
    const candidates2 = [r.display_id, r.display_name, r.payroll_id].filter(Boolean);
    const hit = candidates.some(c1 => candidates2.some(c2 => c1.toLowerCase() === c2.toLowerCase()));
    if (hit) {
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
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  // Match NuVizz's raw["driver name"] against every name we know for this
  // driver, not just externalIds.nuvizz. SCHEMA documents an `aliases` fallback
  // for exactly the "NuVizz prints a slightly different name" case (e.g. Brent
  // Boyd vs Brenton Byrd) that otherwise yields 0 matched stops. All comparisons
  // are exact after whitespace/case normalization — no fuzzy/substring matching,
  // so one driver's stops can't bleed onto another.
  const nameCandidates = [
    employee?.externalIds?.nuvizz,
    employee?.fullName,
    (employee?.firstName && employee?.lastName) ? `${employee.firstName} ${employee.lastName}` : null,
    ...(Array.isArray(employee?.aliases) ? employee.aliases : [])
  ].filter(Boolean).map(norm);
  const targetSet = new Set(nameCandidates);
  const diag = {
    rowsScannedForDate: rows.length,
    nuvizzNameCandidates: [...targetSet],
    driverNameMatches: 0,
    statusBreakdown: {},
    countedAsComplete: 0,
    skippedNoTime: 0,
    manualCompletions: 0
  };
  if (targetSet.size === 0) return { matches: [], diag: { ...diag, reason: 'no nuvizz name/alias on employee' } };

  const matches = [];
  for (const r of rows) {
    const raw = r.raw || {};
    if (!targetSet.has(norm(raw['driver name']))) continue;
    diag.driverNameMatches++;

    const status = raw['stop status'] || '(none)';
    diag.statusBreakdown[status] = (diag.statusBreakdown[status] || 0) + 1;

    // SCHEMA: "Completed only." Accept "Completed" and manual-completion variants
    // ("Completed - Manual"), but NOT "Incomplete" (which contains "complet").
    if (!status.trim().toLowerCase().startsWith('complet')) continue;

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
  matches.sort((a, b) => a.deliveryEnd.getTime() - b.deliveryEnd.getTime());
  return { matches, diag };
}

// ---------- Main scan ----------

export async function scanOneDriverDay({
  driverSlug,
  date,
  scanId,
  skipMotive = false,
  skipWriteIfNoData = false,
  config = null
}) {
  const db = getDb();

  const defaults = config?.defaults || await loadOrBootstrapDefaults(db);
  const truckTypeMap = config?.truckTypeMap || await loadOrBootstrapTruckTypeMap(db);

  const employee = await getEmployee(db, driverSlug);
  const truckType = resolveTruckType(employee, truckTypeMap);

  const punch = await getB600Punch(db, employee, date);
  const { matches: allStops, diag: nuvizzDiag } = await getNuvizzStops(db, employee, date);

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

  const firstDeliveryDt = firstStop?.deliveryEnd || null;
  const lastDeliveryDt = lastStop ? lastStop.deliveryEnd : firstDeliveryDt;

  // ---------- Google typical travel (time-of-day, best_guess traffic) ----------
  // Morning leg departs the yard ~clock-in; afternoon leg departs the last stop
  // ~last-delivery. Passing those times makes Google return the typical traffic
  // for that weekday + time-of-day instead of a free-flow estimate.
  let travelToFirst = { minutes: null, source: 'skipped' };
  let travelFromLast = { minutes: null, source: 'skipped' };
  if (firstStop?.shipTo) {
    travelToFirst = await travelFromYard(firstStop.shipTo, clockInDt || firstDeliveryDt);
  }
  if (lastStop?.shipTo) {
    travelFromLast = await travelToYard(lastStop.shipTo, lastDeliveryDt || clockOutDt);
  }
  const googleToFirst = (typeof travelToFirst.minutes === 'number') ? travelToFirst.minutes : null;
  const googleFromLast = (typeof travelFromLast.minutes === 'number') ? travelFromLast.minutes : null;

  // ---------- Motive (Phase A): fetch once, derive per-leg actual drive +
  // route-match reliability. The in-route flag (Phase B) reuses this. ----------
  const motiveHealth = [];
  let motiveDebug = { skipped: true, reason: 'no motive id on employee' };
  let motiveState = null;
  const motiveId = employee?.externalIds?.motive;
  const yardZips = defaults.yardZips || ['30518', '30542'];
  if (skipMotive) {
    motiveDebug = { skipped: true, reason: 'motive_skipped (caller opted out)' };
    motiveHealth.push('motive_skipped');
  } else if (motiveId) {
    try {
      const { periods: rawPeriods, raw } = await getDrivingPeriods(motiveId, date);
      const buffer = 30 * 60 * 1000;
      const windowStart = clockInDt ? new Date(clockInDt.getTime() - buffer) : null;
      const windowEnd = clockOutDt ? new Date(clockOutDt.getTime() + buffer) : null;
      const inWindow = rawPeriods.filter(p => {
        if (!p.startDt) return false;
        if (windowStart && p.startDt < windowStart) return false;
        if (windowEnd && p.startDt > windowEnd) return false;
        return true;
      });
      const outOfWindow = rawPeriods.length - inWindow.length;
      const customerZipSet = new Set(allStops.map(s => s.zip).filter(Boolean));
      const yardZipSet = new Set(yardZips.map(String));
      const classified = inWindow.map(p => {
        let cls = 'unknown';
        if (!p.destZip) cls = 'unknown';
        else if (yardZipSet.has(p.destZip)) cls = 'yard';
        else if (customerZipSet.has(p.destZip)) cls = 'customer';
        else cls = 'off_route';
        return { ...p, destClass: cls };
      });
      const summary = summarizePeriods(classified);

      // Route-match reliability: did the truck's GPS actually visit ≥1 NuVizz
      // customer ZIP today? If not (or no periods), the truck assignment is
      // stale / a different truck → don't trust Motive, fall back to Google.
      const routeMatch = classified.length > 0 && classified.some(p => p.destClass === 'customer');

      // Per-leg actual drive minutes = sum of driving-period durations whose
      // period started inside that leg's time window.
      const sumDriveIn = (a, b) => {
        if (!a || !b) return { min: null, count: 0 };
        let min = 0, count = 0;
        for (const p of classified) {
          if (p.startDt >= a && p.startDt < b && typeof p.durationMin === 'number') { min += p.durationMin; count++; }
        }
        return { min, count };
      };
      const morning = sumDriveIn(clockInDt, firstDeliveryDt);
      const afternoon = sumDriveIn(lastDeliveryDt, clockOutDt);

      const partitionVisit = (v) => {
        if (!firstDeliveryDt || !lastDeliveryDt) return 'unknown';
        const visitStart = v._startDt;
        if (visitStart < firstDeliveryDt) return 'pre_route';
        if (visitStart > lastDeliveryDt) return 'post_route';
        return 'in_route';
      };
      const offRoutePeriods = classified.filter(p => p.destClass === 'off_route');
      const offRouteVisits = offRoutePeriods.map((p) => {
        const idxInAll = classified.indexOf(p);
        const next = classified[idxInAll + 1];
        const stationarySec = next?.startDt && p.endDt ? Math.max(0, (next.startDt - p.endDt) / 1000) : 0;
        const visit = {
          _startDt: p.startDt,
          arrivedAt: p.endDt ? p.endDt.toISOString().slice(11, 16) : null,
          leftAt: next?.startDt ? next.startDt.toISOString().slice(11, 16) : null,
          destAddr: p.destAddr,
          destZip: p.destZip,
          stationaryMin: Math.round(stationarySec / 60),
          driveMinToReach: p.durationMin,
          driveMi: p.distanceMi
        };
        visit.window = partitionVisit(visit);
        delete visit._startDt;
        return visit;
      });
      const inRouteOffRouteMin = offRouteVisits
        .filter(v => v.window === 'in_route')
        .reduce((s, v) => s + v.driveMinToReach + v.stationaryMin, 0);

      motiveState = {
        driverId: motiveId,
        periodsCount: classified.length,
        totalMi: summary.totalMi,
        totalDriveMin: summary.totalDriveMin,
        offRouteVisits,
        offRouteZips: summary.offRouteZips,
        customerZips: [...customerZipSet],
        yardZips,
        inRouteOffRouteMin,
        routeMatch,
        morningDriveMin: morning.min,
        morningPeriods: morning.count,
        afternoonDriveMin: afternoon.min,
        afternoonPeriods: afternoon.count
      };
      if (!routeMatch) motiveHealth.push('motive_route_mismatch');
      if (summary.offRouteCount > 0) motiveHealth.push(`motive_off_route_visits:${summary.offRouteCount}`);

      motiveDebug = {
        skipped: false,
        motiveDriverId: motiveId,
        rawTotalReported: raw.total,
        fetched: raw.fetched,
        filteredOutOfWindow: outOfWindow,
        routeMatch,
        morningDriveMin: morning.min,
        afternoonDriveMin: afternoon.min,
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
        summary,
        inRouteOffRouteMin
      };
    } catch (err) {
      motiveDebug = { skipped: true, reason: `motive fetch failed: ${err.message}` };
      motiveHealth.push('motive_fetch_failed');
    }
  } else {
    motiveHealth.push('no_motive_id_on_employee');
  }

  // ---------- Choose effective travel per leg ----------
  // Motive wins when its GPS matched the route AND it has driving data in that
  // leg's window; otherwise fall back to Google's typical-traffic estimate.
  const pickLeg = (ok, motiveMin, motivePeriods, googleMin) => {
    if (ok && typeof motiveMin === 'number' && motivePeriods > 0) return { minutes: motiveMin, source: 'motive' };
    if (typeof googleMin === 'number') return { minutes: googleMin, source: 'google' };
    return { minutes: null, source: 'none' };
  };
  const effToFirst = pickLeg(motiveState?.routeMatch, motiveState?.morningDriveMin, motiveState?.morningPeriods || 0, googleToFirst);
  const effFromLast = pickLeg(motiveState?.routeMatch, motiveState?.afternoonDriveMin, motiveState?.afternoonPeriods || 0, googleFromLast);

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
    // A single completed stop is still a valid afternoon (return-trip) anchor.
    // Morning charges clockIn→delivery; afternoon charges delivery→clockOut —
    // disjoint windows, so a one-stop day is not double-counted.
    lastDeliveryTime: lastStop ? lastStop.deliveryEnd : null,
    lastDeliveryAddr: lastStop ? lastStop.shipTo : null,
    lastDeliveryCustomer: lastStop ? lastStop.shipToName : null,
    completedStops: allStops.length,
    nuvizzMatched: allStops.length > 0,

    expectedTravelMinToFirst: effToFirst.minutes,
    expectedTravelMinToFirstSource: effToFirst.source,
    expectedTravelMinFromLast: effFromLast.minutes,
    expectedTravelMinFromLastSource: effFromLast.source,
    googleTravelMinToFirst: googleToFirst,
    motiveDriveMinToFirst: motiveState?.morningDriveMin ?? null,
    googleTravelMinFromLast: googleFromLast,
    motiveDriveMinFromLast: motiveState?.afternoonDriveMin ?? null,

    loadPrepMin: employee.loadPrepMin,
    wrapUpMin: employee.wrapUpMin,

    defaults
  });

  // Data-health notes (NuVizz + Motive), pushed after the record exists.
  if (nuvizzDiag.manualCompletions > 0) result.dataHealth.push(`manual_completions:${nuvizzDiag.manualCompletions}`);
  if (nuvizzDiag.skippedNoTime > 0) result.dataHealth.push(`stops_with_unparseable_time:${nuvizzDiag.skippedNoTime}`);
  if (preClockinStops.length > 0) result.dataHealth.push(`pre_clockin_completions:${preClockinStops.length}`);
  if (postClockoutStops.length > 0) result.dataHealth.push(`post_clockout_completions:${postClockoutStops.length}`);
  for (const n of motiveHealth) result.dataHealth.push(n);

  // ---------- Motive (Phase B): in-route flag (Class 3) + score/stolen add-on ----------
  if (motiveState) {
    const { offRouteVisits, inRouteOffRouteMin } = motiveState;
    result.motive = {
      driverId: motiveState.driverId,
      periodsCount: motiveState.periodsCount,
      totalMi: motiveState.totalMi,
      totalDriveMin: motiveState.totalDriveMin,
      offRouteVisits,
      offRouteZips: motiveState.offRouteZips,
      customerZips: motiveState.customerZips,
      yardZips: motiveState.yardZips,
      inRouteOffRouteMin,
      routeMatch: motiveState.routeMatch,
      morningDriveMin: motiveState.morningDriveMin,
      afternoonDriveMin: motiveState.afternoonDriveMin
    };

    const t = defaults.inRouteStaticThresholds || { ok: 15, warn: 30, flag: 60 };
    let inRouteFlag = 'ok';
    if (inRouteOffRouteMin > t.flag) inRouteFlag = 'critical';
    else if (inRouteOffRouteMin > t.warn) inRouteFlag = 'flag';
    else if (inRouteOffRouteMin > t.ok) inRouteFlag = 'warn';
    result.inRouteFlag = inRouteFlag;
    result.inRouteOffRouteMin = inRouteOffRouteMin;

    const FLAG_TO_SCORE = { ok: 0, warn: 10, flag: 25, critical: 40, no_data: 0 };
    result.riskScore = (result.riskScore || 0) + (FLAG_TO_SCORE[inRouteFlag] || 0);
    // Clamp to 100 so scan and rescore agree on the same record.
    if (result.riskScore > 100) result.riskScore = 100;
    if (result.riskScore >= 70) result.riskLevel = 'critical';
    else if (result.riskScore >= 45) result.riskLevel = 'high';
    else if (result.riskScore >= 25) result.riskLevel = 'medium';
    else if (result.riskScore >= 10) result.riskLevel = 'low';
    else result.riskLevel = 'clean';

    const stolenFromInRoute = Math.max(0, inRouteOffRouteMin - t.ok);
    result.stolenMinutes = (result.stolenMinutes || 0) + stolenFromInRoute;
    const wage = (defaults.wageRates[result.truckType] != null) ? defaults.wageRates[result.truckType] : defaults.wageRates.unknown;
    result.stolenDollars = +((result.stolenMinutes / 60) * wage).toFixed(2);

    if (inRouteFlag !== 'ok' && inRouteFlag !== 'no_data') {
      const inRouteVisits = offRouteVisits.filter(v => v.window === 'in_route');
      const evidenceLocations = inRouteVisits
        .map(v => `${v.destZip}${v.stationaryMin > 0 ? ` (${v.stationaryMin}min stop)` : ''}`)
        .join(', ');
      result.flags.push({
        kind: 'in_route_off_route',
        severity: inRouteFlag,
        evidence: `${inRouteOffRouteMin} min of off-route activity between first and last delivery. Locations: ${evidenceLocations}.`,
        deltaMin: inRouteOffRouteMin
      });
    }

    const postRouteVisits = offRouteVisits.filter(v => v.window === 'post_route');
    if (postRouteVisits.length > 0) {
      const afternoonFlag = result.flags.find(f => f.kind === 'afternoon_gap');
      const detourSummary = postRouteVisits
        .map(v => `${v.destZip}${v.stationaryMin > 0 ? ` (${v.stationaryMin}min stop)` : ''}${v.driveMi > 1 ? ` via ${v.driveMi}mi detour` : ''}`)
        .join(', ');
      if (afternoonFlag) afternoonFlag.evidence += ` Motive shows detour to: ${detourSummary}.`;
      result.dataHealth.push(`motive_post_route_detour:${postRouteVisits.length}`);
    }
  }

  // Write (or skip if caller asked us to suppress empty rows)
  const hasData = !!punch || allStops.length > 0;
  if (skipWriteIfNoData && !hasData) {
    result._written = false;
  } else {
    await db.setDoc('sentinelDriverDays', result._id, result);
    result._written = true;
  }

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
        lastUsedForAnchor: lastStop ? { pro: lastStop.pro, time: lastStop.deliveryEnd.toISOString().slice(11, 16), customer: lastStop.shipToName, sameAsFirst: lastStop === firstStop } : null
      },
      travelToFirst,
      travelFromLast,
      motive: motiveDebug
    }
  };
}
