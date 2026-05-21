// netlify/functions/_firebase-admin.js
// Lightweight Firestore REST API client — no firebase-admin package needed
// Uses native fetch + node:crypto for JWT signing

import crypto from 'crypto';

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
    // Field-masked update — only the fields listed in `fieldPaths` are touched on
    // the server; everything else on the document (including fields the caller
    // doesn't know about, e.g. `epoch`) is preserved exactly.
    //
    // Firestore semantics for masked PATCH:
    //   - field in mask + present in body  → field is set to body value
    //   - field in mask + missing in body  → field is DELETED on the server
    //   - field not in mask                → field is preserved untouched
    //
    // Use this for incremental progress writes that must not clobber sibling
    // fields owned by another writer. `fieldPaths` is REQUIRED and non-empty —
    // we refuse to fall back to full-replace silently because that is exactly
    // the footgun this method exists to prevent.
    async patchDoc(collection, docId, data, fieldPaths) {
      if (!Array.isArray(fieldPaths) || fieldPaths.length === 0) {
        throw new Error('patchDoc requires a non-empty fieldPaths array (use setDoc for full replace)');
      }
      const token = await getAccessToken();
      const params = new URLSearchParams();
      for (const fp of fieldPaths) params.append('updateMask.fieldPaths', fp);
      const url = `${BASE(getProjectId())}/${collection}/${encodeURIComponent(docId)}?${params.toString()}`;
      const fields = {};
      for (const fp of fieldPaths) {
        if (Object.prototype.hasOwnProperty.call(data, fp)) {
          fields[fp] = toFirestoreValue(data[fp]);
        }
        // If a fieldPath is in the mask but not present in `data`, Firestore
        // treats that as a deletion. Caller controls intent — we don't paper
        // over it by silently injecting null.
      }
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      if (!res.ok) throw new Error(`patchDoc failed: ${res.status} ${await res.text()}`);
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
    async deleteDoc(collection, docId) {
      const token = await getAccessToken();
      const url = `${BASE(getProjectId())}/${collection}/${encodeURIComponent(docId)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      // 404 is fine — already gone
      if (!res.ok && res.status !== 404) {
        throw new Error(`deleteDoc failed: ${res.status} ${await res.text()}`);
      }
      return { deleted: true, status: res.status };
    },
    // List ALL doc IDs in a collection (paginated). Used for purge.
    // Returns an array of just doc IDs to keep memory low.
    async listAllDocIds(collection, pageSize = 300) {
      const token = await getAccessToken();
      const out = [];
      let pageToken = null;
      let safety = 0;
      do {
        const params = new URLSearchParams({ pageSize: String(pageSize) });
        // mask=__name__ returns just doc names with no fields. Canonical
        // "list IDs only" trick for Firestore REST.
        params.append('mask.fieldPaths', '__name__');
        if (pageToken) params.set('pageToken', pageToken);
        const url = `${BASE(getProjectId())}/${collection}?${params.toString()}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 404) break;
        if (!res.ok) throw new Error(`listAllDocIds failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        const docs = data.documents || [];
        for (const d of docs) out.push(d.name.split('/').pop());
        pageToken = data.nextPageToken;
        safety++;
        if (safety > 1000) {
          console.warn(`listAllDocIds ${collection}: hit safety ceiling 1000 pages`);
          break;
        }
      } while (pageToken);
      return out;
    },
    // Paginate the WHOLE collection — uses Firestore's native list endpoint
    // (which has pageToken built in), not runQuery. No `where` support: this
    // is the right tool when the caller really wants every doc. Use listDocs
    // for filtered single-page reads; switch to this when the dataset can grow
    // past any reasonable single-page limit.
    //
    // Supports `fields` projection via mask.fieldPaths to keep payloads small.
    // Returns [{ id, ...fields }, ...] in the natural list-endpoint order
    // (Firestore returns __name__ ascending). Sort client-side if needed.
    //
    // Default pageSize=500 trades ~28 round-trips for a ~14k collection
    // against per-page payload size. Caller can bump for slim-projection reads.
    async listAllDocs(collection, { fields, pageSize = 500 } = {}) {
      const token = await getAccessToken();
      const out = [];
      let pageToken = null;
      let safety = 0;
      do {
        const params = new URLSearchParams({ pageSize: String(pageSize) });
        if (Array.isArray(fields) && fields.length) {
          for (const f of fields) params.append('mask.fieldPaths', f);
        }
        if (pageToken) params.set('pageToken', pageToken);
        const url = `${BASE(getProjectId())}/${collection}?${params.toString()}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 404) break;
        if (!res.ok) throw new Error(`listAllDocs ${collection} failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        const docs = data.documents || [];
        for (const d of docs) {
          const id = d.name.split('/').pop();
          out.push({ id, ...docToObj(d) });
        }
        pageToken = data.nextPageToken;
        safety++;
        if (safety > 1000) {
          console.warn(`listAllDocs ${collection}: hit safety ceiling 1000 pages (~${1000 * pageSize} records) — returning partial result`);
          break;
        }
      } while (pageToken);
      return out;
    },
    // Batch delete via Firestore :commit endpoint. Limit 500 per call.
    // Recurses for larger sets. Returns { ok, failed }.
    async batchDelete(collection, docIds) {
      if (!docIds.length) return { ok: 0, failed: 0 };
      if (docIds.length > 500) {
        let ok = 0, failed = 0;
        for (let i = 0; i < docIds.length; i += 500) {
          const r = await this.batchDelete(collection, docIds.slice(i, i + 500));
          ok += r.ok; failed += r.failed;
        }
        return { ok, failed };
      }
      const token = await getAccessToken();
      const url = `${BASE(getProjectId())}:commit`;
      const writes = docIds.map(id => ({
        delete: `projects/${getProjectId()}/databases/(default)/documents/${collection}/${id}`
      }));
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ writes })
      });
      if (!res.ok) {
        console.error(`batchDelete ${collection} failed: ${res.status} ${await res.text()}`);
        return { ok: 0, failed: docIds.length };
      }
      const data = await res.json();
      const writeResults = data.writeResults || [];
      return { ok: writeResults.length, failed: docIds.length - writeResults.length };
    },
    // Use runQuery for ordered list — Firestore REST GET on collection
    // does NOT honor orderBy reliably. runQuery is the correct path.
    // Supports subcollection paths like "sentinelScans/abc/driverDays" by
    // splitting the leaf collection id from the parent document path.
    //
    // where: array of filter objects, ANDed together.
    //   [{ field: 'date', op: '==', value: '2026-04-27' }, ...]
    //   Supported ops: '==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains'.
    async listDocs(collection, { where, orderBy, limit, fields } = {}) {
      const token = await getAccessToken();
      // Parse subcollection path. Top-level: "fooCol" → parent=root, collectionId="fooCol".
      // Nested: "fooCol/abc/barCol" → parent="fooCol/abc", collectionId="barCol".
      let parentPath = '';
      let collectionId = collection;
      if (collection.includes('/')) {
        const parts = collection.split('/');
        if (parts.length % 2 === 1) {
          collectionId = parts[parts.length - 1];
          parentPath = parts.slice(0, parts.length - 1).join('/');
        }
      }
      const url = parentPath
        ? `${BASE(getProjectId())}/${parentPath}:runQuery`
        : `${BASE(getProjectId())}:runQuery`;
      const sq = {
        from: [{ collectionId }],
        limit: limit || 50
      };
      // where filters
      if (Array.isArray(where) && where.length) {
        const OP_MAP = {
          '==': 'EQUAL', '!=': 'NOT_EQUAL',
          '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL',
          '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL',
          'in': 'IN', 'array-contains': 'ARRAY_CONTAINS'
        };
        const toFilter = ({ field, op, value }) => {
          const fop = OP_MAP[op];
          if (!fop) throw new Error(`Unsupported where op: ${op}`);
          return {
            fieldFilter: {
              field: { fieldPath: field },
              op: fop,
              value: toFirestoreValue(value)
            }
          };
        };
        sq.where = where.length === 1
          ? toFilter(where[0])
          : { compositeFilter: { op: 'AND', filters: where.map(toFilter) } };
      }
      if (orderBy) {
        sq.orderBy = [{
          field: { fieldPath: orderBy.field },
          direction: (orderBy.direction || 'desc').toUpperCase() === 'ASC' ? 'ASCENDING' : 'DESCENDING'
        }];
      }
      // Field projection — only fetch the fields you actually need (faster + smaller)
      if (Array.isArray(fields) && fields.length) {
        sq.select = { fields: fields.map(f => ({ fieldPath: f })) };
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery: sq })
      });
      if (!res.ok) throw new Error(`listDocs failed: ${res.status} ${await res.text()}`);
      const rows = await res.json();
      const out = [];
      for (const row of rows) {
        if (!row.document) continue;
        const id = row.document.name.split('/').pop();
        out.push({ id, ...docToObj(row.document) });
      }
      return out;
    }
  };
}
