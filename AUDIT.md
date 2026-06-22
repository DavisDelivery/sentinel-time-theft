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

---
---

# 2026-06-22 — "Empty KPI cards" investigation + follow-up code audit

Triggered by: the Overview shows `$0` unexplained time, `311 / 311 clean (100%)`, every
Reference-Metrics median as `—`, and "No drivers with unexplained time," while Baselines
still reports `49 drivers · 49 high`.

## TL;DR — the empty KPIs are a DATA problem, not a dashboard bug

I traced the full path **record write → `sentinel-read` dashboard → `index.html` render** and
the field contracts match end-to-end (`stolenDollars`, `stolenMinutes`, `riskLevel`,
`clockInToFirstMin`, `morningGapMin`, `lastToClockOutMin`, `firstDeliveryTime`,
`lastDeliveryTime`, `totalDriverDays`, `totalStolen.{dollars,minutes}`, `dist`, `datesPresent`).
The earlier hypothesis of a `totalStolen` / `totalDriverDays` name-shape mismatch is **ruled out** —
the names are identical on both sides.

The symptom fingerprint is decisive: the Reference buckets show `n_drivers` / `n_days`
**populated** (7/91, 6/66, 11/140, 1/14 → 311 days) but **every median is null**. Those medians
only push *numeric* timing fields, while the counts only need `driverSlug`. So the stored
`sentinelDriverDays` records have the counting fields but **no numeric gap fields** — i.e. they
were written without a computable morning/afternoon gap. That happens when a scored day is
missing **either** a B600 punch, **or** a matched NuVizz delivery, **or** a travel-time estimate
(`morningGapMin`/`afternoonGapMin` stay `null` → `riskLevel:'clean'`, `stolen $0`).

Because the nightly scan uses `skipWriteIfNoData:true`, a day is persisted as soon as **one**
feed has data, so a stale/non-matching NuVizz feed (most likely, given all four pair-metrics are
blank) yields punch-only records across the whole window → a silent all-clean `$0` dashboard.

**Root cause is upstream of this repo.** Per `SCHEMA.md`, `nuvizz_rows_raw` and
`timeclock_daily` are populated by MarginIQ's external ingestion; nothing in this repo writes
them (`totalpass-scraper.js` only *returns* B600 CSV, it does not persist it). The scan only
*reads* them and matches by `delivery_date == date` + `raw["driver name"] == externalIds.nuvizz`.

### Confirm it live (needs prod/console access)
1. `GET /api/sentinel-day-scan?secret=…&coverage=true` → newest ingested `delivery_date`
   (NuVizz) vs `date` (timeclock). If NuVizz's newest is older than the window, that's the gap.
2. `sentinelConfig/nightlyScanStatus` → `written` vs `empty` vs `errors` for the last run.
3. `GET /api/sentinel-read?action=detail&driverSlug=…&date=…` on one recent day → check
   `b600Matched` / `nuvizzMatched` and the `dataHealth` array (`nuvizz_no_stops`,
   `b600_no_punch`, `no_travel_time_to_first`).
4. Confirm `SENTINEL_YARD_ADDRESS` and `GOOGLE_MAPS_API_KEY` are set — if travel-time lookups
   all fail you can have punches **and** deliveries yet still null gaps.

## Fixed in this pass

- **Self-diagnosing dashboard (the headline fix).** `sentinel-read.js` now returns a
  `feedHealth` block (`scoredDays`, `withB600`, `withNuvizz`, `withBoth`, `withGapData`).
  `index.html` renders an amber banner on the Overview when days were scored but **none** had a
  computable gap, naming which feed is missing and pointing at the `coverage=true` probe — so this
  exact "$0 but actually broken" state can never again look like a clean fleet.
- `index.html` — `renderTrendIndicator` guards a missing/NaN delta (was "▼ $NaN"); the
  driver-detail Score row guards `riskScore`/`riskLevel` (was "undefined · undefined").
- `sentinel-performance.js` — `?days=abc` no longer 500s (`parseInt` NaN flowed into
  `Date.UTC` → `cutoff.toISOString()` threw); `?class=` now exact-matches (a stray value used to
  collapse to `straight` and silently drop `unknown`-class drivers); stopped leaking `err.stack`
  in the 500 body.
- `motive-gps.mjs` — closed the **open credentialed proxy** (`default: ep = action` let any
  caller hit any Motive endpoint under our server key → now rejects unknown actions); removed the
  unreachable duplicate `users`/`drivers` case; reads the upstream body once and tolerates non-JSON
  error pages (was `resp.json()` → throw on HTML 5xx).
- `sentinel-scan-run-background.mjs` — the committed Firebase Web API key now reads from
  `HUB_FIRESTORE_KEY` env first (literal kept only as fallback) so it can be rotated without a code
  change. **The key is in git history and still MUST be rotated.**

## Found, NOT changed — prioritized backlog

### CRITICAL (security — still open)
- **Committed Firebase Web API key** `sentinel-scan-run-background.mjs:514` for `davismarginiq`
  Firestore (employees/payroll/timeclock read access). Rotate + lock down Firestore rules.
- **Unauthenticated destructive / disclosure endpoints**, all with `Access-Control-Allow-Origin: *`:
  `sentinel-purge.js` (wipes scan history on `?confirm=YES`, no secret), `sentinel-scan-list.js`
  `DELETE` (no secret), `firestore-introspect.js` (dumps any collection — `SCHEMA.md` says it
  should already be deleted), `sentinel-scan-status.js` (open read of internal status/logs).
- **Hardcoded shared-secret fallbacks** `davis2026sentinel` (six files) and `sentinel2026`
  (`sentinel-scan-run-background.mjs`); guessable if `SCAN_SECRET` is ever unset in prod.
- **`sentinel-ai.js` `_rawPrompt`** — unauthenticated LLM passthrough on the server Anthropic key.
- Recommendation unchanged: one shared header-based `requireSecret()` gate (fail-closed), rotate
  all secrets, delete `firestore-introspect.js`.

### HIGH (correctness)
- **Separate NuVizz live-API audit tool is broken** (`nuvizz-loads-by-date.js`
  `getLoadNbrsByDate`, `nuvizz-events.js` `normalizeEvents`). Verified against the bundled
  `docs-nuvizz-openapi.json`: it queries `/event/eventactivity` with a non-existent `eventDttm`
  param and reads `raw.eventActivity` / `eventDesc`, but the API returns `entityEvents[].events[]`
  with `eventName` / `eventDTTM:{dttm,tz}` / `userFullName`. So the by-date NuVizz overlay never
  finds loads, and the `sentinel-nuvizz-patch.js` renderer expects a richer stop/flag shape than
  the server emits (mostly em-dashes even when data flows). **This tool does not write Firestore
  and does not feed the Overview — it is NOT the empty-KPI cause**, but it is genuinely broken.
- **NuVizz timezone double-conversion** (`nuvizz-route-audit.js` `fmtTime`, `nuvizz-loads-by-date.js`):
  naive-local stop timestamps are reparsed and re-zoned to `America/New_York`, shifting displayed
  times ~4–5h. Durations/ordering are internally consistent; absolute times are wrong.
- **Legacy `sentinel-scan-run-background.mjs`**: `_b600Cache` is a module-global "last 120 days"
  that ignores the requested date range and never invalidates (stale/empty matches on warm
  instances → wrong scores); GPS-fallback clock times use server-local `getHours`/`getDate` vs
  naive-ET, shifting gap math ~4–5h and risking off-by-one dates. Confirm whether this legacy path
  is still live; the v4 `_sentinel-scan.js` path is the careful one.
- **`sentinelDriverHistory` aggregates non-idempotent** (`sentinel-scan-save.js`): no `scanId`
  dedup + read-modify-write with no concurrency guard → double-count on retry / lost updates under
  concurrent scans. Use per-scan rows or Firestore `FieldTransform` increments.
- **Baseline corpus scoped to active roster only** (`sentinel-compute-baselines.js`): a suspended
  driver under investigation stops getting baseline refreshes and their history stops contributing.

### MEDIUM
- `_baselines.js` — `inRouteOffRouteMin` and `typicalCustomerZips` are always empty for
  backfill-built baselines (those fields exist only on Motive-enabled scans; backfill runs
  `skipMotive`). Emit a top-level `inRouteOffRouteMin: null` default and/or document the dependency.
- `_firebase-admin.js` `listDocs` — single `runQuery` with a `limit`, warns-but-doesn't-paginate.
  Today's volumes fit one streamed response (so not active data loss), but the big-limit callers
  (`sentinel-performance` 50000, `compute-baselines` 2000, `scan-list` 5000, NuVizz stops 2000)
  should route through the already-paginated `listAllDocs` (or add cursor pagination) before growth.
- `_distance.js` — non-OK Distance Matrix results are cached "forever" but the read path only
  returns `OK`, so non-OK entries re-fetch every call (no benefit) and a transient geocode miss
  costs repeated Google calls; self-heals on later success.
- `motive-gps.mjs` `driving_periods` — forwards scalar `vehicle_id`/`driver_id` which Motive
  silently ignores (returns whole org); normalize to the array-bracketed params `_motive.js` uses.
- `totalpass-scraper.js` — combined `Set-Cookie` split on `,` corrupts cookies containing
  `Expires` dates (only on runtimes lacking `getSetCookie`); off-range sanity check can reject a
  valid single-day pull.
- `sentinel-historical-backfill-background.js` — self-reinvoke relies on doc `state:'pending'` and
  can re-kick a full grid sweep under reset-during-chain; background functions are publicly
  invokable with no secret.
- `sentinel-weekly-baselines.js` — logs the secret inside the self-call URL.

### LOW
- `index.html` — `loadProfileInit` + Settings call `api('dashboard',{days:'all'})` bypassing the
  SWR cache/gen guard (perf); the audit "refresh date" re-binds a `change` listener each run
  (redundant fetches); annualization basis differs between fixed ranges (window length) and `all`
  (observed span); `fmtClockTime` AM/PM regex is unanchored.
- `sentinel-performance.js` — `recordCount` includes `unknown`-class records excluded from the
  benchmarks (reporting gap).
- `_motive.js` — distance-fallback unit assumption (km) is unverified; pagination hard-caps at 10
  pages.

---

## 2026-06-22 — Secrets removed + legacy v3 stack deleted (operator decision)

Per the owner: this is a single-operator internal tool that never wanted an
access secret. The `SCAN_SECRET` mechanism was removed entirely rather than
hardened — and because "no secret" would otherwise leave destructive/dump
endpoints anonymously callable, the unused legacy surface was deleted instead of
left open.

**Removed the secret everywhere**
- Client (`index.html`): dropped `DEFAULT_SECRET` / `getSecret` / `setSecret`,
  the Settings "Access Secret" field + save handler, and the `secret=` param on
  every fetch. No credential is sent.
- Server: removed the secret check from `sentinel-read`, `sentinel-write`,
  `sentinel-compute-baselines`, `sentinel-day-scan`, `sentinel-rescore-all`,
  `sentinel-historical-backfill`; `sentinel-weekly-baselines` no longer puts a
  secret in its internal call.

**Deleted (unused by the app; unsafe to leave un-authed)**
- `firestore-introspect.js` (full-DB dump — must never be public; SCHEMA already
  said to delete it).
- `sentinel-purge.js` (destructive).
- The legacy v3 scan stack: `sentinel-scan-run-background.mjs` (also carried the
  committed Firebase Web API key — now gone from source), `sentinel-scan-save.js`,
  `sentinel-scan-list.js`, `sentinel-scan-status.js`.
- Their `netlify.toml` redirects.

**Also:** stopped tracking `.netlify/` build artifacts (`git rm -r --cached`),
covered by the new `.gitignore`.

**Resolves** prior open CRITICALs #1 (committed Firebase key), the unauthenticated
purge / scan-list-DELETE / introspect endpoints, and the hardcoded secret
fallbacks. **Trade-off the owner accepted:** the remaining endpoints (dashboard
read, driver-config write, rescore, baselines) are now fully open with wildcard
CORS — anyone with the site URL can read the data and edit driver config. If that
ever needs locking down, put the whole site behind Netlify Identity / password
protection rather than re-introducing an in-app secret.
