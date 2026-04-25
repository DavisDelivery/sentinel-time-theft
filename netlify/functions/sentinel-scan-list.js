// netlify/functions/sentinel-scan-list.js
// List recent scans OR load a specific scan by ID

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const scanId = url.searchParams.get('scanId');
    const canonicalName = url.searchParams.get('driver');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    const db = getDb();

    // Load one specific scan
    if (scanId) {
      const doc = await db.collection('sentinelScans').doc(scanId).get();
      if (!doc.exists) {
        return new Response(JSON.stringify({ error: 'Scan not found' }), { status: 404, headers: CORS });
      }
      return new Response(JSON.stringify({ success: true, scan: doc.data() }), { headers: CORS });
    }

    // Load driver's flag history across all scans
    if (canonicalName) {
      const docId = canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const doc = await db.collection('sentinelDriverHistory').doc(docId).get();
      if (!doc.exists) {
        return new Response(JSON.stringify({ success: true, history: null }), { headers: CORS });
      }
      return new Response(JSON.stringify({ success: true, history: doc.data() }), { headers: CORS });
    }

    // List recent scans
    const snap = await db.collection('sentinelScans')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const scans = [];
    snap.forEach(doc => {
      const d = doc.data();
      // Slim summary — don't send full driver arrays in list view
      scans.push({
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
      });
    });

    return new Response(JSON.stringify({ success: true, scans, count: scans.length }), { headers: CORS });

  } catch (err) {
    console.error('[sentinel-scan-list]', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-scan-list' };
