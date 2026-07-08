// netlify/functions/sentinel-read.js
// Read-only endpoint powering the SENTINEL v4 UI.
//
// Actions:
//   ?action=byDate&date=YYYY-MM-DD          → all driver-days for that date, riskScore desc
//   ?action=byDriver&driverSlug=X           → all driver-days for that driver, date desc
//   ?action=driverList                      → all active drivers (slug + display + truck)
//   ?action=dates                           → distinct dates with data, desc
//   ?action=detail&driverSlug=X&date=Y      → full doc for one driver-day
//   ?action=stops&driverSlug=X&date=Y       → all NuVizz stops for driver/date (all statuses)
//   ?action=dashboard[&days=30|90|180|365|all]  → fleet snapshot for selected time range
//   ?action=getBaseline&driverSlug=X        → full baseline doc for one driver
//   ?action=driverConfig                    → active drivers + per-driver loadPrep/wrapUp/truckType overrides
//
// Auth: none — open internal endpoint.
// All responses are JSON. CORS open for browser fetch.

import { getDb } from './_firebase-admin.js';

const VERSION = 'v4.4.0-overview';

// Per-driver listDocs cap. Each driver has at most one record per day; after
// the 17-month backfill ~374 working days exist per driver. 1500 is ~7 years
// of headroom under the single-page runQuery cap — if any driver hits this,
// the per-driver view starts truncating and we'd need to paginate runQuery.
const BY_DRIVER_LIMIT = 1500;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

// Input validators — mirror the date-regex pattern sentinel-day-scan.js uses.
// date: strict YYYY-MM-DD; driverSlug: lowercase alnum + underscore (the
// employee docId charset). Reject anything else before it reaches a query or
// a doc-ID concatenation.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DRIVER_SLUG_RE = /^[a-z0-9_]+$/;

// Whitelist for distribution/grouping keys read off stored fields. Unexpected
// values (undefined / 'nodata' / typos) must not create stray object keys.
const RISK_LEVELS = ['clean', 'low', 'medium', 'high', 'critical'];
const BASELINE_CONFIDENCE_LEVELS = ['insufficient', 'low', 'medium', 'high'];
const normRiskLevel = (v) => (RISK_LEVELS.includes(v) ? v : 'clean');

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

const BY_DATE_LIMIT = 500;

async function byDate(db, date) {
  const rows = await db.listDocs('sentinelDriverDays', {
    where: [{ field: 'date', op: '==', value: date }],
    limit: BY_DATE_LIMIT
  });
  rows.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  // Signal truncation like byDriver does — a silent cap would let the UI
  // under-report driver-days for an unusually busy date.
  const truncated = rows.length >= BY_DATE_LIMIT;
  if (truncated) {
    console.warn(`[sentinel-read] byDate ${date} hit BY_DATE_LIMIT=${BY_DATE_LIMIT} — result truncated, bump the cap or paginate`);
  }
  return { records: rows, truncated };
}

async function byDriver(db, driverSlug) {
  const [rows, baseline] = await Promise.all([
    db.listDocs('sentinelDriverDays', {
      where: [{ field: 'driverSlug', op: '==', value: driverSlug }],
      limit: BY_DRIVER_LIMIT
    }),
    getBaseline(db, driverSlug)
  ]);
  if (rows.length >= BY_DRIVER_LIMIT) {
    console.warn(`[sentinel-read] byDriver ${driverSlug} hit BY_DRIVER_LIMIT=${BY_DRIVER_LIMIT} — view is truncated, bump the cap or paginate`);
  }
  console.log(`[sentinel-read] byDriver ${driverSlug} → ${rows.length} records`);
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Avg clock-in + avg first-delivery time-of-day. We use a CIRCULAR mean
  // (convert minutes-since-midnight to an angle, average sin/cos, convert
  // back) so a driver whose shifts straddle midnight doesn't average to noon.
  // A linear arithmetic mean of {23:50, 00:10} would give 12:00 — wrong by
  // 12 hours; the circular mean gives 00:00. minToHHMM wraps `hh % 24` so
  // round-over and any negative residue both land in [00:00, 23:59].
  // PR #19 review findings #11 (circular mean) + #12 (24:00 wrap).
  const hhmmToMin = (hhmm) => {
    const m = String(hhmm).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = +m[1], mm = +m[2];
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  };
  const TWO_PI = Math.PI * 2;
  const MINS_PER_DAY = 24 * 60;
  const minToHHMM = (avg) => {
    if (avg == null || !Number.isFinite(avg)) return null;
    // Normalize to [0, 1440) then split. `%` keeps negatives negative, so add
    // MINS_PER_DAY before the second `%` to land in the positive range.
    let total = ((avg % MINS_PER_DAY) + MINS_PER_DAY) % MINS_PER_DAY;
    let h = Math.floor(total / 60);
    let m = Math.round(total - h * 60);
    if (m === 60) { h += 1; m = 0; }
    h = h % 24; // 24:00 → 00:00; pure round-over wraparound guard
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  // Circular mean: accumulate sin/cos, atan2 back to an angle, scale to minutes.
  const circularMean = (sumSin, sumCos, n) => {
    if (!n) return null;
    if (sumSin === 0 && sumCos === 0) return null; // exact antipodal cancel
    let theta = Math.atan2(sumSin / n, sumCos / n); // -π..π
    if (theta < 0) theta += TWO_PI;                 // 0..2π
    return (theta / TWO_PI) * MINS_PER_DAY;
  };
  let ciSumSin = 0, ciSumCos = 0, ciN = 0;
  let fdSumSin = 0, fdSumCos = 0, fdN = 0;
  for (const r of rows) {
    if (r.clockIn) {
      const v = hhmmToMin(r.clockIn);
      if (v != null) {
        const a = (v / MINS_PER_DAY) * TWO_PI;
        ciSumSin += Math.sin(a); ciSumCos += Math.cos(a); ciN++;
      }
    }
    if (r.firstDeliveryTime) {
      // ISO-naive "YYYY-MM-DDTHH:MM..." → slice the time component.
      const t = String(r.firstDeliveryTime).slice(11, 16);
      const v = hhmmToMin(t);
      if (v != null) {
        const a = (v / MINS_PER_DAY) * TWO_PI;
        fdSumSin += Math.sin(a); fdSumCos += Math.cos(a); fdN++;
      }
    }
  }
  const avgClockInTime = minToHHMM(circularMean(ciSumSin, ciSumCos, ciN));
  const avgFirstDeliveryTime = minToHHMM(circularMean(fdSumSin, fdSumCos, fdN));

  return { records: rows, baseline, avgClockInTime, avgFirstDeliveryTime };
}

async function getBaseline(db, driverSlug) {
  try {
    return await db.getDoc('sentinelBaselines', driverSlug);
  } catch (_) {
    return null;
  }
}

async function driverList(db) {
  const rows = await db.listDocs('employees', {
    where: [{ field: 'status', op: '==', value: 'active' }],
    limit: 200,
    fields: ['fullName', 'firstName', 'lastName', 'defaultTruck', 'role']
  });
  return rows
    .filter(r => r.role === 'driver' || r.role === 'owner_op')
    .map(r => ({
      slug: r.id,
      fullName: r.fullName,
      firstName: r.firstName,
      lastName: r.lastName,
      defaultTruck: r.defaultTruck || null,
      role: r.role
    }))
    .sort((a, b) => (a.lastName || '').localeCompare(b.lastName || ''));
}

// Active drivers' load-prep / wrap-up / truck-type config + current defaults.
// Backs the "Driver Config" panel in Settings; `loadPrepMin` / `wrapUpMin` are
// null when the driver is using defaults, numeric when an override is set.
// `truckType` is the per-driver override when set; `resolvedTruckType` is the
// effective type after falling back to the truckTypeMap (so the UI can show
// "auto: straight" for unset rows). owner_op rows are included (they don't
// punch B600 so loadPrep/wrapUp don't apply today, but the operator wants
// truckType set so they group correctly in the view-all dashboard).
async function driverConfig(db) {
  const [rows, defaultsDoc, truckTypeMapDoc] = await Promise.all([
    db.listDocs('employees', {
      where: [{ field: 'status', op: '==', value: 'active' }],
      limit: 200,
      fields: ['fullName', 'firstName', 'lastName', 'defaultTruck', 'role', 'loadPrepMin', 'wrapUpMin', 'truckType']
    }),
    db.getDoc('sentinelConfig', 'defaults').catch(() => null),
    db.getDoc('sentinelConfig', 'truckTypeMap').catch(() => null)
  ]);
  const trucksMap = truckTypeMapDoc?.trucks || {};
  function resolveTruckType(emp) {
    if (emp.truckType === 'tractor' || emp.truckType === 'straight') return emp.truckType;
    const key = emp.defaultTruck ? String(emp.defaultTruck).trim() : null;
    const fromMap = key ? trucksMap[key] : null;
    if (fromMap === 'tractor' || fromMap === 'straight') return fromMap;
    return 'unknown';
  }
  const drivers = rows
    .filter(r => r.role === 'driver' || r.role === 'owner_op')
    .map(r => ({
      slug: r.id,
      fullName: r.fullName,
      firstName: r.firstName,
      lastName: r.lastName,
      defaultTruck: r.defaultTruck || null,
      role: r.role,
      loadPrepMin: typeof r.loadPrepMin === 'number' ? r.loadPrepMin : null,
      wrapUpMin: typeof r.wrapUpMin === 'number' ? r.wrapUpMin : null,
      truckType: (r.truckType === 'tractor' || r.truckType === 'straight') ? r.truckType : null,
      resolvedTruckType: resolveTruckType(r)
    }))
    // Sort by what's actually rendered in the row template: fullName, with
    // slug as last-resort fallback for rows where the /employees doc is
    // missing a fullName entirely. The earlier `displayName || fullName`
    // chain referenced a field this mapped object never carries.
    .sort((a, b) => (a.fullName || a.slug || '').localeCompare(b.fullName || b.slug || ''));
  return {
    drivers,
    defaults: {
      loadPrepMin: defaultsDoc?.loadPrepMin ?? 15,
      wrapUpMin: defaultsDoc?.wrapUpMin ?? 15
    }
  };
}

async function dates(db) {
  // Slim projection across ALL sentinelDriverDays — listAllDocs paginates
  // natively so the 17-month backfill's ~14k records all reach us, not just
  // the first 600 (which collapsed to ~13 distinct dates and made the
  // "DATA SCOPE" dropdown lie about coverage).
  const rows = await db.listAllDocs('sentinelDriverDays', { fields: ['date'] });
  console.log(`[sentinel-read] dates → ${rows.length} records, extracting distinct dates`);
  const set = new Set(rows.map(r => r.date).filter(Boolean));
  return [...set].sort().reverse();
}

async function detail(db, driverSlug, date) {
  const id = `${driverSlug}_${date}`;
  try {
    const doc = await db.getDoc('sentinelDriverDays', id);
    return doc || null;
  } catch (e) {
    return null;
  }
}

// All NuVizz stops for a (driver, date) pair, including non-completed rows so
// the operator sees the full picture — the scan engine drops anything whose
// status doesn't contain "complet"; this endpoint reports them all with status
// preserved so a partial / failed / cancelled delivery is visible.
//
// Doesn't share _sentinel-scan.getNuvizzStops because that helper is
// completion-filtered by design (it powers the scoring). Different consumer,
// different filter.
async function stops(db, driverSlug, date) {
  const emp = await db.getDoc('employees', driverSlug);
  if (!emp) return { stops: [], diag: { reason: 'employee not found', driverSlug } };

  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  // Same broadened name matching the scan uses (externalIds.nuvizz + fullName +
  // first/last + aliases) so this diagnostic reflects what actually scores.
  const nameCandidates = [
    emp?.externalIds?.nuvizz,
    emp?.fullName,
    (emp?.firstName && emp?.lastName) ? `${emp.firstName} ${emp.lastName}` : null,
    ...(Array.isArray(emp?.aliases) ? emp.aliases : [])
  ].filter(Boolean).map(norm);
  const targetSet = new Set(nameCandidates);
  if (targetSet.size === 0) return { stops: [], diag: { reason: 'no nuvizz name/alias on employee', driverSlug } };

  const rows = await db.listDocs('nuvizz_rows_raw', {
    where: [{ field: 'delivery_date', op: '==', value: date }],
    limit: 2000
  });

  const out = [];
  const statusBreakdown = {};
  let matched = 0;
  for (const r of rows) {
    const raw = r.raw || {};
    if (!targetSet.has(norm(raw['driver name']))) continue;
    matched++;
    const status = raw['stop status'] || '(none)';
    statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
    out.push({
      pro: r.pro || raw['pro #'] || raw['pro'] || null,
      status,
      deliveryEnd: raw['delivery end'] || null,
      deliveryStart: raw['delivery start'] || null,
      shipTo: raw['ship to'] || null,
      shipToName: raw['ship to name'] || null,
      city: raw['ship to - city'] || null,
      state: raw['ship to - state'] || null,
      zip: raw['ship to - zip code'] || null,
      pieces: raw['pieces'] || null,
      weight: raw['weight'] || null
    });
  }
  // Sort by deliveryEnd (lex on the raw "MM/DD/YYYY HH:MM AM" string is fine
  // within a single day — fall back to PRO order when time is missing).
  out.sort((a, b) => {
    const at = a.deliveryEnd || '';
    const bt = b.deliveryEnd || '';
    if (at && bt) return at.localeCompare(bt);
    if (at) return -1;
    if (bt) return 1;
    return String(a.pro || '').localeCompare(String(b.pro || ''));
  });
  console.log(`[sentinel-read] stops ${driverSlug} ${date} → ${out.length} matched of ${rows.length} scanned`);
  return {
    stops: out,
    diag: { rowsScannedForDate: rows.length, driverNameMatches: matched, statusBreakdown, nuvizzNameCandidates: [...targetSet] }
  };
}

// Median of a non-empty numeric array (mutates: sorts in place). Integer
// result — used for minute-valued metrics where sub-minute precision is noise.
function median(arr) {
  if (!arr.length) return null;
  arr.sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2);
}

// Median preserving 2 decimals — for fractional metrics like stops/hr where
// rounding to an integer would erase the signal (1.8/hr vs 2.4/hr).
function medianFloat(arr) {
  if (!arr.length) return null;
  arr.sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  const v = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  return +v.toFixed(2);
}

// Resolve effective truckType for the view-all grouping. Identical chain to
// _sentinel-scan.resolveTruckType so the dashboard categorization matches
// what the engine writes on next scan.
function resolveTruckType(emp, trucksMap) {
  if (emp.truckType === 'tractor' || emp.truckType === 'straight') return emp.truckType;
  const key = emp.defaultTruck ? String(emp.defaultTruck).trim() : null;
  const fromMap = key ? trucksMap[key] : null;
  if (fromMap === 'tractor' || fromMap === 'straight') return fromMap;
  return 'unknown';
}

// Threshold above which an employee is treated as a "self-loader" for the
// reference-metrics 2x2 grid. Anything below (or unset) buckets as
// "pre-loaded." 60min was chosen so the default-15 + occasional 30-45 outliers
// stay in the pre-load bucket while genuine self-loaders (~120m) classify
// cleanly. Lives here, not in /sentinelConfig/defaults, because it's a UI
// categorization knob, not engine math.
const SELF_LOAD_THRESHOLD_MIN = 60;

async function dashboard(db, days) {
  // Compute the date window. `days='all'` (or any non-numeric) → no filter.
  // Numeric → last N days, inclusive of today (use YYYY-MM-DD lex compare
  // against record.date which is stored ET-naive YYYY-MM-DD).
  const today = new Date();
  let startDate = null;
  if (typeof days === 'number' && days > 0) {
    const start = new Date(today.getTime() - (days - 1) * 86400000);
    const yyyy = start.getUTCFullYear();
    const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(start.getUTCDate()).padStart(2, '0');
    startDate = `${yyyy}-${mm}-${dd}`;
  }
  const todayStr = today.toISOString().slice(0, 10);

  // Slim-projection pagination of ALL sentinelDriverDays. We add raw morning /
  // afternoon fields so the reference-metrics medians can be computed without
  // a second read. listAllDocs uses pageToken so the entire backfill reaches
  // us, not just the alphabetical-by-docId first 600 records.
  const [rows, baselineDocs, employees, truckTypeMapDoc, defaultsDoc] = await Promise.all([
    db.listAllDocs('sentinelDriverDays', {
      fields: [
        'date', 'driverSlug', 'displayName', 'riskLevel', 'riskScore',
        'stolenDollars', 'stolenMinutes', 'b600Matched', 'nuvizzMatched',
        'morningSeveritySource', 'afternoonSeveritySource', 'inRouteSeveritySource',
        'clockInToFirstMin', 'morningGapMin',
        'lastToClockOutMin', 'afternoonGapMin',
        'expectedTravelMinToFirst', 'expectedTravelMinFromLast',
        'googleTravelMinToFirst', 'googleTravelMinFromLast',
        'firstDeliveryTime', 'lastDeliveryTime',
        'totalShiftMin', 'completedStops',
        'truckType'
      ]
    }),
    db.listDocs('sentinelBaselines', {
      limit: 500,
      fields: ['driverSlug', 'confidence', 'daysAnalyzed']
    }),
    db.listDocs('employees', {
      where: [{ field: 'status', op: '==', value: 'active' }],
      limit: 200,
      fields: ['fullName', 'firstName', 'lastName', 'defaultTruck', 'role', 'loadPrepMin', 'truckType']
    }),
    db.getDoc('sentinelConfig', 'truckTypeMap').catch(() => null),
    db.getDoc('sentinelConfig', 'defaults').catch(() => null)
  ]);
  console.log(`[sentinel-read] dashboard(days=${days}) → ${rows.length} sentinelDriverDays, ${baselineDocs.length} baselines, ${employees.length} employees`);

  const trucksMap = truckTypeMapDoc?.trucks || {};
  const defaultLoadPrep = defaultsDoc?.loadPrepMin ?? 15;

  // Build driver metadata index: every active driver, with effective truckType
  // and effective loadPrepMin. UI uses this for view-all grouping + reference
  // metrics categorization. Drivers with no historical records still show up
  // (so the operator sees the full active roster, not just the offenders).
  const driverMeta = {};
  for (const e of employees) {
    if (e.role !== 'driver' && e.role !== 'owner_op') continue;
    const truckType = resolveTruckType(e, trucksMap);
    const loadPrepMin = typeof e.loadPrepMin === 'number' ? e.loadPrepMin : defaultLoadPrep;
    driverMeta[e.id] = {
      slug: e.id,
      displayName: e.fullName || e.id,
      lastName: e.lastName || '',
      role: e.role,
      truckType,
      loadPrepMin,
      isSelfLoader: loadPrepMin >= SELF_LOAD_THRESHOLD_MIN
    };
  }

  const baselinesBySlug = {};
  const baselineConfidence = { insufficient: 0, low: 0, medium: 0, high: 0 };
  for (const b of baselineDocs) {
    const slug = b.driverSlug || b.id;
    if (slug) baselinesBySlug[slug] = b;
    // Whitelist the stored confidence value so an unexpected/typo'd field
    // can't spawn a stray key on the distribution object.
    const c = BASELINE_CONFIDENCE_LEVELS.includes(b.confidence) ? b.confidence : 'insufficient';
    baselineConfidence[c] = (baselineConfidence[c] || 0) + 1;
  }
  let recordsScoredAgainstBaseline = 0;
  for (const r of rows) {
    if (r.morningSeveritySource === 'baseline' ||
        r.afternoonSeveritySource === 'baseline' ||
        r.inRouteSeveritySource === 'baseline') {
      recordsScoredAgainstBaseline++;
    }
  }

  // Split records into current range + 30d trend windows. Trend windows are
  // always 30d regardless of the user-selected range — gives a consistent
  // "trending vs prior month" signal even when the operator is viewing a
  // larger window.
  const trendCurrentStart = (() => {
    const d = new Date(today.getTime() - 29 * 86400000);
    return d.toISOString().slice(0, 10);
  })();
  const trendPriorStart = (() => {
    const d = new Date(today.getTime() - 59 * 86400000);
    return d.toISOString().slice(0, 10);
  })();
  const trendPriorEnd = (() => {
    const d = new Date(today.getTime() - 30 * 86400000);
    return d.toISOString().slice(0, 10);
  })();

  const inRange = r => !startDate || (r.date && r.date >= startDate);
  const inTrendCurrent = r => r.date && r.date >= trendCurrentStart && r.date <= todayStr;
  const inTrendPrior = r => r.date && r.date >= trendPriorStart && r.date <= trendPriorEnd;

  const dist = { critical: 0, high: 0, medium: 0, low: 0, clean: 0 };
  let totalStolen$ = 0, totalStolenMin = 0;
  // Feed-health counters — let the UI tell "genuinely clean fleet" apart from
  // "records were written but the inputs (B600 punch / NuVizz delivery / travel
  // time) never co-occurred, so nothing was computable and everything reads
  // clean $0." A silent all-clean dashboard otherwise hides an ingestion gap.
  let feedWithB600 = 0, feedWithNuvizz = 0, feedWithBoth = 0, feedWithGapData = 0;
  const perDriver = {};
  const datesPresent = new Set();
  const allDatesPresent = new Set();
  const trendStolen = {};   // slug → { current, prior }

  // Reference-metrics buckets: [truckType_isSelfLoader] → arrays of values
  // from records in the selected range. Medians computed at the end. The
  // perDriver sub-map powers the drilldown modal's per-driver breakdown
  // table (one row per driver inside the bucket).
  const newBucket = () => ({
    c2f: [], morningGap: [], l2c: [], afternoonGap: [],
    expToFirst: [], expFromLast: [],
    onRoute: [], shift: [], stops: [], stopsPerHr: [],
    drivers: new Set(),
    perDriver: {},
    days: 0
  });
  const refBuckets = {
    straight_preload: newBucket(),
    straight_selfload: newBucket(),
    tractor_preload: newBucket(),
    tractor_selfload: newBucket()
  };

  // Contractors (owner_ops) combined bucket. They ALSO stay in the truck×load
  // grid above (operator wants them visible next to company drivers), but this
  // bucket backs a dedicated "Contractors" card. Owner-ops don't punch B600, so
  // only route + throughput metrics are meaningful: time on route + stops/hr.
  const contractorsBucket = {
    drivers: new Set(), days: 0,
    onRoute: [], stopsPerHr: [], stops: [],
    perDriver: {}
  };

  for (const r of rows) {
    if (r.date) allDatesPresent.add(r.date);
    const slug = r.driverSlug;

    // 30d trend aggregations — always computed regardless of range filter.
    if (slug) {
      if (!trendStolen[slug]) trendStolen[slug] = { current: 0, prior: 0 };
      if (inTrendCurrent(r)) trendStolen[slug].current += r.stolenDollars || 0;
      else if (inTrendPrior(r)) trendStolen[slug].prior += r.stolenDollars || 0;
    }

    if (!inRange(r)) continue;

    // Coalesce unexpected/missing riskLevel to 'clean' (matching the grouping
    // logic elsewhere) so stray keys like undefined/'nodata' don't appear.
    dist[normRiskLevel(r.riskLevel)] += 1;
    totalStolen$ += r.stolenDollars || 0;
    totalStolenMin += r.stolenMinutes || 0;
    if (r.date) datesPresent.add(r.date);

    // Feed-health: count which inputs actually landed on this scored day.
    if (r.b600Matched) feedWithB600++;
    if (r.nuvizzMatched) feedWithNuvizz++;
    if (r.b600Matched && r.nuvizzMatched) feedWithBoth++;
    if (typeof r.morningGapMin === 'number' || typeof r.afternoonGapMin === 'number') feedWithGapData++;

    if (!perDriver[slug]) {
      perDriver[slug] = {
        slug, displayName: r.displayName,
        days: 0, daysWithData: 0,
        stolenDollars: 0, stolenMinutes: 0,
        criticalDays: 0, highDays: 0
      };
    }
    const pd = perDriver[slug];
    pd.days++;
    if (r.b600Matched || r.nuvizzMatched) pd.daysWithData++;
    pd.stolenDollars += r.stolenDollars || 0;
    pd.stolenMinutes += r.stolenMinutes || 0;
    if (r.riskLevel === 'critical') pd.criticalDays++;
    if (r.riskLevel === 'high') pd.highDays++;

    // Reference-metrics bucketing — only counts records for drivers we know
    // the category for (i.e. on the active roster). Route span + throughput are
    // role-independent, so compute them once and feed whichever buckets apply.
    const meta = driverMeta[slug];
    if (meta) {
      // On-route span: minutes between first and last delivery on this day.
      // null when there's only one stop (no last different from first); the
      // engine writes lastDeliveryTime=null in that case. Keep both the
      // raw-millisecond span (for stops/hr division — see below) and the
      // minute-rounded value (for the on-route median, which is displayed
      // in "Xh Ym" form and gains nothing from sub-minute precision).
      let onRouteMin = null;
      let onRouteMs = null;
      if (r.firstDeliveryTime && r.lastDeliveryTime) {
        const f = Date.parse(r.firstDeliveryTime);
        const l = Date.parse(r.lastDeliveryTime);
        if (Number.isFinite(f) && Number.isFinite(l) && l > f) {
          onRouteMs = l - f;
          onRouteMin = Math.round(onRouteMs / 60000);
        }
      }
      // Stops/hr on route: throughput while actively delivering. Divide by the
      // raw elapsed time (not the minute-rounded value, which inflated tight
      // clusters into 60-120/hr outliers — PR #19 review #10). Require ≥2 stops
      // and a 15-minute floor on the route span so single-cluster days can't
      // drive medians.
      const MIN_ROUTE_SPAN_MS = 15 * 60 * 1000;
      let stopsPerHr = null;
      if (onRouteMs != null && onRouteMs >= MIN_ROUTE_SPAN_MS
          && typeof r.completedStops === 'number' && r.completedStops >= 2) {
        stopsPerHr = r.completedStops / (onRouteMs / 3600000);
      }

      // Contractors (owner_ops): combined bucket. They ALSO fall through into
      // the truck×load grid below (kept visible alongside company drivers per
      // the operator's request); this bucket is what the Contractors card reads.
      if (meta.role === 'owner_op') {
        contractorsBucket.drivers.add(slug);
        contractorsBucket.days++;
        if (onRouteMin != null) contractorsBucket.onRoute.push(onRouteMin);
        if (stopsPerHr != null) contractorsBucket.stopsPerHr.push(stopsPerHr);
        if (typeof r.completedStops === 'number') contractorsBucket.stops.push(r.completedStops);
        if (!contractorsBucket.perDriver[slug]) {
          contractorsBucket.perDriver[slug] = {
            slug, displayName: meta.displayName, truckType: meta.truckType,
            n_days: 0, onRoute: [], stopsPerHr: [], stops: []
          };
        }
        const cpd = contractorsBucket.perDriver[slug];
        cpd.n_days++;
        if (onRouteMin != null) cpd.onRoute.push(onRouteMin);
        if (stopsPerHr != null) cpd.stopsPerHr.push(stopsPerHr);
        if (typeof r.completedStops === 'number') cpd.stops.push(r.completedStops);
      }

      // Truck×load grid — company drivers AND contractors with a known truck
      // type (unchanged behavior: contractors stay in these cards too).
      if (meta.truckType !== 'unknown') {
        const bucketKey = `${meta.truckType}_${meta.isSelfLoader ? 'selfload' : 'preload'}`;
        const bucket = refBuckets[bucketKey];
        if (bucket) {
          bucket.drivers.add(slug);
          bucket.days++;
          if (typeof r.clockInToFirstMin === 'number') bucket.c2f.push(r.clockInToFirstMin);
          if (typeof r.morningGapMin === 'number') bucket.morningGap.push(r.morningGapMin);
          if (typeof r.lastToClockOutMin === 'number') bucket.l2c.push(r.lastToClockOutMin);
          if (typeof r.afternoonGapMin === 'number') bucket.afternoonGap.push(r.afternoonGapMin);
          // "Expected drive" medians use the GOOGLE typical figure specifically —
          // post-dual-source, expectedTravelMin* can be Motive-actual on some days
          // and Google-typical on others, and a median over that mix isn't a
          // like-for-like reference. Older records (pre-dual-source) only carry
          // expectedTravelMin*, which for them IS the Google figure — fall back.
          const gToFirst = (typeof r.googleTravelMinToFirst === 'number') ? r.googleTravelMinToFirst
            : (typeof r.expectedTravelMinToFirst === 'number' ? r.expectedTravelMinToFirst : null);
          const gFromLast = (typeof r.googleTravelMinFromLast === 'number') ? r.googleTravelMinFromLast
            : (typeof r.expectedTravelMinFromLast === 'number' ? r.expectedTravelMinFromLast : null);
          if (gToFirst != null) bucket.expToFirst.push(gToFirst);
          if (gFromLast != null) bucket.expFromLast.push(gFromLast);
          if (onRouteMin != null) bucket.onRoute.push(onRouteMin);
          if (stopsPerHr != null) bucket.stopsPerHr.push(stopsPerHr);
          if (typeof r.totalShiftMin === 'number') bucket.shift.push(r.totalShiftMin);
          if (typeof r.completedStops === 'number') bucket.stops.push(r.completedStops);
          // Per-driver aggregation inside the bucket — keeps arrays per slug so
          // the drilldown table can show driver vs bucket-median deviation.
          if (!bucket.perDriver[slug]) {
            bucket.perDriver[slug] = {
              slug, displayName: meta.displayName, role: meta.role || 'driver',
              n_days: 0,
              c2f: [], morningGap: [], l2c: [], afternoonGap: [], onRoute: [], stopsPerHr: [],
              expToFirst: [], expFromLast: []
            };
          }
          const pd = bucket.perDriver[slug];
          pd.n_days++;
          if (typeof r.clockInToFirstMin === 'number') pd.c2f.push(r.clockInToFirstMin);
          if (gToFirst != null) pd.expToFirst.push(gToFirst);
          if (gFromLast != null) pd.expFromLast.push(gFromLast);
          if (typeof r.morningGapMin === 'number') pd.morningGap.push(r.morningGapMin);
          if (typeof r.lastToClockOutMin === 'number') pd.l2c.push(r.lastToClockOutMin);
          if (typeof r.afternoonGapMin === 'number') pd.afternoonGap.push(r.afternoonGapMin);
          if (onRouteMin != null) pd.onRoute.push(onRouteMin);
          if (stopsPerHr != null) pd.stopsPerHr.push(stopsPerHr);
        }
      }
    }
  }

  for (const pd of Object.values(perDriver)) {
    pd.stolenDollars = +pd.stolenDollars.toFixed(2);
    const t = trendStolen[pd.slug];
    if (t) {
      pd.trend30d = {
        current: +t.current.toFixed(2),
        prior: +t.prior.toFixed(2),
        delta: +(t.current - t.prior).toFixed(2)
      };
    }
    const meta = driverMeta[pd.slug];
    if (meta) {
      pd.truckType = meta.truckType;
      pd.loadPrepMin = meta.loadPrepMin;
      pd.isSelfLoader = meta.isSelfLoader;
      pd.role = meta.role;
    }
  }

  // Top offenders: full sorted list (UI slices top-10 + "View All"). Drivers
  // with zero records in range are added at the tail so view-all shows the
  // complete roster, alphabetical fallback.
  const offendersRanked = Object.values(perDriver)
    .sort((a, b) => b.stolenDollars - a.stolenDollars);
  const rankedSlugs = new Set(offendersRanked.map(o => o.slug));
  const restRoster = Object.values(driverMeta)
    .filter(d => !rankedSlugs.has(d.slug))
    .map(d => ({
      slug: d.slug, displayName: d.displayName,
      truckType: d.truckType, loadPrepMin: d.loadPrepMin, isSelfLoader: d.isSelfLoader, role: d.role,
      days: 0, daysWithData: 0, stolenDollars: 0, stolenMinutes: 0, criticalDays: 0, highDays: 0,
      trend30d: trendStolen[d.slug]
        ? { current: +trendStolen[d.slug].current.toFixed(2), prior: +trendStolen[d.slug].prior.toFixed(2),
            delta: +(trendStolen[d.slug].current - trendStolen[d.slug].prior).toFixed(2) }
        : { current: 0, prior: 0, delta: 0 }
    }));

  // Reference metrics: median c2f / morningGap / l2c / afternoonGap + model
  // expected (per-bucket loadPrep + threshold.ok). Buckets with zero drivers
  // return null so the UI shows "Configure self-loaders to populate."
  const morningOk = defaultsDoc?.morningGapStaticThresholds?.ok ?? 30;
  const afternoonOk = defaultsDoc?.afternoonGapStaticThresholds?.ok ?? 30;
  const refMetricsOut = {};
  for (const [key, b] of Object.entries(refBuckets)) {
    if (b.drivers.size === 0) {
      refMetricsOut[key] = null;
      continue;
    }
    const isSelfLoader = key.endsWith('selfload');
    // Representative loadPrep for the bucket: pick the median of the bucket's
    // drivers' loadPrep values (handles a fleet where self-loaders aren't all
    // at the same minutes setting).
    const bucketLoadPreps = [...b.drivers]
      .map(s => driverMeta[s]?.loadPrepMin)
      .filter(v => typeof v === 'number')
      .sort((a, b) => a - b);
    const representativeLoadPrep = bucketLoadPreps.length
      ? bucketLoadPreps[Math.floor(bucketLoadPreps.length / 2)]
      : (isSelfLoader ? 120 : defaultLoadPrep);
    // Per-driver breakdown: median per metric for each driver in this bucket.
    // Sorted alpha by displayName from the server; frontend handles re-sort.
    const perDriverBreakdown = Object.values(b.perDriver)
      .filter(pd => pd.n_days > 0)
      .map(pd => ({
        slug: pd.slug,
        displayName: pd.displayName,
        role: pd.role || 'driver',
        n_days: pd.n_days,
        medianC2F: median(pd.c2f.slice()),
        medianExpectedToFirst: median(pd.expToFirst.slice()),
        medianExpectedFromLast: median(pd.expFromLast.slice()),
        medianMorningGap: median(pd.morningGap.slice()),
        medianL2C: median(pd.l2c.slice()),
        medianAfternoonGap: median(pd.afternoonGap.slice()),
        medianOnRouteMin: median(pd.onRoute.slice()),
        medianStopsPerHourOnRoute: medianFloat(pd.stopsPerHr.slice())
      }))
      .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    refMetricsOut[key] = {
      n_drivers: b.drivers.size,
      n_days: b.days,
      // All median calls slice first so the bucket arrays remain in insertion
      // order — matches the per-driver branch above and avoids the future-
      // reader trap of seeing sorted-instead-of-insertion data. PR #19 #14.
      medianC2F: median(b.c2f.slice()),
      medianExpectedToFirst: median(b.expToFirst.slice()),
      medianExpectedFromLast: median(b.expFromLast.slice()),
      medianMorningGap: median(b.morningGap.slice()),
      medianL2C: median(b.l2c.slice()),
      medianAfternoonGap: median(b.afternoonGap.slice()),
      medianOnRouteMin: median(b.onRoute.slice()),
      medianShiftMin: median(b.shift.slice()),
      medianStopsPerDay: median(b.stops.slice()),
      medianStopsPerHourOnRoute: medianFloat(b.stopsPerHr.slice()),
      representativeLoadPrep,
      representativeWrapUp: defaultsDoc?.wrapUpMin ?? 15,
      morningOkThreshold: morningOk,
      afternoonOkThreshold: afternoonOk,
      perDriverBreakdown
    };
  }

  // Contractors combined metrics. Owner-ops don't punch B600, so this surfaces
  // only what's meaningful for them: time on route + deliveries/hr (with
  // stops/day for context) plus a per-contractor breakdown for the comparison
  // view and printable card.
  const contractorMetrics = contractorsBucket.drivers.size === 0 ? null : {
    n_drivers: contractorsBucket.drivers.size,
    n_days: contractorsBucket.days,
    medianOnRouteMin: median(contractorsBucket.onRoute.slice()),
    medianStopsPerHourOnRoute: medianFloat(contractorsBucket.stopsPerHr.slice()),
    medianStopsPerDay: median(contractorsBucket.stops.slice()),
    perDriverBreakdown: Object.values(contractorsBucket.perDriver)
      .filter(pd => pd.n_days > 0)
      .map(pd => ({
        slug: pd.slug,
        displayName: pd.displayName,
        truckType: pd.truckType,
        n_days: pd.n_days,
        medianOnRouteMin: median(pd.onRoute.slice()),
        medianStopsPerHourOnRoute: medianFloat(pd.stopsPerHr.slice()),
        medianStopsPerDay: median(pd.stops.slice())
      }))
      .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''))
  };

  return {
    rangeMeta: {
      days: typeof days === 'number' ? days : 'all',
      startDate, endDate: todayStr,
      totalAvailable: rows.length
    },
    totalDriverDays: offendersRanked.reduce((s, o) => s + o.days, 0),
    datesPresent: [...datesPresent].sort(),
    allDatesPresent: [...allDatesPresent].sort(),
    dist,
    totalStolen: { dollars: +totalStolen$.toFixed(2), minutes: totalStolenMin },
    feedHealth: {
      scoredDays: dist.critical + dist.high + dist.medium + dist.low + dist.clean,
      withB600: feedWithB600,
      withNuvizz: feedWithNuvizz,
      withBoth: feedWithBoth,
      withGapData: feedWithGapData
    },
    topOffenders: offendersRanked.slice(0, 15),
    offendersRanked,
    restRoster,
    drivers: Object.values(driverMeta),
    referenceMetrics: refMetricsOut,
    contractorMetrics,
    baselines: {
      total: baselineDocs.length,
      byConfidence: baselineConfidence,
      recordsScoredAgainst: recordsScoredAgainstBaseline
    }
  };
}

// ---------- Anomalies (Motive GPS) ----------
// Fleet-wide feed of GPS anomalies over the last N days, read from the stored
// motive blocks on sentinelDriverDays (populated by a Motive-on scan). Pure
// observation — not tied to the theft score or per-driver config.
//   - flaggedPauses: stationary stretches >= 30m away from customer/yard
//   - deviations:   off-route visits between first and last delivery
//   - placePatterns: repeated (driver, ZIP) pause locations
async function anomalies(db, days) {
  const today = new Date();
  let startDate = null;
  if (typeof days === 'number' && days > 0) {
    const start = new Date(today.getTime() - (days - 1) * 86400000);
    startDate = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`;
  }
  const rows = await db.listAllDocs('sentinelDriverDays', {
    fields: ['date', 'driverSlug', 'displayName', 'truckType', 'clockIn', 'clockOut',
             'firstDeliveryTime', 'lastDeliveryTime', 'motive']
  });
  const inRange = r => !startDate || (r.date && r.date >= startDate);
  const hhmm = (iso) => (typeof iso === 'string' && iso.length >= 16) ? iso.slice(11, 16) : null;
  // Keep only pauses within the working window — a pause starting after the
  // shift end (or ending before the start) is an overnight/parked truck, not
  // sitting on the clock. Use the B600 punch when present, else fall back to
  // the first/last delivery times (handles drivers with no punch). HH:MM string
  // compare is valid within a single day.
  const onShift = (startET, endET, sStart, sEnd) => {
    if (sEnd && startET && startET > sEnd) return false;
    if (sStart && endET && endET < sStart) return false;
    return true;
  };

  const pauses = [];
  const deviations = [];
  const placeMap = {};           // `${slug}|${zip}` → pattern accumulator
  let daysWithMotive = 0;
  const driversWithMotive = new Set();
  let scannedInRange = 0;

  for (const r of rows) {
    if (!inRange(r)) continue;
    scannedInRange++;
    const m = r.motive;
    if (!m || typeof m !== 'object') continue;
    // routeMatch === false → the GPS never touched this driver's route that
    // day (stale/wrong truck assignment). Those pauses and deviations belong
    // to whoever actually drove the truck — showing them under this driver's
    // name is a false attribution. Older records without the field pass.
    if (m.routeMatch === false) continue;
    daysWithMotive++;
    if (r.driverSlug) driversWithMotive.add(r.driverSlug);

    const shiftStart = r.clockIn || hhmm(r.firstDeliveryTime);
    const shiftEnd = r.clockOut || hhmm(r.lastDeliveryTime);
    for (const p of (m.pauses || [])) {
      if (!p || !p.flagged) continue;
      if (!onShift(p.startET, p.endET, shiftStart, shiftEnd)) continue;
      const entry = {
        slug: r.driverSlug, displayName: r.displayName || r.driverSlug, date: r.date,
        durationMin: p.durationMin, atZip: p.atZip || null, atAddr: p.atAddr || null,
        class: p.class || 'unknown', startET: p.startET || null, endET: p.endET || null
      };
      pauses.push(entry);
      const key = `${r.driverSlug}|${p.atZip || 'noZip'}`;
      const pm = placeMap[key] || (placeMap[key] = {
        slug: r.driverSlug, displayName: entry.displayName, atZip: p.atZip || null,
        sampleAddr: p.atAddr || null, count: 0, totalMin: 0, dates: []
      });
      pm.count++; pm.totalMin += p.durationMin;
      if (pm.dates.length < 30) pm.dates.push(r.date);
      if (!pm.sampleAddr && p.atAddr) pm.sampleAddr = p.atAddr;
    }

    for (const v of (m.offRouteVisits || [])) {
      if (!v || v.window !== 'in_route') continue;
      deviations.push({
        slug: r.driverSlug, displayName: r.displayName || r.driverSlug, date: r.date,
        destZip: v.destZip || null, destAddr: v.destAddr || null,
        stationaryMin: v.stationaryMin || 0, driveMinToReach: v.driveMinToReach || 0
      });
    }
  }

  pauses.sort((a, b) => b.durationMin - a.durationMin);
  deviations.sort((a, b) => (b.stationaryMin + b.driveMinToReach) - (a.stationaryMin + a.driveMinToReach));
  const placePatterns = Object.values(placeMap)
    .map(p => ({ ...p, avgMin: Math.round(p.totalMin / p.count) }))
    .filter(p => p.count >= 2)            // "repeated" = 2+ days at the same place
    .sort((a, b) => (b.count - a.count) || (b.avgMin - a.avgMin));

  return {
    rangeDays: typeof days === 'number' ? days : 'all',
    startDate, endDate: today.toISOString().slice(0, 10),
    coverage: { scannedInRange, daysWithMotive, driversWithMotive: driversWithMotive.size },
    counts: { flaggedPauses: pauses.length, deviations: deviations.length, places: placePatterns.length },
    topPauses: pauses.slice(0, 200),
    deviations: deviations.slice(0, 200),
    placePatterns: placePatterns.slice(0, 100)
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'dashboard';
    const db = getDb();
    let body;

    switch (action) {
      case 'byDate': {
        const date = url.searchParams.get('date');
        if (!date) return new Response(JSON.stringify({ error: 'date required' }), { status: 400, headers: CORS });
        if (!DATE_RE.test(date)) return new Response(JSON.stringify({ error: 'date must be YYYY-MM-DD' }), { status: 400, headers: CORS });
        const { records, truncated } = await byDate(db, date);
        body = { action, date, records, truncated };
        break;
      }
      case 'byDriver': {
        const driverSlug = url.searchParams.get('driverSlug');
        if (!driverSlug) return new Response(JSON.stringify({ error: 'driverSlug required' }), { status: 400, headers: CORS });
        if (!DRIVER_SLUG_RE.test(driverSlug)) return new Response(JSON.stringify({ error: 'driverSlug must match ^[a-z0-9_]+$' }), { status: 400, headers: CORS });
        const { records, baseline, avgClockInTime, avgFirstDeliveryTime } = await byDriver(db, driverSlug);
        body = { action, driverSlug, records, baseline, avgClockInTime, avgFirstDeliveryTime };
        break;
      }
      case 'getBaseline': {
        const driverSlug = url.searchParams.get('driverSlug');
        if (!driverSlug) return new Response(JSON.stringify({ error: 'driverSlug required' }), { status: 400, headers: CORS });
        body = { action, driverSlug, baseline: await getBaseline(db, driverSlug) };
        break;
      }
      case 'driverList':
        body = { action, drivers: await driverList(db) };
        break;
      case 'driverConfig':
        body = { action, ...(await driverConfig(db)) };
        break;
      case 'dates':
        body = { action, dates: await dates(db) };
        break;
      case 'detail': {
        const driverSlug = url.searchParams.get('driverSlug');
        const date = url.searchParams.get('date');
        if (!driverSlug || !date) return new Response(JSON.stringify({ error: 'driverSlug + date required' }), { status: 400, headers: CORS });
        if (!DRIVER_SLUG_RE.test(driverSlug)) return new Response(JSON.stringify({ error: 'driverSlug must match ^[a-z0-9_]+$' }), { status: 400, headers: CORS });
        if (!DATE_RE.test(date)) return new Response(JSON.stringify({ error: 'date must be YYYY-MM-DD' }), { status: 400, headers: CORS });
        body = { action, record: await detail(db, driverSlug, date) };
        break;
      }
      case 'stops': {
        const driverSlug = url.searchParams.get('driverSlug');
        const date = url.searchParams.get('date');
        if (!driverSlug || !date) return new Response(JSON.stringify({ error: 'driverSlug + date required' }), { status: 400, headers: CORS });
        if (!DRIVER_SLUG_RE.test(driverSlug)) return new Response(JSON.stringify({ error: 'driverSlug must match ^[a-z0-9_]+$' }), { status: 400, headers: CORS });
        if (!DATE_RE.test(date)) return new Response(JSON.stringify({ error: 'date must be YYYY-MM-DD' }), { status: 400, headers: CORS });
        body = { action, driverSlug, date, ...(await stops(db, driverSlug, date)) };
        break;
      }
      case 'dashboard': {
        const rawDays = url.searchParams.get('days');
        let days = 30; // default rolling window
        if (rawDays === 'all') days = 'all';
        else if (rawDays != null) {
          const n = parseInt(rawDays, 10);
          if (Number.isFinite(n) && n > 0 && n <= 36500) days = n;
        }
        body = { action, ...(await dashboard(db, days)) };
        break;
      }
      case 'anomalies': {
        const rawDays = url.searchParams.get('days');
        let days = 30;
        if (rawDays === 'all') days = 'all';
        else if (rawDays != null) {
          const n = parseInt(rawDays, 10);
          if (Number.isFinite(n) && n > 0 && n <= 36500) days = n;
        }
        body = { action, ...(await anomalies(db, days)) };
        break;
      }
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: CORS });
    }

    return new Response(JSON.stringify({ version: VERSION, ...body }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('[sentinel-read]', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-read' };
