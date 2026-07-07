// netlify/functions/_distance.js
// Google Maps Distance Matrix wrapper with permanent Firestore cache.
//
// Public API:
//   await getTravelTime(fromAddr, toAddr, departureDt?) -> { minutes, miles, source, status, traffic }
//   await travelFromYard(toAddr, departureDt?)          -> same, with yard as origin
//   await travelToYard(fromAddr, departureDt?)          -> same, with yard as destination
//
// departureDt (optional): a Date for the leg's local (naive-ET) departure time.
// When provided we ask Google for the TYPICAL travel time at that day-of-week +
// time-of-day using traffic_model=best_guess. Google only accepts a future
// departure_time, so we map the leg's weekday+time to its next future
// occurrence (Eastern) — that returns Google's historical/typical traffic for
// that slot, which is the right "what it should have taken" baseline. Without a
// departureDt we fall back to the free-flow estimate (legacy behavior).
//
// Cache: /distanceMatrixCache/{sha1(normFrom + '|' + normTo + '|' + bucket)}
//   bucket = "<dow>_<hour>" when departureDt given, else "flow".
// Cache TTL: forever (typical traffic for a slot is stable). Purge manually.
// Yard address: env var SENTINEL_YARD_ADDRESS.

import crypto from 'crypto';
import { getDb } from './_firebase-admin.js';

const TZ = 'America/New_York';
const FETCH_TIMEOUT_MS = 20000;

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

// ---- Time-of-day → next-future-occurrence epoch (Eastern) ----
// The day-of-week of a calendar date is timezone-independent, so we find the
// next calendar date matching the leg's weekday, then resolve that date's
// wall-clock HH:MM in America/New_York to an absolute epoch.
function etYMD(epochMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(epochMs).reduce((o, p) => (p.type !== 'literal' ? (o[p.type] = p.value, o) : o), {});
  return { y: +parts.year, mo: +parts.month, d: +parts.day };
}
function dowOf(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }

// Resolve an Eastern wall-clock (y, mo[1-12], d, hh, mm) to a UTC epoch (ms),
// accounting for the EST/EDT offset in effect at that instant.
function etWallToEpoch(y, mo, d, hh, mm) {
  const utcGuess = Date.UTC(y, mo - 1, d, hh, mm);
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(utcGuess).reduce((o, p) => (p.type !== 'literal' ? (o[p.type] = p.value, o) : o), {});
  let sh = +shown.hour; if (sh === 24) sh = 0;
  const shownAsUTC = Date.UTC(+shown.year, +shown.month - 1, +shown.day, sh, +shown.minute);
  const offset = shownAsUTC - utcGuess; // ms the zone is ahead of UTC at that instant
  return utcGuess - offset;
}

// departureDt is a naive-ET Date (built via Date.UTC by the scan), so its UTC
// fields ARE the Eastern weekday/time. Returns { epochSec, bucket } or null.
function nextFutureDeparture(departureDt) {
  if (!departureDt || Number.isNaN(departureDt.getTime())) return null;
  const targetDow = departureDt.getUTCDay();
  const hh = departureDt.getUTCHours();
  const mm = departureDt.getUTCMinutes();
  const now = Date.now();
  for (let off = 1; off <= 7; off++) {
    const { y, mo, d } = etYMD(now + off * 86400000);
    if (dowOf(y, mo, d) !== targetDow) continue;
    const epochMs = etWallToEpoch(y, mo, d, hh, mm);
    if (epochMs > now + 30 * 60 * 1000) {
      return { epochSec: Math.floor(epochMs / 1000), bucket: `${targetDow}_${hh}` };
    }
  }
  return { epochSec: Math.floor((now + 7 * 86400000) / 1000), bucket: `${targetDow}_${hh}` };
}

function cacheKey(fromAddr, toAddr, bucket) {
  const s = `${normalize(fromAddr)}|${normalize(toAddr)}|${bucket || 'flow'}`;
  return crypto.createHash('sha1').update(s).digest('hex');
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Distance Matrix upstream timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromGoogle(fromAddr, toAddr, departureSec) {
  const apiKey = readEnv('GOOGLE_MAPS_API_KEY');
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY env var not set');
  let url = 'https://maps.googleapis.com/maps/api/distancematrix/json' +
    `?origins=${encodeURIComponent(fromAddr)}` +
    `&destinations=${encodeURIComponent(toAddr)}` +
    `&units=imperial`;
  if (departureSec) url += `&departure_time=${departureSec}&traffic_model=best_guess`;
  url += `&key=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Distance Matrix HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(`Distance Matrix status=${data.status} error=${data.error_message || 'unknown'}`);
  }
  const el = data?.rows?.[0]?.elements?.[0];
  if (!el) throw new Error('Distance Matrix returned no element');
  if (el.status !== 'OK') {
    return { minutes: null, miles: null, status: el.status, traffic: false };
  }
  // duration_in_traffic is present only when departure_time was sent. Prefer it.
  const durSec = (el.duration_in_traffic?.value != null) ? el.duration_in_traffic.value : (el.duration?.value ?? 0);
  return {
    minutes: Math.round(durSec / 60),
    miles: +(((el.distance?.value ?? 0) / 1609.344).toFixed(2)),
    status: 'OK',
    traffic: el.duration_in_traffic?.value != null
  };
}

/**
 * Get travel time between two addresses. Reads from the Firestore cache first
 * (keyed by route + time-of-day bucket), then Google. Writes successful + non-OK
 * results so we don't refetch.
 *
 * Returns { minutes, miles, source: 'cache'|'api'|'error', status, traffic }.
 */
export async function getTravelTime(fromAddr, toAddr, departureDt = null) {
  if (!fromAddr || !toAddr) {
    return { minutes: null, miles: null, source: 'error', status: 'EMPTY_ADDR', error: 'empty address', traffic: false };
  }
  const dep = nextFutureDeparture(departureDt);
  const bucket = dep ? dep.bucket : 'flow';
  const db = getDb();
  const key = cacheKey(fromAddr, toAddr, bucket);

  // 1. Cache. Non-OK entries (ZERO_RESULTS / NOT_FOUND) are honored too — we
  // deliberately cache them so a permanently unroutable address doesn't
  // re-bill Google on every scan forever. They get a retry window in case the
  // address becomes routable (fixed upstream, new construction).
  const NONOK_RETRY_MS = 30 * 86400000;
  try {
    const cached = await db.getDoc('distanceMatrixCache', key);
    if (cached && cached.status === 'OK') {
      return { minutes: cached.minutes, miles: cached.miles, source: 'cache', status: 'OK', traffic: !!cached.traffic };
    }
    if (cached && cached.status && cached.fetchedAt
        && (Date.now() - Date.parse(cached.fetchedAt)) < NONOK_RETRY_MS) {
      return { minutes: null, miles: null, source: 'cache', status: cached.status, traffic: false };
    }
  } catch (e) { /* miss → API */ }

  // 2. Google
  let result;
  try {
    result = await fetchFromGoogle(fromAddr, toAddr, dep?.epochSec || null);
  } catch (err) {
    return { minutes: null, miles: null, source: 'error', status: 'API_ERROR', error: err.message, traffic: false };
  }

  // 3. Cache write (best-effort)
  try {
    await db.setDoc('distanceMatrixCache', key, {
      fromAddr, toAddr,
      fromNorm: normalize(fromAddr), toNorm: normalize(toAddr),
      bucket,
      minutes: result.minutes, miles: result.miles,
      status: result.status, traffic: !!result.traffic,
      fetchedAt: new Date().toISOString(), version: 2
    });
  } catch (e) {
    console.warn('[_distance] cache write failed:', e.message);
  }

  return { ...result, source: 'api' };
}

export async function travelFromYard(toAddr, departureDt = null) {
  const yard = readEnv('SENTINEL_YARD_ADDRESS');
  if (!yard) throw new Error('SENTINEL_YARD_ADDRESS env var not set');
  return getTravelTime(yard, toAddr, departureDt);
}

export async function travelToYard(fromAddr, departureDt = null) {
  const yard = readEnv('SENTINEL_YARD_ADDRESS');
  if (!yard) throw new Error('SENTINEL_YARD_ADDRESS env var not set');
  return getTravelTime(fromAddr, yard, departureDt);
}
