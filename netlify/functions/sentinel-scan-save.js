// netlify/functions/sentinel-scan-save.js
// Saves a completed scan to Firestore: /sentinelScans/{scanId}
// Also updates per-driver history aggregates in /sentinelDriverHistory/{canonicalName}

import { getDb } from './_firebase-admin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: CORS });

  try {
    const body = await req.json();
    const { scanId, startDate, endDate, results, meta } = body;
    if (!scanId || !results) {
      return new Response(JSON.stringify({ error: 'scanId and results required' }), { status: 400, headers: CORS });
    }

    const db = getDb();

    // Summary stats for the scan doc
    const flagged = results.filter(r => r.risk && r.risk !== 'low' && r.risk !== 'nodata');
    const totalStolen = results.reduce((a, r) => a + (r.stolenHrs || 0), 0);
    const totalCost = results.reduce((a, r) => a + (r.stolenDollars || 0), 0);
    const critical = results.filter(r => r.risk === 'critical').length;
    const high = results.filter(r => r.risk === 'high').length;
    const medium = results.filter(r => r.risk === 'medium').length;

    // Save scan doc — strip out any heavy fields we don't need to store
    const scanDoc = {
      scanId,
      startDate,
      endDate,
      createdAt: new Date().toISOString(),
      driverCount: results.length,
      flaggedCount: flagged.length,
      critical, high, medium,
      totalStolenHrs: +totalStolen.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      meta: meta || {},
      // Per-driver slim records (no raw GPS arrays — keep the doc under 1MB)
      drivers: results.map(r => ({
        name: r.name,
        canonicalName: r.canonicalName || r.name,
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
        gps: r.gps ? {
          deliveryStops: r.gps.deliveryStops || 0,
          actualMiles: r.gps.actualMiles || 0,
          engineOnMin: r.gps.engineOnMin || 0,
          effectiveMph: r.gps.effectiveMph || 0,
          firstMove: r.gps.firstMove || '',
          lastMove: r.gps.lastMove || ''
        } : null
      }))
    };

    await db.collection('sentinelScans').doc(scanId).set(scanDoc);

    // Update per-driver history aggregates
    const batch = db.batch();
    for (const r of results) {
      const canonical = r.canonicalName || r.name;
      if (!canonical) continue;
      const docRef = db.collection('sentinelDriverHistory').doc(canonical.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

      // Build flag frequency map for this scan
      const flagsThisScan = {};
      (r.flags || []).forEach(f => {
        const title = typeof f === 'string' ? f : (f.title || 'unknown');
        flagsThisScan[title] = (flagsThisScan[title] || 0) + 1;
      });

      const existing = await docRef.get();
      if (existing.exists) {
        const data = existing.data();
        const scanIds = [...(data.scanIds || []), scanId].slice(-100); // keep last 100
        const flagFreq = { ...(data.flagFrequency || {}) };
        for (const [k, v] of Object.entries(flagsThisScan)) {
          flagFreq[k] = (flagFreq[k] || 0) + v;
        }
        batch.set(docRef, {
          canonicalName: canonical,
          displayName: r.name,
          driverType: r.driverType || data.driverType || '',
          driverRole: r.driverRole || data.driverRole || '',
          totalScans: (data.totalScans || 0) + 1,
          totalFlags: (data.totalFlags || 0) + ((r.flags || []).length),
          totalStolenHrs: +((data.totalStolenHrs || 0) + (r.stolenHrs || 0)).toFixed(2),
          totalCost: +((data.totalCost || 0) + (r.stolenDollars || 0)).toFixed(2),
          riskCounts: {
            critical: (data.riskCounts?.critical || 0) + (r.risk === 'critical' ? 1 : 0),
            high: (data.riskCounts?.high || 0) + (r.risk === 'high' ? 1 : 0),
            medium: (data.riskCounts?.medium || 0) + (r.risk === 'medium' ? 1 : 0),
            low: (data.riskCounts?.low || 0) + (r.risk === 'low' ? 1 : 0),
          },
          flagFrequency: flagFreq,
          lastScanId: scanId,
          lastSeen: new Date().toISOString(),
          scanIds
        }, { merge: true });
      } else {
        batch.set(docRef, {
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
          scanIds: [scanId]
        });
      }
    }
    await batch.commit();

    return new Response(JSON.stringify({
      success: true,
      scanId,
      driverCount: results.length,
      flaggedCount: flagged.length
    }), { status: 200, headers: CORS });

  } catch (err) {
    console.error('[sentinel-scan-save]', err);
    return new Response(JSON.stringify({ error: err.message, stack: err.stack?.substring(0, 300) }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-scan-save' };
