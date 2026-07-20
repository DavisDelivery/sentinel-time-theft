// netlify/functions/sentinel-rescore-all-background.js
// SENTINEL v4 Phase 3 — re-classify every sentinelDriverDays record against
// the current /sentinelBaselines, run as a Netlify background function so it
// has the 15-minute execution budget instead of the 26-second request cap.
//
// After the 17-month backfill the collection has ~14k records; one
// foreground call can't do ~14k Firestore setDoc writes inside 26s and used
// to 502 out at 40s. This bg moves the same logic into a long-running
// invocation that checkpoints progress every CHECKPOINT_EVERY_RECORDS rows
// into sentinelConfig/rescoreAllStatus.
//
// Triggering: POSTed by sentinel-rescore-all (the thin trigger). The first
// invocation reads the kickoff status doc, locks in its `epoch`, and does
// the work. Re-reads epoch before every checkpoint and aborts on mismatch
// (mirrors the historical-backfill epoch-guard pattern so a concurrent
// reset cleanly kills any in-flight worker on its next checkpoint cycle).
//
// Status doc shape (sentinelConfig/rescoreAllStatus):
//   { state, epoch, scanId,
//     totalRecords, processed, cursor,
//     rescored, baselineUsed, staticFallback,
//     levelChanges, totalStolen{before,after,delta},
//     errorSamples, errors,
//     progressText,
//     startedAt, updatedAt, completedAt }

import { getDb } from './_firebase-admin.js';
import { rescoreOne, loadAllBaselines, loadDefaults } from './_sentinel-rescore.js';

const VERSION = 'v4.1.3-rescore-bg';
const STATUS_COLLECTION = 'sentinelConfig';
const STATUS_DOC = 'rescoreAllStatus';

const WALL_BUDGET_MS = 13 * 60 * 1000;       // 13min — 2min headroom under 15min bg cap
const WRITE_PARALLELISM = 20;                 // 20-way parallel setDoc within each batch
const CHECKPOINT_EVERY_BATCHES = 5;           // → status checkpoint every 100 records
const MAX_ERROR_SAMPLES = 25;

// Fields the bg may update during incremental progress writes. `epoch` is
// excluded by design: only the trigger (reset/kickoff) writes epoch, and the
// masked PATCH guarantees a bg checkpoint physically cannot clobber a fresh
// epoch installed by a concurrent reset. Same pattern as
// sentinel-historical-backfill-background.
const CHECKPOINT_FIELD_PATHS = [
  'state',
  'cursor', 'processed',
  'rescored', 'baselineUsed', 'staticFallback',
  'levelChanges',
  'totalStolen',
  'errorSamples', 'errors',
  'progressText',
  'completedAt',
  'updatedAt'
];

async function loadStatus(db) {
  try { return await db.getDoc(STATUS_COLLECTION, STATUS_DOC); } catch (_) { return null; }
}

async function writeStatusFull(db, status) {
  status.updatedAt = new Date().toISOString();
  await db.setDoc(STATUS_COLLECTION, STATUS_DOC, status);
}

async function writeCheckpoint(db, status) {
  status.updatedAt = new Date().toISOString();
  await db.patchDoc(STATUS_COLLECTION, STATUS_DOC, status, CHECKPOINT_FIELD_PATHS);
}

// Re-read the doc's `epoch` immediately before each checkpoint. If it doesn't
// match the value we captured at startup, a reset has superseded us — exit
// cleanly without writing stale progress or chaining a successor.
async function checkSuperseded(db, myEpoch) {
  let cur;
  try {
    cur = await db.getDoc(STATUS_COLLECTION, STATUS_DOC);
  } catch (e) {
    console.warn('[rescore-bg] epoch re-read failed, assuming not superseded:', e.message);
    return { superseded: false };
  }
  if (cur && cur.epoch != null && cur.epoch !== myEpoch) {
    return { superseded: true, currentEpoch: cur.epoch, myEpoch };
  }
  return { superseded: false };
}

function buildProgressText(processed, total) {
  const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0';
  return `${processed.toLocaleString()}/${total.toLocaleString()} records (${pct}%)`;
}

// Our own function URL, for self-chaining. Prefer Netlify's canonical site URL
// over req.url (which can be a localhost shim in some runtimes).
function selfUrlFromReq(req) {
  const u = new URL(req.url);
  let origin = u.origin;
  try {
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      const envUrl = Netlify.env.get('URL') || Netlify.env.get('DEPLOY_URL');
      if (envUrl) origin = envUrl.replace(/\/$/, '');
    }
  } catch (_) {}
  return `${origin}${u.pathname}`;
}

export default async (req, context) => {
  const t0 = Date.now();
  const db = getDb();

  let bodyOpts = {};
  try {
    const text = await req.text();
    if (text && text.trim()) bodyOpts = JSON.parse(text);
  } catch (_) {}

  let status = await loadStatus(db);

  // Same three-mode dispatch as historical-backfill: resume an active run,
  // honor a pending kickoff from the trigger, or refuse to spawn a phantom
  // run from a stale chain-style self-invocation.
  const isResume = status?.state === 'running';
  const isPendingKickoff = status?.state === 'pending';
  const isExplicitKickoff = !!bodyOpts.kickoff;
  const isKickoff = !isResume && (isPendingKickoff || isExplicitKickoff);

  if (!isResume && !isKickoff) {
    console.log(`[rescore-bg] orphan invocation (state=${status?.state || 'none'}, body=${JSON.stringify(bodyOpts)}) — aborting`);
    return new Response(JSON.stringify({
      aborted: true,
      reason: 'no running state and no kickoff signal',
      observedState: status?.state || null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Load shared inputs once per invocation. listAllDocs paginates so we get
  // ALL records (the bug PR #7 fixed for the synchronous version). The
  // employees roster is also loaded via listAllDocs: a capped listDocs page
  // would silently drop overrides for the alphabetically-last drivers once the
  // roster exceeds the cap, corrupting stolen-$ attribution with no signal.
  // employees-by-slug is consulted on every rescored record to resolve
  // loadPrepMin / wrapUpMin overrides.
  const [records, baselines, defaults, employees] = await Promise.all([
    db.listAllDocs('sentinelDriverDays'),
    loadAllBaselines(db),
    loadDefaults(db),
    db.listAllDocs('employees', { fields: ['loadPrepMin', 'wrapUpMin', 'truckType'] })
  ]);
  const employeesBySlug = {};
  for (const e of employees) {
    if (e?.id) employeesBySlug[e.id] = e;
  }
  console.log(`[rescore-bg] read ${records.length} records, ${Object.keys(baselines).length} baselines, ${Object.keys(employeesBySlug).length} employees`);

  if (isKickoff) {
    // Bump epoch off whatever's currently in the doc. Combined with the
    // trigger's own +1 bump, every kickoff lands on a strictly higher epoch
    // than any chain currently in flight.
    const newEpoch = (status?.epoch ?? 0) + 1;
    const startedAt = new Date().toISOString();
    const scanId = `rescoreall_${startedAt}`;

    status = {
      state: 'running',
      epoch: newEpoch,
      scanId,
      totalRecords: records.length,
      cursor: 0,
      processed: 0,
      rescored: 0,
      baselineUsed: 0,
      staticFallback: 0,
      errors: 0,
      errorSamples: [],
      levelChanges: {},
      totalStolen: { before: 0, after: 0, delta: 0 },
      progressText: buildProgressText(0, records.length),
      startedAt,
      completedAt: null
    };
    await writeStatusFull(db, status);
    console.log(`[rescore-bg] kickoff epoch=${newEpoch}, scanId=${scanId}, totalRecords=${records.length}`);
  } else {
    // Resume — keep existing cursor/totals from the status doc.
    console.log(`[rescore-bg] resume at cursor=${status.cursor}/${status.totalRecords} epoch=${status.epoch ?? '(none)'}`);
  }

  const myEpoch = status.epoch;

  // Process records[cursor..] in WRITE_PARALLELISM-wide batches. We re-read
  // the full records list every invocation (cheap relative to total work),
  // so resume just slices from `cursor`.
  let batchesSinceCheckpoint = 0;
  let wallExhausted = false;

  while (status.cursor < records.length) {
    if (Date.now() - t0 > WALL_BUDGET_MS) { wallExhausted = true; break; }

    const batch = records.slice(status.cursor, status.cursor + WRITE_PARALLELISM);
    const results = await Promise.allSettled(batch.map(r => {
      const baseline = baselines[r.driverSlug] || null;
      const employee = employeesBySlug[r.driverSlug] || null;
      const { next, sourceCounts } = rescoreOne(r, baseline, defaults, employee);
      const beforeLevel = r.riskLevel || 'clean';
      const afterLevel = next.riskLevel;
      const beforeStolen = r.stolenDollars || 0;
      const afterStolen = next.stolenDollars || 0;
      return db.setDoc('sentinelDriverDays', next._id, next)
        .then(() => ({ beforeLevel, afterLevel, beforeStolen, afterStolen, sourceCounts, id: next._id }));
    }));

    for (const res of results) {
      if (res.status !== 'fulfilled') {
        status.errors++;
        if (status.errorSamples.length < MAX_ERROR_SAMPLES) {
          status.errorSamples.push({
            message: String(res.reason?.message || res.reason).slice(0, 200)
          });
        }
        console.warn('[rescore-bg] write failed:', res.reason?.message || res.reason);
        continue;
      }
      const { beforeLevel, afterLevel, beforeStolen, afterStolen, sourceCounts } = res.value;
      status.rescored++;
      status.baselineUsed += sourceCounts.baseline;
      status.staticFallback += sourceCounts.static;
      status.totalStolen.before += beforeStolen;
      status.totalStolen.after += afterStolen;
      if (beforeLevel !== afterLevel) {
        const key = `${beforeLevel}→${afterLevel}`;
        status.levelChanges[key] = (status.levelChanges[key] || 0) + 1;
      }
    }

    status.cursor += batch.length;
    status.processed = status.cursor;

    batchesSinceCheckpoint++;
    if (batchesSinceCheckpoint >= CHECKPOINT_EVERY_BATCHES) {
      const guard = await checkSuperseded(db, myEpoch);
      if (guard.superseded) {
        console.log(`[rescore-bg] superseded mid-loop (myEpoch=${myEpoch}, doc.epoch=${guard.currentEpoch}) — aborting before checkpoint`);
        return new Response(JSON.stringify({
          superseded: true, myEpoch, currentEpoch: guard.currentEpoch, processed: status.processed
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      status.progressText = buildProgressText(status.processed, status.totalRecords);
      // Round running totals so the polled status doc stays readable.
      status.totalStolen.before = +status.totalStolen.before.toFixed(2);
      status.totalStolen.after = +status.totalStolen.after.toFixed(2);
      status.totalStolen.delta = +(status.totalStolen.after - status.totalStolen.before).toFixed(2);
      await writeCheckpoint(db, status);
      batchesSinceCheckpoint = 0;
    }
  }

  if (wallExhausted) {
    // 14k records easily fits in one invocation, but if a future dataset
    // grows past one wall budget we want a clean checkpoint here so the next
    // chain (or a re-trigger) can resume rather than restart from scratch.
    const guard = await checkSuperseded(db, myEpoch);
    if (guard.superseded) {
      console.log(`[rescore-bg] superseded at wall-budget exit (myEpoch=${myEpoch}, doc.epoch=${guard.currentEpoch})`);
      return new Response(JSON.stringify({ superseded: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    status.progressText = buildProgressText(status.processed, status.totalRecords) + ' — chaining to next invocation';
    status.totalStolen.before = +status.totalStolen.before.toFixed(2);
    status.totalStolen.after = +status.totalStolen.after.toFixed(2);
    status.totalStolen.delta = +(status.totalStolen.after - status.totalStolen.before).toFixed(2);
    // state stays 'running' with the checkpoint cursor, so the successor's
    // isResume path picks up exactly where this one stopped.
    await writeCheckpoint(db, status);

    // Self-chain (audit W3): re-invoke ourselves with an empty body so the
    // successor resumes from cursor. Previously we just stopped, leaving the
    // collection split across two engine versions once it outgrew one wall
    // budget. Mirrors the historical-backfill worker's proven chaining.
    const selfUrl = selfUrlFromReq(req);
    console.log(`[rescore-bg] wall budget exhausted at cursor=${status.cursor}/${status.totalRecords} — chaining ${selfUrl}`);
    const fire = fetch(selfUrl, { method: 'POST', body: '{}' })
      .catch(e => console.error('[rescore-bg] self-reinvoke failed:', e.message));
    if (context && typeof context.waitUntil === 'function') context.waitUntil(fire);
    else await fire;
    return new Response(JSON.stringify({
      state: 'chained',
      processed: status.processed,
      totalRecords: status.totalRecords,
      progressText: status.progressText
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }

  // Grid exhausted — finalize.
  const finalGuard = await checkSuperseded(db, myEpoch);
  if (finalGuard.superseded) {
    console.log(`[rescore-bg] superseded at completion (myEpoch=${myEpoch}, doc.epoch=${finalGuard.currentEpoch})`);
    return new Response(JSON.stringify({ superseded: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  status.state = 'complete';
  status.completedAt = new Date().toISOString();
  status.totalStolen.before = +status.totalStolen.before.toFixed(2);
  status.totalStolen.after = +status.totalStolen.after.toFixed(2);
  status.totalStolen.delta = +(status.totalStolen.after - status.totalStolen.before).toFixed(2);
  status.progressText = `Complete: ${status.rescored.toLocaleString()} rescored (${status.baselineUsed} baseline / ${status.staticFallback} static, ${status.errors} errors). Unexplained $${status.totalStolen.before} → $${status.totalStolen.after} (Δ $${status.totalStolen.delta}).`;
  await writeCheckpoint(db, status);
  console.log(`[rescore-bg] ${status.progressText} (wallMs=${Date.now() - t0})`);
  return new Response(JSON.stringify({
    state: 'complete',
    version: VERSION,
    wallMs: Date.now() - t0,
    rescored: status.rescored,
    baselineUsed: status.baselineUsed,
    staticFallback: status.staticFallback,
    errors: status.errors,
    levelChanges: status.levelChanges,
    totalStolen: status.totalStolen
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
