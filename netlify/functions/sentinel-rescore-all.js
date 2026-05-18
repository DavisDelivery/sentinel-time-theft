// netlify/functions/sentinel-rescore-all.js
// SENTINEL v4 Phase 3 — re-classify every sentinelDriverDays record using
// per-driver baselines (when available) instead of static thresholds.
//
// GET /api/sentinel-rescore-all?secret=davis2026sentinel
//
// For each record:
//   1. Look up its driver's baseline.
//   2. For morning / afternoon / in-route metrics, try classifyAgainstBaseline.
//      If the baseline returns null (n<5 or p90<=0), fall back to static.
//   3. Stolen-minute attribution becomes excessOverMedian when baseline used,
//      otherwise (value - staticOk).
//   4. Rebuild flags[] with new evidence including
//      "P50 X / P90 Y / today P75-P90 / excess Zmin".
//   5. Preserve Motive post_route detour text from the prior afternoon-gap
//      flag evidence (regex /Motive shows detour[^.]*\./).
//   6. Recompute riskScore (cap at 100), riskLevel, stolenMinutes, stolenDollars.

import { getDb } from './_firebase-admin.js';
import { classifyAgainstBaseline, excessOverMedian, percentileBucket } from './_baselines.js';

const VERSION = 'v4.1.0-phase3c';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

const DEFAULT_DEFAULTS = {
  loadPrepMin: 15,
  wrapUpMin: 15,
  wageRates: { tractor: 27.50, straight: 23.00, unknown: 25.00 },
  morningGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  afternoonGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  inRouteStaticThresholds: { ok: 15, warn: 30, flag: 60 }
};

const FLAG_TO_SCORE = { ok: 0, warn: 10, flag: 25, critical: 40, no_data: 0, deferred: 0 };

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

function classifyStatic(value, t) {
  if (value == null) return 'no_data';
  if (value <= t.ok) return 'ok';
  if (value <= t.warn) return 'warn';
  if (value <= t.flag) return 'flag';
  return 'critical';
}

function riskLevelOf(score) {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 25) return 'medium';
  if (score >= 10) return 'low';
  return 'clean';
}

function fmtTime(iso) {
  return iso ? String(iso).slice(11, 16) : '—';
}

// Extract any "Motive shows detour ... ." sentence from the prior afternoon-gap
// flag evidence so the operator doesn't lose that context after rescore.
function extractDetourNote(record) {
  const prior = (record.flags || []).find(f => f.kind === 'afternoon_gap');
  if (!prior || !prior.evidence) return null;
  const m = String(prior.evidence).match(/Motive shows detour[^.]*\./);
  return m ? m[0] : null;
}

function buildEvidenceMorning({ record, defaults, severity, source, dist, gap }) {
  const customer = record.firstDeliveryCustomer || 'unknown';
  const timeStr = fmtTime(record.firstDeliveryTime);
  const travel = record.expectedTravelMinToFirst;
  const prep = record.loadPrepMin ?? defaults.loadPrepMin;
  const expectedTotal = (travel != null) ? travel + prep : null;
  const prefix = `clockIn ${record.clockIn} → first delivery ${customer} at ${timeStr} (${record.clockInToFirstMin} min).`;
  if (source === 'baseline' && dist) {
    const bucket = percentileBucket(gap, dist);
    const excess = excessOverMedian(gap, dist);
    return `${prefix} Today's morning gap: ${gap} min. Your baseline P50 ${dist.p50}min / P90 ${dist.p90}min — today ${bucket || '?'} / excess over median ${excess}min.`;
  }
  // static fallback — preserve the existing engine evidence shape
  const expectedStr = expectedTotal != null ? `Expected travel ${travel} min + ${prep} min load prep = ${expectedTotal} min.` : '';
  return `${prefix} ${expectedStr} Unexplained: ${gap} min. (static threshold)`;
}

function buildEvidenceAfternoon({ record, defaults, severity, source, dist, gap }) {
  const customer = record.lastDeliveryCustomer || 'unknown';
  const timeStr = fmtTime(record.lastDeliveryTime);
  const travel = record.expectedTravelMinFromLast;
  const wrap = record.wrapUpMin ?? defaults.wrapUpMin;
  const expectedTotal = (travel != null) ? travel + wrap : null;
  const prefix = `last delivery ${customer} at ${timeStr} → clockOut ${record.clockOut} (${record.lastToClockOutMin} min).`;
  if (source === 'baseline' && dist) {
    const bucket = percentileBucket(gap, dist);
    const excess = excessOverMedian(gap, dist);
    return `${prefix} Today's afternoon gap: ${gap} min. Your baseline P50 ${dist.p50}min / P90 ${dist.p90}min — today ${bucket || '?'} / excess over median ${excess}min.`;
  }
  const expectedStr = expectedTotal != null ? `Expected return travel ${travel} min + ${wrap} min wrap-up = ${expectedTotal} min.` : '';
  return `${prefix} ${expectedStr} Unexplained: ${gap} min. (static threshold)`;
}

function buildEvidenceInRoute({ record, source, dist, value }) {
  const visits = record?.motive?.offRouteVisits || [];
  const inRouteVisits = visits.filter(v => v.window === 'in_route');
  const locations = inRouteVisits
    .map(v => `${v.destZip || '?'}${v.stationaryMin > 0 ? ` (${v.stationaryMin}min stop)` : ''}`)
    .join(', ');
  const locStr = locations ? ` Locations: ${locations}.` : '';
  const prefix = `${value} min of off-route activity between first and last delivery.${locStr}`;
  if (source === 'baseline' && dist) {
    const bucket = percentileBucket(value, dist);
    const excess = excessOverMedian(value, dist);
    return `${prefix} Your baseline P50 ${dist.p50}min / P90 ${dist.p90}min — today ${bucket || '?'} / excess over median ${excess}min.`;
  }
  return `${prefix} (static threshold)`;
}

// Re-score one record against its baseline + defaults.
// Returns the new record (mutated copy), plus per-flag source counters.
function rescoreOne(record, baseline, defaults) {
  const next = { ...record };
  const sourceCounts = { baseline: 0, static: 0 };

  const detourNote = extractDetourNote(record);

  // Start fresh on derived fields
  next.flags = [];
  next.morningSeveritySource = 'static';
  next.afternoonSeveritySource = 'static';
  next.inRouteSeveritySource = 'static';

  const morningT = defaults.morningGapStaticThresholds;
  const afternoonT = defaults.afternoonGapStaticThresholds;
  const inRouteT = defaults.inRouteStaticThresholds;

  let stolen = 0;

  // ---------- Morning ----------
  let morningFlag = 'no_data';
  if (record.morningGapMin != null) {
    const dist = baseline?.metrics?.morningGapMin;
    const baseClass = classifyAgainstBaseline(record.morningGapMin, dist);
    if (baseClass != null) {
      morningFlag = baseClass;
      next.morningSeveritySource = 'baseline';
      sourceCounts.baseline++;
      const excess = excessOverMedian(record.morningGapMin, dist);
      stolen += excess;
      if (morningFlag !== 'ok') {
        next.flags.push({
          kind: 'morning_gap',
          severity: morningFlag,
          severitySource: 'baseline',
          evidence: buildEvidenceMorning({ record, defaults, severity: morningFlag, source: 'baseline', dist, gap: record.morningGapMin }),
          deltaMin: record.morningGapMin
        });
      }
    } else {
      morningFlag = classifyStatic(record.morningGapMin, morningT);
      next.morningSeveritySource = 'static';
      sourceCounts.static++;
      const excess = Math.max(0, record.morningGapMin - morningT.ok);
      stolen += excess;
      if (morningFlag !== 'ok' && morningFlag !== 'no_data') {
        next.flags.push({
          kind: 'morning_gap',
          severity: morningFlag,
          severitySource: 'static',
          evidence: buildEvidenceMorning({ record, defaults, severity: morningFlag, source: 'static', dist: null, gap: record.morningGapMin }),
          deltaMin: record.morningGapMin
        });
      }
    }
  }
  next.morningFlag = morningFlag;

  // ---------- Afternoon ----------
  let afternoonFlag = 'no_data';
  if (record.afternoonGapMin != null) {
    const dist = baseline?.metrics?.afternoonGapMin;
    const baseClass = classifyAgainstBaseline(record.afternoonGapMin, dist);
    if (baseClass != null) {
      afternoonFlag = baseClass;
      next.afternoonSeveritySource = 'baseline';
      sourceCounts.baseline++;
      const excess = excessOverMedian(record.afternoonGapMin, dist);
      stolen += excess;
      if (afternoonFlag !== 'ok') {
        let ev = buildEvidenceAfternoon({ record, defaults, severity: afternoonFlag, source: 'baseline', dist, gap: record.afternoonGapMin });
        if (detourNote) ev += ' ' + detourNote;
        next.flags.push({
          kind: 'afternoon_gap',
          severity: afternoonFlag,
          severitySource: 'baseline',
          evidence: ev,
          deltaMin: record.afternoonGapMin
        });
      }
    } else {
      afternoonFlag = classifyStatic(record.afternoonGapMin, afternoonT);
      next.afternoonSeveritySource = 'static';
      sourceCounts.static++;
      const excess = Math.max(0, record.afternoonGapMin - afternoonT.ok);
      stolen += excess;
      if (afternoonFlag !== 'ok' && afternoonFlag !== 'no_data') {
        let ev = buildEvidenceAfternoon({ record, defaults, severity: afternoonFlag, source: 'static', dist: null, gap: record.afternoonGapMin });
        if (detourNote) ev += ' ' + detourNote;
        next.flags.push({
          kind: 'afternoon_gap',
          severity: afternoonFlag,
          severitySource: 'static',
          evidence: ev,
          deltaMin: record.afternoonGapMin
        });
      }
    }
  }
  next.afternoonFlag = afternoonFlag;

  // ---------- In-route ----------
  let inRouteFlag = record.inRouteFlag || 'deferred';
  if (record.inRouteOffRouteMin != null) {
    const dist = baseline?.metrics?.inRouteOffRouteMin;
    const baseClass = classifyAgainstBaseline(record.inRouteOffRouteMin, dist);
    if (baseClass != null) {
      inRouteFlag = baseClass;
      next.inRouteSeveritySource = 'baseline';
      sourceCounts.baseline++;
      const excess = excessOverMedian(record.inRouteOffRouteMin, dist);
      stolen += excess;
      if (inRouteFlag !== 'ok') {
        next.flags.push({
          kind: 'in_route_off_route',
          severity: inRouteFlag,
          severitySource: 'baseline',
          evidence: buildEvidenceInRoute({ record, source: 'baseline', dist, value: record.inRouteOffRouteMin }),
          deltaMin: record.inRouteOffRouteMin
        });
      }
    } else {
      inRouteFlag = classifyStatic(record.inRouteOffRouteMin, inRouteT);
      next.inRouteSeveritySource = 'static';
      sourceCounts.static++;
      const excess = Math.max(0, record.inRouteOffRouteMin - inRouteT.ok);
      stolen += excess;
      if (inRouteFlag !== 'ok' && inRouteFlag !== 'no_data') {
        next.flags.push({
          kind: 'in_route_off_route',
          severity: inRouteFlag,
          severitySource: 'static',
          evidence: buildEvidenceInRoute({ record, source: 'static', dist: null, value: record.inRouteOffRouteMin }),
          deltaMin: record.inRouteOffRouteMin
        });
      }
    }
  }
  next.inRouteFlag = inRouteFlag;

  // ---------- Composite ----------
  let score = 0;
  score += FLAG_TO_SCORE[morningFlag] || 0;
  score += FLAG_TO_SCORE[afternoonFlag] || 0;
  score += FLAG_TO_SCORE[inRouteFlag] || 0;
  if (score > 100) score = 100;
  next.riskScore = score;
  next.riskLevel = riskLevelOf(score);

  next.stolenMinutes = stolen;
  const wage = (defaults.wageRates[record.truckType] != null)
    ? defaults.wageRates[record.truckType]
    : defaults.wageRates.unknown;
  next.stolenDollars = +((stolen / 60) * wage).toFixed(2);

  next.lastUpdated = new Date().toISOString();
  next.version = VERSION;

  return { next, sourceCounts };
}

async function loadAllBaselines(db) {
  const rows = await db.listDocs('sentinelBaselines', { limit: 500 });
  const bySlug = {};
  for (const r of rows) {
    if (r.driverSlug) bySlug[r.driverSlug] = r;
    else if (r.id) bySlug[r.id] = r;
  }
  return bySlug;
}

async function loadDefaults(db) {
  try {
    const doc = await db.getDoc('sentinelConfig', 'defaults');
    if (doc) return { ...DEFAULT_DEFAULTS, ...doc };
  } catch (_) {}
  return DEFAULT_DEFAULTS;
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

    const [records, baselines, defaults] = await Promise.all([
      db.listDocs('sentinelDriverDays', { limit: 1000 }),
      loadAllBaselines(db),
      loadDefaults(db)
    ]);

    const totals = {
      rescored: 0,
      baselineUsed: 0,
      staticFallback: 0,
      levelChanges: {},
      totalStolen: { before: 0, after: 0, delta: 0 }
    };

    // Process in 20-way parallel batches
    const BATCH = 20;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(r => {
        const baseline = baselines[r.driverSlug] || null;
        const { next, sourceCounts } = rescoreOne(r, baseline, defaults);
        // Track totals before doing the write
        const beforeLevel = r.riskLevel || 'clean';
        const afterLevel = next.riskLevel;
        const beforeStolen = r.stolenDollars || 0;
        const afterStolen = next.stolenDollars || 0;
        return db.setDoc('sentinelDriverDays', next._id, next)
          .then(() => ({ beforeLevel, afterLevel, beforeStolen, afterStolen, sourceCounts }));
      }));
      for (const res of results) {
        if (res.status !== 'fulfilled') {
          console.error('[rescore-all] write failed:', res.reason?.message || res.reason);
          continue;
        }
        const { beforeLevel, afterLevel, beforeStolen, afterStolen, sourceCounts } = res.value;
        totals.rescored++;
        totals.baselineUsed += sourceCounts.baseline;
        totals.staticFallback += sourceCounts.static;
        totals.totalStolen.before += beforeStolen;
        totals.totalStolen.after += afterStolen;
        if (beforeLevel !== afterLevel) {
          const key = `${beforeLevel}→${afterLevel}`;
          totals.levelChanges[key] = (totals.levelChanges[key] || 0) + 1;
        }
      }
    }

    totals.totalStolen.before = +totals.totalStolen.before.toFixed(2);
    totals.totalStolen.after = +totals.totalStolen.after.toFixed(2);
    totals.totalStolen.delta = +(totals.totalStolen.after - totals.totalStolen.before).toFixed(2);

    return new Response(JSON.stringify({
      version: VERSION,
      ok: true,
      wallMs: Date.now() - t0,
      recordsScanned: records.length,
      baselinesLoaded: Object.keys(baselines).length,
      ...totals
    }, null, 2), { status: 200, headers: CORS });
  } catch (err) {
    console.error('[sentinel-rescore-all]', err);
    return new Response(JSON.stringify({
      error: err.message,
      stack: err.stack?.slice(0, 800)
    }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-rescore-all' };
