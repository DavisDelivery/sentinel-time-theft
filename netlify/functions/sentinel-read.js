// netlify/functions/sentinel-read.js
// Read-only endpoint powering the SENTINEL v4 UI.
//
// Actions:
//   ?action=byDate&date=YYYY-MM-DD          → all driver-days for that date, riskScore desc
//   ?action=byDriver&driverSlug=X           → all driver-days for that driver, date desc
//   ?action=driverList                      → all active drivers (slug + display + truck)
//   ?action=dates                           → distinct dates with data, desc
//   ?action=detail&driverSlug=X&date=Y      → full doc for one driver-day
//   ?action=dashboard                       → summary stats for landing screen
//
// Auth: ?secret=<SCAN_SECRET>
// All responses are JSON. CORS open for browser fetch.

import { getDb } from './_firebase-admin.js';

const VERSION = 'v4.0.5-phase1c';

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
  const rows = await db.listDocs('sentinelDriverDays', {
    where: [{ field: 'driverSlug', op: '==', value: driverSlug }],
    limit: 200
  });
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return rows;
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
  // Pull a slim projection of all sentinelDriverDays, distinct dates.
  // 500 limit is plenty for the 12-day window.
  const rows = await db.listDocs('sentinelDriverDays', {
    limit: 600,
    fields: ['date'],
    orderBy: { field: 'date', direction: 'desc' }
  });
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

async function dashboard(db) {
  // Pull a slim projection of ALL records for the summary panel
  const rows = await db.listDocs('sentinelDriverDays', {
    limit: 600,
    fields: ['date', 'driverSlug', 'displayName', 'riskLevel', 'riskScore', 'stolenDollars', 'stolenMinutes', 'b600Matched', 'nuvizzMatched']
  });
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
    topOffenders
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
        body = { action, driverSlug, records: await byDriver(db, driverSlug) };
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
