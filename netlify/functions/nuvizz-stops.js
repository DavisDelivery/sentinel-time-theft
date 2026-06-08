// netlify/functions/nuvizz-stops.js
// Batch or single stop fetch — returns per-stop timestamps, dwell, ETA delta, exceptions

const NUVIZZ_BASE = Netlify.env.get('NUVIZZ_BASE_URL') || 'https://portal.nuvizz.com/deliverit/openapi/v7';
const COMPANY_CODE = Netlify.env.get('NUVIZZ_COMPANY_CODE') || 'davis';
const FETCH_TIMEOUT_MS = 20000;

function auth() {
  const u = Netlify.env.get('NUVIZZ_USERNAME'), p = Netlify.env.get('NUVIZZ_PASSWORD');
  if (!u || !p) throw new Error('NuVizz credentials not configured');
  return 'Basic ' + btoa(`${u}:${p}`);
}

async function nv(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${NUVIZZ_BASE}${path}`, { headers: { Authorization: auth() }, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`NuVizz upstream timeout for ${path}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`NuVizz ${res.status}: ${(await res.text()).substring(0,150)}`);
  return res.json();
}

function normalizeStopDetail(raw) {
  const stop = raw.Stop?.stop || {};
  const exec = raw.Stop?.stopExecutionInfo || {};
  const load = raw.Stop?.load || {};
  const toTs = exec.to || {}, fromTs = exec.from || {};
  const planned = toTs.plannedEtaDTTM ? new Date(toTs.plannedEtaDTTM) : null;
  const actual = toTs.arrivalDTTM ? new Date(toTs.arrivalDTTM) : null;
  const earlyLateMinutes = (planned && actual) ? Math.round((actual - planned) / 60000) : null;
  return {
    stopId: stop.stopId, stopNbr: stop.stopNbr, stopSeq: stop.stopSeq,
    stopType: stop.stopType, stopStatus: exec.stopStatus,
    loadNbr: load.loadNbr, loadId: load.loadId, routeName: load.routeName,
    driverName: load.driverName, vehicleNbr: load.vehicleNbr,
    routeActualStart: load.actStartDttm?.dttm, routeActualEnd: load.actEndDttm?.dttm,
    deliveryName: stop.to?.address?.name, deliveryCity: stop.to?.address?.city,
    deliveryState: stop.to?.address?.state, deliveryZip: stop.to?.address?.zip,
    plannedEta: toTs.plannedEtaDTTM, actualArrival: toTs.arrivalDTTM,
    actualConfirmed: toTs.confirmedDTTM, actualDeparture: toTs.departureDTTM,
    dwellMinutes: toTs.duration, etaCode: toTs.etaCode,
    earlyLateMinutes, isLate: earlyLateMinutes != null ? earlyLateMinutes > 0 : null,
    plannedMilesToNextStop: toTs.plannedDistanceToNextStop,
    weight: stop.weight, totalPallets: stop.totalPallets,
    exceptionPresent: exec.exceptionPresent,
    exceptions: (exec.exceptions || []).map(e => ({ code: e.exceptionCode, desc: e.exceptionDesc, addedOn: e.addedOn, addedBy: e.addedByName })),
  };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  const url = new URL(req.url);
  const stopNbr = url.searchParams.get('stopNbr');
  const stopNbrs = url.searchParams.get('stopNbrs');

  try {
    if (stopNbr) {
      const raw = await nv(`/stop/info/${encodeURIComponent(stopNbr)}/${COMPANY_CODE}`);
      return new Response(JSON.stringify({ success: true, stop: normalizeStopDetail(raw) }), { status: 200, headers: CORS });
    }
    if (stopNbrs) {
      const nbrList = stopNbrs.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
      const results = [], errors = [];
      for (let i = 0; i < nbrList.length; i += 5) {
        const batch = nbrList.slice(i, i + 5);
        const settled = await Promise.allSettled(batch.map(n => nv(`/stop/info/${encodeURIComponent(n)}/${COMPANY_CODE}`)));
        settled.forEach((r, idx) => {
          if (r.status === 'fulfilled') { try { results.push(normalizeStopDetail(r.value)); } catch(e) { errors.push({stopNbr: batch[idx], error: e.message}); } }
          else errors.push({ stopNbr: batch[idx], error: r.reason?.message });
        });
      }
      results.sort((a,b) => (a.stopSeq||0) - (b.stopSeq||0));
      const dels = results.filter(s => s.stopType === 'DO' && s.actualArrival).sort((a,b) => new Date(a.actualArrival)-new Date(b.actualArrival));
      const summary = {
        totalStops: results.length, deliveryStops: dels.length,
        firstDeliveryTime: dels[0]?.actualArrival || null, firstDeliveryStop: dels[0]?.stopNbr || null,
        lastDeliveryTime: dels[dels.length-1]?.actualArrival || null, lastDeliveryStop: dels[dels.length-1]?.stopNbr || null,
        routeSpanMinutes: dels.length >= 2 ? Math.round((new Date(dels[dels.length-1].actualArrival) - new Date(dels[0].actualArrival)) / 60000) : null,
        stopsWithExceptions: results.filter(s => s.exceptionPresent).length,
        stopsLate: results.filter(s => s.isLate).length,
        loadNbr: results[0]?.loadNbr || null, driverName: results[0]?.driverName || null,
      };
      return new Response(JSON.stringify({ success: true, summary, stops: results, errors }), { status: 200, headers: CORS });
    }
    return new Response(JSON.stringify({ error: 'Provide stopNbr or stopNbrs' }), { status: 400, headers: CORS });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/nuvizz-stops' };
