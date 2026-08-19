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

import { scrubEvidenceText } from './_privacy.js';

export const ENGINE_VERSION = 'v5.0.0-detection-integrity';

// Dual-source travel gating + prep credit — keep in sync with
// _sentinel-scan.js / _sentinel-engine.js (this module is deliberately
// import-free / self-contained).
const MOTIVE_FLOOR_RATIO = 0.5;    // D6: Motive below half of Google typical = partial GPS → use Google
const SLOW_ROLL_RATIO = 1.5;       // D4: credit GPS drive only up to 1.5× typical…
const SLOW_ROLL_GRACE_MIN = 10;    //     …or typical + 10 min, whichever is larger
const MIN_PREP_CREDIT_MIN = 10;    // D7: never charge prep credit below a pre-trip-inspection floor

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
// Historical records carry the pre-#41 wording with a ZIP in it; scrub before
// carrying it forward, otherwise a rescore would write locations back into a
// record the read path is busy stripping them out of.
function extractDetourNote(record) {
  const prior = (record.flags || []).find(f => f.kind === 'afternoon_gap');
  if (!prior || !prior.evidence) return null;
  const m = String(prior.evidence).match(/Motive shows (?:detour|an off-route detour)[^.]*\./);
  return m ? scrubEvidenceText(m[0]) : null;
}

// Label for which source set the expected travel time on a stored record.
function travelSrcLabel(src) {
  if (src === 'motive') return ' (Motive GPS)';
  if (src === 'motive_capped') return ' (Motive GPS, capped at typical +50%)';
  if (src === 'google' || src === 'cache' || src === 'api') return ' (Google typical)';
  return '';
}

// D4/D6: re-derive the effective expected travel for one leg from the stored
// dual-source figures, mirroring the scan's pickLeg. Legacy records
// (pre-dual-source: neither google* nor motive* stored) keep their stored
// effective value untouched — returns null to signal "no re-derivation".
function reEffectiveTravel(record, googleKey, motiveKey, periodsKey) {
  const google = (typeof record[googleKey] === 'number') ? record[googleKey] : null;
  const motive = (typeof record[motiveKey] === 'number') ? record[motiveKey] : null;
  if (google == null && motive == null) return null;
  const routeMatch = record.motive?.routeMatch === true;
  const periods = record.motive?.[periodsKey];
  // Older dual-source records don't store the period count — require a
  // positive drive figure in that case (the scan only trusts legs with ≥1
  // overlapping period, and 0-period legs store 0 minutes).
  const motiveUsable = routeMatch && motive != null && (periods == null ? motive > 0 : periods > 0);
  if (motiveUsable) {
    if (google == null) return { minutes: motive, source: 'motive' };
    if (motive < google * MOTIVE_FLOOR_RATIO) return { minutes: google, source: 'google' };
    const cap = Math.max(Math.round(google * SLOW_ROLL_RATIO), google + SLOW_ROLL_GRACE_MIN);
    if (motive > cap) return { minutes: cap, source: 'motive_capped' };
    return { minutes: motive, source: 'motive' };
  }
  if (google != null) return { minutes: google, source: 'google' };
  return { minutes: null, source: 'none' };
}

// D2/D3: review-band derivation — mirrored from _sentinel-engine.applyReviewBand
// (kept local: this module is import-free by design). Routes unscoreable-but-
// not-empty days to 'review' instead of 'clean'; never overrides a real charge.
function applyReviewBand(rec, { expectPunch = true } = {}) {
  const SCORED = ['ok', 'warn', 'flag', 'critical'];
  const reasons = [];
  if (rec.nuvizzMatched && !rec.b600Matched && expectPunch) reasons.push('no_punch_with_deliveries');
  if (rec.b600Matched && !rec.nuvizzMatched) reasons.push('punch_without_deliveries');
  if (rec.b600Matched && rec.nuvizzMatched
      && !SCORED.includes(rec.morningFlag)
      && !SCORED.includes(rec.afternoonFlag)
      && !SCORED.includes(rec.inRouteFlag)) {
    const dh = rec.dataHealth || [];
    const anchorBroken = dh.includes('first_delivery_before_clockin')
      || dh.includes('last_delivery_after_clockout_unfiltered')
      || dh.includes('shift_negative_clockout_before_clockin');
    reasons.push(anchorBroken ? 'anchor_anomaly' : 'no_travel_data');
  }
  rec.reviewReasons = reasons;
  if (reasons.length > 0 && (rec.riskScore || 0) === 0
      && (rec.riskLevel === 'clean' || rec.riskLevel == null)) {
    rec.riskLevel = 'review';
  }
  return rec;
}

function buildEvidenceMorning({ record, prep, gap }) {
  const customer = record.firstDeliveryCustomer || 'unknown';
  const timeStr = fmtTime(record.firstDeliveryTime);
  const travel = record.expectedTravelMinToFirst;
  const src = travelSrcLabel(record.travelSourceToFirst || record.expectedTravelMinToFirstSource);
  const expectedTotal = (travel != null) ? travel + prep : null;
  const prepLbl = record.loadPrepSource === 'measured'
    ? ` load prep (GPS-measured; allowance ${fmtDur(record.loadPrepAllowanceMin)})`
    : ' load prep';
  const prefix = `clockIn ${fmtTime(record.clockIn)} → first delivery ${customer} at ${timeStr} (${fmtDur(record.clockInToFirstMin)}).`;
  const expectedStr = expectedTotal != null ? `Expected travel ${fmtDur(travel)}${src} + ${fmtDur(prep)}${prepLbl} = ${fmtDur(expectedTotal)}.` : '';
  return `${prefix} ${expectedStr} Unexplained: ${fmtDur(gap)}. (static threshold)`;
}

function buildEvidenceAfternoon({ record, wrap, gap }) {
  const customer = record.lastDeliveryCustomer || 'unknown';
  const timeStr = fmtTime(record.lastDeliveryTime);
  const travel = record.expectedTravelMinFromLast;
  const src = travelSrcLabel(record.travelSourceFromLast || record.expectedTravelMinFromLastSource);
  const expectedTotal = (travel != null) ? travel + wrap : null;
  const prefix = `last delivery ${customer} at ${timeStr} → clockOut ${fmtTime(record.clockOut)} (${fmtDur(record.lastToClockOutMin)}).`;
  const expectedStr = expectedTotal != null ? `Expected return travel ${fmtDur(travel)}${src} + ${fmtDur(wrap)} wrap-up = ${fmtDur(expectedTotal)}.` : '';
  return `${prefix} ${expectedStr} Unexplained: ${fmtDur(gap)}. (static threshold)`;
}

function buildEvidenceInRoute({ record, value }) {
  const visits = record?.motive?.offRouteVisits || [];
  const inRouteVisits = visits.filter(v => v.window === 'in_route');
  // Dwell durations only — off-route destinations are not recorded (_privacy.js).
  const stops = inRouteVisits
    .filter(v => v.stationaryMin > 0)
    .map(v => fmtDur(v.stationaryMin))
    .join(', ');
  const stopStr = stops ? ` Stops: ${stops}.` : '';
  return `${fmtDur(value)} of off-route activity between first and last delivery.${stopStr} (static threshold)`;
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
  // D7: when the record carries a reliable GPS-measured yard departure, the
  // prep credit is min(allowance, max(floor, measured)) — unused allowance
  // is not granted. Mirrors _sentinel-engine.scoreDriverDay.
  const loadPrepAllowance = resolveOverride(employee, defaults, 'loadPrepMin');
  const measuredPrep = (typeof record.measuredPrepMin === 'number' && record.measuredPrepMin >= 0
      && record.motive?.routeMatch === true)
    ? Math.round(record.measuredPrepMin) : null;
  const loadPrep = (measuredPrep != null)
    ? Math.min(loadPrepAllowance, Math.max(MIN_PREP_CREDIT_MIN, measuredPrep))
    : loadPrepAllowance;
  const wrapUp = resolveOverride(employee, defaults, 'wrapUpMin');
  next.loadPrepMin = loadPrep;
  next.loadPrepAllowanceMin = loadPrepAllowance;
  next.measuredPrepMin = measuredPrep;
  next.loadPrepSource = loadPrep < loadPrepAllowance ? 'measured' : 'allowance';
  next.wrapUpMin = wrapUp;

  // Truck-type override: if /employees has a per-driver truckType (operator-
  // set via Driver Config), prefer it over the record's stamped value. Wage
  // attribution downstream uses next.truckType, so this is what makes a
  // mid-stream "this driver actually drives a tractor" edit flow into the
  // historical stolen$ calculation on the next rescore.
  if (employee?.truckType === 'tractor' || employee?.truckType === 'straight') {
    next.truckType = employee.truckType;
  }

  // D4/D6: re-derive the effective expected travel per leg from the stored
  // dual-source figures (Google typical vs Motive actual) with the same
  // floor + slow-roll cap the scan applies. Legacy records without the
  // dual-source fields keep their stored effective value.
  const effToFirst = reEffectiveTravel(record, 'googleTravelMinToFirst', 'motiveDriveMinToFirst', 'morningPeriods');
  if (effToFirst) {
    next.expectedTravelMinToFirst = effToFirst.minutes;
    next.expectedTravelMinToFirstSource = effToFirst.source;
    next.travelSourceToFirst = effToFirst.source;
  }
  const effFromLast = reEffectiveTravel(record, 'googleTravelMinFromLast', 'motiveDriveMinFromLast', 'afternoonPeriods');
  if (effFromLast) {
    next.expectedTravelMinFromLast = effFromLast.minutes;
    next.expectedTravelMinFromLastSource = effFromLast.source;
    next.travelSourceFromLast = effFromLast.source;
  }
  // Refresh the slow-roll dataHealth notes to match the re-derived sources
  // (drop stale ones; re-add current ones).
  {
    const dh = Array.isArray(next.dataHealth)
      ? next.dataHealth.filter(s => !/^slow_roll_/.test(String(s)))
      : [];
    if (effToFirst?.source === 'motive_capped' && typeof record.motiveDriveMinToFirst === 'number') {
      dh.push(`slow_roll_to_first:${record.motiveDriveMinToFirst - effToFirst.minutes}`);
    }
    if (effFromLast?.source === 'motive_capped' && typeof record.motiveDriveMinFromLast === 'number') {
      dh.push(`slow_roll_from_last:${record.motiveDriveMinFromLast - effFromLast.minutes}`);
    }
    next.dataHealth = dh;
  }

  // Re-derive gaps from raw inputs. If the raw inputs aren't present
  // (e.g. no first-delivery time → clockInToFirstMin null), gap is null and
  // the flag stays no_data. A NEGATIVE anchor delta (first delivery before
  // clock-in, or last delivery after clock-out) is a data-integrity case the
  // engine deliberately suppresses to no_data at scan time — mirror that here
  // so a rescore doesn't resurrect it as a bogus "ok" and lose the dataHealth
  // signal.
  const reMorningGap = (record.clockInToFirstMin != null && record.clockInToFirstMin >= 0 && next.expectedTravelMinToFirst != null)
    ? record.clockInToFirstMin - next.expectedTravelMinToFirst - loadPrep
    : null;
  const reAfternoonGap = (record.lastToClockOutMin != null && record.lastToClockOutMin >= 0 && next.expectedTravelMinFromLast != null)
    ? record.lastToClockOutMin - next.expectedTravelMinFromLast - wrapUp
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
        evidence: buildEvidenceMorning({ record: next, prep: loadPrep, gap: reMorningGap }),
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
      let ev = buildEvidenceAfternoon({ record: next, wrap: wrapUp, gap: reAfternoonGap });
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
  // Reliability gate (mirrors the scan): routeMatch === false means the GPS
  // belonged to a stale/different truck assignment — never re-derive risk or
  // stolen minutes from it. Records without the field (pre-dual-source engine)
  // keep their existing behavior.
  let inRouteFlag = record.inRouteFlag || 'deferred';
  if (record.motive?.routeMatch === false) {
    inRouteFlag = 'no_data';
  } else if (record.inRouteOffRouteMin != null) {
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
  // D1: floor the band by the worst single component so one critical vector
  // reaches 'high' and two reach 'critical' (see _sentinel-engine.js).
  {
    const nCrit = [morningFlag, afternoonFlag, inRouteFlag].filter(f => f === 'critical').length;
    if (nCrit >= 2) next.riskLevel = 'critical';
    else if (nCrit === 1 && (next.riskLevel === 'clean' || next.riskLevel === 'low' || next.riskLevel === 'medium')) next.riskLevel = 'high';
  }

  // D2/D3: unscoreable-but-not-empty days become 'review', never 'clean'.
  // The no-punch reason only applies to company drivers — resolve role from
  // the live employee doc first, then the record's stamped role; when neither
  // says 'driver' (owner-ops, off-roster unknowns), don't flag no-punch.
  const role = (employee?.role === 'driver' || employee?.role === 'owner_op') ? employee.role
    : (record.role === 'driver' || record.role === 'owner_op') ? record.role : null;
  if (role && next.role == null) next.role = role;
  applyReviewBand(next, { expectPunch: role === 'driver' });

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
