// netlify/functions/_sentinel-rescore.js
// Shared rescore engine — extracted from sentinel-rescore-all.js so the
// new background worker (sentinel-rescore-all-background.js) and any
// future single-record rescore caller share one classification path.
//
// Pure logic: takes a record + baseline + defaults, returns the rewritten
// record and source counters. No Firestore I/O in here.
//
// Exports:
//   rescoreOne(record, baseline, defaults)  → { next, sourceCounts }
//   loadAllBaselines(db)                    → { [driverSlug]: baselineDoc }
//   loadDefaults(db)                        → defaults object
//   DEFAULT_DEFAULTS                        → fallback when sentinelConfig/defaults missing
//   ENGINE_VERSION                          → stamped into rescored records

import { classifyAgainstBaseline, excessOverMedian, excessOverP75, percentileBucket } from './_baselines.js';

export const ENGINE_VERSION = 'v4.1.4-attribution';

export const DEFAULT_DEFAULTS = {
  loadPrepMin: 15,
  wrapUpMin: 15,
  wageRates: { tractor: 27.50, straight: 23.00, unknown: 25.00 },
  morningGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  afternoonGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  inRouteStaticThresholds: { ok: 15, warn: 30, flag: 60 }
};

const FLAG_TO_SCORE = { ok: 0, warn: 10, flag: 25, critical: 40, no_data: 0, deferred: 0 };

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

// Preserve any "Motive shows detour ... ." sentence from the prior
// afternoon-gap evidence so the operator doesn't lose that context after rescore.
function extractDetourNote(record) {
  const prior = (record.flags || []).find(f => f.kind === 'afternoon_gap');
  if (!prior || !prior.evidence) return null;
  const m = String(prior.evidence).match(/Motive shows detour[^.]*\./);
  return m ? m[0] : null;
}

function buildEvidenceMorning({ record, defaults, source, dist, gap }) {
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
  const expectedStr = expectedTotal != null ? `Expected travel ${travel} min + ${prep} min load prep = ${expectedTotal} min.` : '';
  return `${prefix} ${expectedStr} Unexplained: ${gap} min. (static threshold)`;
}

function buildEvidenceAfternoon({ record, defaults, source, dist, gap }) {
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

// Re-score one record against its baseline + defaults. Pure: no I/O.
// Returns the new record (shallow copy) plus per-flag source counters.
export function rescoreOne(record, baseline, defaults) {
  const next = { ...record };
  const sourceCounts = { baseline: 0, static: 0 };

  const detourNote = extractDetourNote(record);

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
      // Anchor attribution at P75 — same boundary classifyAgainstBaseline uses
      // to call a day "ok". Result: ok days contribute 0, only warn/flag/critical
      // days add to stolen total.
      stolen += excessOverP75(record.morningGapMin, dist);
      if (morningFlag !== 'ok') {
        next.flags.push({
          kind: 'morning_gap',
          severity: morningFlag,
          severitySource: 'baseline',
          evidence: buildEvidenceMorning({ record, defaults, source: 'baseline', dist, gap: record.morningGapMin }),
          deltaMin: record.morningGapMin
        });
      }
    } else {
      morningFlag = classifyStatic(record.morningGapMin, morningT);
      next.morningSeveritySource = 'static';
      sourceCounts.static++;
      // Static fallback also uses the warn boundary (not ok) — matches the
      // baseline-path P75 alignment: a day classified static "ok" contributes 0.
      stolen += Math.max(0, record.morningGapMin - morningT.warn);
      if (morningFlag !== 'ok' && morningFlag !== 'no_data') {
        next.flags.push({
          kind: 'morning_gap',
          severity: morningFlag,
          severitySource: 'static',
          evidence: buildEvidenceMorning({ record, defaults, source: 'static', dist: null, gap: record.morningGapMin }),
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
      stolen += excessOverP75(record.afternoonGapMin, dist);
      if (afternoonFlag !== 'ok') {
        let ev = buildEvidenceAfternoon({ record, defaults, source: 'baseline', dist, gap: record.afternoonGapMin });
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
      stolen += Math.max(0, record.afternoonGapMin - afternoonT.warn);
      if (afternoonFlag !== 'ok' && afternoonFlag !== 'no_data') {
        let ev = buildEvidenceAfternoon({ record, defaults, source: 'static', dist: null, gap: record.afternoonGapMin });
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
      stolen += excessOverP75(record.inRouteOffRouteMin, dist);
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
      stolen += Math.max(0, record.inRouteOffRouteMin - inRouteT.warn);
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
  next.version = ENGINE_VERSION;

  return { next, sourceCounts };
}

export async function loadAllBaselines(db) {
  const rows = await db.listDocs('sentinelBaselines', { limit: 500 });
  const bySlug = {};
  for (const r of rows) {
    if (r.driverSlug) bySlug[r.driverSlug] = r;
    else if (r.id) bySlug[r.id] = r;
  }
  return bySlug;
}

export async function loadDefaults(db) {
  try {
    const doc = await db.getDoc('sentinelConfig', 'defaults');
    if (doc) return { ...DEFAULT_DEFAULTS, ...doc };
  } catch (_) {}
  return DEFAULT_DEFAULTS;
}
