// netlify/functions/motive-dashcam.js
// Fetches dashcam safety events and video recall from Motive API
// Used by SENTINEL for visual verification of driver activity

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const FETCH_TIMEOUT_MS = 20000;

// Exact set of Motive API actions this handler is allowed to proxy.
// `action` is interpolated into the upstream path, so it must be whitelisted.
const ALLOWED_ACTIONS = new Set(['safety_events', 'vehicle_media_requests']);

async function motiveRequest(path, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://api.gomotive.com${path}`, {
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Motive upstream timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const txt = await res.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: res.status, ok: res.ok, body };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: CORS });
  }

  const KEY = Netlify.env.get('MOTIVE_API_KEY');
  if (!KEY) {
    return new Response(JSON.stringify({ error: 'MOTIVE_API_KEY not set' }), { status: 500, headers: CORS });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'events';

  try {
    let result;

    if (action === 'events') {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(JSON.stringify({ error: 'date must be YYYY-MM-DD format' }), { status: 400, headers: CORS });
      }
      const vehicleId = url.searchParams.get('vehicle_id') || '';
      if (vehicleId && !/^\d+$/.test(vehicleId)) {
        return new Response(JSON.stringify({ error: 'vehicle_id must be digits only' }), { status: 400, headers: CORS });
      }
      let path = `/v1/safety_events?start_date=${encodeURIComponent(date)}&end_date=${encodeURIComponent(date)}&per_page=100`;
      if (vehicleId) path += `&vehicle_id=${encodeURIComponent(vehicleId)}`;
      result = await motiveRequest(path, KEY);

    } else if (action === 'video_request') {
      const vehicleId = url.searchParams.get('vehicle_id');
      const startTime = url.searchParams.get('start_time');
      if (!vehicleId || !startTime) {
        return new Response(JSON.stringify({ error: 'vehicle_id and start_time required' }), { status: 400, headers: CORS });
      }
      if (!/^\d+$/.test(vehicleId)) {
        return new Response(JSON.stringify({ error: 'vehicle_id must be digits only' }), { status: 400, headers: CORS });
      }
      // start_time must parse to a valid date
      const parsed = new Date(startTime);
      if (isNaN(parsed.getTime())) {
        return new Response(JSON.stringify({ error: 'start_time is not a valid timestamp' }), { status: 400, headers: CORS });
      }
      result = await motiveRequest(`/v1/vehicle_media_requests?vehicle_id=${encodeURIComponent(vehicleId)}&start_time=${encodeURIComponent(startTime)}`, KEY);

    } else {
      // Generic passthrough — only for whitelisted actions to avoid an open proxy.
      if (!ALLOWED_ACTIONS.has(action)) {
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: CORS });
      }
      result = await motiveRequest(`/v1/${action}?per_page=100`, KEY);
    }

    // Surface upstream failures as a sane error instead of blindly forwarding.
    if (!result.ok) {
      console.error('[motive-dashcam] upstream error', result.status, typeof result.body === 'string' ? result.body.substring(0, 200) : JSON.stringify(result.body).substring(0, 200));
      return new Response(JSON.stringify({ error: 'Motive upstream request failed', status: result.status }), { status: 502, headers: CORS });
    }

    return new Response(JSON.stringify(result.body), { status: 200, headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};
