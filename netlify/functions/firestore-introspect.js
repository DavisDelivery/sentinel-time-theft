// netlify/functions/firestore-introspect.js
// One-time introspection helper for SENTINEL v4.
// Lists every top-level collection in the davismarginiq Firestore project
// and returns one sample doc from each so we can build the v4 schema
// against the actual data shape (not guesses).
//
// Protected by SCAN_SECRET so it can't be browsed publicly.
//
// Usage:
//   GET /api/firestore-introspect?secret=<SCAN_SECRET>
//     -> list all root collections + one sample doc from each
//   GET /api/firestore-introspect?secret=<SCAN_SECRET>&collection=<name>&limit=5
//     -> dump up to 5 sample docs from a specific collection

import crypto from 'crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

let _accessToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry - 60000) return _accessToken;
  const clientEmail = Netlify.env.get('FIREBASE_CLIENT_EMAIL');
  let privateKey = Netlify.env.get('FIREBASE_PRIVATE_KEY');
  if (!clientEmail || !privateKey) throw new Error('Firebase credentials not set');
  privateKey = privateKey.replace(/\\n/g, '\n');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(claim)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  const jwt = `${unsigned}.${sig}`;

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  if (!tokRes.ok) throw new Error(`OAuth token: ${tokRes.status} ${await tokRes.text()}`);
  const data = await tokRes.json();
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in * 1000);
  return _accessToken;
}

async function fetchRootCollections() {
  const projectId = Netlify.env.get('FIREBASE_PROJECT_ID');
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID not set');
  const token = await getAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:listCollectionIds`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageSize: 200 })
  });
  if (!res.ok) throw new Error(`listCollectionIds: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { projectId, token, collectionIds: data.collectionIds || [] };
}

async function fetchSampleDocs(projectId, token, collection, limit = 1) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${encodeURIComponent(collection)}?pageSize=${limit}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  const data = await res.json();
  return { documents: data.documents || [] };
}

// Firestore REST value -> plain JS value
function unwrapValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(unwrapValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = unwrapValue(val);
    return out;
  }
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return '<bytes>';
  return null;
}

function docToObj(doc) {
  if (!doc) return null;
  const out = {
    _id: doc.name ? doc.name.split('/').pop() : null
  };
  if (doc.fields) {
    for (const [k, v] of Object.entries(doc.fields)) out[k] = unwrapValue(v);
  }
  return out;
}

// Extract field shape (names + types) — useful for designing the schema doc
function shapeOf(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return 'array<empty>';
    return `array<${typeof shapeOf(obj[0]) === 'string' ? shapeOf(obj[0]) : 'object'}>`;
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = shapeOf(v);
    return out;
  }
  return typeof obj;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret');
    const expected = Netlify.env.get('SCAN_SECRET') || 'sentinel2026';
    if (secret !== expected) {
      return new Response(JSON.stringify({ error: 'Unauthorized — wrong secret' }), { status: 401, headers: CORS });
    }

    const specificCollection = url.searchParams.get('collection');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '1'), 10);

    const { projectId, token, collectionIds } = await fetchRootCollections();

    // Specific collection — dump full sample docs
    if (specificCollection) {
      const { documents, error } = await fetchSampleDocs(projectId, token, specificCollection, limit);
      if (error) return new Response(JSON.stringify({ error }), { status: 500, headers: CORS });
      const samples = documents.map(docToObj);
      return new Response(JSON.stringify({
        projectId,
        collection: specificCollection,
        sampleCount: samples.length,
        sampleShape: samples[0] ? shapeOf(samples[0]) : null,
        samples
      }, null, 2), { status: 200, headers: CORS });
    }

    // All root collections + one sample each
    const out = {
      projectId,
      collectionCount: collectionIds.length,
      collections: []
    };
    for (const cid of collectionIds) {
      const { documents, error } = await fetchSampleDocs(projectId, token, cid, 1);
      if (error) {
        out.collections.push({ name: cid, error });
        continue;
      }
      const sample = documents[0] ? docToObj(documents[0]) : null;
      out.collections.push({
        name: cid,
        sampleId: sample?._id || null,
        fieldShape: sample ? shapeOf(sample) : null,
        sample
      });
    }

    return new Response(JSON.stringify(out, null, 2), { status: 200, headers: CORS });

  } catch (err) {
    console.error('[firestore-introspect]', err);
    return new Response(JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 500) }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/firestore-introspect' };
