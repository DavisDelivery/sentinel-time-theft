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
//   ?action=dashboard                       → summary stats for landing screen
//   ?action=getBaseline&driverSlug=X        → full baseline doc for one driver
//
// Auth: ?secret=<SCAN_SECRET>
// All responses are JSON. CORS open for browser fetch.

import { getDb } from './_firebase-admin.js';

const VERSION = 'v4.2.0-stops-drilldown';

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

async function byDate(db, date) {
  const rows = await db.listDocs('sentinelDriverDays', {
    where: [{ field: 'date', op: '==', value: date }],
    limit: 500
  });
  rows.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  return rows;
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
  return { records: rows, baseline };
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
  const nuvizzName = emp?.externalIds?.nuvizz || emp?.fullName;
  if (!nuvizzName) return { stops: [], diag: { reason: 'no nuvizz external ID on employee', driverSlug } };

  const rows = await db.listDocs('nuvizz_rows_raw', {
    where: [{ field: 'delivery_date', op: '==', value: date }],
    limit: 2000
  });
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const target = norm(nuvizzName);

  const out = [];
  const statusBreakdown = {};
  let matched = 0;
  for (const r of rows) {
    const raw = r.raw || {};
    if (norm(raw['driver name']) !== target) continue;
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
    diag: { rowsScannedForDate: rows.length, driverNameMatches: matched, statusBreakdown, nuvizzName }
  };
}

async function dashboard(db) {
  // Slim-projection pagination of ALL sentinelDriverDays — listAllDocs uses
  // pageToken so the dashboard now reflects the entire backfill, not the
  // alphabetical-by-docId first 600 records (which the totals, distribution,
  // top-offenders, and baselines-scored-against panels were silently capped to).
  const [rows, baselineDocs] = await Promise.all([
    db.listAllDocs('sentinelDriverDays', {
      fields: ['date', 'driverSlug', 'displayName', 'riskLevel', 'riskScore', 'stolenDollars', 'stolenMinutes', 'b600Matched', 'nuvizzMatched', 'morningSeveritySource', 'afternoonSeveritySource', 'inRouteSeveritySource']
    }),
    db.listDocs('sentinelBaselines', {
      limit: 500,
      fields: ['driverSlug', 'confidence', 'daysAnalyzed']
    })
  ]);
  console.log(`[sentinel-read] dashboard → ${rows.length} sentinelDriverDays, ${baselineDocs.length} baselines`);
  const baselinesBySlug = {};
  const baselineConfidence = { insufficient: 0, low: 0, medium: 0, high: 0 };
  for (const b of baselineDocs) {
    const slug = b.driverSlug || b.id;
    if (slug) baselinesBySlug[slug] = b;
    const c = b.confidence || 'insufficient';
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
  const dist = { critical: 0, high: 0, medium: 0, low: 0, clean: 0 };
  let totalStolen$ = 0, totalStolenMin = 0;
  const perDriver = {};
  const datesPresent = new Set();
  for (const r of rows) {
    dist[r.riskLevel] = (dist[r.riskLevel] || 0) + 1;
    totalStolen$ += r.stolenDollars || 0;
    totalStolenMin += r.stolenMinutes || 0;
    if (r.date) datesPresent.add(r.date);
    const slug = r.driverSlug;
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
  }
  for (const pd of Object.values(perDriver)) {
    pd.stolenDollars = +pd.stolenDollars.toFixed(2);
  }
  const topOffenders = Object.values(perDriver)
    .sort((a, b) => b.stolenDollars - a.stolenDollars)
    .slice(0, 15);
  return {
    totalDriverDays: rows.length,
    datesPresent: [...datesPresent].sort(),
    dist,
    totalStolen: { dollars: +totalStolen$.toFixed(2), minutes: totalStolenMin },
    topOffenders,
    baselines: {
      total: baselineDocs.length,
      byConfidence: baselineConfidence,
      recordsScoredAgainst: recordsScoredAgainstBaseline
    }
  };
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

    const action = url.searchParams.get('action') || 'dashboard';
    const db = getDb();
    let body;

    switch (action) {
      case 'byDate': {
        const date = url.searchParams.get('date');
        if (!date) return new Response(JSON.stringify({ error: 'date required' }), { status: 400, headers: CORS });
        body = { action, date, records: await byDate(db, date) };
        break;
      }
      case 'byDriver': {
        const driverSlug = url.searchParams.get('driverSlug');
        if (!driverSlug) return new Response(JSON.stringify({ error: 'driverSlug required' }), { status: 400, headers: CORS });
        const { records, baseline } = await byDriver(db, driverSlug);
        body = { action, driverSlug, records, baseline };
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
      case 'dates':
        body = { action, dates: await dates(db) };
        break;
      case 'detail': {
        const driverSlug = url.searchParams.get('driverSlug');
        const date = url.searchParams.get('date');
        if (!driverSlug || !date) return new Response(JSON.stringify({ error: 'driverSlug + date required' }), { status: 400, headers: CORS });
        body = { action, record: await detail(db, driverSlug, date) };
        break;
      }
      case 'stops': {
        const driverSlug = url.searchParams.get('driverSlug');
        const date = url.searchParams.get('date');
        if (!driverSlug || !date) return new Response(JSON.stringify({ error: 'driverSlug + date required' }), { status: 400, headers: CORS });
        body = { action, driverSlug, date, ...(await stops(db, driverSlug, date)) };
        break;
      }
      case 'dashboard':
        body = { action, ...(await dashboard(db)) };
        break;
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
