// netlify/functions/_baselines.js
// SENTINEL v4 Phase 3 — per-driver baseline math. Pure, no I/O.
//
// Replaces static thresholds with each driver's own pattern. A driver whose
// morning gap is consistently 150min (e.g. Buford → Atlanta rush) shouldn't
// flag critical every day; that's their P50. Only dramatic departures from
// their own pattern flag.
//
// Exports:
//   computeDistribution(values)              → {n, min, max, mean, p25, p50, p75, p90}
//   buildDriverBaseline(slug, records)       → full baseline doc
//   classifyAgainstBaseline(value, dist)     → 'ok'|'warn'|'flag'|'critical' | null
//   excessOverP75(value, dist)               → minutes above P75 (stolen-minute attribution)
//   excessOverMedian(value, dist)            → minutes above P50 (descriptive, evidence text only)
//   percentileBucket(value, dist)            → '<P25'|'P25-P50'|...|'>P90'
//   confidenceBand(n)                        → 'insufficient'|'low'|'medium'|'high'

const VERSION = 'v4.1.4-attribution';

export function confidenceBand(n) {
  if (n < 5) return 'insufficient';
  if (n < 8) return 'low';
  if (n < 15) return 'medium';
  return 'high';
}

// Nearest-rank percentile. For p in [0,100] with n sorted values:
//   index = ceil(p/100 * n) - 1, clamped to [0, n-1]
function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function computeDistribution(values) {
  const clean = (values || []).filter(v => v != null && Number.isFinite(v));
  const n = clean.length;
  if (n === 0) return { n: 0, min: null, max: null, mean: null, p25: null, p50: null, p75: null, p90: null };
  const sorted = clean.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: +(sum / n).toFixed(2),
    p25: percentile(sorted, 25),
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90)
  };
}

// Classify a value against the driver's own distribution.
// Returns null when the baseline can't speak — either too few samples (<5)
// or the driver's own P90 is <= 0 (they consistently beat the engine estimate;
// any positive value should fall back to static thresholds).
export function classifyAgainstBaseline(value, dist) {
  if (!dist || dist.n == null || dist.n < 5) return null;
  if (dist.p90 == null || dist.p90 <= 0) return null;
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= dist.p75) return 'ok';
  if (value <= dist.p90) return 'warn';
  if (value <= 1.5 * dist.p90) return 'flag';
  return 'critical';
}

// Minutes above the driver's own P75. This is the stolen-minute attribution
// floor: every "ok" day (value ≤ P75 per classifyAgainstBaseline) contributes
// zero, and only warn / flag / critical days add to the running total. Anchors
// attribution to the exact boundary the engine uses to classify severity, so
// the same record never both says "ok" and adds stolen $.
//
// Previous behavior used P50 (median) as the floor, which attributed stolen
// time on roughly half the days — including ones the engine itself classified
// as ok. Normal day-to-day variance ≠ theft.
export function excessOverP75(value, dist) {
  if (!dist || dist.n == null || dist.n < 5) return 0;
  if (value == null || !Number.isFinite(value)) return 0;
  if (dist.p75 == null) return 0;
  return Math.max(0, value - dist.p75);
}

// Minutes above the driver's own median. Kept for evidence-text display only
// ("excess over median Xmin" surfaces how far this day is from the driver's
// typical; it is NOT used for stolen-minute attribution). For attribution,
// use excessOverP75.
export function excessOverMedian(value, dist) {
  if (!dist || dist.n == null || dist.n < 5) return 0;
  if (value == null || !Number.isFinite(value)) return 0;
  if (dist.p50 == null) return 0;
  return Math.max(0, value - dist.p50);
}

export function percentileBucket(value, dist) {
  if (!dist || dist.n == null || dist.n < 5) return null;
  if (value == null || !Number.isFinite(value)) return null;
  if (dist.p25 != null && value < dist.p25) return '<P25';
  if (dist.p50 != null && value < dist.p50) return 'P25-P50';
  if (dist.p75 != null && value < dist.p75) return 'P50-P75';
  if (dist.p90 != null && value < dist.p90) return 'P75-P90';
  return '>P90';
}

// Aggregate per-driver records into the baseline doc shape.
// Caller is responsible for pre-filtering records (dataHealth, matched flags).
export function buildDriverBaseline(slug, records) {
  const safeRecords = Array.isArray(records) ? records : [];

  const morningGap = safeRecords.map(r => r.morningGapMin).filter(v => v != null);
  const afternoonGap = safeRecords.map(r => r.afternoonGapMin).filter(v => v != null);
  const inRouteOff = safeRecords.map(r => r.inRouteOffRouteMin).filter(v => v != null);
  const clockInToFirst = safeRecords.map(r => r.clockInToFirstMin).filter(v => v != null);
  const lastToClockOut = safeRecords.map(r => r.lastToClockOutMin).filter(v => v != null);
  const totalShift = safeRecords.map(r => r.totalShiftMin).filter(v => v != null);
  const completedStops = safeRecords.map(r => r.completedStops).filter(v => v != null);

  // Derived: stops per hour (only when both shift and stops are present and shift > 0)
  const stopsPerHour = safeRecords
    .filter(r => r.totalShiftMin != null && r.totalShiftMin > 0 && r.completedStops != null)
    .map(r => +(r.completedStops / (r.totalShiftMin / 60)).toFixed(3));

  // Typical customer ZIPs — frequency map across motive.customerZips arrays
  const zipCounts = {};
  for (const r of safeRecords) {
    const zips = r?.motive?.customerZips;
    if (!Array.isArray(zips)) continue;
    for (const z of zips) {
      if (!z) continue;
      zipCounts[z] = (zipCounts[z] || 0) + 1;
    }
  }
  const typicalCustomerZips = Object.entries(zipCounts)
    .map(([zip, count]) => ({ zip, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Pick a representative display name + truck type from records (most recent first)
  const sortedByDate = safeRecords
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const displayName = sortedByDate.find(r => r.displayName)?.displayName || slug;
  const truckType = sortedByDate.find(r => r.truckType && r.truckType !== 'unknown')?.truckType
    || sortedByDate[0]?.truckType
    || 'unknown';

  const daysAnalyzed = safeRecords.length;

  return {
    _id: slug,
    driverSlug: slug,
    displayName,
    truckType,
    daysAnalyzed,
    confidence: confidenceBand(daysAnalyzed),
    metrics: {
      morningGapMin: computeDistribution(morningGap),
      afternoonGapMin: computeDistribution(afternoonGap),
      inRouteOffRouteMin: computeDistribution(inRouteOff),
      clockInToFirstMin: computeDistribution(clockInToFirst),
      lastToClockOutMin: computeDistribution(lastToClockOut),
      totalShiftMin: computeDistribution(totalShift),
      completedStops: computeDistribution(completedStops),
      stopsPerHour: computeDistribution(stopsPerHour)
    },
    typicalCustomerZips,
    computedAt: new Date().toISOString(),
    version: VERSION
  };
}
