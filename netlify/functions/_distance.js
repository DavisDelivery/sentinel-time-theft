// netlify/functions/_distance.js
// Google Maps Distance Matrix wrapper with permanent Firestore cache.
//
// Public API:
//   await getTravelTime(fromAddr, toAddr)   -> { minutes, miles, source, status }
//   await travelFromYard(toAddr)            -> same, with yard as origin
//   await travelToYard(fromAddr)            -> same, with yard as destination
//
// Cache: /distanceMatrixCache/{sha1(normFrom + '|' + normTo)}
// Cache TTL: forever (addresses don't change). Operator can purge manually.
// Yard address: env var SENTINEL_YARD_ADDRESS.

import crypto from 'crypto';
import { getDb } from './_firebase-admin.js';

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

function normalize(addr) {
  if (!addr) return '';
  return String(addr).trim().toLowerCase().replace(/\s+/g, ' ').replace(/,\s*/g, ', ');
}

function cacheKey(fromAddr, toAddr) {
  const s = `${normalize(fromAddr)}|${normalize(toAddr)}`;
  return crypto.createHash('sha1').update(s).digest('hex');
}

async function fetchFromGoogle(fromAddr, toAddr) {
  const apiKey = readEnv('GOOGLE_MAPS_API_KEY');
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY env var not set');
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json' +
    `?origins=${encodeURIComponent(fromAddr)}` +
    `&destinations=${encodeURIComponent(toAddr)}` +
    `&units=imperial` +
    `&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Distance Matrix HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(`Distance Matrix status=${data.status} error=${data.error_message || 'unknown'}`);
  }
  const el = data?.rows?.[0]?.elements?.[0];
  if (!el) throw new Error('Distance Matrix returned no element');
  if (el.status !== 'OK') {
    return { minutes: null, miles: null, status: el.status };
  }
  return {
    minutes: Math.round((el.duration?.value ?? 0) / 60),
    miles: +(((el.distance?.value ?? 0) / 1609.344).toFixed(2)),
    status: 'OK'
  };
}

/**
 * Get travel time between two addresses. Reads from Firestore cache first.
 * Writes to cache on every successful Google fetch.
 *
 * Returns { minutes, miles, source: 'cache' | 'api' | 'error', status }.
 * On Google error, returns { minutes: null, miles: null, source: 'error', status, error }.
 */
export async function getTravelTime(fromAddr, toAddr) {
  if (!fromAddr || !toAddr) {
    return { minutes: null, miles: null, source: 'error', status: 'EMPTY_ADDR', error: 'empty address' };
  }
  const db = getDb();
  const key = cacheKey(fromAddr, toAddr);

  // 1. Try cache
  try {
    const cached = await db.getDoc('distanceMatrixCache', key);
    if (cached && cached.status === 'OK') {
      return {
        minutes: cached.minutes,
        miles: cached.miles,
        source: 'cache',
        status: 'OK'
      };
    }
  } catch (e) {
    // Cache miss — getDoc throws on 404 in some setups; fall through to API.
  }

  // 2. Fetch from Google
  let result;
  try {
    result = await fetchFromGoogle(fromAddr, toAddr);
  } catch (err) {
    return {
      minutes: null, miles: null, source: 'error', status: 'API_ERROR', error: err.message
    };
  }

  // 3. Write to cache (even if status != OK, so we don't retry futile lookups)
  try {
    await db.setDoc('distanceMatrixCache', key, {
      fromAddr,
      toAddr,
      fromNorm: normalize(fromAddr),
      toNorm: normalize(toAddr),
      minutes: result.minutes,
      miles: result.miles,
      status: result.status,
      fetchedAt: new Date().toISOString(),
      version: 1
    });
  } catch (e) {
    // Don't fail the call if cache write breaks — caller still gets the value.
    console.warn('[_distance] cache write failed:', e.message);
  }

  return { ...result, source: 'api' };
}

export async function travelFromYard(toAddr) {
  const yard = readEnv('SENTINEL_YARD_ADDRESS');
  if (!yard) throw new Error('SENTINEL_YARD_ADDRESS env var not set');
  return getTravelTime(yard, toAddr);
}

export async function travelToYard(fromAddr) {
  const yard = readEnv('SENTINEL_YARD_ADDRESS');
  if (!yard) throw new Error('SENTINEL_YARD_ADDRESS env var not set');
  return getTravelTime(fromAddr, yard);
}
