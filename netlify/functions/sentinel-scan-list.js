// netlify/functions/sentinel-scan-list.js
// GET /api/sentinel-scan-list                  → list of recent scans (summary only)
// GET /api/sentinel-scan-list?scanId=xxx       → full scan with all driver-day detail
//                                                (assembles parent + driverDays subcollection)
// GET /api/sentinel-scan-list?driver=xxx       → driver aggregate history
// DELETE /api/sentinel-scan-list?scanId=xxx    → delete a scan (and its driverDays subcollection)

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const scanId = url.searchParams.get('scanId');
    const canonicalName = url.searchParams.get('driver');
    // Parse with radix 10, fall back to 50 on NaN, clamp to a sane max so a
    // caller can't request an unbounded list scan.
    const MAX_LIMIT = 200;
    const parsedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIMIT)
      : 50;
    const db = getDb();

    // DELETE — remove a scan + its subcollection (no secret required, same as
    // sentinel-scan-run / sentinel-purge — only callable from the deployed domain)
    if (req.method === 'DELETE') {
      if (!scanId) return new Response(JSON.stringify({ error: 'scanId required' }), { status: 400, headers: CORS });
      const existing = await db.getDoc('sentinelScans', scanId);
      if (!existing) return new Response(JSON.stringify({ error: 'Scan not found' }), { status: 404, headers: CORS });
      // Delete driverDays subcollection first (Firestore doesn't cascade)
      const dayIds = await db.listAllDocIds(`sentinelScans/${scanId}/driverDays`);
      let dayDeleted = 0;
      if (dayIds.length) {
        const r = await db.batchDelete(`sentinelScans/${scanId}/driverDays`, dayIds);
        dayDeleted = r.ok;
      }
      await db.deleteDoc('sentinelScans', scanId);
      return new Response(JSON.stringify({ success: true, scanId, daysDeleted: dayDeleted }), { headers: CORS });
    }

    // Single scan with full detail — assemble parent + subcollection
    if (scanId) {
      const parent = await db.getDoc('sentinelScans', scanId);
      if (!parent) return new Response(JSON.stringify({ error: 'Scan not found' }), { status: 404, headers: CORS });
      // Load driverDays subcollection
      let driverDays = [];
      try {
        driverDays = await db.listDocs(`sentinelScans/${scanId}/driverDays`, { limit: 5000 });
      } catch (e) {
        console.warn(`driverDays load failed for ${scanId}:`, e.message);
      }
      // Provide the assembled scan in the same shape the frontend expects:
      // scan.drivers = full per-driver-day records (from subcollection if present,
      // fall back to legacy parent.drivers field for older scans).
      const scan = {
        ...parent,
        drivers: driverDays.length ? driverDays : (parent.drivers || [])
      };
      return new Response(JSON.stringify({ success: true, scan }), { headers: CORS });
    }

    // Driver aggregate
    if (canonicalName) {
      const docId = canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const doc = await db.getDoc('sentinelDriverHistory', docId);
      return new Response(JSON.stringify({ success: true, history: doc }), { headers: CORS });
    }

    // List of scans — summary fields only
    const docs = await db.listDocs('sentinelScans', {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
      fields: ['scanId','startDate','endDate','createdAt','driverCount','flaggedCount','critical','high','medium','totalStolenHrs','totalCost','source','rosterSource','rosterDocCount','rosterAliasCount']
    });
    const scans = docs.map(d => ({
      scanId: d.scanId || d.id,
      startDate: d.startDate,
      endDate: d.endDate,
      createdAt: d.createdAt,
      driverCount: d.driverCount || 0,
      flaggedCount: d.flaggedCount || 0,
      critical: d.critical || 0,
      high: d.high || 0,
      medium: d.medium || 0,
      totalStolenHrs: d.totalStolenHrs || 0,
      totalCost: d.totalCost || 0,
      source: d.source || 'client',
      rosterSource: d.rosterSource || null,
      rosterDocCount: d.rosterDocCount || 0,
      rosterAliasCount: d.rosterAliasCount || 0
    }));
    return new Response(JSON.stringify({ success: true, scans, count: scans.length }), { headers: CORS });

  } catch (err) {
    console.error('[sentinel-scan-list]', err);
    return new Response(JSON.stringify({ error: 'Internal error', message: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-scan-list' };
