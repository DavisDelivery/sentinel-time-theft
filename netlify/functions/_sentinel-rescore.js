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

// Static-only fraud detection (v4.5.0). Baselines remain in _baselines.js for
// the driver-detail "Your Typical Day" context card, but the engine no longer
// consumes them — fraud is judged against a fixed threshold the same for every
// driver. Median / P75 / P90 are coaching context ("worse day than usual"),
// not a moving goalpost for theft.
//
// v4.3.0 added per-driver loadPrepMin / wrapUpMin overrides sourced from
// /employees/{slug}. v4.3.1 extended the override path to truckType. v4.5.0
// only changes the cosmetics — evidence-string clock times now render in
// 12-hour am/pm format ("clockIn 5:54am → first delivery at 8:35am") instead
// of the 24-hour HH:MM that previously matched the silently-stripped UI
// output. Math is unchanged; rescore restamps every record so historical
// evidence picks up the new format.

export const ENGINE_VERSION = 'v4.5.0-driver-detail-polish';

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

// 12-hour clock formatter for evidence strings. Same conversion as the UI's
// fmtClockTime — kept local to the engine so this module stays self-contained
// and doesn't need to import a shared helper. Engine math is unchanged; this
// is display-only formatting baked into the persisted evidence string.
function fmtTime(input) {
  if (input == null) return '—';
  const s = String(input).trim();
  if (!s) return '—';
  const nuvizz = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)\b/i);
  if (nuvizz) {
    let hh = parseInt(nuvizz[1], 10);
    const mm = nuvizz[2];
    const suf = nuvizz[3].toUpperCase() === 'PM' ? 'pm' : 'am';
    if (hh === 0) hh = 12;
    return `${hh}:${mm}${suf}`;
  }
  let hhmm = s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) hhmm = s.slice(11, 16);
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '—';
  const h24 = parseInt(m[1], 10);
  const mm = m[2];
  if (!Number.isFinite(h24) || h24 < 0 || h24 > 23) return '—';
  const suf = h24 >= 12 ? 'pm' : 'am';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${mm}${suf}`;
}

// Preserve any "Motive shows detour ... ." sentence from the prior
// afternoon-gap evidence so the operator doesn't lose that context after rescore.
function extractDetourNote(record) {
  const prior = (record.flags || []).find(f => f.kind === 'afternoon_gap');
  if (!prior || !prior.evidence) return null;
  const m = String(prior.evidence).match(/Motive shows detour[^.]*\./);
  return m ? m[0] : null;
}

function buildEvidenceMorning({ record, prep, gap }) {
  const customer = record.firstDeliveryCustomer || 'unknown';
  const timeStr = fmtTime(record.firstDeliveryTime);
  const travel = record.expectedTravelMinToFirst;
  const expectedTotal = (travel != null) ? travel + prep : null;
  const prefix = `clockIn ${fmtTime(record.clockIn)} → first delivery ${customer} at ${timeStr} (${fmtDur(record.clockInToFirstMin)}).`;
  const expectedStr = expectedTotal != null ? `Expected travel ${fmtDur(travel)} + ${fmtDur(prep)} load prep = ${fmtDur(expectedTotal)}.` : '';
  return `${prefix} ${expectedStr} Unexplained: ${fmtDur(gap)}. (static threshold)`;
}

function buildEvidenceAfternoon({ record, wrap, gap }) {
  const customer = record.lastDeliveryCustomer || 'unknown';
  const timeStr = fmtTime(record.lastDeliveryTime);
  const travel = record.expectedTravelMinFromLast;
  const expectedTotal = (travel != null) ? travel + wrap : null;
  const prefix = `last delivery ${customer} at ${timeStr} → clockOut ${fmtTime(record.clockOut)} (${fmtDur(record.lastToClockOutMin)}).`;
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

// Resolve a per-driver override against defaults. Numeric, non-negative,
// finite; anything else falls back. Matches _sentinel-engine.resolveOverride.
function resolveOverride(employee, defaults, key) {
  const ov = employee?.[key];
  if (typeof ov === 'number' && Number.isFinite(ov) && ov >= 0) return ov;
  return defaults[key];
}

// Re-score one record against the current defaults + per-driver employee
// overrides. Pure: no I/O. `employee` may be null when the employee doc was
// missing (rare — typically a driverSlug that has historical days but was
// removed from the roster); in that case overrides default to defaults.
// Returns the new record (shallow copy) plus per-flag source counters.
export function rescoreOne(record, baseline, defaults, employee = null) {
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

  // Always derive from the current employee config + defaults — the value
  // baked into the record at scan time may be stale relative to a roster
  // edit since. Stamp the value used so the record self-documents.
  const loadPrep = resolveOverride(employee, defaults, 'loadPrepMin');
  const wrapUp = resolveOverride(employee, defaults, 'wrapUpMin');
  next.loadPrepMin = loadPrep;
  next.wrapUpMin = wrapUp;

  // Truck-type override: if /employees has a per-driver truckType (operator-
  // set via Driver Config), prefer it over the record's stamped value. Wage
  // attribution downstream uses next.truckType, so this is what makes a
  // mid-stream "this driver actually drives a tractor" edit flow into the
  // historical stolen$ calculation on the next rescore.
  if (employee?.truckType === 'tractor' || employee?.truckType === 'straight') {
    next.truckType = employee.truckType;
  }

  // Re-derive gaps from raw inputs. If the raw inputs aren't present
  // (e.g. no first-delivery time → clockInToFirstMin null), gap is null and
  // the flag stays no_data. A NEGATIVE anchor delta (first delivery before
  // clock-in, or last delivery after clock-out) is a data-integrity case the
  // engine deliberately suppresses to no_data at scan time — mirror that here
  // so a rescore doesn't resurrect it as a bogus "ok" and lose the dataHealth
  // signal.
  const reMorningGap = (record.clockInToFirstMin != null && record.clockInToFirstMin >= 0 && record.expectedTravelMinToFirst != null)
    ? record.clockInToFirstMin - record.expectedTravelMinToFirst - loadPrep
    : null;
  const reAfternoonGap = (record.lastToClockOutMin != null && record.lastToClockOutMin >= 0 && record.expectedTravelMinFromLast != null)
    ? record.lastToClockOutMin - record.expectedTravelMinFromLast - wrapUp
    : null;
  next.morningGapMin = reMorningGap;
  next.afternoonGapMin = reAfternoonGap;

  let stolen = 0;

  // ---------- Morning ----------
  // Fraud is judged absolutely: anything above the static `ok` threshold is
  // unexplained, regardless of the driver's own historical pattern.
  let morningFlag = 'no_data';
  if (reMorningGap != null) {
    morningFlag = classifyStatic(reMorningGap, morningT);
    next.morningSeveritySource = 'static';
    sourceCounts.static++;
    stolen += Math.max(0, reMorningGap - morningT.ok);
    if (morningFlag !== 'ok' && morningFlag !== 'no_data') {
      next.flags.push({
        kind: 'morning_gap',
        severity: morningFlag,
        severitySource: 'static',
        evidence: buildEvidenceMorning({ record, prep: loadPrep, gap: reMorningGap }),
        deltaMin: reMorningGap
      });
    }
  }
  next.morningFlag = morningFlag;

  // ---------- Afternoon ----------
  let afternoonFlag = 'no_data';
  if (reAfternoonGap != null) {
    afternoonFlag = classifyStatic(reAfternoonGap, afternoonT);
    next.afternoonSeveritySource = 'static';
    sourceCounts.static++;
    stolen += Math.max(0, reAfternoonGap - afternoonT.ok);
    if (afternoonFlag !== 'ok' && afternoonFlag !== 'no_data') {
      let ev = buildEvidenceAfternoon({ record, wrap: wrapUp, gap: reAfternoonGap });
      if (detourNote) ev += ' ' + detourNote;
      next.flags.push({
        kind: 'afternoon_gap',
        severity: afternoonFlag,
        severitySource: 'static',
        evidence: ev,
        deltaMin: reAfternoonGap
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
  const wage = (defaults.wageRates[next.truckType] != null)
    ? defaults.wageRates[next.truckType]
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

// Deep-merge an operator-edited defaults doc over DEFAULT_DEFAULTS so a partial
// nested object (e.g. wageRates with only `tractor`) keeps the default sub-keys
// instead of replacing the whole object — a missing wage would otherwise make
// stolenDollars NaN for the affected truck type.
function mergeDefaults(doc) {
  const merged = { ...DEFAULT_DEFAULTS, ...doc };
  for (const [key, value] of Object.entries(DEFAULT_DEFAULTS)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && doc[key] && typeof doc[key] === 'object' && !Array.isArray(doc[key])) {
      merged[key] = { ...value, ...doc[key] };
    }
  }
  return merged;
}

export async function loadDefaults(db) {
  try {
    const doc = await db.getDoc('sentinelConfig', 'defaults');
    if (doc) return mergeDefaults(doc);
  } catch (_) {}
  return DEFAULT_DEFAULTS;
}
