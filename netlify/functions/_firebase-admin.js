// netlify/functions/_firebase-admin.js
// Lightweight Firestore REST API client — no firebase-admin package needed
// Uses native fetch + node:crypto for JWT signing

import crypto from 'node:crypto';

let _accessToken = null;
let _tokenExpiry = 0;

function getProjectId() { return Netlify.env.get('FIREBASE_PROJECT_ID'); }

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
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`OAuth token fetch: ${res.status} ${await res.text()}`);
  const data = await res.json();
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in * 1000);
  return _accessToken;
}

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toFirestoreValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function fromFirestoreValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFirestoreValue(val);
    return out;
  }
  return null;
}
function docToObj(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = fromFirestoreValue(v);
  return out;
}
function objToFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return fields;
}
const BASE = (proj) => `https://firestore.googleapis.com/v1/projects/${proj}/databases/(default)/documents`;

export function getDb() {
  return {
    async setDoc(collection, docId, data) {
      const token = await getAccessToken();
      const url = `${BASE(getProjectId())}/${collection}/${encodeURIComponent(docId)}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: objToFields(data) })
      });
      if (!res.ok) throw new Error(`setDoc failed: ${res.status} ${await res.text()}`);
      return await res.json();
    },
    async getDoc(collection, docId) {
      const token = await getAccessToken();
      const url = `${BASE(getProjectId())}/${collection}/${encodeURIComponent(docId)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getDoc failed: ${res.status}`);
      return docToObj(await res.json());
    },
    async listDocs(collection, { orderBy, limit } = {}) {
      const token = await getAccessToken();
      let url = `${BASE(getProjectId())}/${collection}?pageSize=${limit || 50}`;
      if (orderBy) url += `&orderBy=${orderBy.field}%20${orderBy.direction || 'desc'}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`listDocs failed: ${res.status}`);
      const data = await res.json();
      return (data.documents || []).map(d => ({ id: d.name.split('/').pop(), ...docToObj(d) }));
    }
  };
}
