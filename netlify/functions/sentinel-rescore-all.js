// netlify/functions/sentinel-rescore-all.js
// SENTINEL v4 Phase 3 — thin trigger + status endpoint for the rescore worker.
//
// After the 17-month backfill the rescore now touches ~14k records, which
// can't fit inside Netlify's 26-second request cap. The actual work moved
// into sentinel-rescore-all-background.js (15-min budget). This file:
//
//   GET  /api/sentinel-rescore-all?secret=<S>
//     → if a run is currently 'running': return the status doc (no kickoff)
//     → otherwise: write a 'pending' status with bumped epoch, fire the bg,
//       return 202 with the pending status doc
//
//   GET  /api/sentinel-rescore-all?secret=<S>&status=true
//     → never kick off, just return the current status doc (poll endpoint)
//
//   POST /api/sentinel-rescore-all?secret=<S>
//        body: { reset?: bool }
//     → explicit kickoff. If state==running and !reset → 409. Otherwise bump
//       epoch (which kills any in-flight chain via the bg's epoch guard),
//       write pending, fire bg, return 202.
//
// The GET-as-kickoff path keeps the existing dashboard's "Re-score All"
// button working without UI changes (the same URL still starts a run); the
// dashboard now polls the same URL with &status=true for progress.

import { getDb } from './_firebase-admin.js';

const VERSION = 'v4.1.3-rescore-bg';
const STATUS_COLLECTION = 'sentinelConfig';
const STATUS_DOC = 'rescoreAllStatus';

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

function siteOrigin(req) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      const u = Netlify.env.get('URL') || Netlify.env.get('DEPLOY_URL');
      if (u) return u.replace(/\/$/, '');
    }
  } catch (_) {}
  if (typeof process !== 'undefined' && process?.env) {
    const u = process.env.URL || process.env.DEPLOY_URL;
    if (u) return u.replace(/\/$/, '');
  }
  return new URL(req.url).origin;
}

function bgUrlFromReq(req) {
  return `${siteOrigin(req)}/.netlify/functions/sentinel-rescore-all-background`;
}

async function loadStatus(db) {
  try { return await db.getDoc(STATUS_COLLECTION, STATUS_DOC); } catch (_) { return null; }
}

// Status shape for backwards-compat with the dashboard's existing button: the
// final 'complete' run still surfaces `rescored / baselineUsed / staticFallback
// / totalStolen` at the top level so the doneLabel() formatter from
// runMaintenance still finds the fields it expects. While a run is in flight
// those fields hold the running totals so far.
function dashboardShape(status) {
  if (!status) return { state: 'never_run' };
  return {
    state: status.state,
    epoch: status.epoch ?? null,
    scanId: status.scanId ?? null,
    totalRecords: status.totalRecords ?? 0,
    processed: status.processed ?? 0,
    cursor: status.cursor ?? 0,
    rescored: status.rescored ?? 0,
    baselineUsed: status.baselineUsed ?? 0,
    staticFallback: status.staticFallback ?? 0,
    errors: status.errors ?? 0,
    levelChanges: status.levelChanges ?? {},
    totalStolen: status.totalStolen ?? { before: 0, after: 0, delta: 0 },
    progressText: status.progressText ?? '',
    startedAt: status.startedAt ?? null,
    updatedAt: status.updatedAt ?? null,
    completedAt: status.completedAt ?? null
  };
}

async function kickoff(db, context, req) {
  // Bump epoch off whatever's there. Any in-flight bg worker will see the
  // mismatch on its next checkpoint guard read and exit cleanly without
  // writing stale progress — same kill mechanism PR #5 introduced for the
  // historical backfill.
  const existing = await loadStatus(db);
  const newEpoch = (existing?.epoch ?? 0) + 1;
  const pending = {
    state: 'pending',
    epoch: newEpoch,
    scanId: null,
    totalRecords: 0,
    cursor: 0,
    processed: 0,
    rescored: 0,
    baselineUsed: 0,
    staticFallback: 0,
    errors: 0,
    errorSamples: [],
    levelChanges: {},
    totalStolen: { before: 0, after: 0, delta: 0 },
    progressText: 'Starting…',
    requestedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date().toISOString()
  };
  await db.setDoc(STATUS_COLLECTION, STATUS_DOC, pending);
  console.log(`[rescore-trigger] wrote pending with epoch=${newEpoch} (prev=${existing?.epoch ?? '(none)'})`);

  const bgUrl = bgUrlFromReq(req);
  const fire = fetch(bgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kickoff: true })
  }).catch(e => console.error('[rescore-trigger] bg invoke failed:', e.message));
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(fire);
  } else {
    await fire;
  }
  return pending;
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
    const statusOnly = url.searchParams.get('status') === 'true';
    const existing = await loadStatus(db);

    // Pure poll — never kicks off. The dashboard hits this every few seconds
    // while a run is in flight.
    if (statusOnly) {
      return new Response(JSON.stringify({
        version: VERSION,
        ok: true,
        action: 'status',
        ...dashboardShape(existing)
      }), { status: 200, headers: CORS });
    }

    // POST with explicit reset semantics — only path that can force-restart
    // an already-running chain.
    if (req.method === 'POST') {
      let opts = {};
      try {
        const text = await req.text();
        if (text && text.trim()) opts = JSON.parse(text);
      } catch (_) { opts = {}; }
      if (existing?.state === 'running' && !opts.reset) {
        return new Response(JSON.stringify({
          error: 'Rescore already running. POST with { "reset": true } to force-restart.',
          ...dashboardShape(existing)
        }), { status: 409, headers: CORS });
      }
      const pending = await kickoff(db, context, req);
      return new Response(JSON.stringify({
        version: VERSION,
        ok: true,
        action: 'kickoff',
        accepted: true,
        ...dashboardShape(pending)
      }), { status: 202, headers: CORS });
    }

    // Default GET behavior — backwards-compatible with the dashboard's
    // existing button. If a run is in flight, return its status (no double
    // kickoff). Otherwise kick off a fresh run and return the pending status.
    if (existing?.state === 'running') {
      return new Response(JSON.stringify({
        version: VERSION,
        ok: true,
        action: 'already_running',
        ...dashboardShape(existing)
      }), { status: 200, headers: CORS });
    }
    const pending = await kickoff(db, context, req);
    return new Response(JSON.stringify({
      version: VERSION,
      ok: true,
      action: 'kickoff',
      accepted: true,
      ...dashboardShape(pending)
    }), { status: 202, headers: CORS });

  } catch (err) {
    console.error('[sentinel-rescore-all]', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-rescore-all' };
