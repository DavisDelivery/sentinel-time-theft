// sentinel-nuvizz-patch.js  v3
// Stop-level detail is the primary SENTINEL view.
// Business name, full address, planned ETA, actual arrival,
// completion time, dwell, and inter-stop gap are all front and center.

(function () {
  'use strict';

  const API = '/api/nuvizz-loads-by-date';
  const AUDIT_API = '/api/nuvizz-route-audit';

  let currentDate = null;
  let scanInProgress = false;

  const RC = { critical: '#ff4444', high: '#ff8800', medium: '#ffcc00', low: '#00ff88' };

  // Escape API-sourced strings before interpolating into innerHTML / attributes.
  // Mirrors the helper in index.html — this file had none, so every business
  // name, address, driver, etc. was injected raw.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // Numeric formatters used at render time. The summary now carries raw NUMBERS
  // (buildSummary stopped pre-stringifying via .toFixed), so format here. Coerce
  // defensively so a string from the server path still renders cleanly.
  const fmt1 = v => Number(v ?? 0).toFixed(1);
  const fmt2 = v => Number(v ?? 0).toFixed(2);

  function waitForApp(cb) {
    if (document.getElementById('root')?.children?.length > 0) { cb(); return; }
    const obs = new MutationObserver(() => {
      if (document.getElementById('root')?.children?.length > 0) { obs.disconnect(); cb(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Scan bar (bottom of screen) ────────────────────────────────────────────
  function injectScanBar() {
    if (document.getElementById('nv-scan-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'nv-scan-bar';
    bar.style.cssText = `
      position:fixed;bottom:0;left:0;right:0;
      background:linear-gradient(90deg,#060e1c,#0a1628);
      border-top:1px solid #00d4ff44;padding:10px 20px;
      display:flex;align-items:center;gap:12px;z-index:9999;
      font-family:'Orbitron','Courier New',monospace;
      box-shadow:0 -4px 20px #00d4ff11;
    `;
    bar.innerHTML = `
      <span style="color:#00d4ff;font-size:11px;font-weight:700;letter-spacing:2px;white-space:nowrap;">◈ NUVIZZ LIVE</span>
      <input type="date" id="nv-date-input" style="background:#0a1628;border:1px solid #00d4ff55;border-radius:6px;color:#fff;padding:6px 10px;font-family:inherit;font-size:11px;outline:none;cursor:pointer;"/>
      <button id="nv-scan-btn" style="background:linear-gradient(135deg,#00d4ff22,#0066aa22);border:1px solid #00d4ff66;border-radius:6px;color:#00d4ff;padding:6px 16px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:700;letter-spacing:1px;white-space:nowrap;">▶ RUN SCAN</button>
      <div id="nv-scan-status" style="flex:1;color:#8899aa;font-size:10px;letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>
      <div id="nv-scan-badges" style="display:flex;gap:6px;flex-shrink:0;"></div>
      <button id="nv-clear-btn" style="background:transparent;border:1px solid #ff444433;border-radius:6px;color:#ff444466;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:10px;white-space:nowrap;">CLEAR</button>
    `;
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '56px';

    const today = new Date().toISOString().split('T')[0];
    document.getElementById('nv-date-input').value = today;
    currentDate = today;

    document.getElementById('nv-date-input').addEventListener('change', e => { currentDate = e.target.value; });
    document.getElementById('nv-scan-btn').addEventListener('click', runScan);
    document.getElementById('nv-clear-btn').addEventListener('click', clearScan);
  }

  // ── Run scan ───────────────────────────────────────────────────────────────
  async function runScan() {
    if (scanInProgress || !currentDate) return;
    scanInProgress = true;
    const btn = document.getElementById('nv-scan-btn');
    btn.textContent = '⟳ SCANNING...';
    btn.style.opacity = '0.6';
    clearBadges();
    setStatus(`Fetching all routes for ${currentDate}...`, '#ffcc00');

    try {
      const res = await fetch(`${API}?date=${currentDate}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);

      const auditRecords = Array.isArray(data.auditRecords) ? data.auditRecords : [];
      if (auditRecords.length === 0) {
        setStatus(`No routes found for ${currentDate}. Enter load numbers manually.`, '#ff8800');
        injectFallback(currentDate);
      } else {
        const s = data.summary || buildSummary(auditRecords, currentDate);
        data.auditRecords = auditRecords;
        data.summary = s;
        setStatus(
          `✓ ${s.totalRoutes} routes · ${s.totalStops} stops · ${fmt1(s.totalMilesActual)}mi · $${fmt2(s.totalStolenDollars)} est theft`,
          '#00ff88'
        );
        renderBadges(s);
        renderResults(data, currentDate);
      }
    } catch (err) {
      setStatus(`✗ ${err.message}`, '#ff4444');
    } finally {
      scanInProgress = false;
      btn.textContent = '▶ RUN SCAN';
      btn.style.opacity = '1';
    }
  }

  // ── Fallback manual entry ──────────────────────────────────────────────────
  function injectFallback(date) {
    let p = document.getElementById('nv-fallback');
    if (!p) { p = document.createElement('div'); p.id = 'nv-fallback'; document.body.appendChild(p); }
    p.innerHTML = `
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#0a1628;border:1px solid #00d4ff44;border-radius:12px;padding:24px;width:420px;z-index:99999;font-family:'Orbitron',monospace;box-shadow:0 0 40px #00d4ff22;">
        <div style="color:#00d4ff;font-size:12px;font-weight:700;margin-bottom:6px;">◈ MANUAL LOAD ENTRY — ${escapeHtml(date)}</div>
        <div style="color:#8899aa;font-size:10px;margin-bottom:10px;">Paste route/load numbers, one per line:</div>
        <textarea id="nv-fb-input" rows="6" style="width:100%;box-sizing:border-box;background:#060e1c;border:1px solid #00d4ff33;border-radius:6px;color:#fff;padding:8px;font-family:inherit;font-size:11px;resize:vertical;outline:none;"></textarea>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button onclick="window._nvFetch()" style="flex:1;background:#00d4ff22;border:1px solid #00d4ff55;border-radius:6px;color:#00d4ff;padding:8px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:700;">FETCH</button>
          <button onclick="document.getElementById('nv-fallback').remove()" style="background:transparent;border:1px solid #ff444433;border-radius:6px;color:#ff444466;padding:8px 12px;cursor:pointer;font-family:inherit;font-size:10px;">✕</button>
        </div>
        <div id="nv-fb-status" style="color:#ffcc00;font-size:9px;margin-top:8px;min-height:14px;"></div>
      </div>`;
    window._nvFetch = async () => {
      const lines = document.getElementById('nv-fb-input').value.split('\n').map(l=>l.trim()).filter(Boolean);
      if (!lines.length) return;
      const fbStatus = document.getElementById('nv-fb-status');
      try {
        const records = [], errors = [];
        for (let i = 0; i < lines.length; i += 3) {
          const batch = lines.slice(i, i+3);
          fbStatus.textContent = `Fetching ${i+1}–${Math.min(i+3,lines.length)} of ${lines.length}...`;
          const settled = await Promise.allSettled(batch.map(async n => {
            const r = await fetch(`${AUDIT_API}?loadNbr=${encodeURIComponent(n)}`);
            const d = await r.json();
            // Default the error string so a missing d.error never produces
            // `new Error(undefined)`.
            if (!r.ok || !d.success) throw new Error(d.error || 'Unknown error');
            return d.auditRecord;
          }));
          settled.forEach((r,idx) => {
            if (r.status === 'fulfilled') records.push(r.value);
            else errors.push({ loadNbr: batch[idx], error: r.reason?.message || 'Unknown error' });
          });
        }
        records.sort((a,b) => b.score - a.score);
        setStatus(`✓ ${records.length} routes · ${errors.length} failed`, '#00ff88');
        renderResults({ auditRecords: records, summary: buildSummary(records, date), errors }, date);
        document.getElementById('nv-fallback')?.remove();
      } catch (err) {
        if (fbStatus) { fbStatus.textContent = `✗ ${err.message || 'Fetch failed'}`; fbStatus.style.color = '#ff4444'; }
        setStatus(`✗ ${err.message || 'Fetch failed'}`, '#ff4444');
      }
    };
  }

  function buildSummary(records, date) {
    return {
      date, totalRoutes: records.length,
      critical: records.filter(r=>r.risk==='critical').length,
      high: records.filter(r=>r.risk==='high').length,
      medium: records.filter(r=>r.risk==='medium').length,
      low: records.filter(r=>r.risk==='low').length,
      totalStops: records.reduce((a,r)=>a+(r.stops||0),0),
      // Keep these as NUMBERS (matches the server summary's numeric path) and
      // format only at render time via fmt1 / fmt2.
      totalMilesActual: records.reduce((a,r)=>a+(r.miles||0),0),
      totalStolenHrs: records.reduce((a,r)=>a+(r.stolenH||0),0),
      totalStolenDollars: records.reduce((a,r)=>a+(r.stolenD||0),0),
    };
  }

  function clearScan() {
    ['nv-results','nv-fallback'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
    clearBadges(); setStatus('');
  }

  function setStatus(msg, color='#8899aa') {
    const el = document.getElementById('nv-scan-status');
    if (el) { el.textContent = msg; el.style.color = color; }
  }

  function clearBadges() {
    const el = document.getElementById('nv-scan-badges');
    if (el) el.innerHTML = '';
  }

  function renderBadges(s) {
    const el = document.getElementById('nv-scan-badges');
    if (!el) return;
    el.innerHTML = ['critical','high','medium','low'].map(r =>
      s[r] > 0 ? `<span style="background:${RC[r]}22;border:1px solid ${RC[r]}55;border-radius:4px;padding:2px 7px;color:${RC[r]};font-size:9px;font-weight:700;">${s[r]} ${r.toUpperCase()}</span>` : ''
    ).join('');
  }

  // ── Main results renderer ──────────────────────────────────────────────────
  function renderResults(data, date) {
    let wrap = document.getElementById('nv-results');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'nv-results';
      const mainTable = document.querySelector('table');
      if (mainTable?.parentNode) mainTable.parentNode.insertBefore(wrap, mainTable);
      else document.getElementById('root')?.appendChild(wrap);
    }

    const auditRecords = Array.isArray(data.auditRecords) ? data.auditRecords : [];
    const summary = data.summary || buildSummary(auditRecords, date);

    wrap.innerHTML = `
      <div style="margin:0 0 24px;font-family:'Orbitron',monospace;">

        <!-- Fleet summary bar -->
        <div style="background:linear-gradient(135deg,#0a1628,#0d2040);border:1px solid #00d4ff44;border-radius:12px 12px 0 0;padding:16px 20px;display:flex;gap:24px;align-items:center;flex-wrap:wrap;">
          <div style="color:#00d4ff;font-size:12px;font-weight:700;letter-spacing:2px;">◈ ${escapeHtml(date)} — ${auditRecords.length} ROUTES</div>
          ${['critical','high','medium','low'].map(r => summary[r] > 0 ?
            `<span style="color:${RC[r]};font-size:11px;font-weight:700;">${summary[r]} ${r.toUpperCase()}</span>` : ''
          ).join('')}
          <div style="margin-left:auto;display:flex;gap:20px;">
            <div style="text-align:center;"><div style="color:#8899aa;font-size:9px;">TOTAL STOPS</div><div style="color:#fff;font-size:13px;font-weight:700;">${summary.totalStops}</div></div>
            <div style="text-align:center;"><div style="color:#8899aa;font-size:9px;">ACTUAL MILES</div><div style="color:#fff;font-size:13px;font-weight:700;">${fmt1(summary.totalMilesActual)}</div></div>
            <div style="text-align:center;"><div style="color:#8899aa;font-size:9px;">STOLEN HRS</div><div style="color:#ff4444;font-size:13px;font-weight:700;">${fmt2(summary.totalStolenHrs)}</div></div>
            <div style="text-align:center;"><div style="color:#8899aa;font-size:9px;">EST LOSS</div><div style="color:#ff4444;font-size:13px;font-weight:700;">$${fmt2(summary.totalStolenDollars)}</div></div>
          </div>
        </div>

        <!-- Route accordion list -->
        <div style="border:1px solid #00d4ff33;border-top:none;border-radius:0 0 12px 12px;overflow:hidden;">
          ${auditRecords.map((r, i) => renderRouteRow(r, i)).join('')}
        </div>
      </div>
    `;

    window._nvRecords = auditRecords;
  }

  function renderRouteRow(r, i) {
    const flagBadges = r.flags ? r.flags.slice(0, 4).map(f =>
      `<span style="background:${RC[f.severity] || '#8899aa'}22;border:1px solid ${RC[f.severity] || '#8899aa'}44;border-radius:3px;padding:1px 5px;color:${RC[f.severity] || '#8899aa'};font-size:8px;white-space:nowrap;">${escapeHtml(String(f.type ?? '').replace(/_/g,' '))}</span>`
    ).join('') : '';
    // Over-plan miles color only when plannedMiles is a real finite number —
    // null/undefined * 1.15 === 0, which would paint every route red.
    const overPlan = Number.isFinite(r.plannedMiles) && Number.isFinite(r.miles) && r.miles > r.plannedMiles * 1.15;

    return `
      <div style="border-bottom:1px solid #ffffff0a;">
        <!-- Route header row -->
        <div onclick="window._nvToggle(${i})" style="
          display:grid;grid-template-columns:200px 120px 140px 140px 80px 80px 80px 70px 100px auto;
          gap:0;align-items:center;padding:10px 16px;cursor:pointer;
          background:${i % 2 === 0 ? '#0a1628' : '#080f20'};
          transition:background 0.15s;
        " onmouseover="this.style.background='#0d1f38'" onmouseout="this.style.background='${i % 2 === 0 ? '#0a1628' : '#080f20'}'">
          <div>
            <div style="color:#fff;font-size:11px;font-weight:700;">${escapeHtml(r.driver)}</div>
            <div style="color:#8899aa;font-size:9px;">${escapeHtml(r.truck)} · ${escapeHtml(r.loadNbr)}</div>
          </div>
          <div style="font-size:10px;color:#ccd;">
            <div>${escapeHtml(r.clockIn || '—')} in</div>
            <div>${escapeHtml(r.clockOut || '—')} out</div>
          </div>
          <div style="font-size:10px;">
            <div style="color:#ffcc00;">${escapeHtml(r.firstDeliveryTime || '—')}</div>
            <div style="color:#8899aa;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px;" title="${escapeHtml(r.firstDeliveryBusiness || '')}">${escapeHtml(r.firstDeliveryBusiness || '—')}</div>
            ${r.firstDeliveryMinsAfterStart != null ? `<div style="color:${r.firstDeliveryMinsAfterStart > 90 ? '#ff4444' : '#8899aa'};font-size:8px;">+${r.firstDeliveryMinsAfterStart}min</div>` : ''}
          </div>
          <div style="font-size:10px;">
            <div style="color:#ffcc00;">${escapeHtml(r.lastDeliveryTime || '—')}</div>
            <div style="color:#8899aa;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px;" title="${escapeHtml(r.lastDeliveryBusiness || '')}">${escapeHtml(r.lastDeliveryBusiness || '—')}</div>
          </div>
          <div style="font-size:10px;color:#ccd;text-align:center;">${r.stops ?? '—'}<br><span style="color:#8899aa;font-size:8px;">${r.totalStops ?? '—'} total</span></div>
          <div style="font-size:10px;text-align:center;">
            <div style="color:${overPlan ? '#ff4444' : '#ccd'};">${r.miles ?? '—'}</div>
            <div style="color:#8899aa;font-size:8px;">${r.plannedMiles ?? '—'} plan</div>
          </div>
          <div style="font-size:10px;color:${r.unaccountedMins > 60 ? '#ff8800' : '#8899aa'};text-align:center;">${r.unaccountedMins != null ? r.unaccountedMins + 'min' : '—'}<br><span style="font-size:8px;">unacct</span></div>
          <div style="font-size:10px;font-weight:700;color:${RC[r.risk] || '#8899aa'};text-align:center;">${r.score}<br><span style="font-size:8px;text-transform:uppercase;">${escapeHtml(r.risk)}</span></div>
          <div style="font-size:9px;display:flex;flex-wrap:wrap;gap:3px;">${flagBadges}</div>
          <div style="color:#8899aa;font-size:10px;text-align:right;">▾</div>
        </div>

        <!-- Stop detail (hidden by default) -->
        <div id="nv-detail-${i}" style="display:none;background:#060e1c;padding:0 16px 16px;">
          ${renderStopTable(r, i)}
        </div>
      </div>
    `;
  }

  function renderStopTable(r, i) {
    if (!r.stopDetail || !r.stopDetail.length) {
      return '<div style="color:#8899aa;font-size:10px;padding:12px 0;">No stop detail available.</div>';
    }

    // Flag summary
    const flagHtml = r.flags && r.flags.length ? `
      <div style="padding:10px 0 6px;display:flex;flex-wrap:wrap;gap:6px;">
        ${r.flags.map(f => `
          <div style="background:${RC[f.severity] || '#555'}18;border:1px solid ${RC[f.severity] || '#555'}44;border-radius:4px;padding:4px 8px;max-width:400px;">
            <span style="color:${RC[f.severity] || '#ccd'};font-size:9px;font-weight:700;">${escapeHtml(String(f.type ?? '').replace(/_/g,' '))} — </span>
            <span style="color:#aabbcc;font-size:9px;">${escapeHtml(f.message)}</span>
          </div>
        `).join('')}
      </div>
    ` : '';

    const stopRows = r.stopDetail.map(s => {
      const gapColor = s.interStopGapFlag ? RC.critical : '#8899aa';
      const dwellColor = s.dwellMins > 60 ? RC.critical : s.dwellMins > 35 ? RC.high : s.dwellMins < 3 ? RC.medium : '#8899aa';
      const etaColor = s.earlyLateMinutes > 30 ? RC.high : s.earlyLateMinutes < -10 ? '#00aaff' : '#00ff88';
      const etaStr = s.earlyLateMinutes != null
        ? (s.earlyLateMinutes > 0 ? `+${s.earlyLateMinutes}min late` : `${Math.abs(s.earlyLateMinutes)}min early`)
        : '—';

      return `
        <tr style="border-bottom:1px solid #ffffff08;">
          <td style="padding:6px 8px;color:#556677;font-size:9px;">${s.seq}</td>
          <td style="padding:6px 8px;">
            <div style="color:#fff;font-size:10px;font-weight:600;">${escapeHtml(s.businessName || '—')}</div>
            <div style="color:#8899aa;font-size:9px;">${escapeHtml(s.addr1 || '')} ${escapeHtml(s.city || '')}${s.state ? ', '+escapeHtml(s.state) : ''} ${escapeHtml(s.zip || '')}</div>
            ${s.customerAccount ? `<div style="color:#556677;font-size:8px;">Acct: ${escapeHtml(s.customerAccount)}</div>` : ''}
          </td>
          <td style="padding:6px 8px;font-size:9px;color:#8899aa;">${s.stopType === 'PU' ? '📦 Pickup' : '📍 Delivery'}</td>
          <td style="padding:6px 8px;">
            ${s.interStopGapMins != null ? `
              <div style="color:${gapColor};font-size:10px;font-weight:${s.interStopGapFlag?'700':'400'};">${s.interStopGapMins}min gap</div>
              ${s.prevStopBusiness ? `<div style="color:#556677;font-size:8px;">from ${escapeHtml(s.prevStopBusiness)}</div>` : ''}
              ${s.interStopExcessMins != null && s.interStopGapFlag ? `<div style="color:${RC.high};font-size:8px;">+${s.interStopExcessMins}min over plan</div>` : ''}
            ` : '<span style="color:#556677;font-size:9px;">—</span>'}
          </td>
          <td style="padding:6px 8px;">
            <div style="color:#8899aa;font-size:9px;">${escapeHtml(s.plannedEta || '—')} planned</div>
            <div style="color:#ffcc00;font-size:10px;font-weight:600;">${escapeHtml(s.actualArrival || '—')} arrived</div>
          </td>
          <td style="padding:6px 8px;">
            <div style="color:#00ff88;font-size:10px;font-weight:600;">${escapeHtml(s.completionTime || '—')}</div>
            ${s.arrivalToConfirmMins != null ? `<div style="color:${s.arrivalToConfirmMins > 20 ? RC.high : '#556677'};font-size:8px;">${s.arrivalToConfirmMins}min arr→confirm</div>` : ''}
          </td>
          <td style="padding:6px 8px;">
            <div style="color:${dwellColor};font-size:10px;font-weight:${s.dwellMins > 35 ? '700' : '400'};">${s.dwellMins != null ? s.dwellMins+'min' : '—'}</div>
          </td>
          <td style="padding:6px 8px;">
            <div style="color:${etaColor};font-size:9px;">${etaStr}</div>
          </td>
          <td style="padding:6px 8px;">
            <div style="color:#8899aa;font-size:9px;">${s.pallets != null ? s.pallets+' plt' : ''} ${s.weight != null ? s.weight+'lb' : ''}</div>
            ${s.plannedMilesToNextStop != null ? `<div style="color:#556677;font-size:8px;">${parseFloat(s.plannedMilesToNextStop).toFixed(1)}mi→next</div>` : ''}
          </td>
          <td style="padding:6px 8px;">
            ${s.exceptionPresent ? `<div style="color:${RC.high};font-size:9px;">⚠ ${escapeHtml(s.exceptions?.map(e=>e.desc||e.code).join(', ')||'Exception')}</div>` : ''}
            ${s.proNumber ? `<div style="color:#556677;font-size:8px;">PRO:${escapeHtml(s.proNumber)}</div>` : ''}
          </td>
        </tr>
      `;
    }).join('');

    return `
      ${flagHtml}
      <div style="overflow-x:auto;margin-top:6px;">
        <table style="width:100%;border-collapse:collapse;font-size:10px;">
          <thead>
            <tr style="border-bottom:1px solid #00d4ff22;color:#556677;font-size:9px;text-align:left;">
              <th style="padding:5px 8px;">SEQ</th>
              <th style="padding:5px 8px;">BUSINESS / ADDRESS</th>
              <th style="padding:5px 8px;">TYPE</th>
              <th style="padding:5px 8px;">INTER-STOP GAP</th>
              <th style="padding:5px 8px;">ETA → ARRIVAL</th>
              <th style="padding:5px 8px;">COMPLETION</th>
              <th style="padding:5px 8px;">DWELL</th>
              <th style="padding:5px 8px;">EARLY/LATE</th>
              <th style="padding:5px 8px;">FREIGHT</th>
              <th style="padding:5px 8px;">NOTES</th>
            </tr>
          </thead>
          <tbody>${stopRows}</tbody>
        </table>
      </div>
    `;
  }

  window._nvToggle = (i) => {
    const row = document.getElementById(`nv-detail-${i}`);
    if (!row) return;
    row.style.display = row.style.display === 'none' ? 'block' : 'none';
  };

  waitForApp(() => {
    injectScanBar();
    console.log('[SENTINEL NuVizz v3] Ready — date scan active.');
  });

})();
