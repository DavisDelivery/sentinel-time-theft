# SENTINEL v4 — Design & Orchestrator Document

**Status:** Proposal, awaiting approval
**Author drafted from:** v3.10.25 pain points + Chad's directional input (May 13, 2026)
**Goal:** Rebuild SENTINEL as a focused, opinionated time-theft analyzer that reads from MarginIQ as the system of record, surfaces actionable findings, and stops accumulating dead weight.

---

## 1. Why we're rewriting

What's broken in v3.10.x:

1. **Numbers contradict themselves.** A scan shows 58.1 stolen hours and $1519 lost, but 0 flagged / 0 critical / 0 high. The scoring engine and the aggregate KPIs are computed in different places with different rules, so they drift.
2. **The "detail view" has no detail.** Tapping a scan shows a chip cloud of names and a risk badge. No clock times, no first/last delivery, no GPS reconciliation, no address sanity check, no per-driver flag breakdown.
3. **Clock-in → first-delivery and last-delivery → clock-out are the single biggest theft signals**, and they aren't a first-class view. They're buried inside scoring logic.
4. **No address/drive-time sanity check.** A driver clocks in at 6 AM and the first delivery scans at 9:30 AM, but the first stop is 20 minutes from the yard. That 3-hour window needs to be flagged loudly. We don't currently do this at all.
5. **Six tabs of overlap.** Threat Board, Driver Intel, Performance, History, Name Match, Algorithm. Most show variations of the same data. Mental load on the operator is high; the actual answer to "what should I look at this morning" is unclear.
6. **Data duplication.** B600 history, NuVizz history, driver roster are baked into `public/*.json` files in this repo AND live in MarginIQ. Two systems of record means they drift.
7. **No driver history at the driver level.** "Is Chris Head's clock-in → first-delivery gap getting worse over time?" — should be a one-tap answer. Currently requires manually scanning multiple dates.

---

## 2. Principles for v4

These are non-negotiable design rules. Every decision below traces back to one of these.

**P1. MarginIQ is the system of record.** SENTINEL reads from MarginIQ Firestore at scan time and writes its findings back to MarginIQ. No baked-in JSON files. No duplicate roster. No second source of truth for B600 or NuVizz data.

**P2. Driver-centric, not scan-centric.** The primary unit of analysis is *a driver across time*, not *a scan across drivers*. Scans are how data gets in; drivers are how data gets read.

**P3. Background by default, results always ready.** Scans run on a schedule (or on-demand) and write to driver-history collections. The UI never waits on a scan. Opening the app means reading pre-computed history.

**P4. Two windows that matter most.**
- **Clock-in → first delivery** (morning theft window)
- **Last delivery → clock-out** (afternoon theft window)
These get their own dashboard and their own flag classes. Everything else is supporting evidence.

**P5. Baselines are explicit and visible.** Every metric a driver is judged against shows what they're compared to:
- Their own 30-day rolling average
- Their truck-type peer average (tractor vs straight)
- Their role peer average (shuttle vs route vs loadshift)
- Company-wide average
The driver can never be flagged without showing what "normal" looks like.

**P6. Two tabs, not six.** Daily Audit (the home view) and Investigations (driver deep-dive). Everything else moves to a Settings drawer or gets deleted.

**P7. No silent dropping.** If a name doesn't match, we surface it. If GPS is missing, we say so. If a baseline isn't computed yet, we say so. Empty cells are a UX failure.

---

## 3. Data model (in MarginIQ Firestore)

All of these collections already exist in MarginIQ. SENTINEL reads from them and writes its own findings into the new `sentinel*` collections.

### Existing (read-only from SENTINEL's perspective)

These names and shapes were confirmed via `firestore-introspect` on 2026-05-14. Full field-by-field contract lives in `SCHEMA.md`.

```
/employees/{slug}
  fullName, firstName, lastName, status, role
  externalIds: { motive, b600, nuvizz, payroll }   # cross-system ID map
  defaultTruck                                      # truck number string, e.g. "2561"
  aliases: [...]                                    # additional name variants (often empty)

  NOTE: There is NO truckType field on employees. SENTINEL derives
  truck-type (tractor | straight) from defaultTruck via a self-maintained
  map at /sentinelConfig/truckTypeMap, seeded from historical
  driverPerformanceDaily records on first scan.

/timeclock_daily/{YYYY-MM-DD}_{display_id}
  date, clock_in, clock_out, total_hours, reg_hours, ot_hours
  punches: [{ in, out, hours }]                     # multi-punch days (lunch breaks)
  display_id, display_name, payroll_id              # 3 name forms — match to employee.externalIds.b600

  NOTE: Doc ID is NOT {driverSlug}_{date}. Day-scan queries by
  `where date == X` and matches each result to an employee in-memory
  using payroll_id / display_name.

/nuvizz_rows_raw/{pro}                              # ← THE SOURCE OF TRUTH for stop time/address
  pro, delivery_date, week_ending, month, source, ingested_at
  raw: {
    "driver name": "...",                           # NuVizz canonical name (match employee.externalIds.nuvizz)
    "ship to":     "1350 Braselton Pkwy, Braselton, GA 30517",   # full street address
    "delivery end":"4/20/26 11:37 AM",              # M/D/YY HH:MM AM/PM — parse to datetime
    "ship to name", "ship to - city", "ship to - zip code",
    "stop status", "stop number", "stop original price", "stop sealnbr"
  }

  NOTE: The curated /nuvizz_stops/ rollup STRIPS the address and the
  time-of-day from the raw blob. SENTINEL must read /nuvizz_rows_raw/
  to get the data needed for §4 scoring. /nuvizz_stops/ remains useful
  only for the contractor-pay rollup, which SENTINEL does not care about.

/driver_classifications/{slug}
  classification: 'w2' | '1099', name, source, updated_at
  NOTE: Misnamed for our purposes — this is W2-vs-1099 tax status,
  NOT the alias map. SENTINEL does not use this collection.

# Motive GPS is NOT in Firestore — fetched live via Motive API per scan
# (existing /netlify/functions/motive-gps.mjs). Used in flag class 3 only.
```

### New (written by SENTINEL)

```
/sentinelDriverDays/{driverSlug}_{YYYY-MM-DD}
  driverSlug, date, scanId
  truckType, role

  -- Clock data (from B600)
  clockIn, clockOut, totalShiftMin
  b600Matched: bool

  -- Motive data
  motiveDriverId, vehicleNumbers[]
  firstMovement, lastMovement
  engineOnMin, drivingMin, milesActual

  -- NuVizz data
  firstDeliveryTime, firstDeliveryAddr, firstDeliveryCity
  lastDeliveryTime, lastDeliveryAddr, lastDeliveryCity
  totalStops, completedStops

  -- The two windows that matter
  clockInToFirstMin            -- minutes between clock-in and first delivery
  expectedTravelMinToFirst     -- estimated drive time from yard to first stop
  morningGapMin                -- clockInToFirstMin - expectedTravelMinToFirst
  morningGapBaselineDriver     -- driver's 30d rolling avg
  morningGapBaselinePeer       -- truck-type peer 30d avg
  morningFlag: 'ok' | 'warn' | 'flag' | 'critical'

  lastToClockOutMin
  expectedTravelMinFromLast    -- estimated drive time from last stop to yard
  afternoonGapMin
  afternoonGapBaselineDriver
  afternoonGapBaselinePeer
  afternoonFlag: 'ok' | 'warn' | 'flag' | 'critical'

  -- Composite
  riskScore: 0-100
  riskLevel: 'clean' | 'low' | 'medium' | 'high' | 'critical'
  stolenMinutes                -- minutes above peer baseline in the two windows
  stolenDollars                -- stolenMinutes * wage rate
  flags: [{ kind, severity, evidence, deltaMin }]

  -- Provenance
  createdAt, lastUpdated, version

/sentinelDriverProfiles/{driverSlug}
  driverSlug, displayName, truckType, role
  daysAnalyzed
  rolling30d: { morningGapMedian, afternoonGapMedian, stopsPerHrMedian,
                stolenMinAvg, stolenDollarsAvg }
  rolling90d: { ... }
  allTime: { ... }
  riskTrend: [{ date, riskScore }]  -- last 90 days for sparkline
  worstDays: [{ date, riskScore, primaryFlag }]  -- top 5
  flagFrequency: { morningGap: 12, afternoonGap: 8, lowStopsPerHr: 3, ... }
  lastUpdated

/sentinelBaselines/{key}
  -- key is one of: 'fleet_all', 'fleet_tractor', 'fleet_straight',
  --                'role_shuttle', 'role_route', 'role_loadshift'
  -- Computed weekly from all sentinelDriverDays
  morningGapMin: { median, p75, p90, p95 }
  afternoonGapMin: { median, p75, p90, p95 }
  stopsPerHr: { median, p75, p90 }
  shiftHrs: { median, p75, p90 }
  daysSampled, lastComputed

/sentinelScanRuns/{scanId}
  scanId, startDate, endDate, requestedBy
  driversAnalyzed, daysCovered
  status: 'queued' | 'running' | 'done' | 'failed'
  startedAt, finishedAt, durationMs
  error?: string
  -- Used for audit log only; UI reads from sentinelDriverDays/sentinelDriverProfiles

/sentinelConfig/{key}
  -- Self-maintained SENTINEL configuration. Keys:
  --   truckTypeMap   { trucks: { "2561": "tractor", "0294": "straight", ... },
  --                     derivedFrom: 'driverPerformanceDaily', generatedAt, version }
  --   defaults       { loadPrepMin: 15, wrapUpMin: 15,
  --                     wageRates: { tractor: 27.50, straight: 23.00, unknown: 25.00 },
  --                     morningGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  --                     afternoonGapStaticThresholds: { ok: 30, warn: 60, flag: 90 } }
  -- The static thresholds are used when peer baselines don't yet exist
  -- (i.e. before sentinelBaselines is populated post-backfill).

/distanceMatrixCache/{cacheKey}
  -- Cached Google Maps Distance Matrix results, keyed by
  -- sha1(normalize(from)|normalize(to)). One write per unique pair, forever.
  -- { fromAddr, toAddr, minutes, miles, source, fetchedAt }
```

---

## 4. Scoring engine — rewritten and simple

The current scoring engine has too many flag types fighting each other. The rewrite has **four flag classes**, period. Every flag has a severity calculated against a baseline.

### Flag class 1: Morning gap (clock-in → first delivery)

**Inputs:**
- `clockIn` (B600 timestamp — combine `timeclock_daily.date` + `timeclock_daily.clock_in` "HH:MM")
- `firstDeliveryTime` (NuVizz earliest completed stop — parse `nuvizz_rows_raw.raw["delivery end"]` with format `M/D/YY HH:MM AM/PM`, take the min across rows where `raw["driver name"]` matches the driver's `externalIds.nuvizz`)
- `firstDeliveryAddr` (`nuvizz_rows_raw.raw["ship to"]` from that earliest row)
- `yardAddress` (env var `SENTINEL_YARD_ADDRESS` = "943 Gainesville Hwy Bldg 200-4000, Buford, GA 30518")

**Compute:**
- `clockInToFirstMin` = `firstDeliveryTime` - `clockIn` (minutes, all timestamps assumed America/New_York local — same TZ for both punches and stops, so naive subtraction is correct)
- `expectedTravelMin` = estimated drive time from yard to first delivery address (via `/distanceMatrixCache/` or Google Maps Distance Matrix on first encounter, then cached forever per normalized address pair)
- `loadPrepMin` = `sentinelConfig/defaults.loadPrepMin` (default 15)
- `expectedTotalMin` = `expectedTravelMin` + `loadPrepMin`
- `morningGapMin` = `clockInToFirstMin` - `expectedTotalMin`

**Severity (transitional — pre-baseline):**
Until `sentinelBaselines` is populated post-backfill, use static thresholds from `sentinelConfig/defaults.morningGapStaticThresholds`:
- `morningGapMin` ≤ 30 → **ok**
- `morningGapMin` > 30 and ≤ 60 → **warn**
- `morningGapMin` > 60 and ≤ 90 → **flag**
- `morningGapMin` > 90 → **critical**

**Severity (steady-state — post-baseline):**
Once `sentinelBaselines/{peer_key}` exists with `daysSampled >= 90`:
- `morningGapMin` ≤ baseline.p75 → **ok**
- `morningGapMin` > p75 and ≤ p90 → **warn**
- `morningGapMin` > p90 and ≤ p95 → **flag**
- `morningGapMin` > p95 → **critical**

**Stolen-minute attribution:** `max(0, morningGapMin - baselineFloor)` where `baselineFloor` is the static-threshold `ok` ceiling (30 min) pre-baseline, or `baseline.median` post-baseline. Conservative — only the portion above typical for the peer group counts.

### Flag class 2: Afternoon gap (last delivery → clock-out)

Same structure as morning, reversed:
- `lastDeliveryTime` = max parsed `raw["delivery end"]` for the driver/date in `nuvizz_rows_raw`
- `lastDeliveryAddr` = `raw["ship to"]` for that latest row
- `lastToClockOutMin` = `clockOut` - `lastDeliveryTime`
- `expectedTravelMin` = drive time from last delivery address back to yard (via `/distanceMatrixCache/`)
- `wrapUpMin` = `sentinelConfig/defaults.wrapUpMin` (default 15)
- `afternoonGapMin` = `lastToClockOutMin` - (`expectedTravelMin` + `wrapUpMin`)
- Severity thresholds same shape as morning, but against the afternoon baselines/static thresholds.

### Flag class 3: In-route anomaly (between first and last)

**Scope decision (2026-05-14):** Motive GPS is trusted ONLY for in-route signals. The owner does not trust Motive's first-movement / last-movement timestamps as the morning/afternoon time anchor (yard-shuffle activity contaminates the signal). Morning and afternoon gaps therefore use NuVizz timestamps exclusively; Motive is reserved for this class only.

Inputs: Motive GPS driving periods (live API call) + NuVizz stops list with coordinates from `raw["ship to"]` geocoded via Distance Matrix cache.

Two sub-signals:
1. **Long off-route pauses.** Any continuous Motive idle/parked stretch >30min during the active route window (firstDeliveryTime → lastDeliveryTime) where the GPS position is NOT within ~200m of any NuVizz `ship to` address from that day. Catches "took a 90-minute lunch off-route" and "sat at home for an hour mid-route."
2. **Miles-driven sanity.** Total Motive driving miles for the day compared to driver's own 30-day rolling avg miles-per-stop multiplied by today's stop count. Big positive deltas (>40% over expected) suggest detours or personal-use trips.

Phase 1 implementation note: Flag class 3 is **deferred until Phases 1a/1b complete and verified.** Initial day-scan computes classes 1, 2, 4 only and writes `inRouteFlag: 'deferred'`. Class 3 layered in once morning/afternoon math is signed off.

### Flag class 4: Data integrity

Not a theft signal — a data signal. Surfaced separately, never folded into riskScore.
- B600 punched but no GPS that day
- GPS that day but no B600 punch
- NuVizz stops but no B600 punch
- Driver in MarginIQ but no data from any source
- Name in a data source that didn't resolve to MarginIQ

**Why it matters:** These are the things that make the dashboard lie. We surface them in a separate "Data Health" strip on the Daily Audit so the operator knows which findings to trust.

### Composite riskScore (0-100)

```
score = 0
if morningFlag == 'critical': score += 40
elif morningFlag == 'flag':    score += 25
elif morningFlag == 'warn':    score += 10

if afternoonFlag == 'critical': score += 40
elif afternoonFlag == 'flag':    score += 25
elif afternoonFlag == 'warn':    score += 10

if inRouteAnomaly: score += 20

riskLevel:
  >= 70 -> critical
  >= 45 -> high
  >= 25 -> medium
  >= 10 -> low
  else  -> clean
```

A driver can be `critical` from morning alone (40 + 25 afternoon warn = 65 = high; 40 + 40 = critical).

---

## 5. Background processing

### Three jobs, all scheduled

**Job A: Nightly driver-day scan** (`sentinel-nightly-scan`)
- Runs at 2 AM ET daily.
- Pulls yesterday's B600, NuVizz, Motive data from MarginIQ.
- For each active driver, writes a `sentinelDriverDays` document.
- Triggers Job B for any affected drivers.

**Job B: Driver profile rollup** (`sentinel-rollup-profile`)
- Triggered per-driver after each new day is written.
- Recomputes `rolling30d`, `rolling90d`, `allTime`, `riskTrend`, `worstDays`, `flagFrequency`.
- Writes to `sentinelDriverProfiles/{driverSlug}`.

**Job C: Weekly baseline computation** (`sentinel-compute-baselines`)
- Runs Sunday at 3 AM ET.
- Reads last 90 days of `sentinelDriverDays`.
- Computes percentiles for fleet, truck-type, and role baselines.
- Writes to `sentinelBaselines/{key}`.

### Backfill (one-time)

We have 16 months of B600 and NuVizz data in MarginIQ. On v4 launch:
1. Run Job A iteratively over every day from `2025-01-01` to yesterday.
2. After all days written, run Job B for every driver.
3. Then run Job C.

This populates all history so the app is "always ready" on first open.

Estimated runtime: ~50 drivers × ~480 days = ~24k driver-days. At ~50ms per day (no Motive API needed for historical — we'd only use B600 + NuVizz for backfill since Motive doesn't expose old GPS), backfill completes in ~20 minutes split across batched function calls. We can throttle to stay under Firestore write limits (20k writes/day on free tier).

### On-demand scans

Still supported via UI for ad-hoc date ranges. Same code path as Job A, just driven by user input. Writes to the same collections — so an ad-hoc scan of "April 2026" just updates 30 driver-days that already exist.

---

## 6. UI — two tabs

### Tab 1: Daily Audit (home)

The operator's morning view. Default date = yesterday. Date picker at top supports single-day, week, month, or custom range.

```
┌──────────────────────────────────────────────────────────────┐
│ SENTINEL    Daily Audit | Investigations    [Settings ⚙]      │
├──────────────────────────────────────────────────────────────┤
│ Date: [< Apr 27, 2026 >]   Range: [Day][Week][Month][Custom] │
│                                                              │
│ ┌─ DATA HEALTH ──────────────────────────────────────────┐   │
│ │ 52 drivers expected · 48 with full data · 4 partial   │   │
│ │ ⚠ Brent Byrd: B600 punched, no NuVizz stops          │   │
│ └────────────────────────────────────────────────────────┘   │
│                                                              │
│ ┌─ FLEET SUMMARY ────────────────────────────────────────┐   │
│ │ 3 CRITICAL  ·  7 HIGH  ·  12 MEDIUM  ·  26 CLEAN      │   │
│ │ Estimated theft today: 14.2 hrs  /  $342              │   │
│ │ vs 30d avg: 18.6 hrs / $447  (▼ better)              │   │
│ └────────────────────────────────────────────────────────┘   │
│                                                              │
│ ┌─ MORNING WINDOW (clock-in → first delivery) ──────────┐   │
│ │ Driver          Clock  1st Del  Expected  Gap   Sev  │   │
│ │ Chris Head      06:00  09:42    07:15     2:27  CRIT │   │
│ │ Brent Byrd      06:15  08:55    07:30     1:25  FLAG │   │
│ │ Montel Bishop   05:45  07:48    07:15     0:33  WARN │   │
│ │ [show all 23 with morning gap >0] ▼                  │   │
│ └────────────────────────────────────────────────────────┘   │
│                                                              │
│ ┌─ AFTERNOON WINDOW (last delivery → clock-out) ────────┐   │
│ │ Driver          Last Del  Clock Out  Expected Gap Sev│   │
│ │ Rasko Suljic    14:20     17:55      14:55   3:00 CRT│   │
│ │ Victor Fernandez 15:10    17:30      15:40   1:50 FLG│   │
│ │ [show all 19 with afternoon gap >0] ▼                │   │
│ └────────────────────────────────────────────────────────┘   │
│                                                              │
│ ┌─ ALL DRIVERS (sortable) ──────────────────────────────┐   │
│ │ tap any row to open Investigations for that driver    │   │
│ │ ...                                                    │   │
│ └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

Each row in the Morning/Afternoon windows is tappable → opens Investigations for that driver, that day.

Key behaviors:
- Numbers are clickable. Tapping `2:27 gap` opens the evidence sheet: clock-in time, first delivery address, expected travel, peer baseline, driver's 30d average.
- "Estimated theft today" always shows the comparison to baseline so a single bad day is contextualized.
- Data Health strip is always visible at the top. If any driver has incomplete data, it's surfaced before any conclusions.

### Tab 2: Investigations (driver deep-dive)

Pick a driver from a search box. Default tab when opened from a Daily Audit row.

```
┌──────────────────────────────────────────────────────────────┐
│ ← Daily Audit                                                │
│ Chris Head  🚛 tractor · route driver · Davis employee       │
│                                                              │
│ ┌─ RISK TREND (90 days) ────────────────────────────────┐    │
│ │ [sparkline]      Current: 65 (HIGH) ▲ from 30d avg 42 │    │
│ └────────────────────────────────────────────────────────┘    │
│                                                              │
│ ┌─ ROLLING AVERAGES ────────────────────────────────────┐    │
│ │            7d      30d     90d     All Time           │    │
│ │ Morning   1:42  ↑ 1:15    1:08    1:12               │    │
│ │ Afternoon 0:48  ↑ 0:32    0:28    0:30               │    │
│ │ Stolen    1.8h    1.4h    1.2h    1.3h                │    │
│ │ $/day     $43    $33     $29     $31                  │    │
│ │ vs peer   ↑      ↑      ↑      ↑                      │    │
│ │ baseline (tractor route)  0:34 morning · 0:18 aft     │    │
│ └────────────────────────────────────────────────────────┘    │
│                                                              │
│ ┌─ TOP RECURRING ISSUES ────────────────────────────────┐    │
│ │ Morning gap (>p90): 38 times in last 90 days          │    │
│ │ Afternoon gap (>p90): 14 times                        │    │
│ │ Low stops/hr: 3 times                                  │    │
│ └────────────────────────────────────────────────────────┘    │
│                                                              │
│ ┌─ WORST 5 DAYS ────────────────────────────────────────┐    │
│ │ tap to drill into that day                            │    │
│ │ 2026-04-12 · 92 CRIT · 3:15 morning + 2:48 afternoon │    │
│ │ 2026-03-28 · 88 CRIT · ...                            │    │
│ └────────────────────────────────────────────────────────┘    │
│                                                              │
│ ┌─ DAY-BY-DAY (filterable) ─────────────────────────────┐    │
│ │ Date filter: [Last 30d ▼]   Sort: [Risk desc ▼]      │    │
│ │ 2026-04-27 · 65 HIGH · Morning 2:27 (CRIT) · Aft 0:18│    │
│ │ 2026-04-26 · 48 MED  · ...                            │    │
│ │ ...                                                    │    │
│ └────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

Tapping a date row expands an evidence sheet inline:
- Clock-in time (B600) + clock-out
- First delivery: time, address, city → expected travel from yard → actual gap
- Last delivery: time, address, city → expected travel back to yard → actual gap
- Total stops, stops/hr, peer baseline for stops/hr
- All GPS movements (start, end, miles) if useful
- Any flags raised, with the exact threshold each crossed

### Settings drawer

Everything else lives here, accessible from a gear icon:

- **Yard address** (the home base for travel-time calculations)
- **Load prep / wrap-up buffer minutes** (default 15)
- **Wage rates by truck type**
- **Run on-demand scan** (date picker + run button)
- **Backfill status** (one-time at launch)
- **Baseline freshness** (last computed: <date>)
- **Name reconciliation** — read-only view since MarginIQ owns this now. If a name doesn't resolve, link out to MarginIQ to fix.
- **Scan log** (last 50 runs, success/fail, duration)

---

## 7. What gets deleted

- `public/b600-history.json` — comes from MarginIQ now
- `public/nuvizz-2025.json`, `public/nuvizz-2026.json`, `public/nuvizz-manifest.json` — comes from MarginIQ now
- `netlify/functions/sync-b600-weekly.js` — no longer needed (MarginIQ handles ingest)
- The current Threat Board, Driver Intel, Performance, History, Name Match, Algorithm tabs in `public/index.html` — replaced by the two-tab design above
- Hardcoded `DRIVER_ROSTER` and `CANONICAL_NAME` in `sentinel-scan-run-background.mjs` — comes from MarginIQ's `driver_classifications` now
- Hardcoded `FLEET_BENCH` constants — replaced by computed `sentinelBaselines`
- The "AI Fleet Analysis" button — not part of v4 unless we explicitly add it back. Keep the Anthropic key env var for now.

---

## 8. What gets kept and refactored

- `netlify/functions/_firebase-admin.js` — the lightweight Firestore REST client. Already good.
- `netlify/functions/sentinel-scan-list.js` and `sentinel-scan-save.js` — repurpose to read/write the new collection schema.
- `netlify/functions/sentinel-scan-run-background.mjs` — gut the scoring engine, rewrite per Section 4. Keep the Motive auth and MarginIQ roster-loading logic.
- `netlify/functions/motive-gps.mjs`, `motive-dashcam.js` — keep as-is, they're API proxies.
- The Firestore env vars on Netlify — unchanged.

---

## 9. Migration / build order

We don't ship this all at once. Phased so each phase produces something you can verify before the next starts.

**Phase 1: Schema + backfill (no UI changes)**
- Write the three new Netlify functions: nightly scan, profile rollup, baseline computation.
- Implement the rewritten scoring engine per Section 4.
- Backfill 16 months of `sentinelDriverDays` from MarginIQ's existing B600 + NuVizz collections.
- Run rollup for every driver, then compute baselines.
- Verification: pull a Firestore document for Chris Head's `sentinelDriverProfiles` and check the numbers look right.

**Phase 2: Daily Audit tab**
- Build the new Daily Audit view from scratch (new HTML file or new section).
- Reads `sentinelDriverDays` + `sentinelBaselines` for the selected date range.
- Verification: open it for April 27, 2026 and confirm the morning/afternoon windows show the same drivers and numbers we'd see in MarginIQ raw data.

**Phase 3: Investigations tab**
- Build the driver deep-dive.
- Reads `sentinelDriverProfiles` for the rolling-average section, `sentinelDriverDays` for the day-by-day.
- Verification: open Chris Head, confirm the trend and worst-days match Phase 1 verification.

**Phase 4: Settings drawer + on-demand scans**
- Move yard address, buffers, wage rates, scan-trigger here.
- Hook on-demand scan to call Job A with a custom date range.

**Phase 5: Cleanup**
- Delete the old tabs and code per Section 7.
- Delete the JSON files in `public/`.
- Rename `APP_VERSION` to `4.0.0`.

Each phase is its own commit + deploy + your-eyes-on-it before moving to the next.

---

## 10. Open questions I need answered before Phase 1

1. **Yard address.** What's the exact address used as "home base" for the travel-time calculations? (For Davis Delivery in Buford, GA — what's the street address SENTINEL should use?)

2. **Travel-time source.** Three options for computing "expected travel time from yard to first delivery":
   - (a) Google Maps Distance Matrix API — accurate, costs money per request (cacheable per address pair). Estimate ~$0.005/lookup, mostly one-time cost since addresses repeat.
   - (b) Straight-line distance × fudge factor — free, rough (~20% error in metro areas).
   - (c) Build our own table from historical Motive data (first time a driver went from yard to address X, what did it take?) — free, more accurate over time but cold-start problem.

   My recommendation: **(a) with aggressive caching** in a new `/distanceMatrixCache/{from}_{to}` Firestore collection. Most stops repeat. After a few weeks we'd hit cache 95% of the time. But it requires you enabling Google Maps API and a billing account.

3. **Load-prep and wrap-up buffers.** Default 15 minutes each. Reasonable, or do you want different defaults by truck type?

4. **Backfill scope.** Backfill all 16 months (Jan 2025 → today), or last 6 months only? More data = better baselines but more Firestore writes and longer one-time backfill window.

5. **Scheduling.** Nightly Job A at 2 AM ET — confirm. Or run multiple times a day (e.g., every 4 hours during the operating window so the Daily Audit reflects in-progress days)?

6. **Are you on Netlify Pro?** Background functions (15-minute timeout) make Phase 1 backfill much easier. On the free plan we'd have to chunk into 26-second slices.

---

## 11. What this fixes from the v3.10.x complaints

| v3.10.x complaint | v4 fix |
|---|---|
| 58.1 stolen hrs but 0 flagged | Single source of truth: stolen hrs is computed from flag deltas, can't disagree. |
| No driver details in scan history | Investigations tab is the driver detail view; Daily Audit rows tap through to it. |
| Clock-in → first-delivery monitoring not built | First-class view in Daily Audit, dedicated flag class with severity. |
| No address sanity check | Expected travel time from yard to first/last stop is the core of morning/afternoon flag math. |
| Bloated 6-tab UX | Two tabs + Settings drawer. |
| Data scattered between repo JSON and MarginIQ | MarginIQ is the only source of record. |
| No per-driver behavior history | `sentinelDriverProfiles` is purpose-built for this; Investigations tab renders it. |
| Engine hours showed 23h impossibilities | New scoring engine doesn't rely on `engineOnMin` for theft signals at all — only clock and delivery timestamps. Engine hours are evidence, not the metric. |
| Driver count was wrong (90 vs 52) | MarginIQ active employees is the only roster. No Motive-roster bypass. |

---

## 12. Acceptance criteria — how we know v4 works

Phase 1 done when:
- I can query `sentinelDriverDays/chris-head_2026-04-27` and see correct clock-in, first delivery, expected travel, morning gap, severity.
- Backfill has run for all 16 months without errors.
- `sentinelBaselines/fleet_tractor` has 90+ daysSampled.

Phase 2 done when:
- Opening Daily Audit on yesterday's date loads in <1 second.
- Morning window shows the top N drivers ranked by morning gap severity.
- "Estimated theft" number matches the sum of stolen-minutes across all drivers.
- Tapping any driver row opens Investigations for that driver / that day.

Phase 3 done when:
- Searching "Chris Head" opens his Investigations view in <1 second.
- Rolling averages match independent spot-check against `sentinelDriverDays`.
- Tapping a date in day-by-day expands the evidence sheet.

Final acceptance when:
- A morning operator can open SENTINEL on a phone, see the day's flags, tap into the worst offender, see exactly why he's flagged with all the evidence, and decide whether to confront / coach / discipline — in under 90 seconds, with zero context outside the app.
