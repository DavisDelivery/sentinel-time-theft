// sentinel-nuvizz-patch.js
// Drop this script tag into SENTINEL's index.html AFTER the main React bundle.
// It injects a "Load from NuVizz" panel that fetches live route data and
// merges it into the existing SENTINEL audit table — no CSV required.
//
// <script src="/sentinel-nuvizz-patch.js"></script>

(function () {
  'use strict';

  const API = '/api/nuvizz-route-audit';

  // ── State ──────────────────────────────────────────────────────────────────
  let nuvizzRecords = [];   // scored audit records from NuVizz API
  let loadingLoads = {};    // loadNbr -> true while fetching
  let errorMap = {};        // loadNbr -> error string

  // ── Inject the NuVizz panel into the DOM ───────────────────────────────────
  function injectPanel() {
    // Don't double-inject
    if (document.getElementById('nv-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'nv-panel';
    panel.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      width: 360px;
      background: linear-gradient(135deg, #0a1628 0%, #0d2040 100%);
      border: 1px solid #00d4ff55;
      border-radius: 12px;
      padding: 18px 20px;
      z-index: 9999;
      font-family: 'Orbitron', 'Courier New', monospace;
      box-shadow: 0 0 30px #00d4ff22;
    `;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <span style="color:#00d4ff;font-size:12px;font-weight:700;letter-spacing:2px;">◈ NUVIZZ LIVE FEED</span>
        <button id="nv-collapse" style="background:none;border:none;color:#8899aa;cursor:pointer;font-size:16px;">−</button>
      </div>

      <div id="nv-body">
        <!-- Load number input -->
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <input
            id="nv-load-input"
            placeholder="Load / Route #"
            style="
              flex:1;
              background:#0a1628;
              border:1px solid #00d4ff44;
              border-radius:6px;
              color:#fff;
              padding:8px 10px;
              font-family:inherit;
              font-size:11px;
              outline:none;
            "
          />
          <button id="nv-fetch-btn" style="
            background:#00d4ff22;
            border:1px solid #00d4ff55;
            border-radius:6px;
            color:#00d4ff;
            padding:8px 14px;
            cursor:pointer;
            font-family:inherit;
            font-size:11px;
            font-weight:700;
            white-space:nowrap;
          ">FETCH</button>
        </div>

        <!-- Batch input -->
        <div style="margin-bottom:12px;">
          <textarea
            id="nv-batch-input"
            placeholder="Batch: one load # per line"
            rows="3"
            style="
              width:100%;
              box-sizing:border-box;
              background:#0a1628;
              border:1px solid #00d4ff33;
              border-radius:6px;
              color:#aabbcc;
              padding:8px 10px;
              font-family:inherit;
              font-size:10px;
              resize:vertical;
              outline:none;
            "
          ></textarea>
          <button id="nv-batch-btn" style="
            width:100%;
            margin-top:6px;
            background:#00d4ff11;
            border:1px solid #00d4ff33;
            border-radius:6px;
            color:#00d4ff99;
            padding:6px;
            cursor:pointer;
            font-family:inherit;
            font-size:10px;
            font-weight:700;
          ">BATCH FETCH ALL</button>
        </div>

        <!-- Status -->
        <div id="nv-status" style="
          color:#ffcc00;
          font-size:10px;
          min-height:16px;
          margin-bottom:8px;
          letter-spacing:1px;
        "></div>

        <!-- Loaded routes list -->
        <div id="nv-loaded-list" style="
          max-height:220px;
          overflow-y:auto;
          border-top:1px solid #00d4ff22;
          padding-top:10px;
        "></div>

        <!-- Clear button -->
        <button id="nv-clear-btn" style="
          width:100%;
          margin-top:10px;
          background:transparent;
          border:1px solid #ff444433;
          border-radius:6px;
          color:#ff444499;
          padding:6px;
          cursor:pointer;
          font-family:inherit;
          font-size:10px;
        ">CLEAR NUVIZZ DATA</button>
      </div>
    `;

    document.body.appendChild(panel);

    // Wire events
    document.getElementById('nv-fetch-btn').addEventListener('click', () => {
      const val = document.getElementById('nv-load-input').value.trim();
      if (val) fetchRoute(val);
    });

    document.getElementById('nv-load-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = e.target.value.trim();
        if (val) fetchRoute(val);
      }
    });

    document.getElementById('nv-batch-btn').addEventListener('click', () => {
      const lines = document.getElementById('nv-batch-input').value
        .split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length) fetchBatch(lines);
    });

    document.getElementById('nv-clear-btn').addEventListener('click', () => {
      nuvizzRecords = [];
      errorMap = {};
      renderLoadedList();
      mergeIntoSentinel();
      setStatus('');
    });

    document.getElementById('nv-collapse').addEventListener('click', () => {
      const body = document.getElementById('nv-body');
      const btn = document.getElementById('nv-collapse');
      if (body.style.display === 'none') {
        body.style.display = '';
        btn.textContent = '−';
      } else {
        body.style.display = 'none';
        btn.textContent = '+';
      }
    });
  }

  // ── Fetch a single route ───────────────────────────────────────────────────
  async function fetchRoute(loadNbr) {
    if (loadingLoads[loadNbr]) return;
    loadingLoads[loadNbr] = true;
    setStatus(`Fetching ${loadNbr}...`);

    try {
      const res = await fetch(`${API}?loadNbr=${encodeURIComponent(loadNbr)}`);
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // Replace or add
      const idx = nuvizzRecords.findIndex(r => r.loadNbr === loadNbr);
      if (idx >= 0) {
        nuvizzRecords[idx] = data.auditRecord;
      } else {
        nuvizzRecords.push(data.auditRecord);
      }

      delete errorMap[loadNbr];
      setStatus(`✓ ${data.auditRecord.driver} — ${data.auditRecord.stops} stops — Score: ${data.auditRecord.score} (${data.auditRecord.risk.toUpperCase()})`);

      renderLoadedList();
      mergeIntoSentinel();

    } catch (err) {
      errorMap[loadNbr] = err.message;
      setStatus(`✗ ${loadNbr}: ${err.message}`);
      renderLoadedList();
    } finally {
      delete loadingLoads[loadNbr];
    }
  }

  // ── Batch fetch ────────────────────────────────────────────────────────────
  async function fetchBatch(loadNbrs) {
    setStatus(`Fetching ${loadNbrs.length} routes...`);
    // 3 at a time to avoid rate limiting
    for (let i = 0; i < loadNbrs.length; i += 3) {
      const batch = loadNbrs.slice(i, i + 3);
      setStatus(`Fetching ${i + 1}–${Math.min(i + 3, loadNbrs.length)} of ${loadNbrs.length}...`);
      await Promise.all(batch.map(n => fetchRoute(n)));
    }
    setStatus(`✓ Done — ${nuvizzRecords.length} routes loaded`);
  }

  // ── Render loaded routes list in panel ─────────────────────────────────────
  function renderLoadedList() {
    const el = document.getElementById('nv-loaded-list');
    if (!el) return;

    if (nuvizzRecords.length === 0 && Object.keys(errorMap).length === 0) {
      el.innerHTML = '<div style="color:#8899aa;font-size:10px;">No routes loaded yet.</div>';
      return;
    }

    const riskColor = { critical: '#ff4444', high: '#ff8800', medium: '#ffcc00', low: '#00ff88' };

    el.innerHTML = nuvizzRecords.map(r => `
      <div style="
        border-bottom:1px solid #ffffff11;
        padding:8px 0;
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        gap:8px;
      ">
        <div style="flex:1;min-width:0;">
          <div style="color:#fff;font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${r.driver}
          </div>
          <div style="color:#8899aa;font-size:9px;">
            ${r.loadNbr} · ${r.stops} stops · ${r.miles != null ? r.miles + ' mi' : '—'}
          </div>
          <div style="color:#8899aa;font-size:9px;">
            ${r.firstDeliveryTime || '—'} → ${r.lastDeliveryTime || '—'}
            ${r.firstDeliveryCity ? '· 1st: ' + r.firstDeliveryCity : ''}
          </div>
          ${r.flagCount > 0 ? `<div style="color:#ff8800;font-size:9px;">${r.flagCount} flag(s)</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="color:${riskColor[r.risk] || '#fff'};font-size:12px;font-weight:700;">${r.score}</div>
          <div style="color:${riskColor[r.risk] || '#fff'};font-size:9px;text-transform:uppercase;">${r.risk}</div>
          <button onclick="window._nvRemove('${r.loadNbr}')" style="
            background:none;border:none;color:#ff444466;cursor:pointer;font-size:9px;padding:2px 0;
          ">remove</button>
        </div>
      </div>
    `).join('') + Object.entries(errorMap).map(([nbr, err]) => `
      <div style="padding:6px 0;border-bottom:1px solid #ffffff11;">
        <div style="color:#ff4444;font-size:10px;">✗ ${nbr}</div>
        <div style="color:#ff444488;font-size:9px;">${err}</div>
      </div>
    `).join('');
  }

  // ── Remove a single record ─────────────────────────────────────────────────
  window._nvRemove = function (loadNbr) {
    nuvizzRecords = nuvizzRecords.filter(r => r.loadNbr !== loadNbr);
    delete errorMap[loadNbr];
    renderLoadedList();
    mergeIntoSentinel();
  };

  // ── Merge NuVizz records into the SENTINEL React app ──────────────────────
  // SENTINEL uses a global SENTINEL_DATA array + an uploads state (setUploads).
  // We reach into the React fiber to find setUploads and inject our data,
  // so it appears seamlessly in the existing audit table.
  function mergeIntoSentinel() {
    // Strategy: expose nuvizzRecords on window so the React app can read them.
    // The patched handleFileUpload (below) merges these in.
    window.__NUVIZZ_AUDIT_RECORDS__ = nuvizzRecords;

    // Also try to trigger a React re-render by dispatching a custom event
    window.dispatchEvent(new CustomEvent('nuvizz-data-updated', {
      detail: { records: nuvizzRecords }
    }));

    // Additionally inject directly into SENTINEL's uploads state via React fiber
    tryInjectIntoReact();
  }

  function tryInjectIntoReact() {
    // Walk React fiber tree to find the App component's state setter
    try {
      const root = document.getElementById('root');
      if (!root) return;

      // Find React fiber
      const fiberKey = Object.keys(root).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (!fiberKey) return;

      let fiber = root[fiberKey];
      let found = false;

      // Walk up the fiber tree looking for the App component with setUploads
      while (fiber && !found) {
        const memoized = fiber.memoizedState;
        if (memoized) {
          // Walk the hook linked list
          let hook = memoized;
          while (hook) {
            if (hook.queue && typeof hook.queue.dispatch === 'function') {
              // Check if this is the uploads state by inspecting its current value
              const val = hook.memoizedState;
              if (val && typeof val === 'object' && ('motive' in val || 'nuvizz' in val || 'b600' in val || 'uploads' in val)) {
                // Found it - dispatch new nuvizz data into this state
                const newVal = { ...val, nuvizz: buildNuvizzUploadShape() };
                hook.queue.dispatch({ type: 'nuvizz_merge', payload: newVal });
                found = true;
                break;
              }
            }
            hook = hook.next;
          }
        }
        fiber = fiber.return || fiber.child;
        if (!fiber) break;
      }
    } catch (e) {
      // Silent fail — window event approach is the fallback
    }
  }

  // Build the shape that SENTINEL's uploads state expects for NuVizz data
  function buildNuvizzUploadShape() {
    if (nuvizzRecords.length === 0) return null;

    return {
      source: 'nuvizz-live',
      fetchedAt: new Date().toISOString(),
      recordCount: nuvizzRecords.length,

      // SENTINEL-compatible rows matching the existing CSV parsed shape
      rows: nuvizzRecords.map(r => ({
        // Original CSV fields SENTINEL expects
        driver: r.driver,
        truck: r.truck,
        clockIn: r.clockIn,
        clockOut: r.clockOut,
        engineH: r.engineH,
        miles: r.miles,
        mph: r.mph,
        stops: r.stops,
        score: r.score,
        risk: r.risk,
        flags: r.flags,
        stolenH: r.stolenH,
        stolenD: r.stolenD,
        source: r.source,

        // NEW enriched fields
        loadNbr: r.loadNbr,
        routeName: r.routeName,
        plannedMiles: r.plannedMiles,
        actualMiles: r.miles,
        stemOutMiles: r.stemOutMiles,
        driveH: r.driveH,
        routeSpanHrs: r.routeSpanHrs,
        unaccountedMins: r.unaccountedMins,

        // First/last delivery
        firstDeliveryTime: r.firstDeliveryTime,
        firstDeliveryCity: r.firstDeliveryCity,
        firstDeliveryMinsAfterStart: r.firstDeliveryMinsAfterStart,
        lastDeliveryTime: r.lastDeliveryTime,
        lastDeliveryCity: r.lastDeliveryCity,

        flagList: r.flagList,
        flagCount: r.flagCount,
        stopDetail: r.stopDetail,
      })),

      // Route-level summary table (new - displayed in SENTINEL route panel)
      routeSummaries: nuvizzRecords.map(r => ({
        loadNbr: r.loadNbr,
        routeName: r.routeName,
        driver: r.driver,
        truck: r.truck,
        score: r.score,
        risk: r.risk,
        stops: r.stops,
        miles: r.miles,
        plannedMiles: r.plannedMiles,
        stemOutMiles: r.stemOutMiles,
        routeSpanHrs: r.routeSpanHrs,
        firstDeliveryTime: r.firstDeliveryTime,
        firstDeliveryCity: r.firstDeliveryCity,
        firstDeliveryMinsAfterStart: r.firstDeliveryMinsAfterStart,
        lastDeliveryTime: r.lastDeliveryTime,
        lastDeliveryCity: r.lastDeliveryCity,
        unaccountedMins: r.unaccountedMins,
        stolenH: r.stolenH,
        stolenD: r.stolenD,
        flagCount: r.flagCount,
      })),
    };
  }

  // ── Route analysis panel - inject below main SENTINEL table ───────────────
  function injectRouteAnalysisPanel() {
    // Listen for nuvizz data updates and inject a route-level analysis table
    window.addEventListener('nuvizz-data-updated', (e) => {
      const records = e.detail.records;
      if (!records.length) {
        const existing = document.getElementById('nv-route-table');
        if (existing) existing.remove();
        return;
      }
      renderRouteTable(records);
    });
  }

  function renderRouteTable(records) {
    let panel = document.getElementById('nv-route-table');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'nv-route-table';
      // Insert after the main SENTINEL table, or append to body
      const mainTable = document.querySelector('table') || document.querySelector('[class*="table"]');
      if (mainTable && mainTable.parentNode) {
        mainTable.parentNode.insertBefore(panel, mainTable.nextSibling);
      } else {
        document.body.appendChild(panel);
      }
    }

    const riskColor = { critical: '#ff4444', high: '#ff8800', medium: '#ffcc00', low: '#00ff88' };
    const sorted = [...records].sort((a, b) => b.score - a.score);

    panel.innerHTML = `
      <div style="
        margin: 24px 16px;
        background: linear-gradient(135deg, #0a1628 0%, #0d2040 100%);
        border: 1px solid #00d4ff44;
        border-radius: 12px;
        padding: 20px;
        font-family: 'Orbitron', monospace;
        overflow-x: auto;
      ">
        <div style="color:#00d4ff;font-size:13px;font-weight:700;letter-spacing:2px;margin-bottom:16px;">
          ◈ ROUTE INTELLIGENCE — ${records.length} ROUTE(S) — NUVIZZ LIVE
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;color:#ccd;">
          <thead>
            <tr style="border-bottom:1px solid #00d4ff33;color:#8899aa;text-align:left;">
              <th style="padding:8px 10px;">DRIVER</th>
              <th style="padding:8px 10px;">ROUTE</th>
              <th style="padding:8px 10px;">CLOCK IN/OUT</th>
              <th style="padding:8px 10px;">1ST DEL</th>
              <th style="padding:8px 10px;">LAST DEL</th>
              <th style="padding:8px 10px;">SPAN HRS</th>
              <th style="padding:8px 10px;">STOPS</th>
              <th style="padding:8px 10px;">PLAN MI</th>
              <th style="padding:8px 10px;">ACT MI</th>
              <th style="padding:8px 10px;">STEM MI</th>
              <th style="padding:8px 10px;">UNACCT MIN</th>
              <th style="padding:8px 10px;">FLAGS</th>
              <th style="padding:8px 10px;">SCORE</th>
              <th style="padding:8px 10px;">RISK</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map(r => `
              <tr style="border-bottom:1px solid #ffffff0a;" onclick="window._nvExpandRoute('${r.loadNbr}')" style="cursor:pointer;">
                <td style="padding:8px 10px;font-weight:700;color:#fff;">${r.driver}</td>
                <td style="padding:8px 10px;color:#8899aa;">${r.loadNbr}<br><span style="font-size:9px;">${r.routeName || ''}</span></td>
                <td style="padding:8px 10px;">${r.clockIn || '—'}<br>${r.clockOut || '—'}</td>
                <td style="padding:8px 10px;color:#ffcc00;">
                  ${r.firstDeliveryTime || '—'}<br>
                  <span style="color:#8899aa;font-size:9px;">${r.firstDeliveryCity || ''}</span>
                  ${r.firstDeliveryMinsAfterStart != null ? `<br><span style="color:${r.firstDeliveryMinsAfterStart > 90 ? '#ff4444' : '#8899aa'};font-size:9px;">+${r.firstDeliveryMinsAfterStart}min</span>` : ''}
                </td>
                <td style="padding:8px 10px;color:#ffcc00;">
                  ${r.lastDeliveryTime || '—'}<br>
                  <span style="color:#8899aa;font-size:9px;">${r.lastDeliveryCity || ''}</span>
                </td>
                <td style="padding:8px 10px;">${r.routeSpanHrs != null ? r.routeSpanHrs + 'h' : '—'}</td>
                <td style="padding:8px 10px;">${r.stops}</td>
                <td style="padding:8px 10px;">${r.plannedMiles != null ? r.plannedMiles : '—'}</td>
                <td style="padding:8px 10px;color:${r.miles > r.plannedMiles * 1.15 ? '#ff4444' : '#ccd'};">${r.miles != null ? r.miles : '—'}</td>
                <td style="padding:8px 10px;color:#8899aa;">${r.stemOutMiles != null ? r.stemOutMiles : '—'}</td>
                <td style="padding:8px 10px;color:${r.unaccountedMins > 60 ? '#ff8800' : '#8899aa'};">${r.unaccountedMins != null ? r.unaccountedMins + 'min' : '—'}</td>
                <td style="padding:8px 10px;color:#ff8800;">${r.flagCount}</td>
                <td style="padding:8px 10px;font-weight:700;color:${riskColor[r.risk]};">${r.score}</td>
                <td style="padding:8px 10px;font-weight:700;color:${riskColor[r.risk]};text-transform:uppercase;">${r.risk}</td>
              </tr>
              <tr id="nv-expand-${r.loadNbr}" style="display:none;">
                <td colspan="14" style="padding:0 10px 12px;">
                  ${renderStopDetail(r)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderStopDetail(r) {
    if (!r.stopDetail || !r.stopDetail.length) return '<div style="color:#8899aa;font-size:10px;padding:8px 0;">No stop detail available.</div>';

    return `
      <div style="
        background:#060e1c;
        border-radius:8px;
        padding:12px;
        margin-top:6px;
        font-size:9px;
        color:#8899aa;
        overflow-x:auto;
      ">
        <div style="color:#00d4ff;font-size:10px;margin-bottom:8px;">STOP DETAIL — ${r.driver}</div>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="color:#556677;border-bottom:1px solid #ffffff11;">
              <th style="padding:4px 8px;text-align:left;">SEQ</th>
              <th style="padding:4px 8px;text-align:left;">STOP #</th>
              <th style="padding:4px 8px;text-align:left;">CITY</th>
              <th style="padding:4px 8px;text-align:left;">PLANNED ETA</th>
              <th style="padding:4px 8px;text-align:left;">ACTUAL ARR</th>
              <th style="padding:4px 8px;text-align:left;">DEP</th>
              <th style="padding:4px 8px;text-align:left;">DWELL</th>
              <th style="padding:4px 8px;text-align:left;">MI→NEXT</th>
              <th style="padding:4px 8px;text-align:left;">ETA STATUS</th>
              <th style="padding:4px 8px;text-align:left;">EXCEPTIONS</th>
            </tr>
          </thead>
          <tbody>
            ${r.stopDetail.map(s => `
              <tr style="border-bottom:1px solid #ffffff08;">
                <td style="padding:4px 8px;">${s.seq}</td>
                <td style="padding:4px 8px;">${s.stopNbr}</td>
                <td style="padding:4px 8px;">${s.city}</td>
                <td style="padding:4px 8px;">${s.plannedEta || '—'}</td>
                <td style="padding:4px 8px;color:${s.dwellMins > 35 ? '#ff8800' : '#ccd'};">${s.actualArrival || '—'}</td>
                <td style="padding:4px 8px;">${s.actualDeparture || '—'}</td>
                <td style="padding:4px 8px;color:${s.dwellMins > 35 ? '#ff4444' : s.dwellMins < 3 ? '#ffcc00' : '#8899aa'};">
                  ${s.dwellMins != null ? s.dwellMins + 'min' : '—'}
                </td>
                <td style="padding:4px 8px;">${s.milestoNext != null ? s.milestoNext.toFixed(1) : '—'}</td>
                <td style="padding:4px 8px;color:${s.etaCode === 'DELAYED' ? '#ff4444' : s.etaCode === 'ONTIME' ? '#00ff88' : '#8899aa'};">
                  ${s.etaCode || '—'}
                </td>
                <td style="padding:4px 8px;color:#ff4444;">${s.exceptions && s.exceptions.length ? s.exceptions.join(', ') : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${r.flagList && r.flagList.length ? `
          <div style="margin-top:10px;color:#ff8800;font-size:9px;">
            <span style="color:#ff8800;font-weight:700;">FLAGS: </span>
            ${r.flagList.map(f => `<span style="margin-right:10px;">▸ ${f}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  // Toggle stop detail expand/collapse
  window._nvExpandRoute = function (loadNbr) {
    const row = document.getElementById(`nv-expand-${loadNbr}`);
    if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
  };

  // ── Status helper ──────────────────────────────────────────────────────────
  function setStatus(msg) {
    const el = document.getElementById('nv-status');
    if (el) el.textContent = msg;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    // Wait for React to mount
    if (!document.getElementById('root')) {
      setTimeout(init, 200);
      return;
    }

    injectPanel();
    injectRouteAnalysisPanel();
    renderLoadedList();

    console.log('[SENTINEL NuVizz Patch] Loaded. Use the panel (top-right) to fetch live route data.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
