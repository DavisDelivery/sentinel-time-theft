// netlify/functions/sentinel-scan-run.js
// Server-side scan runner — call with a date range, runs full audit, saves to Firestore
// POST /api/sentinel-scan-run { startDate, endDate, secret }
// GET  /api/sentinel-scan-run?startDate=2026-04-01&endDate=2026-04-01&secret=xxx

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MOTIVE_KEY = () => Netlify.env.get('MOTIVE_API_KEY');
const MOTIVE_BASE = 'https://api.keeptruckin.com/v1';
const SCAN_SECRET = () => Netlify.env.get('SCAN_SECRET') || 'sentinel2026';

// Wage rates
const WAGES = { tractor: 27.50, straight: 23.00, default: 23.00 };

// Fleet benchmarks (from 40K stop analysis)
const FLEET_BENCH = {
  gap: { median: 18, p75: 28, p90: 42, p95: 56 },
  firstDel: { median: 8.55, p90: 11.0 },
  stopsDay: { median: 13, p90: 19 },
  gapWarn: 28, gapFlag: 42, gapCrit: 56,
  shift: { mean: 8.9 }
};

// Driver roster — canonical name → profile
const DRIVER_ROSTER = {
  'james davis':'shuttle','james':'shuttle','jew williams':'shuttle',
  'jonathan sailors':'shuttle','johnathan sailers':'shuttle',
  'leslie thomas':'shuttle','leslie':'shuttle','brad goodroe':'loadshift',
  'allen council':'tractor','anthony kostner':'tractor',
  'brent bryd':'tractor','brenton byrd':'tractor','brent boyd':'tractor',
  'brett spradley':'tractor','brian worley':'tractor','che roberts':'tractor',
  'chris head':'tractor','c head':'tractor','darvin cepeda':'tractor',
  'denis salkic':'tractor','denis salikic':'tractor','garry pitts':'tractor',
  'jim pallette':'tractor','junior thomas':'tractor','junior thoamas':'tractor',
  'marcus young':'tractor','mareese johnson':'tractor','montel bishop':'tractor',
  'rasko suljic':'tractor','robert best':'tractor','terrance hawk':'tractor',
  'victor fernandez':'tractor','william goodwin':'tractor','andre murphy':'tractor',
  'william tillery':'tractor','bill tillery':'tractor','george leonard':'tractor',
  'jean delsoin':'tractor','jean delsion':'tractor',
  'aaron mitchell':'straight','brent dixon':'straight','enock akyea':'straight',
  'john thompson':'straight','leroy smith':'straight',
  'mandi malbrough':'straight','mandi malborough':'straight','mandi marlboroug':'straight',
  'marcus crumpton':'straight','michael frye':'straight','michael tharp':'straight',
  'rasheed davis':'straight','scott hart':'straight','tariq hammou':'straight',
  'terrence taylor':'straight','terrance taylor':'straight',
  'terry gambrell':'straight','t gambrell':'straight',
  'tobias johnson':'straight','trevarr howard':'straight',
  'william kidd':'straight','trevor syers':'straight','william hart':'straight',
  'anthony bennett':'straight','ben paintsil':'straight','colin calhoun':'straight',
  'dj mccrary':'straight','frank okine':'straight',
  'alfred andi':'straight','fred andi':'straight',
  'ken watkins':'straight','kobe boakye':'straight','kobe kawakabe':'straight',
  'martin wyatt':'straight','mone watkins':'straight','nana owusu':'straight',
  'olamide kazeem':'straight','oyieke nelson':'straight',
  'richard mawuenyega':'straight','ronald gates':'straight',
  'samuel osei':'straight','theo afunyah':'straight','vincent bonzo':'straight',
  'pierre adeaban':'straight','jovenski gibbs':'straight','joe gibbs':'straight',
  'steven adjetey':'straight',
};

const CANONICAL = {
  'james':'James Davis','james davis':'James Davis',
  'leslie':'Leslie Thomas','leslie thomas':'Leslie Thomas',
  'brent bryd':'Brent Byrd','brenton byrd':'Brent Byrd','brent boyd':'Brent Byrd',
  'c head':'Chris Head','denis salikic':'Denis Salkic',
  'junior thoamas':'Junior Thomas','mandi malborough':'Mandi Malbrough',
  'mandi marlboroug':'Mandi Malbrough','terrance taylor':'Terrence Taylor',
  't gambrell':'Terry Gambrell','bill tillery':'William Tillery',
  'johnathan sailers':'Jonathan Sailors','fred andi':'Alfred Andi',
  'jean delsion':'Jean Delsoin','kobe kawakabe':'Kobe Boakye',
  'joe gibbs':'Jovenski Gibbs',
};

function toCanonical(name) {
  if (!name) return '';
  const k = name.toLowerCase().trim();
  return CANONICAL[k] || name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getProfile(name) {
  const k = name.toLowerCase().trim();
  const role = DRIVER_ROSTER[k] || 'straight';
  return { role, type: role === 'tractor' ? 'tractor' : 'straight' };
}

function t2m(t) {
  if (!t) return 0;
  const m = t.match(/(\d+):(\d+)\s*(a|p)?/i);
  if (!m) return 0;
  let h = parseInt(m[1]), mn = parseInt(m[2]);
  if (m[3]) { if (m[3].toLowerCase() === 'p' && h !== 12) h += 12; if (m[3].toLowerCase() === 'a' && h === 12) h = 0; }
  return h * 60 + mn;
}

function m2t(m) {
  const h = Math.floor(m / 60) % 24, mn = m % 60;
  return `${h}:${String(mn).padStart(2, '0')}`;
}

// ─── MOTIVE API ───────────────────────────────────────────────────────────────
async function motiveGet(path, params = {}) {
  const url = new URL(`${MOTIVE_BASE}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'X-Api-Key': MOTIVE_KEY(), 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Motive ${path}: ${res.status}`);
  return await res.json();
}

async function fetchDrivingPeriods(startDate, endDate) {
  const all = [];
  let page = 1;
  while (page <= 20) {
    const data = await motiveGet('driving_periods', {
      start_date: startDate, end_date: endDate,
      per_page: 100, page_no: page
    });
    const periods = data.driving_periods || [];
    if (!periods.length) break;
    all.push(...periods);
    if (!data.pagination?.next_page_url || periods.length < 100) break;
    page++;
  }
  return all;
}

async function fetchMotiveUsers() {
  const all = [];
  let page = 1;
  while (page <= 10) {
    const data = await motiveGet('users', { per_page: 100, page_no: page });
    const users = data.users || [];
    if (!users.length) break;
    all.push(...users);
    if (!data.pagination?.next_page_url || users.length < 100) break;
    page++;
  }
  return all.map(u => {
    const usr = u.user || u;
    return ((usr.first_name || '') + ' ' + (usr.last_name || '')).trim();
  }).filter(n => n.length > 1);
}

// ─── GPS PROCESSING ───────────────────────────────────────────────────────────
function processDriverPeriods(periods) {
  const driverMap = {};
  periods.forEach(p => {
    const dp = p.driving_period || p;
    const driver = dp.driver || {};
    const vehicle = dp.vehicle || {};
    let name = ((driver.first_name || '') + ' ' + (driver.last_name || '')).trim();
    if (!name || name.length < 2) name = driver.username || '';
    if (!name || name.length < 2) return;
    const key = name.toLowerCase();
    if (!driverMap[key]) {
      driverMap[key] = { name, periods: [], totalEngineMin: 0, totalMiles: 0, vehicle: vehicle.number || '' };
    }
    const dur = (dp.duration_seconds || 0) / 60;
    const miles = dp.distance_miles || 0;
    driverMap[key].totalEngineMin += dur;
    driverMap[key].totalMiles += miles;
    driverMap[key].periods.push({
      start: dp.start_time || '',
      end: dp.end_time || '',
      dur, miles,
      type: dp.driving_period_type || ''
    });
    if (!driverMap[key].vehicle && vehicle.number) driverMap[key].vehicle = vehicle.number;
  });
  return Object.values(driverMap);
}

// ─── B600 HISTORY (loaded from public JSON via self-fetch) ────────────────────
let _b600Cache = null;
async function loadB600History(siteUrl) {
  if (_b600Cache) return _b600Cache;
  const res = await fetch(`${siteUrl}/b600-history.json`);
  if (!res.ok) return [];
  _b600Cache = await res.json();
  return _b600Cache;
}

// ─── NUVIZZ HISTORY (loaded from yearly files) ────────────────────────────────
let _nuvizzCache = null;
async function loadNuvizzHistory(siteUrl, startDate, endDate) {
  const startYear = startDate.slice(0, 4);
  const endYear = endDate.slice(0, 4);
  if (!_nuvizzCache) _nuvizzCache = [];
  const years = [...new Set([startYear, endYear])];
  const all = [];
  for (const year of years) {
    const res = await fetch(`${siteUrl}/nuvizz-${year}.json`);
    if (!res.ok) continue;
    const data = await res.json();
    // Remap 5-field slimmed format to full
    data.forEach(r => {
      const rec = r.length === 5 ? [r[0], r[1], r[2], '', r[3], '', r[4]] : r;
      all.push(rec);
    });
  }
  return all;
}

// ─── SCORING ──────────────────────────────────────────────────────────────────
function scoreDriver(driverData, b600History, nuvizzStops, scanDate) {
  const { name, totalEngineMin, totalMiles, periods, vehicle } = driverData;
  const profile = getProfile(name);
  const wage = WAGES[profile.type] || WAGES.default;
  const canonical = toCanonical(name);

  // Find B600 match for scan date
  const b600 = b600History.find(r => {
    if (r.date !== scanDate) return false;
    const rn = r.name.toLowerCase();
    const dn = name.toLowerCase();
    if (rn === dn) return true;
    const rl = rn.split(/\s+/).pop(), dl = dn.split(/\s+/).pop();
    return rl.length > 2 && rl === dl;
  });

  // Find NuVizz stops for scan date
  const myStops = nuvizzStops.filter(r => {
    if (r[0] !== scanDate) return false;
    const rn = r[2].toLowerCase().trim();
    const dn = name.toLowerCase().trim();
    if (rn === dn) return true;
    const rl = rn.split(/\s+/).pop(), dl = dn.split(/\s+/).pop();
    return rl.length > 2 && rl === dl;
  });

  const clockIn = b600?.clockIn || (periods[0]?.start ? new Date(periods[0].start).toTimeString().slice(0, 5) : '');
  const clockOut = b600?.clockOut || (periods[periods.length - 1]?.end ? new Date(periods[periods.length - 1].end).toTimeString().slice(0, 5) : '');
  const totalHrs = b600?.totalHrs || totalEngineMin / 60;

  const ciMin = t2m(clockIn);
  const coMin = t2m(clockOut);
  const shiftMin = coMin - ciMin;

  // GPS first/last movement
  const sortedPeriods = periods.sort((a, b) => a.start.localeCompare(b.start));
  const gpsStart = sortedPeriods[0]?.start ? new Date(sortedPeriods[0].start) : null;
  const gpsEnd = sortedPeriods[sortedPeriods.length - 1]?.end ? new Date(sortedPeriods[sortedPeriods.length - 1].end) : null;
  const gpsClockIn = gpsStart ? `${gpsStart.getHours()}:${String(gpsStart.getMinutes()).padStart(2, '0')}` : '';
  const gpsClockOut = gpsEnd ? `${gpsEnd.getHours()}:${String(gpsEnd.getMinutes()).padStart(2, '0')}` : '';

  const lateStart = gpsStart && ciMin ? t2m(gpsClockIn) - ciMin : 0;
  const earlyStop = gpsEnd && coMin ? coMin - t2m(gpsClockOut) : 0;
  const engineGapMin = shiftMin - totalEngineMin;
  const effectiveMph = totalHrs > 0 ? totalMiles / totalHrs : 0;

  const flags = [];
  let score = 0;
  let stolenMin = 0;

  // Thresholds by role
  const isShuttle = profile.role === 'shuttle' || profile.role === 'loadshift';
  const lateStartThresh = isShuttle ? 90 : 45;
  const earlyStopThresh = isShuttle ? 60 : 30;
  const engineGapThresh = isShuttle ? 120 : 75;

  // Flag: B600 clock-in vs GPS first movement
  if (b600 && gpsClockIn && lateStart > 30) {
    const pts = 30; score += pts; stolenMin += lateStart - 30;
    flags.push({ ico: '🔴', sev: 'critical', title: 'B600→GPS Clock-In Gap', detail: `Punched B600 at ${clockIn} but first GPS movement at ${gpsClockIn} — ${lateStart.toFixed(0)}min gap`, pts });
  }

  // Flag: late first movement
  if (!isShuttle && lateStart > lateStartThresh) {
    const pts = 20; score += pts; stolenMin += lateStart - lateStartThresh;
    flags.push({ ico: '🌅', sev: 'high', title: 'Late First Movement', detail: `No movement for ${lateStart.toFixed(0)}min after clock-in`, pts });
  }

  // Flag: early last movement
  if (earlyStop > earlyStopThresh) {
    const pts = 20; score += pts; stolenMin += earlyStop - earlyStopThresh;
    flags.push({ ico: '🏁', sev: 'high', title: 'Stopped Before Clock-Out', detail: `Last GPS movement ${earlyStop.toFixed(0)}min before clock-out`, pts });
  }

  // Flag: clock/engine gap
  if (engineGapMin > engineGapThresh) {
    const pts = 35; score += pts; stolenMin += (engineGapMin - engineGapThresh) * 0.7;
    flags.push({ ico: '⏱️', sev: 'critical', title: 'Clock/Engine Time Gap', detail: `Clocked ${(shiftMin / 60).toFixed(1)}h but engine on ${(totalEngineMin / 60).toFixed(1)}h — ${engineGapMin.toFixed(0)}min gap`, pts });
  }

  // Flag: low velocity
  if (!isShuttle && effectiveMph < 8 && totalMiles > 5) {
    const pts = 25; score += pts;
    flags.push({ ico: '🐢', sev: 'high', title: 'Low Route Velocity', detail: `${effectiveMph.toFixed(1)} mph effective`, pts });
  }

  // Flag: NuVizz stops vs GPS miles (low stops + high idle time)
  if (!isShuttle && myStops.length > 0) {
    const stopsPerHr = myStops.length / Math.max(totalHrs, 1);
    if (stopsPerHr < 1.5 && totalHrs > 4) {
      const pts = 20; score += pts;
      flags.push({ ico: '📦', sev: 'medium', title: 'Low Stops Per Hour', detail: `${myStops.length} stops in ${totalHrs.toFixed(1)}h = ${stopsPerHr.toFixed(1)}/hr (fleet avg ~2.5/hr)`, pts });
    }
  }

  let risk = 'low';
  if (score >= 80) risk = 'critical';
  else if (score >= 50) risk = 'high';
  else if (score >= 25) risk = 'medium';

  const stolenHrs = stolenMin / 60;
  const stolenDollars = stolenHrs * wage;

  return {
    name,
    canonicalName: canonical,
    driverType: profile.type,
    driverRole: profile.role,
    truck: vehicle,
    clockIn,
    clockOut,
    totalHrs: +totalHrs.toFixed(2),
    score,
    risk,
    flags,
    stolenHrs: +stolenHrs.toFixed(2),
    stolenDollars: +stolenDollars.toFixed(2),
    hasData: true,
    b600Matched: !!b600,
    gps: {
      deliveryStops: myStops.length,
      actualMiles: +totalMiles.toFixed(1),
      engineOnMin: +totalEngineMin.toFixed(0),
      effectiveMph: +effectiveMph.toFixed(1),
      lateStart: +lateStart.toFixed(0),
      earlyStop: +earlyStop.toFixed(0),
      engineGapMin: +engineGapMin.toFixed(0),
      gpsClockIn,
      gpsClockOut,
    }
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  const logs = [];
  const log = (msg) => { logs.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); console.log('[SCAN-RUN]', msg); };

  try {
    // Auth check
    const url = new URL(req.url);
    let startDate, endDate, secret;

    if (req.method === 'POST') {
      const body = await req.json();
      ({ startDate, endDate, secret } = body);
    } else {
      startDate = url.searchParams.get('startDate');
      endDate = url.searchParams.get('endDate');
      secret = url.searchParams.get('secret');
    }

    if (secret !== SCAN_SECRET()) {
      return new Response(JSON.stringify({ error: 'Unauthorized — wrong secret' }), { status: 401, headers: CORS });
    }

    if (!startDate || !endDate) {
      return new Response(JSON.stringify({ error: 'startDate and endDate required (YYYY-MM-DD)' }), { status: 400, headers: CORS });
    }

    const siteUrl = Netlify.env.get('URL') || 'https://sentinel-time-theft.netlify.app';
    log(`Scan: ${startDate} → ${endDate}`);

    // Step 1: Fetch Motive data
    log('Fetching driving_periods from Motive...');
    const periods = await fetchDrivingPeriods(startDate, endDate);
    log(`Got ${periods.length} driving periods`);

    log('Fetching Motive user roster...');
    const motiveUsers = await fetchMotiveUsers();
    log(`Got ${motiveUsers.length} Motive users`);

    // Step 2: Load stored data
    log('Loading B600 history...');
    const b600History = await loadB600History(siteUrl);
    log(`B600: ${b600History.length} punches`);

    log('Loading NuVizz history...');
    const nuvizzStops = await loadNuvizzHistory(siteUrl, startDate, endDate);
    log(`NuVizz: ${nuvizzStops.length} stops for date range`);

    // Step 3: Process each day in range
    const results = [];
    const dateList = [];
    let d = new Date(startDate);
    const end = new Date(endDate);
    while (d <= end) {
      dateList.push(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }

    for (const scanDate of dateList) {
      log(`Scoring ${scanDate}...`);
      const dayPeriods = periods.filter(p => {
        const dp = p.driving_period || p;
        const t = dp.start_time || '';
        return t.startsWith(scanDate);
      });

      const drivers = processDriverPeriods(dayPeriods);
      log(`  ${drivers.length} drivers with GPS on ${scanDate}`);

      // Add roster drivers with no GPS
      const driverNames = new Set(drivers.map(d => d.name.toLowerCase()));
      motiveUsers.forEach(name => {
        if (!name || driverNames.has(name.toLowerCase())) return;
        if (!DRIVER_ROSTER[name.toLowerCase()]) return; // only roster drivers
        drivers.push({ name, periods: [], totalEngineMin: 0, totalMiles: 0, vehicle: '' });
      });

      // Score each driver
      const dayResults = drivers.map(driver => {
        if (!driver.periods.length) {
          return {
            name: driver.name, canonicalName: toCanonical(driver.name),
            driverType: getProfile(driver.name).type, driverRole: getProfile(driver.name).role,
            truck: '', clockIn: '', clockOut: '', totalHrs: 0,
            score: 0, risk: 'nodata', flags: [], stolenHrs: 0, stolenDollars: 0,
            hasData: false, b600Matched: false,
            gps: { deliveryStops: 0, actualMiles: 0, engineOnMin: 0, effectiveMph: 0 }
          };
        }
        return scoreDriver(driver, b600History, nuvizzStops, scanDate);
      });

      dayResults.forEach(r => results.push({ ...r, scanDate }));
    }

    log(`Scored ${results.length} driver-day records`);

    // Step 4: Save to Firestore
    const scanId = `scan_${startDate}_${endDate}_${Date.now()}`;
    const flagged = results.filter(r => r.risk !== 'low' && r.risk !== 'nodata');
    const totalStolen = results.reduce((a, r) => a + r.stolenHrs, 0);
    const totalCost = results.reduce((a, r) => a + r.stolenDollars, 0);

    log('Saving to Firestore...');
    const db = getDb();
    await db.setDoc('sentinelScans', scanId, {
      scanId, startDate, endDate,
      createdAt: new Date().toISOString(),
      driverCount: results.length,
      flaggedCount: flagged.length,
      critical: results.filter(r => r.risk === 'critical').length,
      high: results.filter(r => r.risk === 'high').length,
      medium: results.filter(r => r.risk === 'medium').length,
      totalStolenHrs: +totalStolen.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      source: 'server',
      drivers: results
    });
    log(`Saved scan ${scanId}`);

    // Update driver history
    for (const r of results) {
      const canonical = r.canonicalName || r.name;
      if (!canonical) continue;
      const docId = canonical.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const existing = await db.getDoc('sentinelDriverHistory', docId);
      const ff = { ...(existing?.flagFrequency || {}) };
      (r.flags || []).forEach(f => { const t = f.title || ''; ff[t] = (ff[t] || 0) + 1; });
      await db.setDoc('sentinelDriverHistory', docId, {
        canonicalName: canonical, displayName: r.name,
        driverType: r.driverType || '', driverRole: r.driverRole || '',
        totalScans: (existing?.totalScans || 0) + 1,
        totalFlags: (existing?.totalFlags || 0) + r.flags.length,
        totalStolenHrs: +((existing?.totalStolenHrs || 0) + r.stolenHrs).toFixed(2),
        totalCost: +((existing?.totalCost || 0) + r.stolenDollars).toFixed(2),
        riskCounts: {
          critical: (existing?.riskCounts?.critical || 0) + (r.risk === 'critical' ? 1 : 0),
          high: (existing?.riskCounts?.high || 0) + (r.risk === 'high' ? 1 : 0),
          medium: (existing?.riskCounts?.medium || 0) + (r.risk === 'medium' ? 1 : 0),
          low: (existing?.riskCounts?.low || 0) + (r.risk === 'low' ? 1 : 0),
        },
        flagFrequency: ff,
        firstSeen: existing?.firstSeen || new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        lastScanId: scanId,
      });
    }

    log('Done.');
    return new Response(JSON.stringify({
      success: true, scanId, startDate, endDate,
      driverCount: results.length,
      flaggedCount: flagged.length,
      critical: results.filter(r => r.risk === 'critical').length,
      high: results.filter(r => r.risk === 'high').length,
      totalStolenHrs: +totalStolen.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      logs
    }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('[SCAN-RUN]', err);
    return new Response(JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 500), logs }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-scan-run' };
