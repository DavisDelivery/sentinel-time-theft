// netlify/functions/sentinel-scan-status.js
// GET /api/sentinel-scan-status?statusId=xxx → current status of a scan run
// Returns { statusId, status: 'running'|'done'|'error', logs, progress, result?, error? }

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  try {
    const url = new URL(req.url);
    const statusId = url.searchParams.get('statusId') || 'current';
    const db = getDb();
    const doc = await db.getDoc('sentinelScanStatus', statusId);
    if (!doc) return new Response(JSON.stringify({ success: true, statusId, status: 'idle', logs: [], progress: '' }), { headers: CORS });
    return new Response(JSON.stringify({ success: true, ...doc }), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-scan-status' };
