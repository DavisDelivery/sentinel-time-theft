// netlify/functions/sentinel-scan-list.js
// GET /api/sentinel-scan-list                  → list of recent scans (summary only)
// GET /api/sentinel-scan-list?scanId=xxx       → full scan with all driver detail
// GET /api/sentinel-scan-list?driver=xxx       → driver aggregate history
// DELETE /api/sentinel-scan-list?scanId=xxx&secret=xxx  → delete a scan

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

const SCAN_SECRET = () => Netlify.env.get('SCAN_SECRET') || 'sentinel2026';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const scanId = url.searchParams.get('scanId');
    const canonicalName = url.searchParams.get('driver');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const db = getDb();

    // DELETE — remove a scan (requires secret)
    if (req.method === 'DELETE') {
      if (!scanId) return new Response(JSON.stringify({ error: 'scanId required' }), { status: 400, headers: CORS });
      const secret = url.searchParams.get('secret');
      if (secret !== SCAN_SECRET()) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
      // Use a direct REST DELETE — _firebase-admin doesn't expose deleteDoc, so inline it here.
      const projectId = Netlify.env.get('FIREBASE_PROJECT_ID');
      // Reuse db machinery indirectly: getDoc to confirm exists
      const existing = await db.getDoc('sentinelScans', scanId);
      if (!existing) return new Response(JSON.stringify({ error: 'Scan not found' }), { status: 404, headers: CORS });
      // Issue REST delete (need access token — call getDoc again would be wasteful, so do via firestore endpoint)
      // Quick path: we just call setDoc with a delete marker won't work. Use fetch with bearer via a temp token grab.
      // Simplest approach: a scan deletion is rare, do inline.
      const tokenRes = await getAccessTokenInline();
      const delUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/sentinelScans/${encodeURIComponent(scanId)}`;
      const delRes = await fetch(delUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenRes}` } });
      if (!delRes.ok) return new Response(JSON.stringify({ error: `delete failed: ${delRes.status}` }), { status: 500, headers: CORS });
      return new Response(JSON.stringify({ success: true, scanId }), { headers: CORS });
    }

    // Single scan with full detail
    if (scanId) {
      const doc = await db.getDoc('sentinelScans', scanId);
      if (!doc) return new Response(JSON.stringify({ error: 'Scan not found' }), { status: 404, headers: CORS });
      return new Response(JSON.stringify({ success: true, scan: doc }), { headers: CORS });
    }

    // Driver aggregate
    if (canonicalName) {
      const docId = canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const doc = await db.getDoc('sentinelDriverHistory', docId);
      return new Response(JSON.stringify({ success: true, history: doc }), { headers: CORS });
    }

    // List of scans — summary fields only (no big drivers array)
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
      // Roster metadata (v3.10.16+) — empty for older scans
      rosterSource: d.rosterSource || null,
      rosterDocCount: d.rosterDocCount || 0,
      rosterAliasCount: d.rosterAliasCount || 0
    }));
    return new Response(JSON.stringify({ success: true, scans, count: scans.length }), { headers: CORS });

  } catch (err) {
    console.error('[sentinel-scan-list]', err);
    return new Response(JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 300) }), { status: 500, headers: CORS });
  }
};

// Inline helper for delete — duplicates the JWT flow to avoid widening _firebase-admin surface
async function getAccessTokenInline() {
  const crypto = await import('crypto');
  const clientEmail = Netlify.env.get('FIREBASE_CLIENT_EMAIL');
  let privateKey = Netlify.env.get('FIREBASE_PRIVATE_KEY');
  privateKey = privateKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: clientEmail, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(claim)}`;
  const signature = crypto.default.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  const jwt = `${unsigned}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  return data.access_token;
}

export const config = { path: '/api/sentinel-scan-list' };
