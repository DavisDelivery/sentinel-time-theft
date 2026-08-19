// netlify/functions/_privacy.js
// Off-route location de-identification.
//
// Operator decision (Aug 2026): SENTINEL records *that* a driver went
// off-route, for how long, and how far they drove — never *where*. Knowing a
// driver sat for 50 minutes off-route is what the time-theft case rests on;
// knowing the stop was a clinic, a union hall, or a relative's house is not
// ours to keep, and a stored address turns a payroll tool into a location
// history.
//
// This reverses the destination-recording half of PR #40. Detection is
// unaffected: the ZIP is still used in-flight during a scan (it is how
// classifyDestinations separates a customer stop from an off-route one) and is
// discarded before anything is written.
//
// Two layers:
//   1. Write path (_motive.js, _sentinel-scan.js) no longer captures the
//      fields at all, so new records are clean at rest.
//   2. These helpers scrub records already in Firestore on the way out, so the
//      ~17.7k days scanned before this change stop serving their stored
//      addresses through the API. Existing documents are intentionally left
//      untouched at rest (operator chose "going forward only"), which means
//      this read-side scrub is the only thing standing between historical
//      addresses and an API consumer — do not bypass it.
//
// Customer delivery addresses (firstDeliveryAddr / lastDeliveryAddr) and the
// customer/yard ZIP sets are business records of where the driver was *sent*.
// They are deliberately out of scope here.

// A bare 5-digit ZIP. Guarded on both sides so it cannot bite into a currency
// amount ("$12840.16"), a decimal, or a longer identifier.
const ZIP_RE = /(?<![\w.$])\d{5}(?![\w.])/g;

/**
 * Strip location detail from a stored flag-evidence string, keeping the
 * durations and distances that justify the charge.
 *
 * Handles the two historical formats that embedded ZIPs:
 *   "... Locations: 30366 (14min stop), 30366 (32min stop)."
 *     → "... Stops: 14min, 32min."
 *   "... Motive shows detour to: 30336 (50min stop) via 11mi detour."
 *     → "... Motive shows an off-route detour: 50min stop via 11mi detour."
 *
 * Idempotent: text already in the new format contains neither trigger phrase
 * and passes through untouched.
 */
export function scrubEvidenceText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;

  out = out.replace(/\s*Locations:\s*[^.]*\./g, (clause) => {
    const mins = [...clause.matchAll(/(\d+)\s*min stop/g)].map(m => `${m[1]}min`);
    return mins.length ? ` Stops: ${mins.join(', ')}.` : '';
  });

  out = out.replace(/Motive shows detour to:\s*([^.]*)\./g, (_full, body) => {
    const segs = String(body)
      .split(/,\s*/)
      .map(seg => seg
        .replace(ZIP_RE, '')
        .replace(/\(([^)]*)\)/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim())
      .filter(Boolean);
    return segs.length
      ? `Motive shows an off-route detour: ${segs.join(', ')}.`
      : 'Motive shows an off-route detour.';
  });

  // Defense in depth: any stray ZIP left by an evidence format not listed above.
  out = out.replace(ZIP_RE, '');

  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Remove off-route location fields from one stored day record, in place-safe
 * fashion (returns a shallow-cloned record; nested arrays are rebuilt).
 *
 * Removes: motive.offRouteVisits[].destAddr/destZip,
 *          motive.pauses[].atAddr/atZip,
 *          motive.offRouteZips,
 *          motive.periodsClassified[].origin/dest/destZip,
 * and scrubs flags[].evidence.
 */
export function scrubRecordLocations(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec };

  if (Array.isArray(out.flags)) {
    out.flags = out.flags.map(f => (f && typeof f === 'object' && typeof f.evidence === 'string')
      ? { ...f, evidence: scrubEvidenceText(f.evidence) }
      : f);
  }

  if (out.motive && typeof out.motive === 'object') {
    const m = { ...out.motive };
    if (Array.isArray(m.offRouteVisits)) {
      m.offRouteVisits = m.offRouteVisits.map(({ destAddr, destZip, ...keep }) => keep);
    }
    if (Array.isArray(m.pauses)) {
      m.pauses = m.pauses.map(({ atAddr, atZip, ...keep }) => keep);
    }
    if (Array.isArray(m.periodsClassified)) {
      m.periodsClassified = m.periodsClassified.map(({ origin, dest, destZip, ...keep }) => keep);
    }
    delete m.offRouteZips;
    out.motive = m;
  }

  // Older records nested the Motive payload under debug.motive.
  if (out.debug && typeof out.debug === 'object' && out.debug.motive) {
    const d = { ...out.debug };
    const dm = { ...d.motive };
    if (Array.isArray(dm.periodsClassified)) {
      dm.periodsClassified = dm.periodsClassified.map(({ origin, dest, destZip, ...keep }) => keep);
    }
    delete dm.offRouteZips;
    d.motive = dm;
    out.debug = d;
  }

  return out;
}

/** Convenience for the common "scrub a list of records" case. */
export function scrubRecords(records) {
  return Array.isArray(records) ? records.map(scrubRecordLocations) : records;
}
