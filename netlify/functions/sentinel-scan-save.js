// netlify/functions/sentinel-scan-save.js
import { getDb } from './_firebase-admin.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: CORS });

  try {
    const body = await req.json();
    const { scanId, startDate, endDate, results, meta } = body;
    if (!scanId || !results) return new Response(JSON.stringify({ error: 'scanId and results required' }), { status: 400, headers: CORS });
    // scanId is concatenated into a Firestore doc path — constrain to a safe charset.
    if (!/^[A-Za-z0-9_\-]+$/.test(scanId)) return new Response(JSON.stringify({ error: 'scanId must match ^[A-Za-z0-9_\\-]+$' }), { status: 400, headers: CORS });
    if (!Array.isArray(results)) return new Response(JSON.stringify({ error: 'results must be an array' }), { status: 400, headers: CORS });

    const db = getDb();
    const flagged = results.filter(r => r.risk && r.risk !== 'low' && r.risk !== 'nodata');
    const totalStolen = results.reduce((a, r) => a + (r.stolenHrs || 0), 0);
    const totalCost = results.reduce((a, r) => a + (r.stolenDollars || 0), 0);

    const scanDoc = {
      scanId, startDate, endDate,
      createdAt: new Date().toISOString(),
      driverCount: results.length,
      flaggedCount: flagged.length,
      critical: results.filter(r => r.risk === 'critical').length,
      high: results.filter(r => r.risk === 'high').length,
      medium: results.filter(r => r.risk === 'medium').length,
      totalStolenHrs: +totalStolen.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      meta: meta || {},
      drivers: results.map(r => ({
        name: r.name || '',
        canonicalName: r.canonicalName || r.name || '',
        risk: r.risk || 'nodata',
        score: r.score || 0,
        driverType: r.driverType || '',
        driverRole: r.driverRole || '',
        truck: r.truck || '',
        clockIn: r.clockIn || '',
        clockOut: r.clockOut || '',
        totalHrs: r.totalHrs || 0,
        stolenHrs: r.stolenHrs || 0,
        stolenDollars: r.stolenDollars || 0,
        flags: (r.flags || []).map(f => typeof f === 'string' ? { title: f } : { title: f.title || '', severity: f.severity || '', detail: f.detail || '' }),
        hasData: r.hasData !== false,
        b600Matched: r.b600Matched || false,
      }))
    };

    await db.setDoc('sentinelScans', scanId, scanDoc);

    for (const r of results) {
      const canonical = r.canonicalName || r.name;
      if (!canonical) continue;
      const docId = canonical.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      const flagsThisScan = {};
      (r.flags || []).forEach(f => {
        const title = typeof f === 'string' ? f : (f.title || 'unknown');
        flagsThisScan[title] = (flagsThisScan[title] || 0) + 1;
      });

      const existing = await db.getDoc('sentinelDriverHistory', docId);
      const updated = existing ? {
        canonicalName: canonical,
        displayName: r.name,
        driverType: r.driverType || existing.driverType || '',
        driverRole: r.driverRole || existing.driverRole || '',
        totalScans: (existing.totalScans || 0) + 1,
        totalFlags: (existing.totalFlags || 0) + ((r.flags || []).length),
        totalStolenHrs: +((existing.totalStolenHrs || 0) + (r.stolenHrs || 0)).toFixed(2),
        totalCost: +((existing.totalCost || 0) + (r.stolenDollars || 0)).toFixed(2),
        riskCounts: {
          critical: (existing.riskCounts?.critical || 0) + (r.risk === 'critical' ? 1 : 0),
          high: (existing.riskCounts?.high || 0) + (r.risk === 'high' ? 1 : 0),
          medium: (existing.riskCounts?.medium || 0) + (r.risk === 'medium' ? 1 : 0),
          low: (existing.riskCounts?.low || 0) + (r.risk === 'low' ? 1 : 0),
        },
        flagFrequency: (() => {
          const ff = { ...(existing.flagFrequency || {}) };
          for (const [k, v] of Object.entries(flagsThisScan)) ff[k] = (ff[k] || 0) + v;
          return ff;
        })(),
        firstSeen: existing.firstSeen || new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        lastScanId: scanId,
      } : {
        canonicalName: canonical,
        displayName: r.name,
        driverType: r.driverType || '',
        driverRole: r.driverRole || '',
        totalScans: 1,
        totalFlags: (r.flags || []).length,
        totalStolenHrs: +(r.stolenHrs || 0).toFixed(2),
        totalCost: +(r.stolenDollars || 0).toFixed(2),
        riskCounts: {
          critical: r.risk === 'critical' ? 1 : 0,
          high: r.risk === 'high' ? 1 : 0,
          medium: r.risk === 'medium' ? 1 : 0,
          low: r.risk === 'low' ? 1 : 0,
        },
        flagFrequency: flagsThisScan,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        lastScanId: scanId,
      };
      await db.setDoc('sentinelDriverHistory', docId, updated);
    }

    return new Response(JSON.stringify({ success: true, scanId, driverCount: results.length, flaggedCount: flagged.length }), { status: 200, headers: CORS });
  } catch (err) {
    console.error('[sentinel-scan-save]', err);
    return new Response(JSON.stringify({ error: 'Internal error', message: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-scan-save' };
