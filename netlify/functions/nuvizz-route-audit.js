// netlify/functions/nuvizz-route-audit.js
// SENTINEL integration: given a loadNbr, fetches full NuVizz route data and
// returns a SENTINEL-compatible scored driver record.
//
// GET /.netlify/functions/nuvizz-route-audit?loadNbr=XXXX
// GET /.netlify/functions/nuvizz-route-audit?date=YYYY-MM-DD  (all loads for a date)

const NUVIZZ_BASE = 'https://contact-support.nuvizz.com/deliverit/openapi/v7';
const COMPANY_CODE = process.env.NUVIZZ_COMPANY_CODE || 'davis';

function authHeader() {
  const u = process.env.NUVIZZ_USERNAME;
  const p = process.env.NUVIZZ_PASSWORD;
  if (!u || !p) throw new Error('NUVIZZ_USERNAME / NUVIZZ_PASSWORD env vars not set');
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}

async function nv(path) {
  const res = await fetch(`${NUVIZZ_BASE}${path}`, {
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`NuVizz ${res.status} ${path}: ${txt.substring(0, 200)}`);
  }
  return res.json();
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function toMins(dttm) {
  if (!dttm) return null;
  const d = new Date(dttm);
  return d.getHours() * 60 + d.getMinutes();
}

function diffMins(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 60000);
}

function fmtTime(dttm) {
  if (!dttm) return null;
  return new Date(dttm).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtHrs(mins) {
  if (mins == null) return null;
  return (mins / 60).toFixed(2);
}

// ── Load fetcher ──────────────────────────────────────────────────────────────

async function fetchLoadFull(loadNbr) {
  const raw = await nv(`/load/info/${encodeURIComponent(loadNbr)}/${COMPANY_CODE}`);
  const h = raw.Load?.loadHeader || {};
  const exec = raw.Load?.loadExecutionInfo || {};
  const assign = raw.Load?.loadAssignment || {};
  const stops = (raw.Load?.stops || []).map(s => {
    const st = s.stop || {};
    const ex = s.stopExecutionInfo || {};
    const to = ex.to || {};
    return {
      stopId: st.stopId,
      stopNbr: st.stopNbr,
      stopSeq: st.stopSeq,
      stopType: st.stopType,
      stopStatus: ex.stopStatus,
      city: st.to?.address?.city,
      state: st.to?.address?.state,
      plannedEta: to.plannedEtaDTTM,
      actualArrival: to.arrivalDTTM,
      actualConfirmed: to.confirmedDTTM,
      actualDeparture: to.departureDTTM,
      dwellMins: to.duration,
      milestoNext: to.plannedDistanceToNextStop,
      minsToNext: to.plannedDurationToNextStop,
      etaCode: to.etaCode,
      weight: st.weight,
      pallets: st.totalPallets,
      exceptionPresent: ex.exceptionPresent,
      exceptions: (ex.exceptions || []).map(e => e.exceptionDesc).filter(Boolean),
    };
  });

  return {
    loadNbr: h.loadNbr,
    loadId: h.loadId,
    routeName: h.routeName,
    driverName: assign.driverName,
    driverEmail: assign.driverEmail,
    driverUserName: assign.driverUserName,
    tractorNbr: h.tractorNbr,
    trailerNbr: h.trailerNbr,
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
    stemOutMiles: h.rtOptInfo?.stemOutMiles,
    deadHeadMiles: exec.plannedDeadHeadMiles,
    stopsOnRoute: exec.stopsOnRoute,
    totalWeight: h.weight,
    totalPallets: h.totalPallets,
    totalCartons: h.totalCartons,
    stops,
  };
}

// ── SENTINEL scoring engine (NuVizz data layer) ───────────────────────────────
// Mirrors the 8-layer flag logic from the existing SENTINEL audit engine,
// but now using live NuVizz timestamps instead of static CSV data.

function scoreRoute(load) {
  const flags = [];
  let score = 0;

  const deliveryStops = load.stops
    .filter(s => s.stopType === 'DO' && s.actualArrival)
    .sort((a, b) => new Date(a.actualArrival) - new Date(b.actualArrival));

  const pickupStops = load.stops.filter(s => s.stopType === 'PU' && s.actualArrival);

  const firstDelivery = deliveryStops[0] || null;
  const lastDelivery = deliveryStops[deliveryStops.length - 1] || null;

  // Route span
  const routeStartDttm = load.actualStartDttm;
  const routeEndDttm = load.actualEndDttm;
  const routeSpanMins = diffMins(routeStartDttm, routeEndDttm);
  const firstDeliveryMins = diffMins(routeStartDttm, firstDelivery?.actualArrival);
  const lastDeliveryMins = diffMins(routeStartDttm, lastDelivery?.actualArrival);

  // ── FLAG 1: Late First Movement ──────────────────────────────────────────
  // Driver clocked in but first delivery wasn't until very late in shift
  if (firstDeliveryMins != null && firstDeliveryMins > 90) {
    flags.push(`Late First Delivery — ${firstDeliveryMins}min after route start`);
    score += firstDeliveryMins > 150 ? 40 : 20;
  }

  // ── FLAG 2: Excessive Dwell at Individual Stops ──────────────────────────
  const longDwells = load.stops.filter(s => s.dwellMins != null && s.dwellMins > 35);
  longDwells.forEach(s => {
    flags.push(`Stop ${s.stopNbr} — ${s.dwellMins}min dwell`);
    score += s.dwellMins > 60 ? 30 : 15;
  });

  // ── FLAG 3: Actual Miles >> Planned Miles ────────────────────────────────
  if (load.actualDistMiles && load.plannedDistMiles) {
    const excessPct = ((load.actualDistMiles - load.plannedDistMiles) / load.plannedDistMiles) * 100;
    if (excessPct > 15) {
      flags.push(`Excess Mileage — ${load.actualDistMiles.toFixed(1)} actual vs ${load.plannedDistMiles.toFixed(1)} planned (${excessPct.toFixed(0)}% over)`);
      score += excessPct > 30 ? 35 : 20;
    }
  }

  // ── FLAG 4: Actual Duration >> Planned Duration ──────────────────────────
  if (load.actualDurationMins && load.plannedDurationMins) {
    const excessMins = load.actualDurationMins - load.plannedDurationMins;
    if (excessMins > 60) {
      flags.push(`Route Duration Overrun — ${excessMins}min over plan`);
      score += excessMins > 120 ? 30 : 15;
    }
  }

  // ── FLAG 5: Micro-Stop Clusters ──────────────────────────────────────────
  // Multiple consecutive stops with very short dwell (possible skip/fake scan)
  let microCluster = 0;
  for (let i = 0; i < deliveryStops.length; i++) {
    const dwell = deliveryStops[i].dwellMins;
    if (dwell != null && dwell < 3) {
      microCluster++;
    } else {
      if (microCluster >= 3) {
        flags.push(`Micro-Stop Cluster — ${microCluster} stops <3min dwell`);
        score += 25;
      }
      microCluster = 0;
    }
  }
  if (microCluster >= 3) {
    flags.push(`Micro-Stop Cluster — ${microCluster} stops <3min dwell`);
    score += 25;
  }

  // ── FLAG 6: Late Delivery Exceptions ────────────────────────────────────
  const lateStops = load.stops.filter(s => s.etaCode === 'DELAYED');
  if (lateStops.length > 3) {
    flags.push(`${lateStops.length} Late Stops (NuVizz DELAYED)`);
    score += lateStops.length * 5;
  }

  // ── FLAG 7: Stop Exceptions ──────────────────────────────────────────────
  const exStops = load.stops.filter(s => s.exceptionPresent);
  if (exStops.length > 0) {
    const excTypes = [...new Set(exStops.flatMap(s => s.exceptions))].slice(0, 3).join(', ');
    flags.push(`${exStops.length} Stop Exception(s): ${excTypes || 'See detail'}`);
    score += exStops.length * 10;
  }

  // ── FLAG 8: Compressed Route End ────────────────────────────────────────
  // Last delivery to clock-out very compressed — possible early quit
  if (lastDelivery && routeEndDttm) {
    const lastToEnd = diffMins(lastDelivery.actualArrival, routeEndDttm);
    if (lastToEnd != null && lastToEnd > 120) {
      flags.push(`${lastToEnd}min gap — Last Delivery to Route End`);
      score += lastToEnd > 180 ? 30 : 15;
    }
  }

  // ── Derived metrics ──────────────────────────────────────────────────────
  const engineHours = load.actualDurationMins != null ? load.actualDurationMins / 60 : null;
  const driveHours = load.actualDriveTimeMins != null ? load.actualDriveTimeMins / 60 : null;

  // Estimated stolen hours: non-drive, non-delivery time during shift
  const totalShiftMins = routeSpanMins;
  const accountedMins = (load.actualDriveTimeMins || 0) +
    load.stops.filter(s => s.dwellMins).reduce((a, s) => a + s.dwellMins, 0);
  const unaccountedMins = totalShiftMins != null ? Math.max(0, totalShiftMins - accountedMins) : null;
  const stolenHours = unaccountedMins != null ? unaccountedMins / 60 : null;
  const stolenDollars = stolenHours != null ? stolenHours * 23 : null; // $23/hr avg

  // Risk level
  const risk = score >= 150 ? 'critical' : score >= 80 ? 'high' : score >= 40 ? 'medium' : 'low';

  // Route-level mph
  const mph = (load.actualDistMiles && engineHours && engineHours > 0)
    ? (load.actualDistMiles / engineHours).toFixed(1)
    : null;

  return {
    // ── SENTINEL display fields ──
    driver: load.driverName || load.driverUserName || 'Unknown',
    truck: load.tractorNbr || load.trailerNbr || '—',
    loadNbr: load.loadNbr,
    routeName: load.routeName,

    // Clock times (from route actual start/end)
    clockIn: fmtTime(load.actualStartDttm),
    clockOut: fmtTime(load.actualEndDttm),

    // Engine / drive
    engineH: engineHours != null ? parseFloat(engineHours.toFixed(2)) : null,
    driveH: driveHours != null ? parseFloat(driveHours.toFixed(2)) : null,

    // Mileage
    miles: load.actualDistMiles != null ? parseFloat(load.actualDistMiles.toFixed(1)) : null,
    plannedMiles: load.plannedDistMiles != null ? parseFloat(load.plannedDistMiles.toFixed(1)) : null,
    stemOutMiles: load.stemOutMiles != null ? parseFloat(load.stemOutMiles.toFixed(1)) : null,

    mph: mph != null ? parseFloat(mph) : null,
    stops: deliveryStops.length,
    totalStops: load.stops.length,

    // ── SENTINEL audit scores ──
    score,
    risk,
    flags: flags.join('|'),
    flagList: flags,
    flagCount: flags.length,

    // ── Time theft estimates ──
    stolenH: stolenHours != null ? parseFloat(stolenHours.toFixed(2)) : null,
    stolenD: stolenDollars != null ? parseFloat(stolenDollars.toFixed(2)) : null,

    // ── First / Last delivery (key new data) ──
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

    // Source tag
    source: 'NuVizz Live API',

    // ── Full stop detail for drill-down ──
    stopDetail: deliveryStops.map(s => ({
      seq: s.stopSeq,
      stopNbr: s.stopNbr,
      city: `${s.city}, ${s.state}`,
      plannedEta: fmtTime(s.plannedEta),
      actualArrival: fmtTime(s.actualArrival),
      actualDeparture: fmtTime(s.actualDeparture),
      dwellMins: s.dwellMins,
      etaCode: s.etaCode,
      milestoNext: s.milestoNext,
      exceptionPresent: s.exceptionPresent,
      exceptions: s.exceptions,
    })),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: cors });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'GET only' }), { status: 405, headers: cors });
  }

  const url = new URL(req.url);
  const loadNbr = url.searchParams.get('loadNbr');

  if (!loadNbr) {
    return new Response(
      JSON.stringify({ error: 'loadNbr param required. Example: ?loadNbr=DAVIS-2024-001' }),
      { status: 400, headers: cors }
    );
  }

  try {
    const load = await fetchLoadFull(loadNbr);
    const auditRecord = scoreRoute(load);

    return new Response(
      JSON.stringify({ success: true, auditRecord, load }),
      { status: 200, headers: cors }
    );
  } catch (err) {
    console.error('[nuvizz-route-audit]', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: cors }
    );
  }
};

export const config = {
  path: '/api/nuvizz-route-audit',
};
