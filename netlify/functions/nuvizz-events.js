// netlify/functions/nuvizz-events.js
// Fetches event activity log from NuVizz for a stop or route
// Returns: timestamped event stream (arrived, confirmed, departed, exceptions, status changes)
// Used by: SENTINEL (timeline cross-ref), MarginIQ (dwell/service time analysis)

const NUVIZZ_BASE = 'https://contact-support.nuvizz.com/deliverit/openapi/v7';

function getAuth(env) {
  const u = env.get('NUVIZZ_USERNAME');
  const p = env.get('NUVIZZ_PASSWORD');
  return 'Basic ' + btoa(`${u}:${p}`);
}

function getCompany(env) {
  return env.get('NUVIZZ_COMPANY_CODE') || 'davis';
}

async function fetchNuVizz(path, env) {
  const url = `${NUVIZZ_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': getAuth(env),
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NuVizz ${res.status} for ${path}: ${text}`);
  }

  return res.json();
}

// SENTINEL-friendly event timeline — sorted chronologically
function normalizeEvents(raw, entityType) {
  const events = raw?.eventActivity || raw?.eventInfo || [];

  const normalized = events.map(e => ({
    eventId: e.eventId,
    entityType,
    entityId: e.entityId,
    entityNbr: e.entityNbr,
    eventCode: e.eventCode,
    eventDesc: e.eventDesc,
    eventDttm: e.eventDttm || e.eventTime,
    eventTz: e.eventTz || e.timeZone,
    performedBy: e.performedBy || e.createdBy,
    performedByType: e.performedByType,
    location: e.location ? {
      lat: e.location.latitude,
      lng: e.location.longitude,
    } : null,
    comment: e.comment || e.remarks,
  }));

  normalized.sort((a, b) => {
    const ta = a.eventDttm ? new Date(a.eventDttm) : 0;
    const tb = b.eventDttm ? new Date(b.eventDttm) : 0;
    return ta - tb;
  });

  return normalized;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: CORS });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
  }

  const env = Netlify.env;
  const user = env.get('NUVIZZ_USERNAME');
  const pass = env.get('NUVIZZ_PASSWORD');
  if (!user || !pass) {
    return new Response(JSON.stringify({ error: 'NuVizz credentials not configured' }), { status: 500, headers: CORS });
  }

  const url = new URL(req.url);
  const entityType = url.searchParams.get('entityType');
  const entityId = url.searchParams.get('entityId');
  const stopNbr = url.searchParams.get('stopNbr');
  const loadNbr = url.searchParams.get('loadNbr');
  const cc = getCompany(env);

  try {
    // Direct entity ID lookup
    if (entityType && entityId) {
      const validTypes = ['STOP', 'ROUTE'];
      if (!validTypes.includes(entityType.toUpperCase())) {
        return new Response(JSON.stringify({ error: 'entityType must be STOP or ROUTE' }), { status: 400, headers: CORS });
      }

      const path = `/event/eventactivity/${cc}?entityType=${entityType.toUpperCase()}&entityId=${encodeURIComponent(entityId)}`;
      const raw = await fetchNuVizz(path, env);
      const events = normalizeEvents(raw, entityType.toUpperCase());

      return new Response(JSON.stringify({ success: true, entityType, entityId, eventCount: events.length, events }), { status: 200, headers: CORS });
    }

    // Lookup by stopNbr
    if (stopNbr) {
      const stopRaw = await fetchNuVizz(`/stop/info/${encodeURIComponent(stopNbr)}/${cc}`, env);
      const stopId = stopRaw.Stop?.stop?.stopId;
      if (!stopId) {
        return new Response(JSON.stringify({ error: `Could not find stopId for stopNbr ${stopNbr}` }), { status: 404, headers: CORS });
      }

      const path = `/event/eventactivity/${cc}?entityType=STOP&entityId=${encodeURIComponent(stopId)}`;
      const raw = await fetchNuVizz(path, env);
      const events = normalizeEvents(raw, 'STOP');

      let legacyEvents = [];
      try {
        const legacyRaw = await fetchNuVizz(`/stop/eventinfo/${cc}?stopNbr=${encodeURIComponent(stopNbr)}`, env);
        legacyEvents = normalizeEvents(legacyRaw, 'STOP');
      } catch (_) { /* not critical */ }

      return new Response(JSON.stringify({ success: true, stopNbr, stopId, eventCount: events.length, events, legacyEvents }), { status: 200, headers: CORS });
    }

    // Lookup by loadNbr
    if (loadNbr) {
      const loadRaw = await fetchNuVizz(`/load/info/${encodeURIComponent(loadNbr)}/${cc}`, env);
      const loadId = loadRaw.Load?.loadHeader?.loadId;
      if (!loadId) {
        return new Response(JSON.stringify({ error: `Could not find loadId for loadNbr ${loadNbr}` }), { status: 404, headers: CORS });
      }

      const path = `/event/eventactivity/${cc}?entityType=ROUTE&entityId=${encodeURIComponent(loadId)}`;
      const raw = await fetchNuVizz(path, env);
      const events = normalizeEvents(raw, 'ROUTE');

      const routeEvents = {
        firstEvent: events[0] || null,
        lastEvent: events[events.length - 1] || null,
        dispatchEvent: events.find(e => e.eventCode === 'DISPATCH' || e.eventDesc?.toLowerCase().includes('dispatch')),
        routeStartEvent: events.find(e => e.eventCode === 'ROUTE_START' || e.eventCode === 'START'),
        routeEndEvent: events.find(e => e.eventCode === 'ROUTE_END' || e.eventCode === 'COMPLETE'),
        driverEvents: events.filter(e => e.performedByType === 'DRIVER'),
        systemEvents: events.filter(e => e.performedByType === 'SYSTEM'),
        exceptionEvents: events.filter(e => e.eventDesc?.toLowerCase().includes('exception')),
      };

      return new Response(JSON.stringify({ success: true, loadNbr, loadId, eventCount: events.length, routeEvents, events }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error: 'Provide entityType+entityId, stopNbr, or loadNbr' }), { status: 400, headers: CORS });

  } catch (err) {
    console.error('nuvizz-events error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};
