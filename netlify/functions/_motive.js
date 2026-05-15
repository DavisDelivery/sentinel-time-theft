// netlify/functions/_motive.js
// Motive API helper for SENTINEL — fetches a driver's driving periods for a single day,
// returns them normalized into a clean shape.
//
// Critical lesson learned 2026-05-14: Motive's /v1/driving_periods endpoint requires
// `driver_ids[]=X` (array-bracketed) to actually filter. Passing `driver_id=X` (scalar)
// silently returns the entire org's periods. Same for vehicle_ids vs vehicle_id.
//
// Time normalization: Motive returns timestamps as UTC ISO 8601 (Z suffix). All
// other SENTINEL data (B600 punches, NuVizz delivery_end) is naive ET. We convert
// Motive UTC to naive-ET-as-UTC for arithmetic consistency.

const MOTIVE_BASE = 'https://api.gomotive.com/v1';

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

// EDT/EST offset for a given date string YYYY-MM-DD.
// Davis Delivery is in GA (Eastern). DST runs second Sunday of March to first Sunday of November.
// Returns hours-to-subtract-from-UTC to get ET wall-clock.
function etOffsetForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Find second Sunday of March (DST start)
  const marchSecondSunday = (() => {
    for (let day = 8; day <= 14; day++) {
      const d = new Date(Date.UTC(y, 2, day));
      if (d.getUTCDay() === 0) return d;
    }
  })();
  // First Sunday of November (DST end)
  const novFirstSunday = (() => {
    for (let day = 1; day <= 7; day++) {
      const d = new Date(Date.UTC(y, 10, day));
      if (d.getUTCDay() === 0) return d;
    }
  })();
  return (dt >= marchSecondSunday && dt < novFirstSunday) ? 4 : 5; // EDT=4, EST=5
}

/**
 * Convert a Motive UTC ISO timestamp to a naive-ET Date (treating ET wall-clock as UTC).
 * This makes Motive times directly comparable to B600/NuVizz times in our codebase.
 */
function motiveUtcToNaiveET(isoStr, etOffset) {
  if (!isoStr) return null;
  // "2026-04-27T12:12:57Z" → parse to true UTC, subtract offset to get ET wall-clock,
  // then re-encode as naive-UTC so arithmetic with our other timestamps works.
  const m = isoStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const trueUtc = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return new Date(trueUtc.getTime() - etOffset * 3600 * 1000);
}

// Parse ZIP from a Motive address string like "Josh Pirkle Rd, Braselton, GA 30548"
// or "100 Gainesville Hwy, Buford, GA 30518". Returns 5-digit ZIP or null.
export function parseZipFromAddress(addr) {
  if (!addr) return null;
  const m = String(addr).match(/\b(\d{5})(-\d{4})?\b/);
  return m ? m[1] : null;
}

/**
 * Fetch all driving periods for one driver on one date.
 *
 * @param {string} driverMotiveId  numeric Motive driver ID (string)
 * @param {string} date            YYYY-MM-DD
 * @returns {Promise<{ periods: Array, raw: { total, fetched } }>}
 *   Each period: {
 *     startUtc, endUtc,           // ISO strings, as Motive returned them
 *     startDt, endDt,             // Date objects, naive-ET-as-UTC
 *     durationSec, durationMin,
 *     originAddr, originLat, originLon, originZip,
 *     destAddr, destLat, destLon, destZip,
 *     distanceKm, distanceMi,
 *     vehicleId, vehicleNumber,
 *     type, status
 *   }
 */
export async function getDrivingPeriods(driverMotiveId, date) {
  const apiKey = readEnv('MOTIVE_API_KEY');
  if (!apiKey) throw new Error('MOTIVE_API_KEY env var not set');
  if (!driverMotiveId || !date) return { periods: [], raw: { total: 0, fetched: 0 } };

  const etOff = etOffsetForDate(date);
  const periods = [];
  let totalReported = null;
  let page = 1;
  const PER_PAGE = 100;

  while (page < 10) {
    const url = `${MOTIVE_BASE}/driving_periods` +
      `?driver_ids%5B%5D=${encodeURIComponent(driverMotiveId)}` +
      `&start_date=${date}` +
      `&end_date=${date}` +
      `&per_page=${PER_PAGE}` +
      `&page_no=${page}`;
    const res = await fetch(url, {
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`Motive driving_periods HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const rows = data.driving_periods || [];
    if (totalReported == null) totalReported = data?.pagination?.total ?? rows.length;
    for (const row of rows) {
      const p = row.driving_period || row;
      const startDt = motiveUtcToNaiveET(p.start_time, etOff);
      const endDt = motiveUtcToNaiveET(p.end_time, etOff);
      // duration is in seconds when numeric; sometimes returned as string like "1h 20m"
      let durSec = 0;
      if (typeof p.duration === 'number') durSec = p.duration;
      else if (typeof p.duration === 'string') {
        const parts = p.duration.split(/\s+/);
        for (const part of parts) {
          if (part.endsWith('h')) durSec += parseInt(part) * 3600;
          else if (part.endsWith('m')) durSec += parseInt(part) * 60;
          else if (part.endsWith('s')) durSec += parseInt(part);
        }
      }
      if (!durSec && startDt && endDt) durSec = Math.round((endDt - startDt) / 1000);

      const distKm = (p.end_kilometers != null && p.start_kilometers != null)
        ? Math.max(0, p.end_kilometers - p.start_kilometers)
        : (typeof p.distance === 'number' ? p.distance : 0);

      periods.push({
        startUtc: p.start_time,
        endUtc: p.end_time,
        startDt,
        endDt,
        durationSec: durSec,
        durationMin: Math.round(durSec / 60),
        originAddr: p.origin || null,
        originLat: p.origin_lat ?? null,
        originLon: p.origin_lon ?? null,
        originZip: parseZipFromAddress(p.origin),
        destAddr: p.destination || null,
        destLat: p.destination_lat ?? null,
        destLon: p.destination_lon ?? null,
        destZip: parseZipFromAddress(p.destination),
        distanceKm: +distKm.toFixed(2),
        distanceMi: +(distKm * 0.621371).toFixed(2),
        vehicleId: p.vehicle?.id ?? null,
        vehicleNumber: p.vehicle?.number ?? null,
        type: p.type || null,
        status: p.status || null
      });
    }
    if (rows.length < PER_PAGE) break;
    page++;
  }

  // Sort ascending by start time
  periods.sort((a, b) => (a.startDt?.getTime() || 0) - (b.startDt?.getTime() || 0));

  return {
    periods,
    raw: { total: totalReported, fetched: periods.length }
  };
}

/**
 * Classify each period's destination ZIP relative to a customer/yard set.
 * Returns the same periods with `destClass` added: 'yard' | 'customer' | 'off_route' | 'unknown'.
 */
export function classifyDestinations(periods, yardZip, customerZipSet) {
  const cset = new Set(Array.from(customerZipSet || []).map(String));
  return periods.map(p => {
    let cls = 'unknown';
    if (!p.destZip) cls = 'unknown';
    else if (yardZip && p.destZip === String(yardZip)) cls = 'yard';
    else if (cset.has(p.destZip)) cls = 'customer';
    else cls = 'off_route';
    return { ...p, destClass: cls };
  });
}

/**
 * Summarize: total driving miles, total driving minutes, distinct off-route destinations,
 * total time spent associated with off-route segments.
 */
export function summarizePeriods(periods) {
  const totalMi = periods.reduce((s, p) => s + p.distanceMi, 0);
  const totalDriveMin = periods.reduce((s, p) => s + p.durationMin, 0);
  const offRoute = periods.filter(p => p.destClass === 'off_route');
  const offRouteZips = [...new Set(offRoute.map(p => p.destZip))];
  const offRouteMin = offRoute.reduce((s, p) => s + p.durationMin, 0);
  // Compute time "spent at" each off-route location: drive time to it + stationary time
  // before the next driving period
  const offRouteVisits = offRoute.map((p, idx) => {
    const idxInAll = periods.indexOf(p);
    const next = periods[idxInAll + 1];
    const stationarySec = next?.startDt && p.endDt ? Math.max(0, (next.startDt - p.endDt) / 1000) : 0;
    return {
      arrivedAt: p.endDt ? p.endDt.toISOString().slice(11, 16) : null,
      leftAt: next?.startDt ? next.startDt.toISOString().slice(11, 16) : null,
      destAddr: p.destAddr,
      destZip: p.destZip,
      stationaryMin: Math.round(stationarySec / 60),
      driveMinToReach: p.durationMin,
      driveMi: p.distanceMi
    };
  });
  return {
    totalMi: +totalMi.toFixed(2),
    totalDriveMin,
    offRouteCount: offRoute.length,
    offRouteZips,
    offRouteMin,
    offRouteVisits
  };
}
