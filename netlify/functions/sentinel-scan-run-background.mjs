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
const MOTIVE_BASE = 'https://api.gomotive.com/v1';  // fixed: was api.keeptruckin.com
const SCAN_SECRET = () => Netlify.env.get('SCAN_SECRET') || 'sentinel2026';

// Wage rates
const WAGES = { tractor: 27.50, straight: 23.00, default: 23.00 };

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

// Legacy helpers — kept as fallback shims. New code uses resolveDriver().
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

// driverKey — MUST match MarginIQ's slug function exactly so doc IDs line up
// across nuvizz_stops, timeclock_daily, and driver_classifications.
function driverKey(name) {
  if (!name) return null;
  return (String(name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 140)) || null;
}

// ─── DRIVER ROSTER FROM MARGINIQ (authoritative source) ──────────────────────
// Loads every doc from `driver_classifications` in davismarginiq Firestore
// and builds an alias→profile map. Falls back to the hardcoded DRIVER_ROSTER
// below if MarginIQ is unreachable.
//
// Each driver_classifications doc has:
//   driver_key, full_name, role (driver/owner_op/shuttle_driver/yard_jockey),
//   classification (W2/1099), default_vehicle_id, aliases[], status (active/...)
async function loadDriverRoster() {
  const out = {
    aliasMap: {},          // lookup key → { canonicalName, role, type, classification, employeeId, source }
    employeesById: {},     // employeeId/driver_key → full classification doc
    source: 'fallback',    // 'marginiq' | 'fallback'
    loadedAt: new Date().toISOString(),
    docCount: 0,
    aliasCount: 0,
    error: null
  };

  try {
    const url = `${HUB_FIRESTORE_BASE}:runQuery?key=${HUB_FIRESTORE_KEY}`;
    const query = {
      structuredQuery: {
        from: [{ collectionId: 'driver_classifications' }],
        limit: 500
      }
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    let aliasCount = 0;
    for (const row of rows) {
      if (!row.document) continue;
      const f = _fsFields(row.document.fields);
      const docId = row.document.name.split('/').pop();
      const key = f.driver_key || docId;
      if (!key) continue;
      // Exclude inactive employees so they don't get matched
      if (f.status && f.status !== 'active') continue;

      const role = f.role || '';
      // Map MarginIQ canonical role → SENTINEL profile
      let sentinelRole = 'straight';
      let sentinelType = 'straight';
      if (role === 'shuttle_driver') { sentinelRole = 'shuttle'; sentinelType = 'tractor'; }
      else if (role === 'yard_jockey') { sentinelRole = 'loadshift'; sentinelType = 'tractor'; }
      else if (role === 'driver' || role === 'owner_op') {
        // Determine tractor vs straight from default vehicle if available
        // (we don't have vehicles map here; assume straight unless aliases or
        // explicit truck_type field tells us otherwise)
        if (f.truck_type === 'tractor' || f.unit_type === 'tractor') {
          sentinelRole = 'tractor'; sentinelType = 'tractor';
        }
      } else if (role) {
        // Non-driver role — skip
        continue;
      } else {
        // No role — skip (probably warehouse/office)
        continue;
      }

      const canonicalName = f.full_name || f.fullName || `${f.first_name||f.firstName||''} ${f.last_name||f.lastName||''}`.trim() || key;
      const employeeId = f.employee_id || f.employeeId || docId;
      const profile = {
        canonicalName,
        role: sentinelRole,
        type: sentinelType,
        classification: f.classification || '',
        employeeId,
        defaultVehicleId: f.default_vehicle_id || f.defaultVehicleId || null,
        marginIqRole: role,
        source: 'marginiq'
      };
      out.employeesById[employeeId] = profile;
      out.docCount++;

      // Build aliases — driver_key, full_name, first/last splits, custom aliases
      const aliases = new Set();
      aliases.add(key);
      const fn = canonicalName.toLowerCase().trim();
      if (fn) aliases.add(fn);
      const parts = fn.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        // first-name only (e.g. "leslie")
        if (parts[0].length >= 3) aliases.add(parts[0]);
        // first-initial + last (e.g. "c head")
        aliases.add(`${parts[0][0]} ${parts[parts.length-1]}`);
        // "first last"
        aliases.add(`${parts[0]} ${parts[parts.length-1]}`);
      }
      const customAliases = Array.isArray(f.aliases) ? f.aliases : [];
      for (const a of customAliases) {
        const lower = String(a).toLowerCase().trim();
        if (lower) aliases.add(lower);
      }

      for (const a of aliases) {
        if (!out.aliasMap[a]) {
          out.aliasMap[a] = profile;
          aliasCount++;
        }
      }
    }
    out.aliasCount = aliasCount;
    out.source = 'marginiq';
    return out;
  } catch (e) {
    out.error = e.message;
    out.source = 'fallback';
    return out;
  }
}

// Resolve a Motive driver name → profile, using MarginIQ first then fallback.
// Returns { canonicalName, role, type, classification, employeeId, source, lookupKey, lookupMethod }
function resolveDriver(name, roster) {
  if (!name) return null;
  const trimmed = String(name).trim();
  const lower = trimmed.toLowerCase();
  const slug = driverKey(trimmed);

  // 1) Exact slug match against MarginIQ
  if (slug && roster.aliasMap[slug]) {
    return { ...roster.aliasMap[slug], lookupKey: slug, lookupMethod: 'marginiq-slug' };
  }
  // 2) Lower-cased name match against MarginIQ aliases
  if (roster.aliasMap[lower]) {
    return { ...roster.aliasMap[lower], lookupKey: lower, lookupMethod: 'marginiq-alias' };
  }
  // 3) First-initial + last-name fallback
  const parts = lower.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const fil = `${parts[0][0]} ${parts[parts.length-1]}`;
    if (roster.aliasMap[fil]) {
      return { ...roster.aliasMap[fil], lookupKey: fil, lookupMethod: 'marginiq-firstinitial' };
    }
  }
  // 4) Hardcoded fallback (only used if MarginIQ failed or driver missing there)
  if (DRIVER_ROSTER[lower]) {
    const fallbackRole = DRIVER_ROSTER[lower];
    const isShuttle = fallbackRole === 'shuttle' || fallbackRole === 'loadshift';
    return {
      canonicalName: CANONICAL[lower] || trimmed.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      role: fallbackRole,
      type: fallbackRole === 'tractor' || isShuttle ? 'tractor' : 'straight',
      classification: '',
      employeeId: null,
      source: 'fallback-hardcoded',
      lookupKey: lower,
      lookupMethod: 'sentinel-hardcoded'
    };
  }
  // 5) No match anywhere — emit a "best effort" record marked unmatched
  return {
    canonicalName: trimmed.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    role: 'straight',
    type: 'straight',
    classification: '',
    employeeId: null,
    source: 'unmatched',
    lookupKey: lower,
    lookupMethod: 'no-match'
  };
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

// Fetch all users WITH their numeric IDs
async function fetchMotiveUsersWithIds() {
  const all = [];
  let page = 1, total = null;
  while (page <= 20) {
    const data = await motiveGet('users', { per_page: 100, page_no: page, role: 'driver' });
    const users = data.users || [];
    if (!users.length) break;
    all.push(...users);
    const pg = data.pagination || {};
    if (typeof pg.total === 'number') total = pg.total;
    if (total !== null && all.length >= total) break;
    if (users.length < 100) break;
    page++;
  }
  return all.map(u => {
    const usr = u.user || u;
    const name = ((usr.first_name || '') + ' ' + (usr.last_name || '')).trim();
    return { id: usr.id, name };
  }).filter(u => u.name.length > 1);
}

// Fetch driving periods for ONE driver by driver_id
async function fetchDriverPeriods(driverId, startDate, endDate) {
  const all = [];
  let page = 1;
  while (page <= 10) {
    let data;
    try {
      data = await motiveGet('driving_periods', {
        driver_id: driverId,
        start_date: startDate,
        end_date: endDate,
        per_page: 100,
        page_no: page
      });
    } catch (e) {
      break;
    }
    const periods = data.driving_periods || [];
    if (!periods.length) break;
    all.push(...periods);
    const pg = data.pagination || {};
    const tot = typeof pg.total === 'number' ? pg.total : null;
    if (tot !== null && all.length >= tot) break;
    if (periods.length < 100) break;
    page++;
  }
  return all;
}

// Fetch driving periods for ALL drivers in batches of 10 concurrent requests
async function fetchDrivingPeriods(startDate, endDate, motiveUsers, onProgress) {
  const all = [];
  const BATCH = 10;
  for (let i = 0; i < motiveUsers.length; i += BATCH) {
    const batch = motiveUsers.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(u => fetchDriverPeriods(u.id, startDate, endDate))
    );
    results.forEach(r => {
      if (r.status === 'fulfilled') all.push(...r.value);
    });
    if (onProgress) await onProgress(Math.min(i + BATCH, motiveUsers.length), motiveUsers.length);
  }
  return all;
}

// ─── GPS PROCESSING ───────────────────────────────────────────────────────────
// Aggregates driving_periods by driver and captures the full Motive metadata
// (driver IDs, every vehicle they touched that day, raw fields per period) so
// the UI can show every input we used for scoring.
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
      driverMap[key] = {
        name,
        // Motive driver record
        motiveDriver: {
          id: driver.id || null,
          first_name: driver.first_name || '',
          last_name: driver.last_name || '',
          username: driver.username || '',
          email: driver.email || '',
          role: driver.role || '',
          status: driver.status || ''
        },
        // Every vehicle this driver touched on this date
        vehiclesUsed: {},   // keyed by vehicle.id → {id, number, make, model, year}
        periods: [],
        totalEngineMin: 0,
        totalMiles: 0,
        vehicle: vehicle.number || '' // primary truck (first one seen) for display
      };
    }
    const dur = (dp.duration_seconds || 0) / 60;
    const miles = dp.distance_miles || 0;
    driverMap[key].totalEngineMin += dur;
    driverMap[key].totalMiles += miles;

    // Track this vehicle if we haven't seen it yet
    if (vehicle.id && !driverMap[key].vehiclesUsed[vehicle.id]) {
      driverMap[key].vehiclesUsed[vehicle.id] = {
        id: vehicle.id,
        number: vehicle.number || '',
        make: vehicle.make || '',
        model: vehicle.model || '',
        year: vehicle.year || null,
        vin: vehicle.vin || ''
      };
    }

    driverMap[key].periods.push({
      start: dp.start_time || '',
      end: dp.end_time || '',
      dur,
      miles,
      type: dp.driving_period_type || '',
      // Per-period vehicle (in case the driver swapped trucks mid-day)
      vehicleId: vehicle.id || null,
      vehicleNumber: vehicle.number || '',
      // Location data Motive returns when available
      startLat: dp.start_location?.lat || null,
      startLon: dp.start_location?.lon || null,
      startAddr: dp.start_location?.description || dp.start_location?.address || '',
      endLat: dp.end_location?.lat || null,
      endLon: dp.end_location?.lon || null,
      endAddr: dp.end_location?.description || dp.end_location?.address || '',
      // Speed if present
      maxSpeedMph: dp.max_speed_mph || null,
      avgSpeedMph: dp.avg_speed_mph || null
    });
    if (!driverMap[key].vehicle && vehicle.number) driverMap[key].vehicle = vehicle.number;
  });
  return Object.values(driverMap);
}

// ─── DATA HUB CONFIG ─────────────────────────────────────────────────────────
const HUB_FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/davismarginiq/databases/(default)/documents';
const HUB_FIRESTORE_KEY = 'AIzaSyDyRyjuiP_UD8T_2xmW2xLjvqx9RLCYCmo';

function _fsFields(fields) {
  const out = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('doubleValue' in v) out[k] = Number(v.doubleValue);
    else if ('integerValue' in v) out[k] = Number(v.integerValue);
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('arrayValue' in v) out[k] = (v.arrayValue.values || []).map(x => {
      if ('stringValue' in x) return x.stringValue;
      if ('doubleValue' in x) return Number(x.doubleValue);
      if ('integerValue' in x) return Number(x.integerValue);
      if ('mapValue' in x) return _fsFields(x.mapValue.fields);
      return null;
    });
    else if ('mapValue' in v) out[k] = _fsFields(v.mapValue.fields);
  }
  return out;
}

// ─── B600 HISTORY ────────────────────────────────────────────────────────────
let _b600Cache = null;
async function loadB600History(_siteUrl) {
  if (_b600Cache) return _b600Cache;
  const today = new Date();
  const earliest = new Date(today);
  earliest.setDate(today.getDate() - 120);
  const fromIso = earliest.toISOString().slice(0, 10);
  const toIso = today.toISOString().slice(0, 10);
  const query = {
    structuredQuery: {
      from: [{ collectionId: 'timeclock_daily' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: fromIso } } },
            { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: toIso } } }
          ]
        }
      },
      limit: 5000
    }
  };
  try {
    const url = `${HUB_FIRESTORE_BASE}:runQuery?key=${HUB_FIRESTORE_KEY}`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
    if (!res.ok) { console.error(`B600 hub query failed: HTTP ${res.status}`); _b600Cache = []; return _b600Cache; }
    const rows = await res.json();
    const records = [];
    for (const row of rows) {
      if (!row.document) continue;
      const f = _fsFields(row.document.fields);
      if (!f.date || !f.display_name) continue;
      records.push({
        name: f.display_name,
        driver_key: f.driver_key || null,   // MarginIQ canonical slug, links to driver_classifications
        clockIn: f.clock_in || '',
        clockOut: f.clock_out || '',
        date: f.date
      });
    }
    _b600Cache = records;
    return records;
  } catch (e) {
    console.error('B600 hub load error:', e);
    _b600Cache = [];
    return _b600Cache;
  }
}

// ─── NUVIZZ HISTORY ──────────────────────────────────────────────────────────
async function loadNuvizzHistory(_siteUrl, startDate, endDate) {
  const all = [];
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  const chunkDays = 7;
  let cur = new Date(start);
  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    const fromIso = cur.toISOString().slice(0, 10);
    const toIso = chunkEnd.toISOString().slice(0, 10);
    const query = {
      structuredQuery: {
        from: [{ collectionId: 'nuvizz_stops' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'delivery_date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: fromIso } } },
              { fieldFilter: { field: { fieldPath: 'delivery_date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: toIso } } }
            ]
          }
        },
        limit: 5000
      }
    };
    try {
      const url = `${HUB_FIRESTORE_BASE}:runQuery?key=${HUB_FIRESTORE_KEY}`;
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
      if (!res.ok) { console.warn(`NuVizz chunk ${fromIso}..${toIso}: HTTP ${res.status}`); cur.setUTCDate(cur.getUTCDate() + chunkDays); continue; }
      const rows = await res.json();
      for (const row of rows) {
        if (!row.document) continue;
        const f = _fsFields(row.document.fields);
        if (!f.delivery_date || !f.driver_name) continue;
        all.push([
          f.delivery_date,
          '',
          f.driver_name || '',
          f.ship_to || '',
          f.city || '',
          f.zip || '',
          f.stop_number || f.pro || '',
          f.driver_key || null   // [7] MarginIQ canonical slug
        ]);
      }
    } catch (e) {
      console.warn(`NuVizz hub chunk error ${fromIso}..${toIso}:`, e.message);
    }
    cur.setUTCDate(cur.getUTCDate() + chunkDays);
  }
  return all;
}

// ─── SCORING ──────────────────────────────────────────────────────────────────
function scoreDriver(driverData, b600History, nuvizzStops, scanDate) {
  const { name, totalEngineMin, totalMiles, periods, vehicle, motiveDriver, vehiclesUsed, resolved } = driverData;
  // `resolved` is the MarginIQ-or-fallback profile. Falls back to local hardcoded
  // lookup if not provided (defensive — this should always be set by the caller).
  const profile = resolved || (() => {
    const p = getProfile(name);
    return { ...p, canonicalName: toCanonical(name), source: 'fallback-hardcoded', lookupMethod: 'sentinel-hardcoded', lookupKey: name.toLowerCase().trim() };
  })();
  const wage = WAGES[profile.type] || WAGES.default;
  const canonical = profile.canonicalName || toCanonical(name);
  const rosterKey = profile.lookupKey || name.toLowerCase().trim();
  const inRoster = profile.source !== 'unmatched';

  // B600 matching: try driver_key slug first (MarginIQ canonical), then exact
  // name, then last-name fuzzy fallback.
  const driverSlug = profile.lookupKey && profile.source === 'marginiq' ? profile.lookupKey : driverKey(canonical);
  const b600 = b600History.find(r => {
    if (r.date !== scanDate) return false;
    if (r.driver_key && driverSlug && r.driver_key === driverSlug) return true;
    const rn = r.name.toLowerCase();
    const dn = name.toLowerCase();
    const cn = canonical.toLowerCase();
    if (rn === dn || rn === cn) return true;
    const rl = rn.split(/\s+/).pop(), dl = dn.split(/\s+/).pop();
    return rl.length > 2 && rl === dl;
  });

  // NuVizz matching: try driver_key slug first, then exact name, then last-name fuzzy.
  const myStops = nuvizzStops.filter(r => {
    if (r[0] !== scanDate) return false;
    // r[7] is driver_key (added v3.10.16); fall back to name fields if missing.
    if (r[7] && driverSlug && r[7] === driverSlug) return true;
    const rn = (r[2] || '').toLowerCase().trim();
    const dn = name.toLowerCase().trim();
    const cn = canonical.toLowerCase().trim();
    if (rn === dn || rn === cn) return true;
    const rl = rn.split(/\s+/).pop(), dl = dn.split(/\s+/).pop();
    return rl.length > 2 && rl === dl;
  });

  const clockIn = b600?.clockIn || (periods[0]?.start ? new Date(periods[0].start).toTimeString().slice(0, 5) : '');
  const clockOut = b600?.clockOut || (periods[periods.length - 1]?.end ? new Date(periods[periods.length - 1].end).toTimeString().slice(0, 5) : '');
  const totalHrs = b600?.totalHrs || totalEngineMin / 60;

  const ciMin = t2m(clockIn);
  const coMin = t2m(clockOut);
  const shiftMin = coMin - ciMin;

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

  const isShuttle = profile.role === 'shuttle' || profile.role === 'loadshift';
  const thresholds = {
    lateStartMin: isShuttle ? 90 : 45,
    earlyStopMin: isShuttle ? 60 : 30,
    engineGapMin: isShuttle ? 120 : 75,
    velocityFloorMph: 8,
    stopsPerHrMin: 1.5,
    b600GpsClockInGapMin: 30,
    riskMediumScore: 25,
    riskHighScore: 50,
    riskCriticalScore: 80
  };
  const lateStartThresh = thresholds.lateStartMin;
  const earlyStopThresh = thresholds.earlyStopMin;
  const engineGapThresh = thresholds.engineGapMin;

  if (b600 && gpsClockIn && lateStart > 30) {
    const pts = 30; score += pts; stolenMin += lateStart - 30;
    flags.push({ ico: '🔴', sev: 'critical', title: 'B600→GPS Clock-In Gap', detail: `Punched B600 at ${clockIn} but first GPS movement at ${gpsClockIn} — ${lateStart.toFixed(0)}min gap`, pts });
  }
  if (!isShuttle && lateStart > lateStartThresh) {
    const pts = 20; score += pts; stolenMin += lateStart - lateStartThresh;
    flags.push({ ico: '🌅', sev: 'high', title: 'Late First Movement', detail: `No movement for ${lateStart.toFixed(0)}min after clock-in`, pts });
  }
  if (earlyStop > earlyStopThresh) {
    const pts = 20; score += pts; stolenMin += earlyStop - earlyStopThresh;
    flags.push({ ico: '🏁', sev: 'high', title: 'Stopped Before Clock-Out', detail: `Last GPS movement ${earlyStop.toFixed(0)}min before clock-out`, pts });
  }
  if (engineGapMin > engineGapThresh) {
    const pts = 35; score += pts; stolenMin += (engineGapMin - engineGapThresh) * 0.7;
    flags.push({ ico: '⏱️', sev: 'critical', title: 'Clock/Engine Time Gap', detail: `Clocked ${(shiftMin / 60).toFixed(1)}h but engine on ${(totalEngineMin / 60).toFixed(1)}h — ${engineGapMin.toFixed(0)}min gap`, pts });
  }
  if (!isShuttle && effectiveMph < 8 && totalMiles > 5) {
    const pts = 25; score += pts;
    flags.push({ ico: '🐢', sev: 'high', title: 'Low Route Velocity', detail: `${effectiveMph.toFixed(1)} mph effective`, pts });
  }
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

  // ─── PERFORMANCE METRICS ───────────────────────────────────────────────────
  // Pre-route dwell:  clockIn → first GPS movement (warehouse loiter)
  // On-route minutes: first GPS movement → last GPS movement (productive route time)
  // Post-route dwell: last GPS movement → clockOut (return + paperwork + lounging)
  const ciAbs = ciMin;
  const coAbs = coMin;
  const fmAbs = gpsStart ? t2m(gpsClockIn) : 0;
  const lmAbs = gpsEnd ? t2m(gpsClockOut) : 0;
  const preRouteMin   = (ciAbs && fmAbs) ? Math.max(0, fmAbs - ciAbs) : 0;
  const onRouteMin    = (fmAbs && lmAbs) ? Math.max(0, lmAbs - fmAbs) : 0;
  const postRouteMin  = (lmAbs && coAbs) ? Math.max(0, coAbs - lmAbs) : 0;
  const stops = myStops.length;
  const stopsPerHrOnRoute = onRouteMin > 0 ? (stops / (onRouteMin / 60)) : 0;
  const minPerStop        = stops > 0 ? (onRouteMin / stops) : 0;
  const milesPerStop      = stops > 0 ? (totalMiles / stops) : 0;
  const drivePctOnRoute   = onRouteMin > 0 ? (totalEngineMin / onRouteMin) : 0;

  return {
    name, canonicalName: canonical,
    driverType: profile.type, driverRole: profile.role,
    truck: vehicle, clockIn, clockOut,
    totalHrs: +totalHrs.toFixed(2),
    score, risk, flags,
    stolenHrs: +stolenHrs.toFixed(2),
    stolenDollars: +stolenDollars.toFixed(2),
    hasData: true, b600Matched: !!b600,
    gps: {
      deliveryStops: myStops.length,
      actualMiles: +totalMiles.toFixed(1),
      engineOnMin: +totalEngineMin.toFixed(0),
      effectiveMph: +effectiveMph.toFixed(1),
      lateStart: +lateStart.toFixed(0),
      earlyStop: +earlyStop.toFixed(0),
      engineGapMin: +engineGapMin.toFixed(0),
      gpsClockIn, gpsClockOut,
    },
    perf: {
      preRouteMin:    +preRouteMin.toFixed(0),
      onRouteMin:     +onRouteMin.toFixed(0),
      postRouteMin:   +postRouteMin.toFixed(0),
      stops,
      totalMiles:     +totalMiles.toFixed(1),
      stopsPerHr:     +stopsPerHrOnRoute.toFixed(2),
      minPerStop:     +minPerStop.toFixed(1),
      milesPerStop:   +milesPerStop.toFixed(1),
      drivePctOnRoute:+drivePctOnRoute.toFixed(3),
      effectiveMph:   +effectiveMph.toFixed(1),
      firstMovement:  gpsClockIn,
      lastMovement:   gpsClockOut,
    },
    // Comprehensive `inputs` object — every raw value that fed into scoring.
    // The UI uses this to surface "why this driver, why this score" so the
    // operator can audit Sentinel against the source of truth (Motive + B600
    // + NuVizz + roster).
    inputs: {
      // ── Motive driver assignment ──
      motive: {
        driverId: motiveDriver?.id || null,
        firstName: motiveDriver?.first_name || '',
        lastName: motiveDriver?.last_name || '',
        username: motiveDriver?.username || '',
        email: motiveDriver?.email || '',
        role: motiveDriver?.role || '',
        status: motiveDriver?.status || '',
        // Every truck this driver touched on this date
        vehicles: Object.values(vehiclesUsed || {}),
        primaryTruck: vehicle || ''
      },
      // ── Roster lookup (MarginIQ driver_classifications) ──
      roster: {
        rawNameFromMotive: name,
        lookupKey: profile.lookupKey || rosterKey,
        lookupMethod: profile.lookupMethod || 'unknown',
        matched: profile.source !== 'unmatched',
        source: profile.source || 'unknown',  // 'marginiq' | 'fallback-hardcoded' | 'unmatched'
        canonicalName: canonical,
        employeeId: profile.employeeId || null,
        defaultVehicleId: profile.defaultVehicleId || null,
        marginIqRole: profile.marginIqRole || null,
        classification: profile.classification || null,  // W2 / 1099 / ''
        derivedRole: profile.role,
        derivedType: profile.type,
        wageRate: wage
      },
      // ── B600 punch (the clock-in/out we used) ──
      b600: b600 ? {
        matchedRecordName: b600.name,
        clockIn: b600.clockIn,
        clockOut: b600.clockOut,
        date: b600.date,
        clockInMinutes: t2m(b600.clockIn),
        clockOutMinutes: t2m(b600.clockOut),
        shiftMinutes: t2m(b600.clockOut) - t2m(b600.clockIn)
      } : { matched: false, note: 'No B600 punch matched — used GPS first/last as fallback' },
      // ── NuVizz stops (manifest count + raw rows) ──
      nuvizz: {
        stopCount: myStops.length,
        stops: myStops.map(s => ({
          date: s[0], deliveryEnd: s[1], driverName: s[2],
          shipTo: s[3], city: s[4], zip: s[5], stopNumber: s[6]
        }))
      },
      // ── Scoring thresholds applied (varies by role) ──
      thresholds,
      // ── Derived intermediate values ──
      derived: {
        clockInUsed: clockIn,
        clockOutUsed: clockOut,
        clockSource: b600 ? 'b600' : 'gps-fallback',
        gpsFirstMovement: gpsClockIn,
        gpsLastMovement: gpsClockOut,
        clockInMin: ciMin,
        clockOutMin: coMin,
        shiftMin,
        gpsFirstMin: gpsStart ? t2m(gpsClockIn) : 0,
        gpsLastMin: gpsEnd ? t2m(gpsClockOut) : 0,
        engineOnMin: +totalEngineMin.toFixed(1),
        totalMilesRaw: +totalMiles.toFixed(2),
        engineGapMin: +engineGapMin.toFixed(1),
        lateStartMin: +lateStart.toFixed(1),
        earlyStopMin: +earlyStop.toFixed(1),
        effectiveMph: +effectiveMph.toFixed(2),
        totalHrs: +totalHrs.toFixed(2)
      }
    },
    // Raw Motive driving_periods — the source-of-truth records used. Each
    // entry is what Motive returned: start, end, duration_minutes,
    // distance_miles, vehicle, period type, location.
    rawPeriods: periods.map(p => ({
      start: p.start || '',
      end: p.end || '',
      durMin: +Number(p.dur || 0).toFixed(1),
      miles: +Number(p.miles || 0).toFixed(2),
      type: p.type || '',
      vehicleNumber: p.vehicleNumber || '',
      vehicleId: p.vehicleId || null,
      startLat: p.startLat || null,
      startLon: p.startLon || null,
      startAddr: p.startAddr || '',
      endLat: p.endLat || null,
      endLon: p.endLon || null,
      endAddr: p.endAddr || '',
      maxSpeedMph: p.maxSpeedMph || null,
      avgSpeedMph: p.avgSpeedMph || null
    }))
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  const logs = [];
  let _sid = 'current';
  let startedAtTop = new Date().toISOString();
  const log = (msg) => {
    logs.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
    console.log('[SCAN-BG]', msg);
  };

  try {
    const url = new URL(req.url);
    let startDate, endDate, secret;

    if (req.method === 'POST') {
      const body = await req.json();
      ({ startDate, endDate, secret } = body);
      _sid = body.statusId || 'current';
    } else {
      startDate = url.searchParams.get('startDate');
      endDate = url.searchParams.get('endDate');
      secret = url.searchParams.get('secret');
      _sid = url.searchParams.get('statusId') || 'current';
    }

    // Secret check is optional now — if provided and wrong, reject; if missing, allow.
    // The function is only invokable from the deployed Netlify domain anyway, and
    // the heavy artifact (Motive API key) stays server-side.
    if (secret && secret !== SCAN_SECRET()) {
      return new Response(JSON.stringify({ error: 'Unauthorized — wrong secret' }), { status: 401, headers: CORS });
    }
    if (!startDate || !endDate) {
      return new Response(JSON.stringify({ error: 'startDate and endDate required (YYYY-MM-DD)' }), { status: 400, headers: CORS });
    }

    const siteUrl = Netlify.env.get('URL') || 'https://sentinel-time-theft.netlify.app';
    const startedAt = startedAtTop;
    const dbForStatus = getDb();
    let lastStatusUpdate = 0;
    const writeStatus = async (msg, force=false) => {
      const now = Date.now();
      if (!force && now - lastStatusUpdate < 1000) return;
      lastStatusUpdate = now;
      try {
        await dbForStatus.setDoc('sentinelScanStatus', _sid, {
          statusId: _sid, startedAt, status: 'running',
          startDate, endDate,
          logs: logs.slice(-200), progress: msg,
          updatedAt: new Date().toISOString(),
        });
      } catch(e) {}
    };

    log(`Scan: ${startDate} → ${endDate}`);
    await writeStatus(`Scan ${startDate} → ${endDate} starting`, true);

    // Step 0: Load authoritative driver roster from MarginIQ driver_classifications
    log('Loading driver roster from MarginIQ (driver_classifications)...');
    await writeStatus('Loading MarginIQ driver roster...', true);
    const roster = await loadDriverRoster();
    if (roster.source === 'marginiq') {
      log(`MarginIQ roster: ${roster.docCount} drivers, ${roster.aliasCount} aliases (active only)`);
    } else {
      log(`⚠️  MarginIQ roster unavailable (${roster.error || 'unknown'}). Falling back to hardcoded list.`);
    }
    await writeStatus(`Roster: ${roster.docCount} drivers from ${roster.source}`, true);

    // Step 1: Fetch Motive drivers WITH IDs
    log('Fetching Motive driver roster (with IDs)...');
    const motiveUsers = await fetchMotiveUsersWithIds();
    log(`Got ${motiveUsers.length} Motive drivers`); await writeStatus(`Got ${motiveUsers.length} Motive drivers`, true);

    // Step 2: Fetch driving periods PER DRIVER — fixes the 12-driver bug
    log('Fetching driving_periods per driver (batches of 10)...');
    const periods = await fetchDrivingPeriods(startDate, endDate, motiveUsers, async (done, total) => {
      log(`  driving_periods: ${done}/${total} drivers fetched`);
      await writeStatus(`Fetching driving_periods: ${done}/${total} drivers`);
    });
    log(`Got ${periods.length} driving periods across all drivers`); await writeStatus(`Got ${periods.length} driving periods`, true);

    // Step 3: Load B600 + NuVizz
    log('Loading B600 history...');
    const b600History = await loadB600History(siteUrl);
    log(`B600: ${b600History.length} punches`); await writeStatus(`B600: ${b600History.length} punches`, true);

    log('Loading NuVizz history...');
    const nuvizzStops = await loadNuvizzHistory(siteUrl, startDate, endDate);
    log(`NuVizz: ${nuvizzStops.length} stops for date range`); await writeStatus(`NuVizz: ${nuvizzStops.length} stops`, true);

    // Step 4: Score each driver per day
    const results = [];
    const dateList = [];
    let d = new Date(startDate);
    const endD = new Date(endDate);
    while (d <= endD) {
      dateList.push(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }

    for (const scanDate of dateList) {
      log(`Scoring ${scanDate}...`); await writeStatus(`Scoring ${scanDate}`, true);
      const dayPeriods = periods.filter(p => {
        const dp = p.driving_period || p;
        const t = dp.start_time || '';
        return t.startsWith(scanDate);
      });

      const drivers = processDriverPeriods(dayPeriods);
      log(`  ${drivers.length} drivers with GPS on ${scanDate}`);

      // Resolve every Motive driver against MarginIQ roster
      drivers.forEach(driver => {
        driver.resolved = resolveDriver(driver.name, roster);
      });

      // Add roster drivers with no GPS this day — pull from MarginIQ first,
      // then fallback hardcoded
      const driverNames = new Set(drivers.map(dr => dr.name.toLowerCase()));
      motiveUsers.forEach(u => {
        if (!u.name || driverNames.has(u.name.toLowerCase())) return;
        const r = resolveDriver(u.name, roster);
        // Only auto-add if MarginIQ knows this driver (don't add unmatched)
        if (r && r.source !== 'unmatched') {
          drivers.push({
            name: u.name,
            resolved: r,
            periods: [],
            totalEngineMin: 0,
            totalMiles: 0,
            vehicle: '',
            motiveDriver: { id: u.id, first_name:'', last_name:'', username:u.name, email:'', role:'', status:'' },
            vehiclesUsed: {}
          });
        }
      });

      const dayResults = drivers.map(driver => {
        const r = driver.resolved || resolveDriver(driver.name, roster);
        if (!driver.periods.length) {
          return {
            name: driver.name,
            canonicalName: r.canonicalName,
            driverType: r.type,
            driverRole: r.role,
            truck: '', clockIn: '', clockOut: '', totalHrs: 0,
            score: 0, risk: 'nodata', flags: [], stolenHrs: 0, stolenDollars: 0,
            hasData: false, b600Matched: false,
            gps: { deliveryStops: 0, actualMiles: 0, engineOnMin: 0, effectiveMph: 0 },
            inputs: {
              motive: { driverId: driver.motiveDriver?.id || null },
              roster: {
                rawNameFromMotive: driver.name,
                lookupKey: r.lookupKey,
                lookupMethod: r.lookupMethod,
                matched: r.source !== 'unmatched',
                source: r.source,
                canonicalName: r.canonicalName,
                employeeId: r.employeeId,
                marginIqRole: r.marginIqRole,
                classification: r.classification,
                derivedRole: r.role,
                derivedType: r.type,
                wageRate: WAGES[r.type] || WAGES.default
              }
            }
          };
        }
        return scoreDriver(driver, b600History, nuvizzStops, scanDate);
      });

      dayResults.forEach(r => results.push({ ...r, scanDate }));
    }

    log(`Scored ${results.length} driver-day records`); await writeStatus(`Scored ${results.length} driver-day records`, true);

    // Step 5: Save to Firestore
    const scanId = `scan_${startDate}_${endDate}_${Date.now()}`;
    const flagged = results.filter(r => r.risk !== 'low' && r.risk !== 'nodata');
    const totalStolen = results.reduce((a, r) => a + r.stolenHrs, 0);
    const totalCost = results.reduce((a, r) => a + r.stolenDollars, 0);

    log('Saving to Firestore...');
    const db = getDb();
    await db.setDoc('sentinelScans', scanId, {
      scanId, startDate, endDate,
      createdAt: new Date().toISOString(),
      // Roster metadata — lets us tell which scans used the live MarginIQ
      // roster vs the hardcoded fallback (and how many drivers/aliases).
      rosterSource: roster.source,
      rosterDocCount: roster.docCount,
      rosterAliasCount: roster.aliasCount,
      rosterError: roster.error || null,
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
    log(`Saved scan ${scanId}`); await writeStatus(`Saved scan ${scanId}`, true);

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

    // ─── Step 6: Per-driver-per-day performance records ──────────────────────
    // One doc per (driver, date) — used by /api/sentinel-performance for trend
    // analysis, regression fitting, and the Performance tab.
    log('Saving driverPerformanceDaily records...');
    let perfWrites = 0;
    for (const r of results) {
      if (!r.hasData || !r.perf) continue;
      if (r.perf.onRouteMin <= 0 && r.perf.totalMiles <= 0) continue;
      const canonical = r.canonicalName || r.name;
      if (!canonical) continue;
      const docId = `${r.scanDate}_${canonical.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      try {
        await db.setDoc('driverPerformanceDaily', docId, {
          date: r.scanDate,
          canonicalName: canonical,
          displayName: r.name,
          driverType: r.driverType || 'straight',
          driverRole: r.driverRole || '',
          truck: r.truck || '',
          clockIn: r.clockIn || '',
          clockOut: r.clockOut || '',
          firstMovement: r.perf.firstMovement || '',
          lastMovement: r.perf.lastMovement || '',
          preRouteMin: r.perf.preRouteMin,
          onRouteMin: r.perf.onRouteMin,
          postRouteMin: r.perf.postRouteMin,
          totalMiles: r.perf.totalMiles,
          stops: r.perf.stops,
          stopsPerHr: r.perf.stopsPerHr,
          minPerStop: r.perf.minPerStop,
          milesPerStop: r.perf.milesPerStop,
          drivePctOnRoute: r.perf.drivePctOnRoute,
          effectiveMph: r.perf.effectiveMph,
          totalHrs: r.totalHrs,
          score: r.score,
          risk: r.risk,
          stolenHrs: r.stolenHrs,
          flagCount: (r.flags || []).length,
          scanId,
          updatedAt: new Date().toISOString(),
        });
        perfWrites++;
      } catch (e) {
        console.warn(`perf write failed for ${docId}:`, e.message);
      }
    }
    log(`Wrote ${perfWrites} performance records`); await writeStatus(`Wrote ${perfWrites} performance records`, true);

    log('Done.');
    // Final status doc with result payload
    try {
      await dbForStatus.setDoc('sentinelScanStatus', _sid, {
        statusId: _sid, startedAt, finishedAt: new Date().toISOString(),
        status: 'done',
        startDate, endDate, scanId,
        logs: logs.slice(-200), progress: 'Done',
        result: {
          scanId,
          driverCount: results.length,
          flaggedCount: flagged.length,
          critical: results.filter(r => r.risk === 'critical').length,
          high: results.filter(r => r.risk === 'high').length,
          totalStolenHrs: +totalStolen.toFixed(2),
          totalCost: +totalCost.toFixed(2),
        },
        updatedAt: new Date().toISOString(),
      });
    } catch(e) {}
    return new Response(JSON.stringify({
      success: true, scanId, statusId: _sid, startDate, endDate,
      driverCount: results.length,
      flaggedCount: flagged.length,
      critical: results.filter(r => r.risk === 'critical').length,
      high: results.filter(r => r.risk === 'high').length,
      totalStolenHrs: +totalStolen.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      logs
    }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('[SCAN-BG]', err);
    try {
      await getDb().setDoc('sentinelScanStatus', _sid, {
        statusId: _sid,
        startedAt: startedAtTop,
        finishedAt: new Date().toISOString(),
        status: 'error',
        error: err.message,
        logs: logs.slice(-200),
        updatedAt: new Date().toISOString(),
      });
    } catch(e) {}
    return new Response(JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 500), logs }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-scan-run' };
