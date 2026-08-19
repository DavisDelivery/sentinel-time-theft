// netlify/functions/_sentinel-engine.js
// Pure scoring logic for SENTINEL v4. No I/O. No fetch. No Firestore.
// Caller (sentinel-day-scan.js) does all data gathering, then calls scoreDriverDay()
// with already-prepared inputs. (The single import below is likewise pure —
// string/object helpers runSelfTest uses to assert the off-route privacy
// guarantees.)
//
// Phase 1 scope: flag class 1 (morning), 2 (afternoon), 4 (data integrity).
// Flag class 3 (in-route Motive) is deferred — written as inRouteFlag: "deferred".
//
// Exports:
//   scoreDriverDay(input)        → output object matching SCHEMA.md sentinelDriverDays shape
//   parseB600DateTime(date, hhmm) → Date (naive ET, treated as UTC for math)
//   parseNuvizzDeliveryEnd(str)   → Date (naive ET, treated as UTC for math)
//   minutesBetween(a, b)          → number
//   classifyGap(gapMin, t)        → 'ok' | 'warn' | 'flag' | 'critical'

import { scrubEvidenceText, scrubRecordLocations } from './_privacy.js';

const VERSION = 'v5.0.0-detection-integrity';

// D7: minimum load-prep credit when Motive measured a faster yard departure
// than the driver's allowance. Pre-trip inspection + paperwork happen even
// when GPS shows a quick exit, so never charge below this floor.
const MIN_PREP_CREDIT_MIN = 10;

// Per-driver load-prep / wrap-up overrides land on /employees/{slug} and flow
// through scoreDriverDay via the optional `loadPrepMin` / `wrapUpMin` input
// fields. When unset, scoring falls back to defaults.loadPrepMin /
// defaults.wrapUpMin. The value actually used is stamped on the record so a
// later rescore (or a human audit) can see whether the engine charged this
// driver as a self-loader or a pre-loader.
function resolveOverride(input, defaults, key) {
  const ov = input[key];
  if (typeof ov === 'number' && Number.isFinite(ov) && ov >= 0) return ov;
  return defaults[key];
}

/**
 * Parse a B600 date + clock time into a Date object.
 * date: "YYYY-MM-DD", hhmm: "HH:MM" (24h, local Eastern, no TZ).
 * We use naive UTC for the Date so arithmetic stays simple — all our
 * timestamps come from the same timezone, so absolute offset is irrelevant.
 */
export function parseB600DateTime(date, hhmm) {
  if (!date || !hhmm || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  // Reject impossible dates that silently roll over (e.g. Feb 30 → Mar 2).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/**
 * Parse NuVizz "delivery end" timestamp.
 * Format: "M/D/YY HH:MM AM/PM" — e.g. "4/20/26 11:37 AM".
 * Returns Date (naive UTC, same convention as parseB600DateTime).
 */
export function parseNuvizzDeliveryEnd(str) {
  if (!str || typeof str !== 'string') return null;
  // "4/20/26 11:37 AM"
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let [_, mon, day, yr, hh, mm, ampm] = m;
  mon = Number(mon); day = Number(day); yr = Number(yr);
  hh = Number(hh); mm = Number(mm);
  if (yr < 100) yr += 2000;
  if (ampm.toUpperCase() === 'PM' && hh < 12) hh += 12;
  if (ampm.toUpperCase() === 'AM' && hh === 12) hh = 0;
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hh > 23 || mm > 59) return null;
  const dt = new Date(Date.UTC(yr, mon - 1, day, hh, mm, 0));
  // Reject impossible dates that silently roll over (e.g. 2/30 → 3/2, 4/31 → 5/1).
  if (dt.getUTCFullYear() !== yr || dt.getUTCMonth() !== mon - 1 || dt.getUTCDate() !== day) return null;
  return dt;
}

/**
 * Whole minutes between two Date objects (later - earlier). Negative if a > b.
 */
export function minutesBetween(earlier, later) {
  if (!earlier || !later) return null;
  return Math.round((later.getTime() - earlier.getTime()) / 60000);
}

/**
 * Classify a gap against static thresholds.
 * thresholds: { ok, warn, flag } — each is an upper bound in minutes for that severity.
 *   gap <= ok       → "ok"
 *   gap <= warn     → "warn"
 *   gap <= flag     → "flag"
 *   gap >  flag     → "critical"
 */
export function classifyGap(gapMin, thresholds) {
  if (gapMin == null) return 'no_data';
  if (gapMin <= thresholds.ok) return 'ok';
  if (gapMin <= thresholds.warn) return 'warn';
  if (gapMin <= thresholds.flag) return 'flag';
  return 'critical';
}

const FLAG_TO_SCORE = { ok: 0, warn: 10, flag: 25, critical: 40, no_data: 0 };

function riskLevelOf(score) {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 25) return 'medium';
  if (score >= 10) return 'low';
  return 'clean';
}

/**
 * D2/D3: route unscoreable-but-not-empty days into a distinct 'review' band.
 *
 * A day where at least one feed matched but nothing could actually be scored
 * used to fall through riskLevelOf(0) → 'clean', which painted three very
 * different situations green:
 *   - deliveries with no punch (missed punch or B600 name mismatch — the
 *     driver's paid hours are unknown, so time theft is unmeasurable)
 *   - a punch with zero recorded deliveries (paid hours, no work product —
 *     the classic ghost day)
 *   - punch + deliveries present but no travel data / broken anchors, so no
 *     gap was computable
 * None of those are "clean"; they are "a human needs to look". The band never
 * overrides a real charge: any component that scored (riskScore > 0 or a
 * scored flag) keeps its earned level.
 *
 * `expectPunch === false` (owner-ops, who never punch B600) suppresses the
 * no-punch reason — a contractor day without a punch is normal, not review.
 *
 * Mutates and returns rec. Shared by scan Phase B (which re-derives the level
 * after in-route scoring); _sentinel-rescore.js carries a mirrored copy to
 * stay self-contained.
 */
export function applyReviewBand(rec, { expectPunch = true } = {}) {
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

/**
 * Main scoring entrypoint.
 *
 * input: {
 *   driverSlug, displayName, date, scanId, truckType,
 *
 *   // Clock data (from B600). Either field may be null if no match.
 *   clockIn:  "HH:MM" | null,
 *   clockOut: "HH:MM" | null,
 *   b600Matched: bool,
 *
 *   // NuVizz data — already filtered to driver+date+completed
 *   firstDeliveryTime: Date | null,   // parsed
 *   firstDeliveryAddr: string | null,
 *   firstDeliveryCustomer: string | null,
 *   lastDeliveryTime: Date | null,
 *   lastDeliveryAddr: string | null,
 *   lastDeliveryCustomer: string | null,
 *   completedStops: number,
 *   nuvizzMatched: bool,
 *
 *   // Travel times — already fetched from Distance Matrix
 *   expectedTravelMinToFirst: number | null,
 *   expectedTravelMinToFirstSource: string,
 *   expectedTravelMinFromLast: number | null,
 *   expectedTravelMinFromLastSource: string,
 *
 *   // Defaults (from sentinelConfig/defaults)
 *   defaults: {
 *     loadPrepMin, wrapUpMin,
 *     wageRates: { tractor, straight, unknown },
 *     morningGapStaticThresholds: { ok, warn, flag },
 *     afternoonGapStaticThresholds: { ok, warn, flag }
 *   }
 * }
 */
export function scoreDriverDay(input) {
  const {
    driverSlug, displayName, date, scanId, truckType = 'unknown',
    clockIn, clockOut, b600Matched,
    firstDeliveryTime, firstDeliveryAddr, firstDeliveryCustomer,
    lastDeliveryTime, lastDeliveryAddr, lastDeliveryCustomer,
    completedStops = 0, nuvizzMatched,
    expectedTravelMinToFirst, expectedTravelMinToFirstSource = 'skipped',
    expectedTravelMinFromLast, expectedTravelMinFromLastSource = 'skipped',
    googleTravelMinToFirst = null, motiveDriveMinToFirst = null,
    googleTravelMinFromLast = null, motiveDriveMinFromLast = null,
    role = null, expectPunch = true,
    defaults
  } = input;

  // Human label for which source set the expected travel time.
  const srcLbl = (s) => s === 'motive' ? ' (Motive GPS)'
    : s === 'motive_capped' ? ' (Motive GPS, capped at typical +50%)'
    : (s === 'google' || s === 'cache' || s === 'api') ? ' (Google typical)' : '';

  // D7: load-prep credit. The allowance is the per-driver/default config
  // value; when Motive reliably measured the yard departure (clock-in → first
  // drive that left the yard), an unused chunk of the allowance is not
  // credited — a self-loader with a 60m allowance who left after 8 minutes
  // did not spend 60 minutes loading. Floor at MIN_PREP_CREDIT_MIN, never
  // exceed the allowance (sitting longer than the allowance is what the
  // morning gap already charges).
  const loadPrepAllowanceMin = resolveOverride(input, defaults, 'loadPrepMin');
  const measuredPrepMin = (typeof input.measuredPrepMin === 'number'
    && Number.isFinite(input.measuredPrepMin) && input.measuredPrepMin >= 0)
    ? Math.round(input.measuredPrepMin) : null;
  const loadPrepMin = (measuredPrepMin != null)
    ? Math.min(loadPrepAllowanceMin, Math.max(MIN_PREP_CREDIT_MIN, measuredPrepMin))
    : loadPrepAllowanceMin;
  const loadPrepSource = loadPrepMin < loadPrepAllowanceMin ? 'measured' : 'allowance';
  const prepLbl = loadPrepSource === 'measured'
    ? ` load prep (GPS-measured; allowance ${loadPrepAllowanceMin} min)`
    : ' load prep';
  const wrapUpMin = resolveOverride(input, defaults, 'wrapUpMin');

  const out = {
    _id: `${driverSlug}_${date}`,
    driverSlug,
    displayName,
    date,
    scanId,
    truckType,
    role,

    clockIn,
    clockOut,
    totalShiftMin: null,
    b600Matched: !!b600Matched,

    firstDeliveryTime: firstDeliveryTime ? firstDeliveryTime.toISOString() : null,
    firstDeliveryAddr: firstDeliveryAddr || null,
    firstDeliveryCustomer: firstDeliveryCustomer || null,
    lastDeliveryTime: lastDeliveryTime ? lastDeliveryTime.toISOString() : null,
    lastDeliveryAddr: lastDeliveryAddr || null,
    lastDeliveryCustomer: lastDeliveryCustomer || null,
    completedStops,
    nuvizzMatched: !!nuvizzMatched,

    // Morning gap
    clockInToFirstMin: null,
    expectedTravelMinToFirst: expectedTravelMinToFirst ?? null,
    expectedTravelMinToFirstSource,
    googleTravelMinToFirst: googleTravelMinToFirst ?? null,
    motiveDriveMinToFirst: motiveDriveMinToFirst ?? null,
    travelSourceToFirst: expectedTravelMinToFirstSource,
    loadPrepMin,
    loadPrepAllowanceMin,
    measuredPrepMin,
    loadPrepSource,
    morningGapMin: null,
    morningFlag: 'no_data',
    morningSeveritySource: 'static',

    // Afternoon gap
    lastToClockOutMin: null,
    expectedTravelMinFromLast: expectedTravelMinFromLast ?? null,
    expectedTravelMinFromLastSource,
    googleTravelMinFromLast: googleTravelMinFromLast ?? null,
    motiveDriveMinFromLast: motiveDriveMinFromLast ?? null,
    travelSourceFromLast: expectedTravelMinFromLastSource,
    wrapUpMin,
    afternoonGapMin: null,
    afternoonFlag: 'no_data',
    afternoonSeveritySource: 'static',

    // In-route deferred
    inRouteFlag: 'deferred',

    // Data integrity
    dataHealth: [],

    // Composite
    riskScore: 0,
    riskLevel: 'clean',
    stolenMinutes: 0,
    stolenDollars: 0,
    flags: [],

    // Provenance
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    version: VERSION
  };

  // Parse clock times
  const clockInDt = clockIn ? parseB600DateTime(date, clockIn) : null;
  const clockOutDt = clockOut ? parseB600DateTime(date, clockOut) : null;
  if (clockInDt && clockOutDt) {
    const shiftMin = minutesBetween(clockInDt, clockOutDt);
    if (shiftMin != null && shiftMin < 0) {
      // Don't silently +24h. Davis Delivery doesn't run overnight routes;
      // a negative shift on the same calendar date is a data integrity issue.
      out.dataHealth.push('shift_negative_clockout_before_clockin');
      out.totalShiftMin = null;
    } else {
      out.totalShiftMin = shiftMin;
    }
  }

  // Data integrity flags
  if (!b600Matched || !clockIn) out.dataHealth.push('b600_no_punch');
  if (!nuvizzMatched || completedStops === 0) out.dataHealth.push('nuvizz_no_stops');
  if (b600Matched && (!nuvizzMatched || completedStops === 0)) out.dataHealth.push('b600_punch_no_stops');

  // ---------- Morning gap ----------
  if (clockInDt && firstDeliveryTime) {
    let clockInToFirstMin = minutesBetween(clockInDt, firstDeliveryTime);
    out.clockInToFirstMin = clockInToFirstMin;

    if (clockInToFirstMin == null || clockInToFirstMin < 0) {
      // First delivery before clock-in is data weirdness — flag it as data health
      out.dataHealth.push('first_delivery_before_clockin');
    } else if (expectedTravelMinToFirst != null) {
      const expectedTotal = expectedTravelMinToFirst + loadPrepMin;
      const gap = clockInToFirstMin - expectedTotal;
      out.morningGapMin = gap;
      out.morningFlag = classifyGap(gap, defaults.morningGapStaticThresholds);

      if (out.morningFlag !== 'ok' && out.morningFlag !== 'no_data') {
        out.flags.push({
          kind: 'morning_gap',
          severity: out.morningFlag,
          evidence: `clockIn ${clockIn} → first delivery ${firstDeliveryCustomer || 'unknown'} at ${firstDeliveryTime.toISOString().slice(11, 16)} (${clockInToFirstMin} min). Expected travel ${expectedTravelMinToFirst} min${srcLbl(expectedTravelMinToFirstSource)} + ${loadPrepMin} min${prepLbl} = ${expectedTotal} min. Unexplained: ${gap} min.`,
          deltaMin: gap
        });
      }
    } else {
      // No travel-time data — can compute clockInToFirstMin but not gap
      out.dataHealth.push('no_travel_time_to_first');
    }
  }

  // ---------- Afternoon gap ----------
  if (clockOutDt && lastDeliveryTime) {
    const lastToClockOutMin = minutesBetween(lastDeliveryTime, clockOutDt);
    if (lastToClockOutMin == null) {
      // can't compute
    } else if (lastToClockOutMin < 0) {
      // Last delivery timestamp is AFTER clock-out. Caller should have filtered
      // these out (post-clockout manual completions), so this branch is defense-
      // in-depth. Don't silently add 24h and produce a fake 23-hour afternoon —
      // surface as data integrity.
      out.dataHealth.push('last_delivery_after_clockout_unfiltered');
      out.lastToClockOutMin = lastToClockOutMin;
    } else {
      out.lastToClockOutMin = lastToClockOutMin;
      if (expectedTravelMinFromLast != null) {
        const expectedTotal = expectedTravelMinFromLast + wrapUpMin;
        const gap = lastToClockOutMin - expectedTotal;
        out.afternoonGapMin = gap;
        out.afternoonFlag = classifyGap(gap, defaults.afternoonGapStaticThresholds);

        if (out.afternoonFlag !== 'ok' && out.afternoonFlag !== 'no_data') {
          out.flags.push({
            kind: 'afternoon_gap',
            severity: out.afternoonFlag,
            evidence: `last delivery ${lastDeliveryCustomer || 'unknown'} at ${lastDeliveryTime.toISOString().slice(11, 16)} → clockOut ${clockOut} (${lastToClockOutMin} min). Expected return travel ${expectedTravelMinFromLast} min${srcLbl(expectedTravelMinFromLastSource)} + ${wrapUpMin} min wrap-up = ${expectedTotal} min. Unexplained: ${gap} min.`,
            deltaMin: gap
          });
        }
      } else {
        out.dataHealth.push('no_travel_time_from_last');
      }
    }
  }

  // ---------- Composite risk score & stolen-time attribution ----------
  let score = FLAG_TO_SCORE[out.morningFlag] || 0;
  score += FLAG_TO_SCORE[out.afternoonFlag] || 0;
  out.riskScore = score;
  out.riskLevel = riskLevelOf(score);
  // D1: a single component maxes at 40 ('critical' flag), but 'high' needs 45
  // and 'critical' 70 - so one critical vector (e.g. a 3h+ morning gap) was
  // capped at 'medium' and hid from high/critical triage. Floor the band by the
  // worst component: one critical -> at least 'high', two -> 'critical'.
  {
    const nCrit = [out.morningFlag, out.afternoonFlag].filter(f => f === 'critical').length;
    if (nCrit >= 2) out.riskLevel = 'critical';
    else if (nCrit === 1 && (out.riskLevel === 'clean' || out.riskLevel === 'low' || out.riskLevel === 'medium')) out.riskLevel = 'high';
  }

  // Stolen minutes: portion of each gap above the "ok" threshold (the static floor)
  const stolenFromMorning = (out.morningGapMin != null)
    ? Math.max(0, out.morningGapMin - defaults.morningGapStaticThresholds.ok)
    : 0;
  const stolenFromAfternoon = (out.afternoonGapMin != null)
    ? Math.max(0, out.afternoonGapMin - defaults.afternoonGapStaticThresholds.ok)
    : 0;
  out.stolenMinutes = stolenFromMorning + stolenFromAfternoon;

  const wage = (defaults.wageRates[truckType] != null) ? defaults.wageRates[truckType] : defaults.wageRates.unknown;
  out.stolenDollars = +((out.stolenMinutes / 60) * wage).toFixed(2);

  // D2/D3: unscoreable-but-not-empty days become 'review', never 'clean'.
  // Scan Phase B re-applies this after in-route scoring mutates the level.
  applyReviewBand(out, { expectPunch });

  return out;
}

// ---------- Self-test runner ----------
// Call with `?test=true` to run synthetic inputs and print results.
// This is not a complete suite — just enough to catch obvious math regressions.
export function runSelfTest() {
  const defaults = {
    loadPrepMin: 15,
    wrapUpMin: 15,
    wageRates: { tractor: 27.50, straight: 23.00, unknown: 25.00 },
    morningGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
    afternoonGapStaticThresholds: { ok: 30, warn: 60, flag: 90 }
  };

  const cases = [];

  // Case 1: clean driver — left yard fast, delivered on time, came home prompt
  cases.push({
    name: 'clean driver',
    input: {
      driverSlug: 'test_clean', displayName: 'Clean Driver', date: '2026-04-27', scanId: 'test',
      truckType: 'tractor',
      clockIn: '06:00', clockOut: '17:00', b600Matched: true,
      firstDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 07:30 AM'),
      firstDeliveryAddr: '100 Main St, City, GA',
      firstDeliveryCustomer: 'Acme',
      lastDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 04:00 PM'),
      lastDeliveryAddr: '200 Other St, City, GA',
      lastDeliveryCustomer: 'Beta',
      completedStops: 12, nuvizzMatched: true,
      expectedTravelMinToFirst: 60, expectedTravelMinToFirstSource: 'cache',
      expectedTravelMinFromLast: 45, expectedTravelMinFromLastSource: 'cache',
      defaults
    },
    expect: { morningFlag: 'ok', afternoonFlag: 'ok', riskLevel: 'clean', stolenMinutes: 0 }
  });

  // Case 2: morning theft — clocked in 6am, first delivery not until 10am for a 30-min drive
  cases.push({
    name: 'morning theft',
    input: {
      driverSlug: 'test_morning', displayName: 'Slow Morning', date: '2026-04-27', scanId: 'test',
      truckType: 'straight',
      clockIn: '06:00', clockOut: '17:00', b600Matched: true,
      firstDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 10:00 AM'),
      firstDeliveryAddr: '100 Main St', firstDeliveryCustomer: 'X',
      lastDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 04:00 PM'),
      lastDeliveryAddr: '200 Other St', lastDeliveryCustomer: 'Y',
      completedStops: 8, nuvizzMatched: true,
      expectedTravelMinToFirst: 30, expectedTravelMinToFirstSource: 'cache',
      expectedTravelMinFromLast: 30, expectedTravelMinFromLastSource: 'cache',
      defaults
    },
    // clockInToFirstMin = 240, expected = 30+15 = 45, gap = 195 → critical
    // stolenFromMorning = 195-30 = 165 min
    // stolenDollars at $23/hr straight = 165/60 * 23 = 63.25
    expect: { morningFlag: 'critical', stolenMinutes: 165, stolenDollars: 63.25 }
  });

  // Case 3: ghost day — driver clocked in but no stops at all. D3: paid hours
  // with zero recorded deliveries is 'review', not 'clean'.
  cases.push({
    name: 'no nuvizz stops → review',
    input: {
      driverSlug: 'test_nodata', displayName: 'Ghost', date: '2026-04-27', scanId: 'test',
      truckType: 'tractor',
      clockIn: '06:00', clockOut: '17:00', b600Matched: true,
      firstDeliveryTime: null, firstDeliveryAddr: null, firstDeliveryCustomer: null,
      lastDeliveryTime: null, lastDeliveryAddr: null, lastDeliveryCustomer: null,
      completedStops: 0, nuvizzMatched: false,
      expectedTravelMinToFirst: null, expectedTravelMinFromLast: null,
      defaults
    },
    expect: { morningFlag: 'no_data', riskLevel: 'review', dataHealthIncludes: 'nuvizz_no_stops' }
  });

  // Case 4 (D7): measured prep smaller than allowance grows the morning gap.
  // clockInToFirst = 240; allowance 60 but GPS shows a 12-min departure →
  // prep credit 12; expected = 30 + 12 = 42; gap = 198 (vs 150 with allowance).
  cases.push({
    name: 'measured prep < allowance (D7)',
    input: {
      driverSlug: 'test_prep', displayName: 'Fast Exit', date: '2026-04-27', scanId: 'test',
      truckType: 'straight',
      clockIn: '06:00', clockOut: '17:00', b600Matched: true,
      firstDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 10:00 AM'),
      firstDeliveryAddr: '100 Main St', firstDeliveryCustomer: 'X',
      lastDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 04:00 PM'),
      lastDeliveryAddr: '200 Other St', lastDeliveryCustomer: 'Y',
      completedStops: 8, nuvizzMatched: true,
      expectedTravelMinToFirst: 30, expectedTravelMinToFirstSource: 'motive',
      expectedTravelMinFromLast: 30, expectedTravelMinFromLastSource: 'motive',
      loadPrepMin: 60, measuredPrepMin: 12,
      defaults
    },
    expect: { loadPrepMin: 12, loadPrepAllowanceMin: 60, loadPrepSource: 'measured', morningGapMin: 198, morningFlag: 'critical' }
  });

  // Case 5 (D3): deliveries but no punch → review for a company driver…
  cases.push({
    name: 'no punch with deliveries → review',
    input: {
      driverSlug: 'test_nopunch', displayName: 'No Punch', date: '2026-04-27', scanId: 'test',
      truckType: 'straight',
      clockIn: null, clockOut: null, b600Matched: false,
      firstDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 09:00 AM'),
      firstDeliveryAddr: '100 Main St', firstDeliveryCustomer: 'X',
      lastDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 03:00 PM'),
      lastDeliveryAddr: '200 Other St', lastDeliveryCustomer: 'Y',
      completedStops: 6, nuvizzMatched: true,
      expectedTravelMinToFirst: null, expectedTravelMinFromLast: null,
      defaults
    },
    expect: { riskLevel: 'review' }
  });

  // …but NOT for an owner-op (they never punch B600).
  cases.push({
    name: 'owner-op no punch stays clean',
    input: {
      driverSlug: 'test_ownerop', displayName: 'Owner Op', date: '2026-04-27', scanId: 'test',
      truckType: 'tractor', role: 'owner_op', expectPunch: false,
      clockIn: null, clockOut: null, b600Matched: false,
      firstDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 09:00 AM'),
      firstDeliveryAddr: '100 Main St', firstDeliveryCustomer: 'X',
      lastDeliveryTime: parseNuvizzDeliveryEnd('4/27/26 03:00 PM'),
      lastDeliveryAddr: '200 Other St', lastDeliveryCustomer: 'Y',
      completedStops: 6, nuvizzMatched: true,
      expectedTravelMinToFirst: null, expectedTravelMinFromLast: null,
      defaults
    },
    expect: { riskLevel: 'clean' }
  });

  const results = cases.map(c => {
    const out = scoreDriverDay(c.input);
    const fails = [];
    for (const [k, v] of Object.entries(c.expect)) {
      if (k === 'dataHealthIncludes') {
        if (!out.dataHealth.includes(v)) fails.push(`dataHealth missing "${v}" — got ${JSON.stringify(out.dataHealth)}`);
      } else if (out[k] !== v) {
        fails.push(`${k}: expected ${v}, got ${out[k]}`);
      }
    }
    return { name: c.name, pass: fails.length === 0, fails, out };
  });

  // Privacy guard (#41): nothing served may carry an off-route location. This
  // runs against the scrubber the read path depends on for the ~17.7k records
  // that still hold addresses at rest — a regression here silently re-exposes
  // them, so it fails the self-test rather than just logging.
  const BARE_ZIP = /(?<![\w.$])\d{5}(?![\w.])/;
  const privacyCases = [
    {
      name: 'privacy: in-route evidence keeps durations, drops ZIPs',
      got: scrubEvidenceText('110 min of off-route activity between first and last delivery. Locations: 30366 (14min stop), 30366 (32min stop). (static threshold)'),
      want: '110 min of off-route activity between first and last delivery. Stops: 14min, 32min. (static threshold)'
    },
    {
      name: 'privacy: detour note keeps distance, drops ZIP',
      got: scrubEvidenceText('Unexplained: 6h 16m. Motive shows detour to: 30336 (50min stop) via 11mi detour.'),
      want: 'Unexplained: 6h 16m. Motive shows an off-route detour: 50min stop via 11mi detour.'
    },
    {
      name: 'privacy: dollar amounts survive ZIP stripping',
      got: scrubEvidenceText('Driver cost $12840.16 today.'),
      want: 'Driver cost $12840.16 today.'
    }
  ];
  const privacyResults = privacyCases.map(c => ({
    name: c.name,
    pass: c.got === c.want && !BARE_ZIP.test(c.got),
    fails: c.got === c.want ? [] : [`expected "${c.want}", got "${c.got}"`],
    out: c.got
  }));

  const scrubbed = scrubRecordLocations({
    flags: [{ kind: 'in_route_off_route', evidence: 'x. Locations: 30366 (14min stop).' }],
    motive: {
      offRouteVisits: [{ arrivedAt: '16:31', destAddr: 'N Bogan Rd, Buford, GA 30519', destZip: '30519', stationaryMin: 13 }],
      pauses: [{ durationMin: 650, atZip: '30542', atAddr: '100 Gainesville Hwy', class: 'yard' }],
      offRouteZips: ['30519']
    }
  });
  const leaked = BARE_ZIP.test(JSON.stringify(scrubbed)) || /Bogan|Gainesville Hwy/.test(JSON.stringify(scrubbed));
  privacyResults.push({
    name: 'privacy: record scrub removes addresses, ZIPs and offRouteZips',
    pass: !leaked && scrubbed.motive.offRouteVisits[0].stationaryMin === 13,
    fails: leaked ? [`location data survived scrub: ${JSON.stringify(scrubbed)}`] : [],
    out: scrubbed
  });

  // Ordering guard (#41): NuVizz emits a zero-padded 12-hour clock, so a
  // lexicographic sort on the raw string orders by clock digits and ignores
  // AM/PM — "02:15 PM" sorts ahead of "09:21 AM", putting the whole afternoon
  // before the morning. Anything displaying stops in time order must sort on
  // parseNuvizzDeliveryEnd, not on the string.
  const rawTimes = [
    '08/11/26 02:15 PM', '08/11/26 09:21 AM', '08/11/26 11:14 AM',
    '08/11/26 04:14 PM', '08/11/26 10:24 AM', '08/11/26 03:03 PM'
  ];
  const chronological = rawTimes.slice().sort((a, b) => {
    const at = parseNuvizzDeliveryEnd(a), bt = parseNuvizzDeliveryEnd(b);
    return (at ? at.getTime() : 0) - (bt ? bt.getTime() : 0);
  });
  const wantOrder = [
    '08/11/26 09:21 AM', '08/11/26 10:24 AM', '08/11/26 11:14 AM',
    '08/11/26 02:15 PM', '08/11/26 03:03 PM', '08/11/26 04:14 PM'
  ];
  const orderOk = JSON.stringify(chronological) === JSON.stringify(wantOrder);
  const orderResult = {
    name: 'ordering: zero-padded 12-hour stop times sort chronologically',
    pass: orderOk,
    fails: orderOk ? [] : [`expected ${JSON.stringify(wantOrder)}, got ${JSON.stringify(chronological)}`],
    out: chronological
  };

  const allResults = [...results, ...privacyResults, orderResult];
  return { passed: allResults.every(r => r.pass), results: allResults };
}
