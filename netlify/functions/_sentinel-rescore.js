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

// Static-only fraud detection (v4.2.3). Baselines remain in _baselines.js for
// the driver-detail "Your Typical Day" context card, but the engine no longer
// consumes them — fraud is judged against a fixed threshold the same for every
// driver. Median / P75 / P90 are coaching context ("worse day than usual"),
// not a moving goalpost for theft.

export const ENGINE_VERSION = 'v4.2.3-static-fraud';

// Operator-facing duration formatter — matches the dashboard's fmtDur.
//   null/undefined/NaN → "—"
//   0..59 min          → "5m"
//   exact hours        → "2h"
//   otherwise          → "1h 40m"
// Every evidence string now stamps "1h 40m" instead of "100 min".
function fmtDur(m) {
  if (m == null || !Number.isFinite(+m)) return '—';
  const total = Math.max(0, Math.round(+m));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

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

function buildEvidenceMorning({ record, defaults, gap }) {
  const customer = record.firstDeliveryCustomer || 'unknown';
  const timeStr = fmtTime(record.firstDeliveryTime);
  const travel = record.expectedTravelMinToFirst;
  const prep = record.loadPrepMin ?? defaults.loadPrepMin;
  const expectedTotal = (travel != null) ? travel + prep : null;
  const prefix = `clockIn ${record.clockIn} → first delivery ${customer} at ${timeStr} (${fmtDur(record.clockInToFirstMin)}).`;
  const expectedStr = expectedTotal != null ? `Expected travel ${fmtDur(travel)} + ${fmtDur(prep)} load prep = ${fmtDur(expectedTotal)}.` : '';
  return `${prefix} ${expectedStr} Unexplained: ${fmtDur(gap)}. (static threshold)`;
}

function buildEvidenceAfternoon({ record, defaults, gap }) {
  const customer = record.lastDeliveryCustomer || 'unknown';
  const timeStr = fmtTime(record.lastDeliveryTime);
  const travel = record.expectedTravelMinFromLast;
  const wrap = record.wrapUpMin ?? defaults.wrapUpMin;
  const expectedTotal = (travel != null) ? travel + wrap : null;
  const prefix = `last delivery ${customer} at ${timeStr} → clockOut ${record.clockOut} (${fmtDur(record.lastToClockOutMin)}).`;
  const expectedStr = expectedTotal != null ? `Expected return travel ${fmtDur(travel)} + ${fmtDur(wrap)} wrap-up = ${fmtDur(expectedTotal)}.` : '';
  return `${prefix} ${expectedStr} Unexplained: ${fmtDur(gap)}. (static threshold)`;
}

function buildEvidenceInRoute({ record, value }) {
  const visits = record?.motive?.offRouteVisits || [];
  const inRouteVisits = visits.filter(v => v.window === 'in_route');
  const locations = inRouteVisits
    .map(v => `${v.destZip || '?'}${v.stationaryMin > 0 ? ` (${fmtDur(v.stationaryMin)} stop)` : ''}`)
    .join(', ');
  const locStr = locations ? ` Locations: ${locations}.` : '';
  return `${fmtDur(value)} of off-route activity between first and last delivery.${locStr} (static threshold)`;
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
  // Fraud is judged absolutely: anything above the static `ok` threshold is
  // unexplained, regardless of the driver's own historical pattern.
  let morningFlag = 'no_data';
  if (record.morningGapMin != null) {
    morningFlag = classifyStatic(record.morningGapMin, morningT);
    next.morningSeveritySource = 'static';
    sourceCounts.static++;
    stolen += Math.max(0, record.morningGapMin - morningT.ok);
    if (morningFlag !== 'ok' && morningFlag !== 'no_data') {
      next.flags.push({
        kind: 'morning_gap',
        severity: morningFlag,
        severitySource: 'static',
        evidence: buildEvidenceMorning({ record, defaults, gap: record.morningGapMin }),
        deltaMin: record.morningGapMin
      });
    }
  }
  next.morningFlag = morningFlag;

  // ---------- Afternoon ----------
  let afternoonFlag = 'no_data';
  if (record.afternoonGapMin != null) {
    afternoonFlag = classifyStatic(record.afternoonGapMin, afternoonT);
    next.afternoonSeveritySource = 'static';
    sourceCounts.static++;
    stolen += Math.max(0, record.afternoonGapMin - afternoonT.ok);
    if (afternoonFlag !== 'ok' && afternoonFlag !== 'no_data') {
      let ev = buildEvidenceAfternoon({ record, defaults, gap: record.afternoonGapMin });
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
  next.afternoonFlag = afternoonFlag;

  // ---------- In-route ----------
  let inRouteFlag = record.inRouteFlag || 'deferred';
  if (record.inRouteOffRouteMin != null) {
    inRouteFlag = classifyStatic(record.inRouteOffRouteMin, inRouteT);
    next.inRouteSeveritySource = 'static';
    sourceCounts.static++;
    stolen += Math.max(0, record.inRouteOffRouteMin - inRouteT.ok);
    if (inRouteFlag !== 'ok' && inRouteFlag !== 'no_data') {
      next.flags.push({
        kind: 'in_route_off_route',
        severity: inRouteFlag,
        severitySource: 'static',
        evidence: buildEvidenceInRoute({ record, value: record.inRouteOffRouteMin }),
        deltaMin: record.inRouteOffRouteMin
      });
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
