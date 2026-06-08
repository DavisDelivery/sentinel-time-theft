# SENTINEL Code Audit & Remediation

Full in-depth audit of the repository (all `netlify/functions/*` backend, `public/`
frontend, config). `node_modules` excluded.

This document records the findings and which were fixed. The **HIGH / MEDIUM / LOW**
items were remediated in this branch. The **CRITICAL** items were intentionally left
out of scope for this pass and still require attention (see bottom).

---

## ✅ Fixed in this branch

### HIGH

**Security / robustness**
- `motive-dashcam.js` — was an open proxy: `action` interpolated into `/v1/${action}`,
  unencoded `vehicle_id`/`start_time`/`date`, and a broken `res.json().catch(()=>res.text())`
  double-read. Now: action whitelist, regex validation, `encodeURIComponent`, read-body-once,
  `res.ok` check.
- `sentinel-read.js` — `date`/`driverSlug` now validated (`^\d{4}-\d{2}-\d{2}$` / `^[a-z0-9_]+$`)
  before building Firestore queries and doc IDs; 400 on mismatch.
- `nuvizz-events.js` — upstream error body truncated; client gets a generic message, full detail logged.
- All external fetches (`_motive`, `nuvizz-*`, `sentinel-ai`, `totalpass`) now use a 20s
  `AbortController` timeout.
- `dist[riskLevel]` / `baselineConfidence` (`sentinel-read.js`, `index.html` ×2) — unknown stored
  values coalesced to a known bucket so distributions sum correctly.

**Correctness (theft-math)**
- `_sentinel-scan.js` — single-stop days no longer drop the afternoon anchor (`lastStop===firstStop`
  no longer nulls `lastDelivery*`); the afternoon return-trip gap is now computed.
- `_sentinel-scan.js` — scan-path `riskScore` now clamped to 100, matching the rescore path
  (no more 120-vs-100 drift on re-score).
- `_sentinel-rescore.js` — negative anchor deltas (first-delivery-before-clock-in, etc.) are no
  longer resurrected into a bogus `ok`; they stay `no_data`, preserving the dataHealth signal.
- `_motive.js` — ET conversion now uses the `America/New_York` IANA zone per-instant (via `Intl`),
  correct across DST transitions; replaced the date-granularity offset that could be 60 min off.
- `sentinel-historical-backfill.js` — `await fire` in the no-`waitUntil` branch so the background
  invoke is actually sent (was a bare `fire;` no-op → backfill never started).
- `sentinel-performance.js` — `driverType` partitioned into tractor/straight/unknown; unknown
  excluded from benchmarks (was a `!== 'tractor'` catch-all contaminating the straight class).
- `sentinel-performance.js` — `pct()` now uses the same nearest-rank formula as `_baselines.js`.
- `sentinel-rescore-all-background.js` — employees join now uses paginated `listAllDocs` (was a
  silent 500-row cap that dropped overrides for alphabetically-last drivers).
- `index.html` — `navigateToDriver` awaits the driver-list fetch (was a 50ms `setTimeout` race);
  `sentinel-nuvizz-patch.js` — `response`/shape guards + `_nvFetch` try/catch.

### MEDIUM
- `_sentinel-scan.js` — NuVizz status filter uses `startsWith('complet')` (rejects "Incomplete",
  per SCHEMA "Completed only").
- `nuvizz-loads-by-date.js` — surfaces a `truncated` flag (no silent first-page-only audits) and
  no longer swallows lookup errors as "no loads found".
- `nuvizz-loads-by-date.js` / `nuvizz-route-audit.js` — `stolenDollars` uses a per-truck-type rate
  map (tractor 27.50 / straight 23 / unknown 25) instead of a flat $23.
- `_sentinel-scan.js` & `_sentinel-rescore.js` — config defaults deep-merged so a partial
  `wageRates`/threshold doc can't produce `NaN` stolenDollars.
- NuVizz time formatting pinned to `America/New_York`.
- `sentinel-purge.js` — `driverPerformanceDaily` removed from the default purge set (not
  SENTINEL-owned); subcollection-cleanup failure no longer deletes the parent (no orphaning).
- `sentinel-nightly-scan.js` — weekend targets skipped with a `skipped: 'weekend'` status.
- `index.html` — annualized projection divides by the calendar span, not count-of-dates-with-data;
  `isWeekend` uses UTC; dead `renderSparkBars` removed.
- Stack traces removed from `sentinel-scan-save` / `sentinel-scan-list` / `sentinel-day-scan`
  responses; `sentinel-read` `byDate` surfaces a `truncated` flag; `_firebase-admin` guards
  `FIREBASE_PROJECT_ID` and wraps `crypto.sign`.
- **XSS**: all API-sourced strings in `index.html` and `sentinel-nuvizz-patch.js` are now
  `escapeHtml()`-wrapped (the patch file previously had no escaping at all).

### LOW
- `nuvizz-stops.js` credential guard; `totalpass-scraper.js` CSV escaped-quote handling;
  `parseInt` radix (`_motive`, `scan-list`, `index.html`); frontend `r.records || []` shape
  guards; stale-banner date; invalid-date rollover guards in `_sentinel-engine` date parsers;
  `_sentinel-scan` sort uses `getTime()`; SCHEMA distance-cache `normalize` contract documented.

---

## ⚠️ NOT fixed — CRITICAL (still open, out of scope for this pass)

These remain and should be addressed before relying on this deployment:

1. **No authentication on most endpoints** + wildcard CORS — `sentinel-scan-save` (writes),
   `sentinel-scan-list` (DELETE), and all `nuvizz-*`/`motive-*`/`totalpass`/`sentinel-ai`
   endpoints are anonymously callable.
2. **Hardcoded secret `davis2026sentinel`** shipped in client JS and used as the server
   fallback (`readEnv('SCAN_SECRET') || 'davis2026sentinel'`). Rotate + remove the fallback (fail closed).
3. **Hardcoded B600 credentials** (`admin`/`admin12345`) and real host in `totalpass-scraper.js`.
   Rotate the password, remove the literals, scrub git history.
4. **`firestore-introspect.js`** — full-DB introspection behind the hardcoded secret; SCHEMA says
   it should already be deleted.
5. **`sentinel-ai.js` `_rawPrompt` passthrough** — anonymous prompt injection / free LLM proxy.

Recommended: add a single shared `requireSecret()` gate (header, not query-string, fail-closed),
rotate both secrets, and delete `firestore-introspect.js`.
