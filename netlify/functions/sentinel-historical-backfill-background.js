// netlify/functions/sentinel-historical-backfill-background.js
// SENTINEL v4 Phase 3c — one-time historical sweep of every (active driver × date)
// cell from startDate → endDate, calling the shared scanOneDriverDay core.
//
// Runs as a Netlify background function (15-min execution limit). When the wall
// budget is exhausted it checkpoints the (cursorDate, cursorDriver) pair into
// sentinelConfig/historicalBackfillStatus and re-invokes itself, so a single
// kickoff transparently chains across many invocations until done.
//
// Triggering:
//   POST /.netlify/functions/sentinel-historical-backfill-background
//   First call: body {startDate?, endDate?} from sentinel-historical-backfill
//     → loads roster, builds dates[], seeds status doc, begins.
//   Self-reinvocations: empty body → resumes from the status doc.
//
// Status doc shape: sentinelConfig/historicalBackfillStatus
//   { state: 'running' | 'complete' | 'error',
//     startDate, endDate,
//     dates: [YYYY-MM-DD...], driverSlugs: [...],
//     cursorDate, cursorDriver,
//     scanned, written, empty, errors, errorSamples: [],
//     chainCount, scanId,
//     startedAt, updatedAt, completedAt,
//     progressText }
//
// Skips Motive (Class 3) entirely — Motive history is sparse and unreliable
// past ~30 days. Skips Firestore writes for empty driver-days (no B600 punch
// AND no NuVizz stops) to keep collection growth proportional to real activity.

import { getDb } from './_firebase-admin.js';
import {
  scanOneDriverDay,
  loadOrBootstrapDefaults,
  loadOrBootstrapTruckTypeMap
} from './_sentinel-scan.js';

const VERSION = 'v4.1.0-phase3c';
const STATUS_COLLECTION = 'sentinelConfig';
const STATUS_DOC = 'historicalBackfillStatus';

const WALL_BUDGET_MS = 13 * 60 * 1000;          // 13 min — 2 min headroom under the 15min cap
const CHECKPOINT_EVERY_N = 25;                  // Persist progress every N scans
const DEFAULT_START_DATE = '2025-01-02';
const T_MINUS_DAYS = 7;                         // endDate default = today (ET) − 7 days
const MAX_ERROR_SAMPLES = 25;
const MAX_DATE_RANGE_DAYS = 1000;               // Sanity cap — refuse to build grids past this size

// ---------- Helpers ----------

function easternYMD(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

// Parse "YYYY-MM-DD" into a UTC Date pinned to midnight, so all calendar math
// stays on a single timezone (no DST jumps, no off-by-one when formatting back).
function ymdToUTCDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcDateToYMD(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Add days to a YYYY-MM-DD string and return the new YYYY-MM-DD string. UTC-only
// math: setUTCDate handles month/year rollover correctly without any timezone
// involvement. (Previous impl built a UTC Date then formatted it in ET, which
// landed 4–5h behind and made addDays(d, 1) return d unchanged for any UTC
// midnight — see the v4.1.0 backfill bug that produced 5,001 duplicate entries.)
function addDays(ymd, n) {
  const dt = ymdToUTCDate(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return utcDateToYMD(dt);
}

function defaultEndDateYMD() {
  // "Today (ET) − 7 days" — find today's ET calendar date, then do UTC math
  // on that string. We're not crossing into ET wall-clock time, just using ET
  // to decide which calendar day "today" is.
  return addDays(easternYMD(new Date()), -T_MINUS_DAYS);
}

// Walk calendar days inclusively from startYMD through endYMD. Increments one
// UTC day per iteration and terminates strictly when the cursor passes
// endYMD. Hard caps at MAX_DATE_RANGE_DAYS to refuse pathological inputs.
function buildDateRange(startYMD, endYMD) {
  const start = ymdToUTCDate(startYMD);
  const end = ymdToUTCDate(endYMD);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`buildDateRange: invalid date(s) ${startYMD} → ${endYMD}`);
  }
  if (end < start) {
    throw new Error(`buildDateRange: endDate ${endYMD} is before startDate ${startYMD}`);
  }
  const spanDays = Math.round((end - start) / 86400000) + 1;
  if (spanDays > MAX_DATE_RANGE_DAYS) {
    throw new Error(
      `buildDateRange: ${startYMD} → ${endYMD} spans ${spanDays} days, ` +
      `exceeds MAX_DATE_RANGE_DAYS=${MAX_DATE_RANGE_DAYS}`
    );
  }
  const out = [];
  const cur = new Date(start);
  while (cur <= end) {
    out.push(utcDateToYMD(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function loadActiveDriverSlugs(db) {
  const rows = await db.listDocs('employees', {
    where: [{ field: 'status', op: '==', value: 'active' }],
    limit: 500,
    fields: ['role']
  });
  return rows
    .filter(r => r.role === 'driver' || r.role === 'owner_op')
    .map(r => r.id)
    .sort();
}

async function loadStatus(db) {
  try { return await db.getDoc(STATUS_COLLECTION, STATUS_DOC); } catch (_) { return null; }
}

async function writeStatus(db, status) {
  status.updatedAt = new Date().toISOString();
  await db.setDoc(STATUS_COLLECTION, STATUS_DOC, status);
}

function buildProgressText(s) {
  const totalCells = (s.dates?.length || 0) * (s.driverSlugs?.length || 0);
  const doneCells = (s.cursorDate || 0) * (s.driverSlugs?.length || 0) + (s.cursorDriver || 0);
  const pct = totalCells > 0 ? ((doneCells / totalCells) * 100).toFixed(1) : '0.0';
  const curDate = s.dates?.[s.cursorDate] || '(end)';
  return `${doneCells.toLocaleString()}/${totalCells.toLocaleString()} cells (${pct}%) — currently ${curDate} chain#${s.chainCount}`;
}

function selfUrlFromReq(req) {
  const u = new URL(req.url);
  let origin = u.origin;
  // Hedge against environments where req.url is a localhost shim — prefer the
  // canonical site URL when Netlify exposes one.
  try {
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      const envUrl = Netlify.env.get('URL') || Netlify.env.get('DEPLOY_URL');
      if (envUrl) origin = envUrl.replace(/\/$/, '');
    }
  } catch (_) {}
  return `${origin}${u.pathname}`;
}

// ---------- Handler ----------

export default async (req, context) => {
  const t0 = Date.now();
  const db = getDb();

  // Parse incoming body (may be empty for self-reinvocations).
  let bodyOpts = {};
  try {
    const text = await req.text();
    if (text && text.trim()) bodyOpts = JSON.parse(text);
  } catch (_) {}

  let status = await loadStatus(db);

  // Three distinct invocation modes:
  //   resume  — status.state === 'running': chain self-invoke continuing an active sweep
  //   kickoff — status.state === 'pending' (trigger just wrote it) OR body has explicit
  //             startDate/endDate: build a fresh grid
  //   orphan  — neither of the above (status is complete/error/missing AND body is empty):
  //             a stale chain self-invoke whose run was already retired. Refuse to start
  //             a phantom new sweep — abort cleanly so we don't silently spawn a ~495 day
  //             grid that nobody asked for.
  const isResume  = status?.state === 'running';
  const isPendingKickoff = status?.state === 'pending';
  const isExplicitKickoff = !!(bodyOpts.startDate || bodyOpts.endDate);
  const isKickoff = !isResume && (isPendingKickoff || isExplicitKickoff);

  if (!isResume && !isKickoff) {
    console.log(`[backfill-bg] orphan invocation (state=${status?.state || 'none'}, empty body) — refusing to start a phantom sweep`);
    return new Response(JSON.stringify({
      aborted: true,
      reason: 'no running state and no kickoff signal',
      observedState: status?.state || null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (isKickoff) {
    // Fresh kickoff: build the grid, seed status doc.
    const startDate = bodyOpts.startDate || DEFAULT_START_DATE;
    const endDate = bodyOpts.endDate || defaultEndDateYMD();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      const err = `Invalid startDate/endDate: ${startDate} → ${endDate}`;
      console.error('[backfill-bg]', err);
      await writeStatus(db, {
        state: 'error', error: err, startedAt: new Date().toISOString()
      });
      return new Response(JSON.stringify({ error: err }), { status: 400 });
    }

    let dates;
    try {
      dates = buildDateRange(startDate, endDate);
    } catch (e) {
      console.error('[backfill-bg] buildDateRange rejected:', e.message);
      await writeStatus(db, {
        state: 'error', error: e.message, startDate, endDate,
        startedAt: new Date().toISOString()
      });
      return new Response(JSON.stringify({ error: e.message }), { status: 400 });
    }
    const driverSlugs = await loadActiveDriverSlugs(db);
    const startedAt = new Date().toISOString();
    const scanId = `histbackfill_${startedAt}`;

    status = {
      state: 'running',
      startDate, endDate,
      dates, driverSlugs,
      cursorDate: 0, cursorDriver: 0,
      scanned: 0, written: 0, empty: 0, errors: 0,
      errorSamples: [],
      chainCount: 1,
      scanId,
      startedAt,
      completedAt: null,
      progressText: ''
    };
    status.progressText = buildProgressText(status);
    await writeStatus(db, status);
    console.log(`[backfill-bg] kickoff: ${dates.length} dates × ${driverSlugs.length} drivers = ${dates.length * driverSlugs.length} cells, scanId=${scanId}`);
  } else {
    status.chainCount = (status.chainCount || 1) + 1;
    console.log(`[backfill-bg] resume chain#${status.chainCount} at date[${status.cursorDate}]=${status.dates?.[status.cursorDate]} driver[${status.cursorDriver}]`);
  }

  // Load config once for this invocation — passed into every scan to avoid 24,000 redundant getDoc calls.
  const [defaults, truckTypeMap] = await Promise.all([
    loadOrBootstrapDefaults(db),
    loadOrBootstrapTruckTypeMap(db)
  ]);
  const config = { defaults, truckTypeMap };

  // Walk the grid serially. Each scan involves ~3-4 Firestore reads + optional
  // setDoc, so serial keeps us well under the rate-limit ceiling and avoids
  // memory spikes — wall time is the constraint, not throughput.
  let sinceCheckpoint = 0;
  let wallExhausted = false;

  outer: for (; status.cursorDate < status.dates.length; status.cursorDate++) {
    const date = status.dates[status.cursorDate];
    for (; status.cursorDriver < status.driverSlugs.length; status.cursorDriver++) {
      // Wall-budget guard — checked before each scan
      if (Date.now() - t0 > WALL_BUDGET_MS) {
        wallExhausted = true;
        break outer;
      }

      const driverSlug = status.driverSlugs[status.cursorDriver];
      try {
        const { result } = await scanOneDriverDay({
          driverSlug,
          date,
          scanId: status.scanId,
          skipMotive: true,
          skipWriteIfNoData: true,
          config
        });
        status.scanned++;
        if (result._written) status.written++;
        else status.empty++;
      } catch (err) {
        status.errors++;
        if (status.errorSamples.length < MAX_ERROR_SAMPLES) {
          status.errorSamples.push({
            date, driverSlug,
            message: String(err?.message || err).slice(0, 200)
          });
        }
        console.warn(`[backfill-bg] scan failed ${driverSlug} ${date}: ${err.message}`);
      }

      sinceCheckpoint++;
      if (sinceCheckpoint >= CHECKPOINT_EVERY_N) {
        // Advance cursor past this driver so the resume cleanly starts on the next cell.
        status.cursorDriver++;
        status.progressText = buildProgressText(status);
        await writeStatus(db, status);
        sinceCheckpoint = 0;
        status.cursorDriver--; // restore for the normal increment to take over
      }
    }
    // Finished all drivers for this date — reset driver cursor for the next date.
    status.cursorDriver = 0;
  }

  // Decide: chain on, or finish.
  if (wallExhausted) {
    // Persist checkpoint as-is (cursors point at the next cell to process).
    status.progressText = buildProgressText(status);
    await writeStatus(db, status);

    const selfUrl = selfUrlFromReq(req);
    console.log(`[backfill-bg] wall budget exhausted at chain#${status.chainCount}, re-invoking ${selfUrl}`);
    // Use waitUntil so Netlify keeps the runtime alive long enough for the
    // re-invocation request to be accepted, then this invocation returns.
    const fire = fetch(selfUrl, { method: 'POST', body: '{}' })
      .catch(e => console.error('[backfill-bg] self-reinvoke fetch failed:', e.message));
    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(fire);
    } else {
      await fire;
    }
    return new Response(JSON.stringify({
      state: 'chained',
      chainCount: status.chainCount,
      scanned: status.scanned,
      progressText: status.progressText
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }

  // Grid exhausted — mark complete.
  status.state = 'complete';
  status.completedAt = new Date().toISOString();
  // Snap cursors to the end so the dashboard shows 100%.
  status.cursorDate = status.dates.length;
  status.cursorDriver = 0;
  status.progressText = `Complete: ${status.scanned.toLocaleString()} scanned, ${status.written.toLocaleString()} written, ${status.empty.toLocaleString()} empty, ${status.errors} errors across ${status.chainCount} chained invocation(s)`;
  await writeStatus(db, status);
  console.log(`[backfill-bg] ${status.progressText}`);
  return new Response(JSON.stringify({
    state: 'complete',
    scanned: status.scanned,
    written: status.written,
    empty: status.empty,
    errors: status.errors,
    chainCount: status.chainCount,
    version: VERSION
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
