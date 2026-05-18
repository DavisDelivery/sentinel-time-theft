// netlify/functions/_sentinel-engine.js
// Pure scoring logic for SENTINEL v4. No I/O. No fetch. No Firestore.
// Caller (sentinel-day-scan.js) does all data gathering, then calls scoreDriverDay()
// with already-prepared inputs.
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

const VERSION = 'v4.1.0-phase3c';

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
  if (hh > 23 || mm > 59) return null;
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
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
  return new Date(Date.UTC(yr, mon - 1, day, hh, mm, 0));
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
    defaults
  } = input;

  const out = {
    _id: `${driverSlug}_${date}`,
    driverSlug,
    displayName,
    date,
    scanId,
    truckType,

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
    loadPrepMin: defaults.loadPrepMin,
    morningGapMin: null,
    morningFlag: 'no_data',
    morningSeveritySource: 'static',

    // Afternoon gap
    lastToClockOutMin: null,
    expectedTravelMinFromLast: expectedTravelMinFromLast ?? null,
    expectedTravelMinFromLastSource,
    wrapUpMin: defaults.wrapUpMin,
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
      const expectedTotal = expectedTravelMinToFirst + defaults.loadPrepMin;
      const gap = clockInToFirstMin - expectedTotal;
      out.morningGapMin = gap;
      out.morningFlag = classifyGap(gap, defaults.morningGapStaticThresholds);

      if (out.morningFlag !== 'ok' && out.morningFlag !== 'no_data') {
        out.flags.push({
          kind: 'morning_gap',
          severity: out.morningFlag,
          evidence: `clockIn ${clockIn} → first delivery ${firstDeliveryCustomer || 'unknown'} at ${firstDeliveryTime.toISOString().slice(11, 16)} (${clockInToFirstMin} min). Expected travel ${expectedTravelMinToFirst} min + ${defaults.loadPrepMin} min load prep = ${expectedTotal} min. Unexplained: ${gap} min.`,
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
        const expectedTotal = expectedTravelMinFromLast + defaults.wrapUpMin;
        const gap = lastToClockOutMin - expectedTotal;
        out.afternoonGapMin = gap;
        out.afternoonFlag = classifyGap(gap, defaults.afternoonGapStaticThresholds);

        if (out.afternoonFlag !== 'ok' && out.afternoonFlag !== 'no_data') {
          out.flags.push({
            kind: 'afternoon_gap',
            severity: out.afternoonFlag,
            evidence: `last delivery ${lastDeliveryCustomer || 'unknown'} at ${lastDeliveryTime.toISOString().slice(11, 16)} → clockOut ${clockOut} (${lastToClockOutMin} min). Expected return travel ${expectedTravelMinFromLast} min + ${defaults.wrapUpMin} min wrap-up = ${expectedTotal} min. Unexplained: ${gap} min.`,
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

  // Case 3: no data — driver clocked in but no stops at all
  cases.push({
    name: 'no nuvizz stops',
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
    expect: { morningFlag: 'no_data', dataHealthIncludes: 'nuvizz_no_stops' }
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

  return { passed: results.every(r => r.pass), results };
}
