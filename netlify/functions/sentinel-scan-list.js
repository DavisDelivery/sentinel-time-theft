// netlify/functions/sentinel-scan-list.js
import { getDb } from './_firebase-admin.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const scanId = url.searchParams.get('scanId');
    const canonicalName = url.searchParams.get('driver');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    const db = getDb();

    if (scanId) {
      const doc = await db.getDoc('sentinelScans', scanId);
      if (!doc) return new Response(JSON.stringify({ error: 'Scan not found' }), { status: 404, headers: CORS });
      return new Response(JSON.stringify({ success: true, scan: doc }), { headers: CORS });
    }

    if (canonicalName) {
      const docId = canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const doc = await db.getDoc('sentinelDriverHistory', docId);
      return new Response(JSON.stringify({ success: true, history: doc }), { headers: CORS });
    }

    const docs = await db.listDocs('sentinelScans', { orderBy: { field: 'createdAt', direction: 'desc' }, limit });
    const scans = docs.map(d => ({
      scanId: d.scanId,
      startDate: d.startDate,
      endDate: d.endDate,
      createdAt: d.createdAt,
      driverCount: d.driverCount,
      flaggedCount: d.flaggedCount,
      critical: d.critical,
      high: d.high,
      medium: d.medium,
      totalStolenHrs: d.totalStolenHrs,
      totalCost: d.totalCost
    }));

    return new Response(JSON.stringify({ success: true, scans, count: scans.length }), { headers: CORS });
  } catch (err) {
    console.error('[sentinel-scan-list]', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-scan-list' };
