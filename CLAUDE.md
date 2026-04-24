# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SENTINEL — a fleet time-theft detection web app for **Davis Delivery Service** (Buford, GA). It correlates three data sources to identify suspicious driver behavior:

1. **Motive** — GPS / driving periods / HOS / dashcam (via `MOTIVE_API_KEY`)
2. **NuVizz** (portal.nuvizz.com, OpenAPI v7) — dispatch, routes, stops, ETAs, exceptions (via basic auth)
3. **TotalPass B600** timeclock — clock-in/out punches (scraped from its web UI, no official API)

The app is a single-page static frontend with Netlify Functions acting as an API proxy / scoring engine. Claude (Sonnet) is used server-side for natural-language analysis.

## Build / run / deploy

There is **no build step, no bundler, no linter, no test suite**. `package.json` only declares the `@netlify/functions` runtime (Node ≥20, ESM).

- **Local dev:** `npx netlify dev` from the repo root. Serves `public/` and runs functions under `/api/*`. A redirect table in `netlify.toml` rewrites `/api/<name>` → `/.netlify/functions/<name>`.
- **Deploy:** pushed to `main` → Netlify auto-deploys. `publish = "public"`, `functions = "netlify/functions"`.
- **Smoke-test a single function:** `curl http://localhost:8888/api/nuvizz-loads-by-date?date=2026-04-14` (under `netlify dev`).
- **Version bumps:** the client reads `APP_VERSION` (currently `3.2.0`) near the top of the `<script>` block in `public/index.html`. Bump it in the same commit whose message is titled `vX.Y.Z: …`.

## What lives where (big picture)

```
public/                 ← everything Netlify serves
  index.html            ← THE app (~3000 lines, single file, inline CSS+JS)
  sentinel-nuvizz-patch.js  ← bottom "NUVIZZ LIVE" scan bar, injected at runtime
  b600-history.json     ← cached clock punches (Jan 2025 – Apr 2026)
  nuvizz-history.json   ← cached NuVizz delivery stops (~40K rows)

netlify/functions/      ← serverless backend (one file = one endpoint)
  motive-gps.mjs        ← proxy for Motive v1/v2 (vehicles, vehicle_history, driving_periods, ifta_trips, users, hos, safety_events)
  motive-dashcam.js     ← safety_events + vehicle_media_requests (video recall)
  nuvizz-load.js        ← /load/info/{loadNbr}/{company} — full route + stops
  nuvizz-loads-by-date.js ← date → all loadNbrs → parallel score (batch 5); returns fleet summary
  nuvizz-route-audit.js ← single load → scored audit record (same 8-flag engine)
  nuvizz-stops.js       ← /stop/info, single or batch of up to 50
  nuvizz-events.js      ← /event/eventactivity (entityType STOP or ROUTE)
  sentinel-ai.js        ← posts driver/fleet prompt to Claude (model: claude-sonnet-4-20250514)
  totalpass-scraper.js  ← logs into B600 via form POST, probes report paths for CSV/HTML
  sync-b600-weekly.js   ← SCHEDULED (cron "0 11 * * 1" = Mon 6 AM ET); scrape → dedupe → GitHub PUT back to public/b600-history.json

docs-nuvizz-openapi.json ← reference schema for NuVizz v7 (not deployed, do not ship)
index.html               ← OLDER standalone copy at repo root; not served by Netlify. Treat public/index.html as the source of truth.
netlify.toml             ← publish dir + per-endpoint /api redirects + CSP headers
```

## Required environment variables (Netlify)

| Var | Used by |
| --- | --- |
| `MOTIVE_API_KEY` | `motive-gps`, `motive-dashcam` |
| `NUVIZZ_USERNAME`, `NUVIZZ_PASSWORD` | all `nuvizz-*` functions |
| `NUVIZZ_BASE_URL` (optional, default `https://portal.nuvizz.com/deliverit/openapi/v7`) | all `nuvizz-*` |
| `NUVIZZ_COMPANY_CODE` (optional, default `davis`) | all `nuvizz-*` |
| `TOTALPASS_IP`, `TOTALPASS_PASSWORD`, `TOTALPASS_PORT?`, `TOTALPASS_EXPORT_PATH?` | `totalpass-scraper`, `sync-b600-weekly` |
| `ANTHROPIC_API_KEY` | `sentinel-ai` |
| `GITHUB_TOKEN` | `sync-b600-weekly` (needs contents write on `DavisDelivery/sentinel-time-theft`) |

## The scoring engine (shared invariant)

`nuvizz-route-audit.js` and `nuvizz-loads-by-date.js` **both** implement the same 8-flag scorer (`scoreLoad` / `scoreRoute`). If you change one, change the other or they will drift. The flags:

1. **Late First Delivery** — >90 min from `actualStartDTTM` (>150 min = +40, else +20)
2. **Excessive dwell** per stop — >35 min (+15 / >60 min +30)
3. **Excess mileage** — `actualDistMiles` >15% over `plannedDistMiles` (+20 / >30% +35)
4. **Duration overrun** — `actualDuration - plannedDuration` > 60 min (+15 / >120 min +30)
5. **Micro-stop cluster** — ≥3 consecutive delivery stops with dwell <3 min (+25 per cluster)
6. **Late stops** — count of stops with `etaCode === 'DELAYED'` > 3 (+5 each)
7. **Stop exceptions** — `exceptionPresent` stops (+10 each)
8. **Long gap after last delivery** — >120 min from last delivery to route end (+15 / >180 min +30)

Derived: `stolenMins = routeSpan - (driveTime + sum(dwell))`, `stolenDollars = stolenH × 23`.
Risk buckets: `critical ≥150`, `high ≥80`, `medium ≥40`, else `low`.

## Client-side conventions worth knowing before editing `public/index.html`

- **`DRIVER_ROSTER`** (grep for it) is a flat map keyed by lowercase driver name → `{role, type, co}`. It is deliberately fat with aliases: B600 typos, first-name-only punches, NuVizz spellings (e.g. `brent bryd` / `brenton byrd` / `brent boyd`). **When reconciling data shows a driver missing, add the alias here** — do not try to fuzzy-match at the call site.
- **Geofences** — `WAREHOUSE` (2000 ft @ 34.1477,-83.9610) and `ULINE` (1500 ft @ Braselton). Stops inside these are not flagged. Uline shuttle drivers get much looser thresholds via `getRoleThresholds('shuttle')`.
- **Shift window** — GPS is filtered to clock-in − `SHIFT_BUFFER_BEFORE` (30m) through clock-out + `SHIFT_BUFFER_AFTER` (90m). The 90m-after buffer is intentional so we still catch "GPS-after-clockout" theft.
- **Wages** — hard-coded in two places: the UI default (`WAGE()` reads `#wageRate`, default $23) and the Claude prompt in `sentinel-ai.js` (`$23/hr` box, `$27.50/hr` tractor).
- **Fleet / type benchmarks** (`FLEET_BENCH`, `TYPE_BENCH`) are hardcoded from real historical data — do not recompute on every render.
- **Settings persistence** — threshold overrides live in `localStorage['sentinel_settings']`.
- The root `index.html` is older and unused; always edit `public/index.html`.

## Commit / branch conventions

- Commit subjects follow `vX.Y.Z: <short imperative>` (see `git log`). Patch-level changes that don't touch the app can skip the version prefix.
- Active development branch for this task: `claude/add-claude-documentation-s9lLl`. Push with `-u origin <branch>`; open PRs as **draft**.
- `sync-b600-weekly` writes directly to `main` via the GitHub Contents API — avoid renaming `public/b600-history.json` unless you also update the hard-coded `path` there.
