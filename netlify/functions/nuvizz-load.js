// netlify/functions/nuvizz-load.js
// Fetches full load/route data from NuVizz API v7
// Returns: route header, mileage (planned + actual), duration, driver, all stops with timestamps

const NUVIZZ_BASE = 'https://contact-support.nuvizz.com/deliverit/openapi/v7';
const COMPANY_CODE = Netlify.env.get('NUVIZZ_COMPANY_CODE') || 'davis';

function getAuthHeader() {
  const u = Netlify.env.get('NUVIZZ_USERNAME');
  const p = Netlify.env.get('NUVIZZ_PASSWORD');
  if (!u || !p) throw new Error('NUVIZZ credentials not set');
  return 'Basic ' + btoa(`${u}:${p}`);
}

async function fetchNuVizz(path) {
  const res = await fetch(`${NUVIZZ_BASE}${path}`, {
    headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`NuVizz ${res.status} for ${path}: ${(await res.text()).substring(0,200)}`);
  return res.json();
}

function normalizeStop(s) {
  const stop = s.stop || {};
  const exec = s.stopExecutionInfo || {};
  const toTs = exec.to || {};
  const fromTs = exec.from || {};
  return {
    stopId: stop.stopId, stopNbr: stop.stopNbr, stopSeq: stop.stopSeq,
    stopType: stop.stopType, stopStatus: exec.stopStatus,
    deliveryName: stop.to?.address?.name, deliveryAddr1: stop.to?.address?.addr1,
    deliveryCity: stop.to?.address?.city, deliveryState: stop.to?.address?.state,
    deliveryZip: stop.to?.address?.zip, deliveryLat: stop.to?.address?.latitude,
    deliveryLng: stop.to?.address?.longitude,
    plannedEta: toTs.plannedEtaDTTM, etaDttm: toTs.etaDttm,
    actualArrival: toTs.arrivalDTTM, actualConfirmed: toTs.confirmedDTTM,
    actualDeparture: toTs.departureDTTM, dwellMinutes: toTs.duration,
    etaCode: toTs.etaCode, plannedMilesToNextStop: toTs.plannedDistanceToNextStop,
    plannedMinsToNextStop: toTs.plannedDurationToNextStop,
    pickupActualArrival: fromTs.arrivalDTTM, pickupActualDeparture: fromTs.departureDTTM,
    weight: stop.weight, totalPallets: stop.totalPallets, totalCartons: stop.totalCartons,
    sealNbr: stop.sealNbr, reference1: stop.reference1, proNumber: stop.proNumber,
    exceptionPresent: exec.exceptionPresent,
    exceptions: (exec.exceptions || []).map(e => ({ code: e.exceptionCode, desc: e.exceptionDesc, addedOn: e.addedOn })),
  };
}

function normalizeLoad(raw) {
  const h = raw.Load?.loadHeader || {};
  const exec = raw.Load?.loadExecutionInfo || {};
  const assign = raw.Load?.loadAssignment || {};
  const optInfo = h.rtOptInfo || {};
  const stops = (raw.Load?.stops || []).map(normalizeStop);
  const deliveryStops = stops.filter(s => s.stopType === 'DO' && s.actualArrival)
    .sort((a, b) => new Date(a.actualArrival) - new Date(b.actualArrival));
  return {
    loadId: h.loadId, loadNbr: h.loadNbr, routeName: h.routeName, routeDesc: h.routeDesc,
    driverName: assign.driverName, driverEmail: assign.driverEmail, driverUserName: assign.driverUserName,
    tractorNbr: h.tractorNbr, trailerNbr: h.trailerNbr, vehicleType: h.vehicleType,
    plannedStartDttm: h.earliestStartDttm, plannedLatestStartDttm: h.latestStartDttm,
    actualStartDttm: exec.actualStartDTTM, actualStartTz: exec.actualStartTimeZone,
    actualEndDttm: exec.actualEndDTTM, actualEndTz: exec.actualEndTimeZone,
    plannedDistanceMiles: exec.plannedDistanceMiles, actualDistanceMiles: exec.actualDistanceMiles,
    plannedDuration: exec.plannedDuration, actualDuration: exec.actualDuration,
    plannedDriveTime: exec.plannedDriveTime, actualDriveTime: exec.actualDriveTime,
    stemOutMiles: optInfo.stemOutMiles, stemOutMins: optInfo.stemOutMins,
    plannedRouteDistMiles: optInfo.plannedDist, deadHeadMiles: optInfo.deadHeadMiles,
    loadStatus: exec.loadStatus, stopsOnRoute: exec.stopsOnRoute,
    totalWeight: h.weight, weightUOM: h.weightUOM, totalPallets: h.totalPallets, totalCartons: h.totalCartons,
    originName: h.originName, originCity: h.originCity, originState: h.originState, originZip: h.originZip,
    firstDeliveryTime: deliveryStops[0]?.actualArrival || null,
    lastDeliveryTime: deliveryStops[deliveryStops.length - 1]?.actualArrival || null,
    firstDeliveryStop: deliveryStops[0] || null,
    lastDeliveryStop: deliveryStops[deliveryStops.length - 1] || null,
    stops, stopCount: stops.length, deliveryStopCount: deliveryStops.length,
  };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  const url = new URL(req.url);
  const loadNbr = url.searchParams.get('loadNbr');
  if (!loadNbr) return new Response(JSON.stringify({ error: 'loadNbr required' }), { status: 400, headers: CORS });
  try {
    const raw = await fetchNuVizz(`/load/info/${encodeURIComponent(loadNbr)}/${COMPANY_CODE}`);
    return new Response(JSON.stringify({ success: true, load: normalizeLoad(raw) }), { status: 200, headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/nuvizz-load' };
