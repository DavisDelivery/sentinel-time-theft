// netlify/functions/sentinel-performance.js
// Driver performance aggregation + benchmark fitting
// GET /api/sentinel-performance?days=30                    → fleet + per-driver aggregate
// GET /api/sentinel-performance?days=30&driver=Trevor%20Seyers → per-driver detail with daily records
// GET /api/sentinel-performance?days=30&class=tractor       → filter by truck class

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const HUB_FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/davismarginiq/databases/(default)/documents';

// ─── helpers ───────────────────────────────────────────────────────────────
function median(nums){
  const s = nums.filter(n=>typeof n==='number' && !isNaN(n)).sort((a,b)=>a-b);
  if (!s.length) return 0;
  const m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}
function mean(nums){
  const s = nums.filter(n=>typeof n==='number' && !isNaN(n));
  return s.length ? s.reduce((a,b)=>a+b,0)/s.length : 0;
}
function stddev(nums){
  const s = nums.filter(n=>typeof n==='number' && !isNaN(n));
  if (s.length < 2) return 0;
  const m = mean(s);
  return Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
}
function pct(arr, p){
  const s = arr.filter(n=>typeof n==='number' && !isNaN(n)).sort((a,b)=>a-b);
  if (!s.length) return 0;
  const idx = Math.min(s.length-1, Math.floor(s.length * p));
  return s[idx];
}

// Linear regression: onRouteMin ~ b0 + b1*stops + b2*miles
// Returns {b0, b1, b2, r2, n} or null if insufficient data
function fitOnRouteModel(records){
  const valid = records.filter(r =>
    r.onRouteMin > 30 && r.onRouteMin < 900 &&  // sanity bounds
    r.stops >= 1 && r.totalMiles >= 1
  );
  if (valid.length < 8) return null; // need at least 8 points
  const n = valid.length;

  // Build matrices for normal equations: X'X β = X'y
  // X = [1, stops, miles], y = onRouteMin
  let s1=0, sStops=0, sMiles=0, sStops2=0, sMiles2=0, sStopsMiles=0;
  let sY=0, sYStops=0, sYMiles=0;
  for (const r of valid){
    s1 += 1;
    sStops += r.stops;
    sMiles += r.totalMiles;
    sStops2 += r.stops*r.stops;
    sMiles2 += r.totalMiles*r.totalMiles;
    sStopsMiles += r.stops*r.totalMiles;
    sY += r.onRouteMin;
    sYStops += r.onRouteMin*r.stops;
    sYMiles += r.onRouteMin*r.totalMiles;
  }
  // X'X is 3x3 symmetric
  const A = [[s1, sStops, sMiles],
             [sStops, sStops2, sStopsMiles],
             [sMiles, sStopsMiles, sMiles2]];
  const b = [sY, sYStops, sYMiles];

  // Gaussian elimination
  const M = A.map((row,i)=>[...row, b[i]]);
  for (let i=0;i<3;i++){
    // pivot
    let maxR = i;
    for (let k=i+1;k<3;k++) if (Math.abs(M[k][i])>Math.abs(M[maxR][i])) maxR = k;
    [M[i], M[maxR]] = [M[maxR], M[i]];
    if (Math.abs(M[i][i])<1e-10) return null; // singular
    for (let k=i+1;k<3;k++){
      const f = M[k][i]/M[i][i];
      for (let j=i;j<4;j++) M[k][j] -= f*M[i][j];
    }
  }
  // back-substitute
  const beta = [0,0,0];
  for (let i=2;i>=0;i--){
    let s = M[i][3];
    for (let j=i+1;j<3;j++) s -= M[i][j]*beta[j];
    beta[i] = s/M[i][i];
  }
  // R²
  const yMean = sY/n;
  let ssRes=0, ssTot=0;
  for (const r of valid){
    const yhat = beta[0] + beta[1]*r.stops + beta[2]*r.totalMiles;
    ssRes += (r.onRouteMin - yhat)**2;
    ssTot += (r.onRouteMin - yMean)**2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes/ssTot : 0;
  return { b0: beta[0], b1: beta[1], b2: beta[2], r2, n };
}

function predictOnRoute(model, stops, miles){
  if (!model) return null;
  return Math.max(0, model.b0 + model.b1*stops + model.b2*miles);
}

// ─── Firestore query ───────────────────────────────────────────────────────
async function fetchPerformanceRecords(days){
  // Use the davismarginiq-style runQuery against driverPerformanceDaily
  const db = getDb();
  // Pull last `days` days of records via the listDocs API (which now uses runQuery)
  // We don't have a date-bounded query helper, so fetch a generous limit and filter client-side.
  // Daily records: ~55 drivers * days ≈ 1650 docs for 30d. Well under the 5000 cap.
  const all = await db.listDocs('driverPerformanceDaily', {
    orderBy: { field: 'date', direction: 'desc' },
    limit: Math.min(5000, 55 * days + 50)
  });
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0,10);
  return all.filter(r => r.date && r.date >= cutoffIso);
}

// ─── handler ───────────────────────────────────────────────────────────────
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const days = parseInt(url.searchParams.get('days') || '30');
    const driverFilter = url.searchParams.get('driver');
    const classFilter = url.searchParams.get('class'); // 'tractor' | 'straight'

    const records = await fetchPerformanceRecords(days);

    // Apply class filter (also used for benchmarks below)
    const recordsByClass = {
      tractor: records.filter(r => r.driverType === 'tractor'),
      straight: records.filter(r => r.driverType !== 'tractor'),
    };

    // ─── Fleet-level benchmarks per class ──────────────────────────────────
    function buildBench(rs){
      if (!rs.length) return null;
      const onRoute = rs.map(r=>r.onRouteMin);
      const preR    = rs.map(r=>r.preRouteMin);
      const postR   = rs.map(r=>r.postRouteMin);
      const stops   = rs.map(r=>r.stops);
      const miles   = rs.map(r=>r.totalMiles);
      const sph     = rs.map(r=>r.stopsPerHr);
      const mph     = rs.map(r=>r.effectiveMph);
      const drivePct= rs.map(r=>r.drivePctOnRoute);
      return {
        sampleSize: rs.length,
        onRouteMin:    { median: Math.round(median(onRoute)), mean: Math.round(mean(onRoute)), p10: Math.round(pct(onRoute,0.10)), p90: Math.round(pct(onRoute,0.90)) },
        preRouteMin:   { median: Math.round(median(preR)),    mean: Math.round(mean(preR)),    p90: Math.round(pct(preR,0.90)) },
        postRouteMin:  { median: Math.round(median(postR)),   mean: Math.round(mean(postR)),   p90: Math.round(pct(postR,0.90)) },
        stops:         { median: Math.round(median(stops)),   mean: +mean(stops).toFixed(1) },
        totalMiles:    { median: Math.round(median(miles)),   mean: Math.round(mean(miles)) },
        stopsPerHr:    { median: +median(sph).toFixed(2),     mean: +mean(sph).toFixed(2) },
        effectiveMph:  { median: +median(mph).toFixed(1),     mean: +mean(mph).toFixed(1) },
        drivePctOnRoute:{median: +median(drivePct).toFixed(3),mean: +mean(drivePct).toFixed(3) },
        regressionModel: fitOnRouteModel(rs),
      };
    }

    const benchmarks = {
      tractor: buildBench(recordsByClass.tractor),
      straight: buildBench(recordsByClass.straight),
    };

    // ─── Per-driver aggregates ─────────────────────────────────────────────
    const byDriver = {};
    for (const r of records) {
      const k = r.canonicalName;
      if (!k) continue;
      if (!byDriver[k]) {
        byDriver[k] = {
          canonicalName: k,
          displayName: r.displayName || k,
          driverType: r.driverType || 'straight',
          driverRole: r.driverRole || '',
          truck: r.truck || '',
          records: []
        };
      }
      byDriver[k].records.push(r);
    }

    const driverAggs = Object.values(byDriver).map(d => {
      const rs = d.records;
      const bench = benchmarks[d.driverType === 'tractor' ? 'tractor' : 'straight'];
      const model = bench?.regressionModel || null;

      // Compute "expected on-route" per record using both methods and aggregate
      const efficienciesMedian = [];
      const efficienciesRegression = [];
      for (const r of rs) {
        if (r.onRouteMin > 30 && bench) {
          if (bench.onRouteMin.median > 0) {
            efficienciesMedian.push(r.onRouteMin / bench.onRouteMin.median);
          }
          const predicted = predictOnRoute(model, r.stops, r.totalMiles);
          if (predicted && predicted > 30) {
            efficienciesRegression.push(r.onRouteMin / predicted);
          }
        }
      }
      const avgPreRoute   = Math.round(mean(rs.map(r=>r.preRouteMin)));
      const avgOnRoute    = Math.round(mean(rs.map(r=>r.onRouteMin)));
      const avgPostRoute  = Math.round(mean(rs.map(r=>r.postRouteMin)));
      const avgStops      = +mean(rs.map(r=>r.stops)).toFixed(1);
      const avgMiles      = Math.round(mean(rs.map(r=>r.totalMiles)));
      const avgStopsPerHr = +mean(rs.map(r=>r.stopsPerHr)).toFixed(2);
      const avgMph        = +mean(rs.map(r=>r.effectiveMph)).toFixed(1);
      const avgDrivePct   = +mean(rs.map(r=>r.drivePctOnRoute)).toFixed(3);

      return {
        ...d,
        records: undefined, // strip from response unless driver=... filter
        days: rs.length,
        firstDate: rs.map(r=>r.date).sort()[0],
        lastDate: rs.map(r=>r.date).sort().slice(-1)[0],
        avg: {
          preRouteMin: avgPreRoute,
          onRouteMin: avgOnRoute,
          postRouteMin: avgPostRoute,
          stops: avgStops,
          totalMiles: avgMiles,
          stopsPerHr: avgStopsPerHr,
          effectiveMph: avgMph,
          drivePctOnRoute: avgDrivePct,
        },
        consistency: {
          // lower = more consistent
          onRouteMinStdDev: +stddev(rs.map(r=>r.onRouteMin)).toFixed(0),
          stopsStdDev: +stddev(rs.map(r=>r.stops)).toFixed(1),
          milesStdDev: +stddev(rs.map(r=>r.totalMiles)).toFixed(0),
        },
        efficiencyMedian: efficienciesMedian.length ? +mean(efficienciesMedian).toFixed(2) : null,
        efficiencyRegression: efficienciesRegression.length ? +mean(efficienciesRegression).toFixed(2) : null,
      };
    });

    // Apply driver / class filters for response
    let responseDrivers = driverAggs;
    if (classFilter) responseDrivers = responseDrivers.filter(d =>
      classFilter === 'tractor' ? d.driverType === 'tractor' : d.driverType !== 'tractor'
    );
    if (driverFilter) {
      const want = driverFilter.toLowerCase();
      responseDrivers = responseDrivers.filter(d =>
        d.canonicalName.toLowerCase() === want ||
        d.displayName.toLowerCase() === want
      );
      // Include daily records for the filtered driver(s)
      for (const d of responseDrivers) {
        d.dailyRecords = byDriver[d.canonicalName].records.sort((a,b)=>a.date.localeCompare(b.date));
      }
    }

    return new Response(JSON.stringify({
      success: true,
      days,
      recordCount: records.length,
      driverCount: driverAggs.length,
      benchmarks,
      drivers: responseDrivers,
    }), { headers: CORS });

  } catch (err) {
    console.error('[sentinel-performance]', err);
    return new Response(JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 400) }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-performance' };
