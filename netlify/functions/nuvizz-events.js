// netlify/functions/nuvizz-events.js
// Fetches event activity log from NuVizz for a stop or route
// Returns: timestamped event stream (arrived, confirmed, departed, exceptions, status changes)
// Used by: SENTINEL (timeline cross-ref), MarginIQ (dwell/service time analysis)

const NUVIZZ_BASE = 'https://contact-support.nuvizz.com/deliverit/openapi/v7';
const COMPANY_CODE = process.env.NUVIZZ_COMPANY_CODE || 'davis';
const NUVIZZ_USER = process.env.NUVIZZ_USERNAME;
const NUVIZZ_PASS = process.env.NUVIZZ_PASSWORD;

function getAuthHeader() {
  const token = Buffer.from(`${NUVIZZ_USER}:${NUVIZZ_PASS}`).toString('base64');
  return `Basic ${token}`;
}

async function fetchNuVizz(path) {
  const url = `${NUVIZZ_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': getAuthHeader(),
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
    performedByType: e.performedByType,   // DRIVER, DISPATCHER, SYSTEM
    location: e.location ? {
      lat: e.location.latitude,
      lng: e.location.longitude,
    } : null,
    comment: e.comment || e.remarks,
  }));

  // Sort chronologically
  normalized.sort((a, b) => {
    const ta = a.eventDttm ? new Date(a.eventDttm) : 0;
    const tb = b.eventDttm ? new Date(b.eventDttm) : 0;
    return ta - tb;
  });

  return normalized;
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!NUVIZZ_USER || !NUVIZZ_PASS) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'NuVizz credentials not configured' }),
    };
  }

  const params = event.queryStringParameters || {};
  // entityType: STOP or ROUTE
  // entityId: NuVizz system-generated ID (not the stop/load number)
  const { entityType, entityId, stopNbr, loadNbr } = params;

  try {
    // Direct entity ID lookup (fastest — use when you already have the system ID)
    if (entityType && entityId) {
      const validTypes = ['STOP', 'ROUTE'];
      if (!validTypes.includes(entityType.toUpperCase())) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'entityType must be STOP or ROUTE' }),
        };
      }

      const path = `/event/eventactivity/${COMPANY_CODE}?entityType=${entityType.toUpperCase()}&entityId=${encodeURIComponent(entityId)}`;
      const raw = await fetchNuVizz(path);
      const events = normalizeEvents(raw, entityType.toUpperCase());

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true, entityType, entityId, eventCount: events.length, events }),
      };
    }

    // Lookup by stopNbr: first fetch stop to get stopId, then get events
    if (stopNbr) {
      const stopRaw = await fetchNuVizz(`/stop/info/${encodeURIComponent(stopNbr)}/${COMPANY_CODE}`);
      const stopId = stopRaw.Stop?.stop?.stopId;
      if (!stopId) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: `Could not find stopId for stopNbr ${stopNbr}` }),
        };
      }

      const path = `/event/eventactivity/${COMPANY_CODE}?entityType=STOP&entityId=${encodeURIComponent(stopId)}`;
      const raw = await fetchNuVizz(path);
      const events = normalizeEvents(raw, 'STOP');

      // Also grab stop event info (legacy endpoint) for comparison
      let legacyEvents = [];
      try {
        const legacyRaw = await fetchNuVizz(`/stop/eventinfo/${COMPANY_CODE}?stopNbr=${encodeURIComponent(stopNbr)}`);
        legacyEvents = normalizeEvents(legacyRaw, 'STOP');
      } catch (_) { /* not critical */ }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true, stopNbr, stopId, eventCount: events.length, events, legacyEvents }),
      };
    }

    // Lookup by loadNbr: fetch load to get loadId, then get route events
    if (loadNbr) {
      const loadRaw = await fetchNuVizz(`/load/info/${encodeURIComponent(loadNbr)}/${COMPANY_CODE}`);
      const loadId = loadRaw.Load?.loadHeader?.loadId;
      if (!loadId) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: `Could not find loadId for loadNbr ${loadNbr}` }),
        };
      }

      const path = `/event/eventactivity/${COMPANY_CODE}?entityType=ROUTE&entityId=${encodeURIComponent(loadId)}`;
      const raw = await fetchNuVizz(path);
      const events = normalizeEvents(raw, 'ROUTE');

      // Derive key timestamps from the event stream for SENTINEL
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

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true, loadNbr, loadId, eventCount: events.length, routeEvents, events }),
      };
    }

    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Provide entityType+entityId, stopNbr, or loadNbr' }),
    };

  } catch (err) {
    console.error('nuvizz-events error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
