// netlify/functions/sentinel-historical-backfill.js
// SENTINEL v4 Phase 3c — control plane for the historical backfill.
//
//   GET  /api/sentinel-historical-backfill?secret=<S>
//     → returns the current sentinelConfig/historicalBackfillStatus doc
//
//   POST /api/sentinel-historical-backfill?secret=<S>
//        body: { reset?: bool, startDate?: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD' }
//     → if a run is already in flight and reset is falsy → 409
//        otherwise wipes status and fires the background worker, returns 202
//
// Secret defaults to davis2026sentinel (same as sentinel-day-scan).

import { getDb } from './_firebase-admin.js';

const VERSION = 'v4.1.0-phase3c';
const STATUS_COLLECTION = 'sentinelConfig';
const STATUS_DOC = 'historicalBackfillStatus';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

function readEnv(key) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      const v = Netlify.env.get(key);
      if (v) return v;
    }
  } catch (_) {}
  if (typeof process !== 'undefined' && process?.env?.[key]) return process.env[key];
  return null;
}

function bgUrlFromReq(req) {
  const u = new URL(req.url);
  return `${u.origin}/.netlify/functions/sentinel-historical-backfill-background`;
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret');
    const expected = readEnv('SCAN_SECRET') || 'davis2026sentinel';
    if (secret !== expected) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    const db = getDb();

    if (req.method === 'GET') {
      let doc = null;
      try { doc = await db.getDoc(STATUS_COLLECTION, STATUS_DOC); } catch (_) { doc = null; }
      return new Response(JSON.stringify({
        version: VERSION,
        status: doc || { state: 'never_run' }
      }, null, 2), { status: 200, headers: CORS });
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });
    }

    // POST: kick off (or reset + kick off)
    let opts = {};
    try {
      const text = await req.text();
      if (text && text.trim()) opts = JSON.parse(text);
    } catch (_) { opts = {}; }

    const existing = await (async () => {
      try { return await db.getDoc(STATUS_COLLECTION, STATUS_DOC); } catch (_) { return null; }
    })();

    if (existing?.state === 'running' && !opts.reset) {
      return new Response(JSON.stringify({
        error: 'Backfill already running. POST with { "reset": true } to force restart.',
        status: existing
      }, null, 2), { status: 409, headers: CORS });
    }

    // Bump the epoch so any in-flight chain dies on its next checkpoint guard
    // read. This is the kill mechanism: by the time the worker re-reads the
    // doc, doc.epoch != worker.myEpoch → worker exits without re-invoking or
    // writing stale progress back. The bg's own kickoff path will bump again
    // (off our pending value) when it builds the fresh grid — cheap insurance
    // that every kickoff is authoritative even if this trigger is somehow
    // skipped.
    const newEpoch = (existing?.epoch ?? 0) + 1;
    await db.setDoc(STATUS_COLLECTION, STATUS_DOC, {
      state: 'pending',
      epoch: newEpoch,
      requestedAt: new Date().toISOString(),
      requestedOpts: opts
    });
    console.log(`[backfill-trigger] wrote pending with epoch=${newEpoch} (prev=${existing?.epoch ?? '(none)'})`);

    const bgUrl = bgUrlFromReq(req);
    const bgBody = JSON.stringify({
      startDate: opts.startDate || undefined,
      endDate: opts.endDate || undefined
    });

    const fire = fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bgBody
    }).catch(e => console.error('[backfill-trigger] bg invoke failed:', e.message));

    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(fire);
    } else {
      // No waitUntil → fire and forget at least the request initiation
      fire;
    }

    return new Response(JSON.stringify({
      version: VERSION,
      ok: true,
      accepted: true,
      message: 'Historical backfill kicked off. GET this endpoint to poll status.',
      opts
    }, null, 2), { status: 202, headers: CORS });
  } catch (err) {
    console.error('[sentinel-historical-backfill]', err);
    return new Response(JSON.stringify({
      error: err.message,
      stack: err.stack?.slice(0, 800)
    }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-historical-backfill' };
