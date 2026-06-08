// netlify/functions/nuvizz-loads-by-date.js
// Returns all loads (routes) dispatched on a given date, then fetches
// full stop + scoring data for each. This is the SENTINEL date-scan trigger.
//
// GET /api/nuvizz-loads-by-date?date=2026-04-14
// GET /api/nuvizz-loads-by-date?startDate=2026-04-14&endDate=2026-04-14

const NUVIZZ_BASE = Netlify.env.get('NUVIZZ_BASE_URL') || 'https://portal.nuvizz.com/deliverit/openapi/v7';
const COMPANY_CODE = Netlify.env.get('NUVIZZ_COMPANY_CODE') || 'davis';
const FETCH_TIMEOUT_MS = 20000;

// NuVizz times are naive US-Eastern — format/parse them in that zone.
const NUVIZZ_TZ = 'America/New_York';

// Per-truck-type hourly rate used to value stolen (unaccounted) time.
const STOLEN_RATE_BY_TYPE = { tractor: 27.50, straight: 23.00, unknown: 25.00 };

function auth() {
  const u = Netlify.env.get('NUVIZZ_USERNAME');
  const p = Netlify.env.get('NUVIZZ_PASSWORD');
  if (!u || !p) throw new Error('NUVIZZ credentials not configured');
  return 'Basic ' + btoa(`${u}:${p}`);
}

async function nv(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${NUVIZZ_BASE}${path}`, {
      headers: { Authorization: auth(), 'Content-Type': 'application/json' },
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`NuVizz upstream timeout for ${path}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`NuVizz ${res.status} ${path}: ${txt.substring(0, 200)}`);
  }
  return res.json();
}

// Resolve a stolen-time rate from a truck-type-ish value.
function stolenRate(truckType) {
  const t = (truckType || '').toString().toLowerCase();
  if (t.includes('tractor')) return STOLEN_RATE_BY_TYPE.tractor;
  if (t.includes('straight') || t.includes('box')) return STOLEN_RATE_BY_TYPE.straight;
  return STOLEN_RATE_BY_TYPE.unknown;
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function fmtTime(dttm) {
  if (!dttm) return null;
  // NuVizz timestamps are naive US-Eastern; format in that zone.
  return new Date(dttm).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: NUVIZZ_TZ });
}

function diffMins(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 60000);
}

// ── Score a load (same logic as nuvizz-route-audit.js) ───────────────────────
function scoreLoad(load) {
  const flags = [];
  let score = 0;

  const deliveryStops = load.stops
    .filter(s => s.stopType === 'DO' && s.actualArrival)
    .sort((a, b) => new Date(a.actualArrival) - new Date(b.actualArrival));

  const firstDelivery = deliveryStops[0] || null;
  const lastDelivery = deliveryStops[deliveryStops.length - 1] || null;
  const routeStartDttm = load.actualStartDttm;
  const routeEndDttm = load.actualEndDttm;
  const routeSpanMins = diffMins(routeStartDttm, routeEndDttm);
  const firstDeliveryMins = diffMins(routeStartDttm, firstDelivery?.actualArrival);

  // FLAG 1: Late First Delivery
  if (firstDeliveryMins != null && firstDeliveryMins > 90) {
    flags.push(`Late First Delivery — ${firstDeliveryMins}min after route start`);
    score += firstDeliveryMins > 150 ? 40 : 20;
  }

  // FLAG 2: Excessive Dwell
  load.stops.filter(s => s.dwellMins != null && s.dwellMins > 35).forEach(s => {
    flags.push(`Stop ${s.stopNbr} — ${s.dwellMins}min dwell`);
    score += s.dwellMins > 60 ? 30 : 15;
  });

  // FLAG 3: Excess Mileage
  if (load.actualDistMiles && load.plannedDistMiles) {
    const pct = ((load.actualDistMiles - load.plannedDistMiles) / load.plannedDistMiles) * 100;
    if (pct > 15) {
      flags.push(`Excess Mileage — ${load.actualDistMiles.toFixed(1)} vs ${load.plannedDistMiles.toFixed(1)} planned (${pct.toFixed(0)}% over)`);
      score += pct > 30 ? 35 : 20;
    }
  }

  // FLAG 4: Duration Overrun
  if (load.actualDurationMins && load.plannedDurationMins) {
    const over = load.actualDurationMins - load.plannedDurationMins;
    if (over > 60) {
      flags.push(`Route Duration Overrun — ${over}min over plan`);
      score += over > 120 ? 30 : 15;
    }
  }

  // FLAG 5: Micro-Stop Clusters
  let cluster = 0;
  for (const s of deliveryStops) {
    if (s.dwellMins != null && s.dwellMins < 3) { cluster++; }
    else { if (cluster >= 3) { flags.push(`Micro-Stop Cluster — ${cluster} stops <3min dwell`); score += 25; } cluster = 0; }
  }
  if (cluster >= 3) { flags.push(`Micro-Stop Cluster — ${cluster} stops <3min dwell`); score += 25; }

  // FLAG 6: Late Stops
  const lateStops = load.stops.filter(s => s.etaCode === 'DELAYED');
  if (lateStops.length > 3) { flags.push(`${lateStops.length} Late Stops`); score += lateStops.length * 5; }

  // FLAG 7: Exceptions
  const exStops = load.stops.filter(s => s.exceptionPresent);
  if (exStops.length > 0) {
    flags.push(`${exStops.length} Stop Exception(s)`);
    score += exStops.length * 10;
  }

  // FLAG 8: Long Gap After Last Delivery
  if (lastDelivery && routeEndDttm) {
    const gap = diffMins(lastDelivery.actualArrival, routeEndDttm);
    if (gap != null && gap > 120) { flags.push(`${gap}min gap after Last Delivery`); score += gap > 180 ? 30 : 15; }
  }

  const engineH = load.actualDurationMins != null ? load.actualDurationMins / 60 : null;
  const driveH = load.actualDriveTimeMins != null ? load.actualDriveTimeMins / 60 : null;
  const accountedMins = (load.actualDriveTimeMins || 0) +
    load.stops.filter(s => s.dwellMins).reduce((a, s) => a + s.dwellMins, 0);
  const unaccountedMins = routeSpanMins != null ? Math.max(0, routeSpanMins - accountedMins) : null;
  const stolenH = unaccountedMins != null ? unaccountedMins / 60 : null;
  const rate = stolenRate(load.vehicleType);
  const risk = score >= 150 ? 'critical' : score >= 80 ? 'high' : score >= 40 ? 'medium' : 'low';
  const mph = (load.actualDistMiles && engineH && engineH > 0) ? parseFloat((load.actualDistMiles / engineH).toFixed(1)) : null;

  return {
    driver: load.driverName || load.driverUserName || 'Unknown',
    truck: load.tractorNbr || load.trailerNbr || '—',
    loadNbr: load.loadNbr,
    routeName: load.routeName,
    clockIn: fmtTime(load.actualStartDttm),
    clockOut: fmtTime(load.actualEndDttm),
    engineH: engineH != null ? parseFloat(engineH.toFixed(2)) : null,
    driveH: driveH != null ? parseFloat(driveH.toFixed(2)) : null,
    miles: load.actualDistMiles != null ? parseFloat(load.actualDistMiles.toFixed(1)) : null,
    plannedMiles: load.plannedDistMiles != null ? parseFloat(load.plannedDistMiles.toFixed(1)) : null,
    stemOutMiles: load.stemOutMiles != null ? parseFloat(load.stemOutMiles.toFixed(1)) : null,
    mph,
    stops: deliveryStops.length,
    totalStops: load.stops.length,
    score,
    risk,
    flags: flags.join('|'),
    flagList: flags,
    flagCount: flags.length,
    stolenH: stolenH != null ? parseFloat(stolenH.toFixed(2)) : null,
    stolenD: stolenH != null ? parseFloat((stolenH * rate).toFixed(2)) : null,
    firstDeliveryTime: fmtTime(firstDelivery?.actualArrival),
    firstDeliveryDttm: firstDelivery?.actualArrival || null,
    firstDeliveryCity: firstDelivery ? `${firstDelivery.city}, ${firstDelivery.state}` : null,
    firstDeliveryMinsAfterStart: firstDeliveryMins,
    lastDeliveryTime: fmtTime(lastDelivery?.actualArrival),
    lastDeliveryDttm: lastDelivery?.actualArrival || null,
    lastDeliveryCity: lastDelivery ? `${lastDelivery.city}, ${lastDelivery.state}` : null,
    routeSpanMins,
    routeSpanHrs: routeSpanMins != null ? parseFloat((routeSpanMins / 60).toFixed(2)) : null,
    unaccountedMins,
    source: 'NuVizz Live API',
    stopDetail: deliveryStops.map(s => ({
      seq: s.stopSeq, stopNbr: s.stopNbr,
      city: `${s.city}, ${s.state}`,
      plannedEta: fmtTime(s.plannedEta),
      actualArrival: fmtTime(s.actualArrival),
      actualDeparture: fmtTime(s.actualDeparture),
      dwellMins: s.dwellMins, etaCode: s.etaCode,
      milestoNext: s.milestoNext,
      exceptionPresent: s.exceptionPresent,
      exceptions: s.exceptions,
    })),
  };
}

// ── Fetch and normalize a single load ────────────────────────────────────────
async function fetchAndScoreLoad(loadNbr) {
  const raw = await nv(`/load/info/${encodeURIComponent(loadNbr)}/${COMPANY_CODE}`);
  const h = raw.Load?.loadHeader || {};
  const exec = raw.Load?.loadExecutionInfo || {};
  const assign = raw.Load?.loadAssignment || {};
  const optInfo = h.rtOptInfo || {};

  const stops = (raw.Load?.stops || []).map(s => {
    const st = s.stop || {};
    const ex = s.stopExecutionInfo || {};
    const to = ex.to || {};
    return {
      stopId: st.stopId, stopNbr: st.stopNbr, stopSeq: st.stopSeq,
      stopType: st.stopType, stopStatus: ex.stopStatus,
      city: st.to?.address?.city, state: st.to?.address?.state,
      plannedEta: to.plannedEtaDTTM,
      actualArrival: to.arrivalDTTM, actualConfirmed: to.confirmedDTTM,
      actualDeparture: to.departureDTTM, dwellMins: to.duration,
      etaCode: to.etaCode, milestoNext: to.plannedDistanceToNextStop,
      weight: st.weight, pallets: st.totalPallets,
      exceptionPresent: ex.exceptionPresent,
      exceptions: (ex.exceptions || []).map(e => e.exceptionDesc).filter(Boolean),
    };
  });

  const load = {
    loadNbr: h.loadNbr, loadId: h.loadId, routeName: h.routeName,
    driverName: assign.driverName, driverEmail: assign.driverEmail,
    driverUserName: assign.driverUserName,
    tractorNbr: h.tractorNbr, trailerNbr: h.trailerNbr,
    vehicleType: h.vehicleType,
    loadStatus: exec.loadStatus,
    plannedStartDttm: h.earliestStartDttm,
    actualStartDttm: exec.actualStartDTTM,
    actualEndDttm: exec.actualEndDTTM,
    plannedDistMiles: exec.plannedDistanceMiles,
    actualDistMiles: exec.actualDistanceMiles,
    plannedDurationMins: exec.plannedDuration,
    actualDurationMins: exec.actualDuration,
    plannedDriveTimeMins: exec.plannedDriveTime,
    actualDriveTimeMins: exec.actualDriveTime,
    stemOutMiles: optInfo.stemOutMiles,
    stopsOnRoute: exec.stopsOnRoute,
    stops,
  };

  return scoreLoad(load);
}

// ── Get all load numbers for a date via stop search ──────────────────────────
// NuVizz doesn't have a direct "get loads by date" endpoint,
// so we use the static route list or load list approach.
// Strategy: fetch loads via /load/static/info or use event activity by date.
// Best available: GET /stop/info/{companyCode} with date filters,
// then extract unique loadNbrs from the stop results.
async function getLoadNbrsByDate(date) {
  // NuVizz exposes no documented pagination/total field on these endpoints that we
  // can verify from the code, so rather than guess an API contract we detect *likely*
  // truncation: a raw record count at or above a common server page cap (100 here)
  // strongly suggests more pages exist. We surface that via a `truncated` flag.
  const PAGE_CAP = 100;
  const errors = [];

  // Try fetching loads scheduled for the date
  // NuVizz static route info gives recurring route numbers
  // Use event activity to find all routes active on date
  const path = `/event/eventactivity/${COMPANY_CODE}?entityType=ROUTE&eventDttm=${encodeURIComponent(date)}`;
  try {
    const raw = await nv(path);
    const events = raw?.eventActivity || [];
    const loadNbrs = [...new Set(events.map(e => e.entityNbr).filter(Boolean))];
    if (loadNbrs.length > 0) {
      const truncated = events.length >= PAGE_CAP;
      if (truncated) console.warn(`[nuvizz-loads-by-date] eventActivity returned ${events.length} rows (>= ${PAGE_CAP}); results may be truncated for ${date}`);
      return { loadNbrs, method: 'eventActivity', truncated, errors };
    }
  } catch (err) { errors.push({ method: 'eventActivity', error: err.message }); }

  // Fallback: try static route info for the date
  try {
    const raw = await nv(`/load/static/info/${COMPANY_CODE}?routeDate=${encodeURIComponent(date)}`);
    const routes = raw?.routes || raw?.loads || [];
    const loadNbrs = routes.map(r => r.loadNbr || r.routeNbr).filter(Boolean);
    if (loadNbrs.length > 0) {
      const truncated = routes.length >= PAGE_CAP;
      if (truncated) console.warn(`[nuvizz-loads-by-date] staticRoute returned ${routes.length} rows (>= ${PAGE_CAP}); results may be truncated for ${date}`);
      return { loadNbrs, method: 'staticRoute', truncated, errors };
    }
  } catch (err) { errors.push({ method: 'staticRoute', error: err.message }); }

  // Fallback 2: stop eventinfo by date — extract loadNbrs from stop data
  try {
    const raw = await nv(`/stop/eventinfo/${COMPANY_CODE}?eventDate=${encodeURIComponent(date)}`);
    const stops = raw?.stops || raw?.stopList || [];
    const loadNbrs = [...new Set(stops.map(s => s.loadNbr || s.routeNbr).filter(Boolean))];
    if (loadNbrs.length > 0) {
      const truncated = stops.length >= PAGE_CAP;
      if (truncated) console.warn(`[nuvizz-loads-by-date] stopEventInfo returned ${stops.length} rows (>= ${PAGE_CAP}); results may be truncated for ${date}`);
      return { loadNbrs, method: 'stopEventInfo', truncated, errors };
    }
  } catch (err) { errors.push({ method: 'stopEventInfo', error: err.message }); }

  // No strategy produced loads. Distinguish "genuinely empty" from "all strategies errored".
  return { loadNbrs: [], method: 'none', truncated: false, errors };
}

// ── Handler ───────────────────────────────────────────────────────────────────
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || url.searchParams.get('startDate');

  if (!date) {
    return new Response(
      JSON.stringify({ error: 'date param required (YYYY-MM-DD). Example: ?date=2026-04-14' }),
      { status: 400, headers: CORS }
    );
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(
      JSON.stringify({ error: 'date must be YYYY-MM-DD format' }),
      { status: 400, headers: CORS }
    );
  }

  try {
    // Step 1: Get all load numbers for the date
    const { loadNbrs, method, truncated, errors: lookupErrors } = await getLoadNbrsByDate(date);

    if (loadNbrs.length === 0) {
      // If every strategy threw (e.g. 401 bad creds), this is NOT "no loads" — surface it.
      if (lookupErrors && lookupErrors.length > 0) {
        console.warn('[nuvizz-loads-by-date] all lookup strategies failed:', JSON.stringify(lookupErrors));
        return new Response(
          JSON.stringify({
            success: false, date, loadCount: 0, auditRecords: [],
            error: `Load lookup failed for ${date} — all strategies errored (possible auth/upstream issue).`,
            method, lookupErrors
          }),
          { status: 502, headers: CORS }
        );
      }
      return new Response(
        JSON.stringify({
          success: true, date, loadCount: 0, auditRecords: [],
          message: `No loads found for ${date}. NuVizz may not support date-based load lookup for company code "${COMPANY_CODE}" — verify the date has dispatch data.`,
          method
        }),
        { status: 200, headers: CORS }
      );
    }

    // Step 2: Score each load (max 30 concurrent with batching)
    const auditRecords = [];
    const errors = [];
    const batchSize = 5;

    for (let i = 0; i < loadNbrs.length; i += batchSize) {
      const batch = loadNbrs.slice(i, i + batchSize);
      const settled = await Promise.allSettled(batch.map(n => fetchAndScoreLoad(n)));
      settled.forEach((r, idx) => {
        if (r.status === 'fulfilled') auditRecords.push(r.value);
        else errors.push({ loadNbr: batch[idx], error: r.reason?.message });
      });
    }

    // Sort by score descending
    auditRecords.sort((a, b) => b.score - a.score);

    // Fleet summary
    const summary = {
      date,
      truncated: !!truncated,
      totalRoutes: auditRecords.length,
      critical: auditRecords.filter(r => r.risk === 'critical').length,
      high: auditRecords.filter(r => r.risk === 'high').length,
      medium: auditRecords.filter(r => r.risk === 'medium').length,
      low: auditRecords.filter(r => r.risk === 'low').length,
      totalMilesActual: auditRecords.reduce((a, r) => a + (r.miles || 0), 0).toFixed(1),
      totalMilesPlanned: auditRecords.reduce((a, r) => a + (r.plannedMiles || 0), 0).toFixed(1),
      totalStops: auditRecords.reduce((a, r) => a + r.stops, 0),
      totalStolenHrs: auditRecords.reduce((a, r) => a + (r.stolenH || 0), 0).toFixed(2),
      totalStolenDollars: auditRecords.reduce((a, r) => a + (r.stolenD || 0), 0).toFixed(2),
      avgScore: auditRecords.length ? Math.round(auditRecords.reduce((a, r) => a + r.score, 0) / auditRecords.length) : 0,
    };

    return new Response(
      JSON.stringify({ success: true, date, method, truncated: !!truncated, summary, auditRecords, errors, lookupErrors }),
      { status: 200, headers: CORS }
    );

  } catch (err) {
    console.error('[nuvizz-loads-by-date]', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS }
    );
  }
};

export const config = { path: '/api/nuvizz-loads-by-date' };
