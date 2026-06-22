// netlify/functions/sentinel-write.js
// Write endpoint for operator-driven config edits made from the Settings panel.
//
// Actions (POST, JSON body):
//   setDriverConfig: { driverSlug, loadPrepMin?, wrapUpMin?, truckType? }
//     - Numeric value     → set/overwrite per-driver override on /employees
//     - 'tractor' / 'straight' → set per-driver truckType override
//     - null              → clear the override (revert to defaults/auto-resolve)
//     - Omitted key       → field untouched
//
// Auth: none — open internal endpoint.
// Uses masked patchDoc so the existing employee fields (externalIds, fullName,
// status, etc.) are preserved exactly.

import { getDb } from './_firebase-admin.js';

const VERSION = 'v4.3.1-truck-type-override';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

// Bounded sanity check — a loadPrep > 8h is almost certainly a typo, not a
// real-world prep window. Reject early instead of writing nonsense that the
// engine will then attribute as massive "negative" gaps.
const MAX_MIN = 480;

function validateOverrideValue(val, key) {
  if (val === null) return { ok: true, normalized: null };
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return { ok: false, error: `${key} must be a number or null` };
  }
  if (val < 0) return { ok: false, error: `${key} must be >= 0` };
  if (val > MAX_MIN) return { ok: false, error: `${key} must be <= ${MAX_MIN} (8 hours)` };
  return { ok: true, normalized: Math.round(val) };
}

const VALID_TRUCK_TYPES = ['tractor', 'straight'];

function validateTruckType(val) {
  if (val === null) return { ok: true, normalized: null };
  if (typeof val !== 'string') return { ok: false, error: 'truckType must be a string or null' };
  if (!VALID_TRUCK_TYPES.includes(val)) {
    return { ok: false, error: `truckType must be one of: ${VALID_TRUCK_TYPES.join(', ')} (or null to clear)` };
  }
  return { ok: true, normalized: val };
}

async function setDriverConfig(db, body) {
  const { driverSlug, loadPrepMin, wrapUpMin, truckType } = body;
  if (!driverSlug || typeof driverSlug !== 'string') {
    return { status: 400, body: { error: 'driverSlug required' } };
  }
  const emp = await db.getDoc('employees', driverSlug);
  if (!emp) {
    return { status: 404, body: { error: `employee not found: ${driverSlug}` } };
  }

  const patch = {};
  const fieldPaths = [];

  if (Object.prototype.hasOwnProperty.call(body, 'loadPrepMin')) {
    const v = validateOverrideValue(loadPrepMin, 'loadPrepMin');
    if (!v.ok) return { status: 400, body: { error: v.error } };
    if (v.normalized !== null) patch.loadPrepMin = v.normalized;
    fieldPaths.push('loadPrepMin');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'wrapUpMin')) {
    const v = validateOverrideValue(wrapUpMin, 'wrapUpMin');
    if (!v.ok) return { status: 400, body: { error: v.error } };
    if (v.normalized !== null) patch.wrapUpMin = v.normalized;
    fieldPaths.push('wrapUpMin');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'truckType')) {
    const v = validateTruckType(truckType);
    if (!v.ok) return { status: 400, body: { error: v.error } };
    if (v.normalized !== null) patch.truckType = v.normalized;
    fieldPaths.push('truckType');
  }

  if (fieldPaths.length === 0) {
    return { status: 400, body: { error: 'nothing to update — supply loadPrepMin, wrapUpMin, and/or truckType' } };
  }

  await db.patchDoc('employees', driverSlug, patch, fieldPaths);
  return {
    status: 200,
    body: {
      driverSlug,
      updated: fieldPaths,
      loadPrepMin: Object.prototype.hasOwnProperty.call(patch, 'loadPrepMin') ? patch.loadPrepMin : (typeof emp.loadPrepMin === 'number' ? emp.loadPrepMin : null),
      wrapUpMin: Object.prototype.hasOwnProperty.call(patch, 'wrapUpMin') ? patch.wrapUpMin : (typeof emp.wrapUpMin === 'number' ? emp.wrapUpMin : null),
      truckType: Object.prototype.hasOwnProperty.call(patch, 'truckType') ? patch.truckType : (emp.truckType || null)
    }
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: CORS });
  }

  try {
    const url = new URL(req.url);
    let body;
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers: CORS });
    }

    const action = url.searchParams.get('action') || body.action;
    const db = getDb();

    switch (action) {
      case 'setDriverConfig': {
        const out = await setDriverConfig(db, body);
        return new Response(JSON.stringify({ version: VERSION, action, ...out.body }), { status: out.status, headers: CORS });
      }
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: CORS });
    }
  } catch (err) {
    console.error('[sentinel-write]', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-write' };
