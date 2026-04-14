// netlify/functions/motive-dashcam.js
// Fetches dashcam safety events and video recall from Motive API
// Used by SENTINEL for visual verification of driver activity

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

async function motiveRequest(path, apiKey) {
  const res = await fetch(`https://api.gomotive.com${path}`, {
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });
  const body = await res.json().catch(() => res.text());
  return { status: res.status, body };
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
      const vehicleId = url.searchParams.get('vehicle_id') || '';
      let path = `/v1/safety_events?start_date=${date}&end_date=${date}&per_page=100`;
      if (vehicleId) path += `&vehicle_id=${vehicleId}`;
      result = await motiveRequest(path, KEY);

    } else if (action === 'video_request') {
      const vehicleId = url.searchParams.get('vehicle_id');
      const startTime = url.searchParams.get('start_time');
      if (!vehicleId || !startTime) {
        return new Response(JSON.stringify({ error: 'vehicle_id and start_time required' }), { status: 400, headers: CORS });
      }
      result = await motiveRequest(`/v1/vehicle_media_requests?vehicle_id=${vehicleId}&start_time=${startTime}`, KEY);

    } else {
      result = await motiveRequest(`/v1/${action}?per_page=100`, KEY);
    }

    return new Response(JSON.stringify(result.body), { status: result.status || 200, headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};
