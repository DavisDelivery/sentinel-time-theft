// netlify/functions/sentinel-day-trail.js
// One driver's GPS trail for one day, as Motive would show it.
//
// GET /api/sentinel-day-trail?driverSlug=X&date=YYYY-MM-DD
//
// Answers "what was he actually doing that day?" without leaving SENTINEL.
// Motive's raw breadcrumb feed is far too heavy to hand a browser — a single
// tractor-day came back as 3,612 points / 2.3 MB — so the reduction happens
// here and the client gets a compact route plus a stop list.
//
// PRIVACY NOTE. #41 deliberately stopped SENTINEL *recording* where a driver
// goes off-route: no addresses, no ZIPs, in storage or in any API response.
// This endpoint is the operator-initiated exception and it is scoped to stay
// one: it reads live from Motive on request, returns the trail in the HTTP
// response, and writes NOTHING to Firestore. Nothing here is persisted,
// scored, aggregated or used by the engine. Removing the button removes the
// capability; no residue is left behind in a record. Do not add a write path
// to this file.

import { getDb } from './_firebase-admin.js';
import { getDrivingPeriods, motiveUtcToNaiveET } from './_motive.js';

const VERSION = 'v1.0.0-day-trail';
const MOTIVE_BASE_V1 = 'https://api.gomotive.com/v1';
const MOTIVE_BASE_V2 = 'https://api.gomotive.com/v2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DRIVER_SLUG_RE = /^[a-z0-9_]+$/;

// A browser map stays responsive to a few hundred vertices; past that the
// polyline costs more than it shows. Stops are kept whole regardless.
const MAX_ROUTE_POINTS = 700;
// Below this the vehicle is parked, not crawling in traffic.
const MOVING_SPEED_MPH = 1;
// Shorter than this is a light, not a stop worth listing.
const MIN_STOP_MIN = 3;

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

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Minutes since midnight of `date`, in naive ET — the same clock the rest of
// SENTINEL works in, so these line up with clockIn/clockOut and delivery times.
function minutesInto(dayStartMs, dt) {
  if (!dt) return null;
  return Math.round((dt.getTime() - dayStartMs) / 60000);
}

const hhmmToMin = (hhmm) => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
};

/**
 * Fetch the vehicle's raw location history for the calendar day.
 *
 * Motive's v2 vehicle_locations takes whole dates, not instants, and returns
 * them in UTC — an ET day (UTC-4/-5) therefore spans two of its dates, D and
 * D+1, and we clamp to the shift window afterwards. D+1 is what keeps a late
 * finish or a night shift crossing midnight intact.
 *
 * D-1 is deliberately NOT fetched: it covers UTC [D-1 00:00Z, D-1 23:59Z],
 * entirely before an ET day D begins at D 04:00Z, so it cannot contribute a
 * point inside the window — even a 90-minute pad on a midnight start reaches
 * only D 02:30Z. Including it was a third of the payload and a third of the
 * latency for nothing (12.2s to 8s on a real tractor-day).
 */
async function fetchVehicleHistory(vehicleId, date) {
  const apiKey = readEnv('MOTIVE_API_KEY');
  if (!apiKey) throw new Error('MOTIVE_API_KEY not set');
  const url = `${MOTIVE_BASE_V2}/vehicle_locations/${encodeURIComponent(vehicleId)}`
    + `?start_date=${date}&end_date=${addDays(date, 1)}&per_page=1000`;
  const res = await fetch(url, { headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`Motive vehicle_locations HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const rows = data.vehicle_locations || data.data || [];
  return rows.map(r => r.vehicle_location || r).filter(Boolean);
}

// Resolve truck number → Motive vehicle id, for the fallback path when the
// day has no driving periods to read the vehicle from.
async function vehicleIdForNumber(number) {
  const apiKey = readEnv('MOTIVE_API_KEY');
  if (!apiKey || !number) return null;
  const res = await fetch(`${MOTIVE_BASE_V1}/vehicle_locations?per_page=100`, {
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const rows = (data.vehicles || data.data || []).map(r => r.vehicle || r);
  const hit = rows.find(v => String(v?.number) === String(number));
  return hit?.id ?? null;
}

/**
 * Reduce a day of breadcrumbs to something a map can draw.
 *
 * Stops are found first and kept whole — they are the point of the view, and
 * thinning them away would hide exactly the dwell the operator is looking for.
 * Only the moving trail is thinned, evenly by index so the route's shape
 * survives, with every stop's entry and exit point forced back in.
 */
function reduceTrail(points, dayStartMs, fromMin, toMin, shiftFromMin, shiftToMin) {
  const inWindow = [];
  for (const p of points) {
    const dt = motiveUtcToNaiveET(p.located_at);
    if (!dt) continue;
    const t = minutesInto(dayStartMs, dt);
    if (t == null) continue;
    if (fromMin != null && t < fromMin) continue;
    if (toMin != null && t > toMin) continue;
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    inWindow.push({ t, lat: p.lat, lon: p.lon, speed: typeof p.speed === 'number' ? p.speed : 0, desc: p.description || null });
  }
  inWindow.sort((a, b) => a.t - b.t);

  // Runs of consecutive stationary points become stops.
  const stops = [];
  const keepIdx = new Set();
  let runStart = null;
  for (let i = 0; i <= inWindow.length; i++) {
    const p = inWindow[i];
    const stationary = p && p.speed <= MOVING_SPEED_MPH;
    if (stationary && runStart == null) runStart = i;
    if ((!stationary || i === inWindow.length) && runStart != null) {
      const a = inWindow[runStart], b = inWindow[i - 1];
      const mins = b.t - a.t;
      if (mins >= MIN_STOP_MIN) {
        // The padded window deliberately reaches past the shift so the drive
        // to the first stop and home from the last are drawn. That also picks
        // up the truck parked at the yard either side, and those stops
        // STRADDLE the punch: one real day starts with 4:40am-6:43am parked
        // against a 6:03am clock-in. A boolean "does it overlap the shift"
        // calls that 123 minutes on the clock when only 40 of them are, which
        // is the same overstatement this view exists to avoid. Report the
        // overlap itself and let the UI show both numbers.
        const lo = shiftFromMin == null ? a.t : Math.max(a.t, shiftFromMin);
        const hi = shiftToMin == null ? b.t : Math.min(b.t, shiftToMin);
        const onShiftMinutes = Math.max(0, hi - lo);
        stops.push({
          fromMin: a.t, toMin: b.t, minutes: mins,
          onShiftMinutes,
          lat: a.lat, lon: a.lon,
          description: a.desc || b.desc || null
        });
        keepIdx.add(runStart); keepIdx.add(Math.max(runStart, i - 1));
      }
      runStart = null;
    }
  }

  const moving = [];
  for (let i = 0; i < inWindow.length; i++) {
    if (inWindow[i].speed > MOVING_SPEED_MPH) moving.push(i);
  }
  const step = Math.max(1, Math.ceil(moving.length / MAX_ROUTE_POINTS));
  for (let i = 0; i < moving.length; i += step) keepIdx.add(moving[i]);
  if (inWindow.length) { keepIdx.add(0); keepIdx.add(inWindow.length - 1); }

  const route = [...keepIdx].sort((a, b) => a - b).map(i => {
    const p = inWindow[i];
    // [lat, lon, minutesIntoDay, mph] — array form, not objects: at several
    // hundred vertices the key names dominate the payload.
    return [+p.lat.toFixed(5), +p.lon.toFixed(5), p.t, Math.round(p.speed)];
  });

  return { route, stops, rawCount: inWindow.length };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  const url = new URL(req.url);
  const driverSlug = url.searchParams.get('driverSlug');
  const date = url.searchParams.get('date');

  if (!driverSlug || !DRIVER_SLUG_RE.test(driverSlug)) {
    return new Response(JSON.stringify({ error: 'driverSlug required, ^[a-z0-9_]+$' }), { status: 400, headers: CORS });
  }
  if (!date || !DATE_RE.test(date)) {
    return new Response(JSON.stringify({ error: 'date required, YYYY-MM-DD' }), { status: 400, headers: CORS });
  }

  try {
    const db = getDb();
    const [employee, record] = await Promise.all([
      db.getDoc('employees', driverSlug).catch(() => null),
      db.getDoc('sentinelDriverDays', `${driverSlug}_${date}`).catch(() => null)
    ]);
    if (!employee) {
      return new Response(JSON.stringify({ error: `employee not found: ${driverSlug}` }), { status: 404, headers: CORS });
    }
    const motiveId = employee?.externalIds?.motive;
    if (!motiveId) {
      return new Response(JSON.stringify({ error: 'no Motive driver id on this employee', code: 'no_motive_id' }), { status: 409, headers: CORS });
    }

    // The vehicle actually driven that day, read from the day's driving
    // periods. defaultTruck is only the fallback: a driver in a swap truck
    // would otherwise get someone else's trail drawn under their name.
    let vehicleId = null, vehicleNumber = null, periods = [];
    try {
      const dp = await getDrivingPeriods(String(motiveId), date);
      periods = dp.periods || [];
      const withVehicle = periods.filter(p => p.vehicleId);
      if (withVehicle.length) {
        const counts = {};
        for (const p of withVehicle) counts[p.vehicleId] = (counts[p.vehicleId] || 0) + p.durationSec;
        const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        vehicleId = dominant;
        vehicleNumber = withVehicle.find(p => String(p.vehicleId) === String(dominant))?.vehicleNumber || null;
      }
    } catch (e) {
      // Fall through to the truck-number path rather than failing outright.
      console.warn(`[day-trail] driving_periods failed for ${driverSlug} ${date}: ${e.message}`);
    }
    if (!vehicleId && employee.defaultTruck) {
      vehicleId = await vehicleIdForNumber(employee.defaultTruck);
      vehicleNumber = employee.defaultTruck;
    }
    if (!vehicleId) {
      return new Response(JSON.stringify({
        error: 'could not determine which vehicle this driver used that day',
        code: 'no_vehicle', driverSlug, date
      }), { status: 409, headers: CORS });
    }

    // Clamp to the shift where we know it, so the trail is the working day
    // rather than a calendar day that includes the truck sitting overnight.
    // Punch first, then the delivery window, then the whole day.
    const dayStartMs = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
    let fromMin = hhmmToMin(record?.clockIn);
    let toMin = hhmmToMin(record?.clockOut);
    let windowSource = (fromMin != null || toMin != null) ? 'punch' : null;
    if (fromMin == null && record?.firstDeliveryTime) {
      fromMin = minutesInto(dayStartMs, new Date(record.firstDeliveryTime));
      windowSource = windowSource || 'deliveries';
    }
    if (toMin == null && record?.lastDeliveryTime) {
      toMin = minutesInto(dayStartMs, new Date(record.lastDeliveryTime));
      windowSource = windowSource || 'deliveries';
    }
    // Pad so the drive to the first stop and home from the last are included —
    // that travel is most of what the morning and afternoon gaps are about.
    const PAD_MIN = 90;
    const shiftFromMin = fromMin, shiftToMin = toMin;
    if (fromMin != null) fromMin -= PAD_MIN;
    if (toMin != null) toMin += PAD_MIN;
    if (fromMin == null && toMin == null) windowSource = 'full-day';

    const raw = await fetchVehicleHistory(vehicleId, date);
    const { route, stops, rawCount } = reduceTrail(raw, dayStartMs, fromMin, toMin, shiftFromMin, shiftToMin);

    return new Response(JSON.stringify({
      version: VERSION,
      driverSlug,
      date,
      vehicle: { id: vehicleId, number: vehicleNumber },
      window: { fromMin, toMin, shiftFromMin, shiftToMin, source: windowSource || 'full-day', padMin: PAD_MIN },
      route,
      stops,
      drivingPeriods: periods.map(p => ({
        fromMin: minutesInto(dayStartMs, p.startDt),
        toMin: minutesInto(dayStartMs, p.endDt),
        minutes: p.durationMin,
        miles: p.distanceMi
      })),
      counts: { fetched: raw.length, inWindow: rawCount, route: route.length, stops: stops.length }
    }), { status: 200, headers: CORS });
  } catch (e) {
    console.error('[day-trail]', e);
    return new Response(JSON.stringify({ error: e.message || 'day-trail failed' }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-day-trail' };
