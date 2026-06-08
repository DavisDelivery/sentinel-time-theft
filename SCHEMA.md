# SENTINEL v4 — Firestore Schema Contract

**Purpose:** Field-by-field contract for every collection SENTINEL touches.
**Source of truth for the design:** `DESIGN.md`. This doc is the implementation-level
contract — what fields code can safely read, what fields code is responsible for writing.

**Last verified against live Firestore:** 2026-05-14 via `/api/firestore-introspect`.

---

## Collections SENTINEL READS

### `/employees/{slug}` — Driver roster

Owned by MarginIQ. SENTINEL treats as authoritative for driver identity.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | string | yes | Slug, e.g. `che_roberts`. SENTINEL uses as `driverSlug`. |
| `fullName` | string | yes | Display name, e.g. "Che Roberts". |
| `firstName` | string | yes | |
| `lastName` | string | yes | |
| `status` | string | yes | `active` / inactive — SENTINEL skips non-active. |
| `role` | string | yes | `driver` / `owner_op` / `office` / `management` — SENTINEL scans `driver` and `owner_op` only. |
| `defaultTruck` | string \| null | no | Truck number string, e.g. `"2561"`. Contractors may be null. |
| `externalIds.motive` | string | no | Motive driver ID (numeric string), e.g. `"4955269"`. |
| `externalIds.nuvizz` | string | no | NuVizz display name, e.g. `"Che Roberts"`. **Match key for nuvizz_rows_raw lookups.** |
| `externalIds.b600` | string | no | B600 display name, e.g. `"Che Roberts"`. **Match key for timeclock_daily lookups.** May differ from nuvizz (e.g. `Brent Boyd` vs `Brenton Byrd`). |
| `externalIds.payroll` | string | no | CyberPay code, e.g. `"0686"`. |
| `aliases` | string[] | no | Additional name variants — often empty. SENTINEL falls back to fuzzy matching only if nothing else matches. |
| `payRate` | number | no | Hourly rate. SENTINEL uses for stolen-dollars only if truckType lookup fails. |

**SENTINEL does NOT depend on:** `payType`, `ytdGross`, `createdAt/By`, `updatedAt/By`, `source`.

---

### `/timeclock_daily/{YYYY-MM-DD}_{display_id}` — Daily B600 punches

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | string | yes | Doc ID format is `{date}_{display_id}`, e.g. `2024-12-29_B_Goodroe`. **Not** `{slug}_{date}`. |
| `date` | string | yes | `YYYY-MM-DD`. **Query key:** SENTINEL queries `where date == X`. |
| `clock_in` | string | yes | Local time `HH:MM` (24h). Combine with `date` for a naive datetime. |
| `clock_out` | string | yes | Local time `HH:MM` (24h). |
| `total_hours` | number | yes | Already computed by B600 ingestion. |
| `reg_hours` | number | no | |
| `ot_hours` | number | no | |
| `punches` | object[] | no | Multi-punch days: `[{ in: "HH:MM", out: "HH:MM", hours }]`. SENTINEL uses first.in / last.out if present; otherwise top-level `clock_in`/`clock_out`. |
| `display_id` | string | yes | B600 short name, e.g. `"Che Roberts"` or `"B Goodroe"`. |
| `display_name` | string | no | Upper-case form, e.g. `"BRAD GOODROE"`. |
| `payroll_id` | string | no | Title-case form, e.g. `"Brad Goodroe"`. |

**Matching to employees:** SENTINEL builds the lookup as: for each timeclock row, find the employee where `employees.externalIds.b600 == row.display_id || row.display_name || row.payroll_id`. First match wins.

**Timezone:** B600 times are local Eastern. No TZ field stored. SENTINEL treats as naive ET throughout.

---

### `/nuvizz_rows_raw/{pro}` — Raw NuVizz stop ingestion

**This is the source of truth for stop times and addresses.** The curated `/nuvizz_stops/` rollup drops both fields during MarginIQ's ingestion pipeline.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | string | yes | NuVizz PRO number, e.g. `"7105667"`. Equals `pro`. |
| `pro` | string | yes | |
| `delivery_date` | string | yes | `YYYY-MM-DD`. **Query key.** |
| `week_ending` | string | yes | |
| `month` | string | yes | `YYYY-MM` |
| `source` | string | yes | Always `"nuvizz"`. |
| `raw["driver name"]` | string | yes | NuVizz canonical driver name. **Match key — equality with `employees.externalIds.nuvizz`.** |
| `raw["delivery end"]` | string | yes | Format `M/D/YY HH:MM AM/PM` (e.g. `"4/20/26 11:37 AM"`). Parse with strict format. Local ET, no TZ. |
| `raw["ship to"]` | string | yes | Full street address: `"1350 Braselton Pkwy Ste 100, Braselton, GA 30517"`. Used as Distance Matrix destination. |
| `raw["ship to name"]` | string | yes | Customer name. |
| `raw["ship to - city"]` | string | yes | |
| `raw["ship to - zip code"]` | string | yes | |
| `raw["stop status"]` | string | yes | `"Completed"` / `"Cancelled"` / etc. **Filter to Completed only.** |
| `raw["stop number"]` | string | yes | NuVizz stop number (may have leading zeros). |

**Query pattern for one driver / one day:**
1. `db.listDocs('nuvizz_rows_raw', { where: [{ field: 'delivery_date', op: '==', value: 'YYYY-MM-DD' }], limit: 2000 })`
2. In-memory filter on `raw["driver name"] === employee.externalIds.nuvizz`
3. In-memory filter on `raw["stop status"] === "Completed"`
4. Sort by parsed `raw["delivery end"]` ascending
5. First and last are the morning/afternoon anchors.

---

### `/driverPerformanceDaily/{YYYY-MM-DD_slug}` — v3 cruft, READ-ONLY for bootstrap

SENTINEL does NOT trust v3 metrics. It reads this collection ONCE, at bootstrap, to seed `/sentinelConfig/truckTypeMap`. After bootstrap, this collection is never read again.

Bootstrap reads only:
- `truck` (string, e.g. `"2561"`) → key
- `driverType` (string, `"tractor"` | `"straight"`) → value

If a truck value contains non-numeric chars (e.g. `"Service Truck 1 #7206"`), skip it.

---

## Collections SENTINEL WRITES

### `/sentinelDriverDays/{driverSlug}_{YYYY-MM-DD}` — One doc per driver per day

The primary SENTINEL output. Full shape per `DESIGN.md` §3.

Phase 1 writes the following subset (rest defer to later phases):

```ts
{
  _id: "che_roberts_2026-04-27",
  driverSlug: "che_roberts",
  displayName: "Che Roberts",
  date: "2026-04-27",
  scanId: "scan_one_2026-04-27_1716...",
  truckType: "tractor" | "straight" | "unknown",

  // Clock data (from B600)
  clockIn: "HH:MM" | null,
  clockOut: "HH:MM" | null,
  totalShiftMin: number | null,
  b600Matched: boolean,

  // NuVizz data
  firstDeliveryTime: "YYYY-MM-DDTHH:MM" | null,
  firstDeliveryAddr: string | null,
  firstDeliveryCustomer: string | null,
  lastDeliveryTime: "YYYY-MM-DDTHH:MM" | null,
  lastDeliveryAddr: string | null,
  lastDeliveryCustomer: string | null,
  completedStops: number,
  nuvizzMatched: boolean,

  // Morning gap (flag class 1)
  clockInToFirstMin: number | null,
  expectedTravelMinToFirst: number | null,
  expectedTravelMinToFirstSource: "cache" | "api" | "skipped",
  loadPrepMin: 15,
  morningGapMin: number | null,
  morningFlag: "ok" | "warn" | "flag" | "critical" | "no_data",
  morningSeveritySource: "static" | "baseline",

  // Afternoon gap (flag class 2)
  lastToClockOutMin: number | null,
  expectedTravelMinFromLast: number | null,
  expectedTravelMinFromLastSource: "cache" | "api" | "skipped",
  wrapUpMin: 15,
  afternoonGapMin: number | null,
  afternoonFlag: "ok" | "warn" | "flag" | "critical" | "no_data",
  afternoonSeveritySource: "static" | "baseline",

  // In-route (flag class 3) — DEFERRED for Phase 1
  inRouteFlag: "deferred",

  // Data integrity (flag class 4)
  dataHealth: string[],  // e.g. ["b600_no_punch", "nuvizz_no_stops"]

  // Composite
  riskScore: 0-100,
  riskLevel: "clean" | "low" | "medium" | "high" | "critical",
  stolenMinutes: number,
  stolenDollars: number,
  flags: [{ kind, severity, evidence, deltaMin }],

  // Provenance
  createdAt: ISO timestamp,
  lastUpdated: ISO timestamp,
  version: "v4.0.1-phase1"
}
```

**Idempotency:** Re-scanning the same driver-day overwrites the doc. No history table in Phase 1.

---

### `/sentinelConfig/{key}` — SENTINEL-owned configuration

Doc IDs and shapes:

**`/sentinelConfig/truckTypeMap`** — written by sentinel-day-scan bootstrap if missing:
```ts
{
  _id: "truckTypeMap",
  trucks: { "2561": "tractor", "0294": "straight", ... },
  derivedFrom: "driverPerformanceDaily",
  sampleSize: number,
  generatedAt: ISO timestamp,
  version: 1
}
```

**`/sentinelConfig/defaults`** — written by sentinel-day-scan bootstrap if missing:
```ts
{
  _id: "defaults",
  loadPrepMin: 15,
  wrapUpMin: 15,
  wageRates: { tractor: 27.50, straight: 23.00, unknown: 25.00 },
  morningGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  afternoonGapStaticThresholds: { ok: 30, warn: 60, flag: 90 },
  generatedAt: ISO timestamp,
  version: 1
}
```

Operator can edit either doc directly in Firestore console; SENTINEL never overwrites once written.

---

### `/distanceMatrixCache/{cacheKey}` — Google Maps cache

`cacheKey = sha1(normalize(fromAddr) + '|' + normalize(toAddr))` where `normalize` = trim + lowercase + collapse whitespace + normalize comma spacing (`,\s*` → `, `). Any component computing this key must match `_distance.js:normalize()` exactly, or it will miss the existing cache and re-bill Google.

```ts
{
  _id: "<sha1 hex>",
  fromAddr: string,        // raw, for debugging
  toAddr: string,
  fromNorm: string,        // normalized, for debugging
  toNorm: string,
  minutes: number,         // duration in traffic-free minutes (best estimate)
  miles: number,
  status: "OK" | "ZERO_RESULTS" | "...",
  fetchedAt: ISO timestamp,
  version: 1
}
```

Cache is forever. Operator can purge entries manually if addresses ever need re-geocoding.

---

### `/sentinelScanRuns/{scanId}` — audit log

Not written by Phase 1 single-day scan; written by Phase 1 backfill orchestrator. Shape per `DESIGN.md` §3.

---

## Collections SENTINEL IGNORES

These exist in `davismarginiq` Firestore but SENTINEL does not read or write them:

- `/driver_classifications/` — W2/1099 tax status, not the alias map.
- `/nuvizz_stops/` — curated rollup that strips the fields we need.
- `/audit_items/`, `/audited_financials*` — Uline billing audit, not driver behavior.
- `/das_lines*`, `/ddis_*`, `/recon_*`, `/uline_*` — billing/payment domain.
- `/stop_economics_*` — atom-builder output, contractor pay attribution.
- `/sentinelScans/`, `/sentinelDriverHistory/`, `/sentinelScanStatus/` — v3 cruft. Left in place until Phase 5 cleanup; not touched by v4.

If a future SENTINEL feature requires reading any of these, update this doc first.
