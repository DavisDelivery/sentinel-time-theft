// netlify/functions/motive-dashcam.js
// Fetches dashcam safety events and video recall from Motive API
// Used by SENTINEL for visual verification of driver activity

const https = require('https');

const MOTIVE_API_KEY = process.env.MOTIVE_API_KEY || '';

function motiveRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.gomotive.com',
      port: 443,
      path,
      method: 'GET',
      headers: {
        'X-Api-Key': MOTIVE_API_KEY,
        'Authorization': `Bearer ${MOTIVE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const params = event.queryStringParameters || {};
  const action = params.action || 'events';

  try {
    let result;

    if (action === 'events') {
      const date = params.date || new Date().toISOString().split('T')[0];
      const vehicleId = params.vehicle_id || '';
      let path = `/v1/safety_events?start_date=${date}&end_date=${date}&per_page=100`;
      if (vehicleId) path += `&vehicle_id=${vehicleId}`;
      result = await motiveRequest(path);

    } else if (action === 'video_request') {
      // Request video recall for a specific time/vehicle
      const vehicleId = params.vehicle_id;
      const startTime = params.start_time;
      if (!vehicleId || !startTime) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'vehicle_id and start_time required' }) };
      }
      result = await motiveRequest(`/v1/vehicle_media_requests?vehicle_id=${vehicleId}&start_time=${startTime}`);

    } else {
      result = await motiveRequest(`/v1/${action}?per_page=100`);
    }

    return {
      statusCode: result.status || 200,
      headers,
      body: JSON.stringify(result.body)
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
