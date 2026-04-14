// sentinel-nuvizz-patch.js  v2
// Wires NuVizz live data into SENTINEL's date-based scan flow.
// When a scan date is selected and Run Scan is triggered, automatically
// pulls all loads + stops for that date from NuVizz and injects them
// into the audit engine — no manual load numbers needed.

(function () {
  'use strict';

  const API = '/api/nuvizz-loads-by-date';
  const AUDIT_API = '/api/nuvizz-route-audit';

  // ── State ──────────────────────────────────────────────────────────────────
  let currentDate = null;
  let scanInProgress = false;
  let lastScanResult = null;

  // ── Wait for React app to mount ────────────────────────────────────────────
  function waitForApp(cb) {
    if (document.getElementById('root')?.children?.length > 0) { cb(); return; }
    const obs = new MutationObserver(() => {
      if (document.getElementById('root')?.children?.length > 0) { obs.disconnect(); cb(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Inject the NuVizz date scan bar ───────────────────────────────────────
  function injectScanBar() {
    if (document.getElementById('nv-scan-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'nv-scan-bar';
    bar.style.cssText = `
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: linear-gradient(90deg, #060e1c 0%, #0a1628 100%);
      border-top: 1px solid #00d4ff44;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 14px;
      z-index: 9999;
      font-family: 'Orbitron', 'Courier New', monospace;
      box-shadow: 0 -4px 20px #00d4ff11;
    `;

    bar.innerHTML = `
      <span style="color:#00d4ff;font-size:11px;font-weight:700;letter-spacing:2px;white-space:nowrap;">◈ NUVIZZ LIVE</span>

      <input type="date" id="nv-date-input" style="
        background:#0a1628;
        border:1px solid #00d4ff55;
        border-radius:6px;
        color:#fff;
        padding:7px 10px;
        font-family:inherit;
        font-size:11px;
        outline:none;
        cursor:pointer;
      " />

      <button id="nv-scan-btn" style="
        background: linear-gradient(135deg, #00d4ff22, #0066aa22);
        border: 1px solid #00d4ff66;
        border-radius: 6px;
        color: #00d4ff;
        padding: 7px 18px;
        cursor: pointer;
        font-family: inherit;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 1px;
        white-space: nowrap;
        transition: all 0.2s;
      ">▶ RUN SCAN</button>

      <div id="nv-scan-status" style="
        flex: 1;
        color: #8899aa;
        font-size: 10px;
        letter-spacing: 1px;
      "></div>

      <div id="nv-scan-badges" style="display:flex;gap:8px;"></div>

      <button id="nv-clear-btn" style="
        background: transparent;
        border: 1px solid #ff444433;
        border-radius: 6px;
        color: #ff444466;
        padding: 6px 12px;
        cursor: pointer;
        font-family: inherit;
        font-size: 10px;
        white-space: nowrap;
      ">CLEAR</button>
    `;

    document.body.appendChild(bar);

    // Add bottom padding to body so content isn't hidden behind bar
    document.body.style.paddingBottom = '60px';

    // Set default date to today
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('nv-date-input').value = today;
    currentDate = today;

    // Wire events
    document.getElementById('nv-date-input').addEventListener('change', (e) => {
      currentDate = e.target.value;
    });

    document.getElementById('nv-scan-btn').addEventListener('click', runScan);

    document.getElementById('nv-clear-btn').addEventListener('click', clearScan);
  }

  // ── Run scan for selected date ─────────────────────────────────────────────
  async function runScan() {
    if (scanInProgress) return;
    if (!currentDate) { setStatus('Select a date first', '#ff4444'); return; }

    scanInProgress = true;
    const btn = document.getElementById('nv-scan-btn');
    btn.textContent = '⟳ SCANNING...';
    btn.style.opacity = '0.6';
    btn.style.cursor = 'not-allowed';
    clearBadges();

    setStatus(`Fetching all loads for ${currentDate} from NuVizz...`, '#ffcc00');

    try {
      const res = await fetch(`${API}?date=${currentDate}`);
      const data = await res.json();

      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);

      lastScanResult = data;

      if (data.auditRecords.length === 0) {
        setStatus(`No loads found for ${currentDate} in NuVizz. Check date or company code.`, '#ff8800');
        scanInProgress = false;
        btn.textContent = '▶ RUN SCAN';
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';

        // If NuVizz date endpoint not supported, fall back to prompting for load numbers
        injectFallbackPanel(currentDate);
        return;
      }

      const s = data.summary;
      setStatus(
        `✓ ${s.totalRoutes} routes · ${s.totalStops} stops · ${s.totalMilesActual} mi actual · ${s.totalStolenHrs} stolen hrs · $${s.totalStolenDollars} est loss`,
        '#00ff88'
      );

      renderBadges(data.summary);
      renderRouteTable(data.auditRecords, currentDate);
      injectIntoSentinelAuditEngine(data.auditRecords);

      // Show error count if any loads failed
      if (data.errors?.length > 0) {
        setStatus(
          `✓ ${s.totalRoutes} routes loaded · ${data.errors.length} failed to fetch`,
          '#ff8800'
        );
      }

    } catch (err) {
      setStatus(`✗ Scan failed: ${err.message}`, '#ff4444');
    } finally {
      scanInProgress = false;
      btn.textContent = '▶ RUN SCAN';
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    }
  }

  // ── Fallback: if NuVizz date endpoint returns 0, let user enter load numbers ──
  function injectFallbackPanel(date) {
    let panel = document.getElementById('nv-fallback-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'nv-fallback-panel';
      document.body.appendChild(panel);
    }
    panel.innerHTML = `
      <div style="
        position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
        background:#0a1628; border:1px solid #00d4ff44; border-radius:12px;
        padding:24px; width:400px; z-index:99999; font-family:'Orbitron',monospace;
        box-shadow:0 0 40px #00d4ff22;
      ">
        <div style="color:#00d4ff;font-size:12px;font-weight:700;margin-bottom:8px;">◈ ENTER LOAD NUMBERS FOR ${date}</div>
        <div style="color:#8899aa;font-size:10px;margin-bottom:12px;">
          NuVizz date-based lookup returned 0 routes. Paste load/route numbers below (one per line) to scan manually.
        </div>
        <textarea id="nv-fb-input" placeholder="e.g.&#10;ROUTE001&#10;ROUTE002" rows="6" style="
          width:100%;box-sizing:border-box;
          background:#060e1c;border:1px solid #00d4ff33;border-radius:6px;
          color:#fff;padding:8px;font-family:inherit;font-size:11px;resize:vertical;outline:none;
        "></textarea>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button onclick="window._nvFallbackFetch()" style="
            flex:1;background:#00d4ff22;border:1px solid #00d4ff55;border-radius:6px;
            color:#00d4ff;padding:8px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:700;
          ">FETCH THESE LOADS</button>
          <button onclick="document.getElementById('nv-fallback-panel').remove()" style="
            background:transparent;border:1px solid #ff444433;border-radius:6px;
            color:#ff444466;padding:8px 14px;cursor:pointer;font-family:inherit;font-size:10px;
          ">✕</button>
        </div>
        <div id="nv-fb-status" style="color:#ffcc00;font-size:9px;margin-top:8px;min-height:14px;"></div>
      </div>
    `;

    window._nvFallbackFetch = async () => {
      const lines = document.getElementById('nv-fb-input').value.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return;
      const statusEl = document.getElementById('nv-fb-status');
      statusEl.textContent = `Fetching ${lines.length} loads...`;
      const records = [], errors = [];
      for (let i = 0; i < lines.length; i += 3) {
        const batch = lines.slice(i, i + 3);
        statusEl.textContent = `Fetching ${i+1}–${Math.min(i+3,lines.length)} of ${lines.length}...`;
        const settled = await Promise.allSettled(batch.map(async n => {
          const r = await fetch(`${AUDIT_API}?loadNbr=${encodeURIComponent(n)}`);
          const d = await r.json();
          if (!r.ok || !d.success) throw new Error(d.error);
          return d.auditRecord;
        }));
        settled.forEach((r, idx) => {
          if (r.status === 'fulfilled') records.push(r.value);
          else errors.push({ loadNbr: batch[idx], error: r.reason?.message });
        });
      }
      records.sort((a, b) => b.score - a.score);
      setStatus(`✓ ${records.length} routes loaded${errors.length ? ` · ${errors.length} failed` : ''}`, '#00ff88');
      renderRouteTable(records, date);
      injectIntoSentinelAuditEngine(records);
      document.getElementById('nv-fallback-panel').remove();
    };
  }

  // ── Clear scan ─────────────────────────────────────────────────────────────
  function clearScan() {
    lastScanResult = null;
    const tbl = document.getElementById('nv-route-table');
    if (tbl) tbl.remove();
    clearBadges();
    setStatus('');
    window.__NUVIZZ_AUDIT_RECORDS__ = [];
    window.dispatchEvent(new CustomEvent('nuvizz-data-updated', { detail: { records: [] } }));
  }

  // ── Status / badges ────────────────────────────────────────────────────────
  function setStatus(msg, color = '#8899aa') {
    const el = document.getElementById('nv-scan-status');
    if (el) { el.textContent = msg; el.style.color = color; }
  }

  function clearBadges() {
    const el = document.getElementById('nv-scan-badges');
    if (el) el.innerHTML = '';
  }

  function renderBadges(summary) {
    const el = document.getElementById('nv-scan-badges');
    if (!el) return;
    const riskColor = { critical: '#ff4444', high: '#ff8800', medium: '#ffcc00', low: '#00ff88' };
    el.innerHTML = ['critical', 'high', 'medium', 'low'].map(r =>
      summary[r] > 0 ? `<span style="
        background:${riskColor[r]}22;border:1px solid ${riskColor[r]}55;
        border-radius:4px;padding:3px 8px;color:${riskColor[r]};font-size:9px;font-weight:700;
      ">${summary[r]} ${r.toUpperCase()}</span>` : ''
    ).join('');
  }

  // ── Inject NuVizz records into SENTINEL's React audit engine ──────────────
  function injectIntoSentinelAuditEngine(records) {
    window.__NUVIZZ_AUDIT_RECORDS__ = records;
    window.dispatchEvent(new CustomEvent('nuvizz-data-updated', { detail: { records } }));

    // Try to reach setUploads via React fiber
    try {
      const root = document.getElementById('root');
      const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fiberKey) return;

      let fiber = root[fiberKey];
      let attempts = 0;
      while (fiber && attempts++ < 200) {
        const state = fiber.memoizedState;
        if (state) {
          let hook = state;
          while (hook) {
            if (hook.queue?.dispatch && hook.memoizedState && typeof hook.memoizedState === 'object') {
              const v = hook.memoizedState;
              // Identify the uploads hook — it's an object with motive/b600/nuvizz keys or null
              if ('motive' in v || 'b600' in v || 'nuvizz' in v || v === null) {
                hook.queue.dispatch({
                  ...v,
                  nuvizz: {
                    source: 'nuvizz-live',
                    rows: records.map(r => ({
                      driver: r.driver, truck: r.truck, loadNbr: r.loadNbr,
                      clockIn: r.clockIn, clockOut: r.clockOut,
                      engineH: r.engineH, miles: r.miles, mph: r.mph,
                      stops: r.stops, score: r.score, risk: r.risk,
                      flags: r.flags, stolenH: r.stolenH, stolenD: r.stolenD,
                      source: r.source,
                    }))
                  }
                });
                break;
              }
            }
            hook = hook.next;
          }
        }
        fiber = fiber.return || fiber.child;
      }
    } catch (_) {}
  }

  // ── Route table ────────────────────────────────────────────────────────────
  function renderRouteTable(records, date) {
    let panel = document.getElementById('nv-route-table');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'nv-route-table';
      // Insert before the main table or append to root
      const mainTable = document.querySelector('table');
      if (mainTable?.parentNode) mainTable.parentNode.insertBefore(panel, mainTable);
      else document.getElementById('root')?.appendChild(panel);
    }

    const rc = { critical: '#ff4444', high: '#ff8800', medium: '#ffcc00', low: '#00ff88' };

    panel.innerHTML = `
      <div style="
        margin:0 0 24px 0;
        background:linear-gradient(135deg,#0a1628,#0d2040);
        border:1px solid #00d4ff44;border-radius:12px;
        padding:20px;font-family:'Orbitron',monospace;overflow-x:auto;
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div style="color:#00d4ff;font-size:13px;font-weight:700;letter-spacing:2px;">
            ◈ ROUTE INTELLIGENCE — ${date} — ${records.length} ROUTES — NUVIZZ LIVE
          </div>
          <div style="color:#8899aa;font-size:10px;">Click row to expand stops</div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;color:#ccd;">
          <thead>
            <tr style="border-bottom:1px solid #00d4ff33;color:#8899aa;text-align:left;">
              <th style="padding:8px 10px;">DRIVER</th>
              <th style="padding:8px 10px;">ROUTE</th>
              <th style="padding:8px 10px;">IN / OUT</th>
              <th style="padding:8px 10px;">1ST DEL</th>
              <th style="padding:8px 10px;">LAST DEL</th>
              <th style="padding:8px 10px;">SPAN</th>
              <th style="padding:8px 10px;">STOPS</th>
              <th style="padding:8px 10px;">PLAN MI</th>
              <th style="padding:8px 10px;">ACT MI</th>
              <th style="padding:8px 10px;">STEM</th>
              <th style="padding:8px 10px;">UNACCT</th>
              <th style="padding:8px 10px;">FLAGS</th>
              <th style="padding:8px 10px;">SCORE</th>
              <th style="padding:8px 10px;">RISK</th>
            </tr>
          </thead>
          <tbody>
            ${records.map((r, i) => `
              <tr style="border-bottom:1px solid #ffffff0a;cursor:pointer;"
                  onclick="window._nvToggleRow(${i})">
                <td style="padding:8px 10px;font-weight:700;color:#fff;">${r.driver}</td>
                <td style="padding:8px 10px;color:#8899aa;font-size:9px;">${r.loadNbr}<br>${r.routeName || ''}</td>
                <td style="padding:8px 10px;">${r.clockIn || '—'}<br>${r.clockOut || '—'}</td>
                <td style="padding:8px 10px;color:#ffcc00;">
                  ${r.firstDeliveryTime || '—'}
                  ${r.firstDeliveryCity ? `<br><span style="color:#8899aa;font-size:9px;">${r.firstDeliveryCity}</span>` : ''}
                  ${r.firstDeliveryMinsAfterStart != null ? `<br><span style="color:${r.firstDeliveryMinsAfterStart > 90 ? '#ff4444' : '#8899aa'};font-size:9px;">+${r.firstDeliveryMinsAfterStart}min</span>` : ''}
                </td>
                <td style="padding:8px 10px;color:#ffcc00;">
                  ${r.lastDeliveryTime || '—'}
                  ${r.lastDeliveryCity ? `<br><span style="color:#8899aa;font-size:9px;">${r.lastDeliveryCity}</span>` : ''}
                </td>
                <td style="padding:8px 10px;">${r.routeSpanHrs != null ? r.routeSpanHrs + 'h' : '—'}</td>
                <td style="padding:8px 10px;">${r.stops}<br><span style="color:#8899aa;font-size:9px;">${r.totalStops} total</span></td>
                <td style="padding:8px 10px;">${r.plannedMiles ?? '—'}</td>
                <td style="padding:8px 10px;color:${r.miles > r.plannedMiles * 1.15 ? '#ff4444' : '#ccd'};">${r.miles ?? '—'}</td>
                <td style="padding:8px 10px;color:#8899aa;">${r.stemOutMiles ?? '—'}</td>
                <td style="padding:8px 10px;color:${r.unaccountedMins > 60 ? '#ff8800' : '#8899aa'};">${r.unaccountedMins != null ? r.unaccountedMins + 'min' : '—'}</td>
                <td style="padding:8px 10px;color:#ff8800;">${r.flagCount}</td>
                <td style="padding:8px 10px;font-weight:700;color:${rc[r.risk]};">${r.score}</td>
                <td style="padding:8px 10px;font-weight:700;color:${rc[r.risk]};text-transform:uppercase;">${r.risk}</td>
              </tr>
              <tr id="nv-row-${i}" style="display:none;">
                <td colspan="14" style="padding:0 10px 12px;">${renderStopDetail(r)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Store records for expand/collapse
    window._nvRecords = records;
  }

  window._nvToggleRow = (i) => {
    const row = document.getElementById(`nv-row-${i}`);
    if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
  };

  function renderStopDetail(r) {
    if (!r.stopDetail?.length) return '<div style="color:#8899aa;font-size:10px;padding:8px 0;">No stop detail.</div>';
    return `
      <div style="background:#060e1c;border-radius:8px;padding:12px;margin-top:6px;font-size:9px;overflow-x:auto;">
        <div style="color:#00d4ff;font-size:10px;margin-bottom:8px;">STOP DETAIL — ${r.driver}</div>
        ${r.flagList?.length ? `<div style="color:#ff8800;font-size:9px;margin-bottom:8px;">${r.flagList.map(f=>'▸ '+f).join('  ')}</div>` : ''}
        <table style="width:100%;border-collapse:collapse;color:#8899aa;">
          <thead><tr style="color:#556677;border-bottom:1px solid #ffffff11;">
            <th style="padding:4px 8px;text-align:left;">SEQ</th>
            <th style="padding:4px 8px;text-align:left;">STOP#</th>
            <th style="padding:4px 8px;text-align:left;">CITY</th>
            <th style="padding:4px 8px;text-align:left;">PLAN ETA</th>
            <th style="padding:4px 8px;text-align:left;">ACTUAL ARR</th>
            <th style="padding:4px 8px;text-align:left;">DEP</th>
            <th style="padding:4px 8px;text-align:left;">DWELL</th>
            <th style="padding:4px 8px;text-align:left;">MI→NEXT</th>
            <th style="padding:4px 8px;text-align:left;">STATUS</th>
            <th style="padding:4px 8px;text-align:left;">EXCEPTIONS</th>
          </tr></thead>
          <tbody>
            ${r.stopDetail.map(s => `
              <tr style="border-bottom:1px solid #ffffff08;">
                <td style="padding:4px 8px;">${s.seq}</td>
                <td style="padding:4px 8px;">${s.stopNbr}</td>
                <td style="padding:4px 8px;">${s.city}</td>
                <td style="padding:4px 8px;">${s.plannedEta || '—'}</td>
                <td style="padding:4px 8px;color:${s.dwellMins > 35 ? '#ff8800' : '#ccd'};">${s.actualArrival || '—'}</td>
                <td style="padding:4px 8px;">${s.actualDeparture || '—'}</td>
                <td style="padding:4px 8px;color:${s.dwellMins > 35 ? '#ff4444' : s.dwellMins < 3 ? '#ffcc00' : '#8899aa'};">${s.dwellMins != null ? s.dwellMins+'min' : '—'}</td>
                <td style="padding:4px 8px;">${s.milestoNext != null ? parseFloat(s.milestoNext).toFixed(1) : '—'}</td>
                <td style="padding:4px 8px;color:${s.etaCode==='DELAYED'?'#ff4444':s.etaCode==='ONTIME'?'#00ff88':'#8899aa'};">${s.etaCode||'—'}</td>
                <td style="padding:4px 8px;color:#ff4444;">${s.exceptions?.join(', ')||''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  waitForApp(() => {
    injectScanBar();
    console.log('[SENTINEL NuVizz v2] Ready. Select a date and click RUN SCAN.');
  });

})();
