'use strict';
const { SLOT_MS: Q } = require('../history-format');
const { calendar } = require('../pricing/coverage');

function matchesSource(issue, source) {
  return Boolean(
    source?.key && (issue.source === source.key || (!issue.source && source.since <= issue.start)),
  );
}

function solarWh(issue, t) {
  const index = (t - issue.start) / Q;
  let wh = 0;
  for (const roof of issue.roofs) {
    const value = roof.wh[index];
    if (!Number.isFinite(value) || value < 0) return null;
    wh += value;
  }
  return wh;
}

// Run against weather predictions that really existed when the meter interval began.
function adjust(issues, source, now, readSlots) {
  const base = issues.at(-1);
  const end = Math.floor(now / Q) * Q;
  const start = Math.max(base.start, Math.ceil(now / Q) * Q);
  const day = calendar(new Date(now)).today;
  const until = Math.min(day.end, base.start + 96 * Q);
  if (!matchesSource(base, source) || start >= until) return null;
  const remaining = Array.from({ length: (until - start) / Q }, (_, i) =>
    solarWh(base, start + i * Q),
  );
  if (!remaining.some((wh) => wh > 0)) return null;
  const floorWh = base.roofs.reduce((total, roof) => total + roof.kwp, 0) * 250 * 0.02;
  const expected = new Map();
  for (let t = Math.max(end - 4 * Q, day.start, Math.ceil(source.since / Q) * Q); t < end; t += Q) {
    const prior = issues.findLast(
      (i) =>
        i.key === base.key &&
        matchesSource(i, source) &&
        i.at <= t &&
        i.start <= t &&
        t < i.start + 96 * Q,
    );
    const wh = prior && solarWh(prior, t);
    if (wh > 0 && wh >= floorWh) expected.set(t, wh);
  }
  if (expected.size < 3 || !expected.has(end - Q)) return null;
  let measuredWh = 0,
    expectedWh = 0,
    samples = 0,
    latest = false;
  for (const row of readSlots()) {
    if (
      !expected.has(row.t) ||
      row.fieldCoverageMs?.pvW !== Q ||
      !Number.isFinite(row.pvWh) ||
      row.pvWh < 0
    )
      continue;
    samples++;
    measuredWh += row.pvWh;
    expectedWh += expected.get(row.t);
    latest ||= row.t === end - Q;
    expected.delete(row.t);
  }
  if (samples < 3 || !latest) return null;
  const factor = Math.min(1.25, measuredWh / expectedWh);
  return {
    at: now,
    start,
    samples,
    factor,
    wh: remaining.map((wh) => (wh === null ? null : Math.round(wh * factor))),
  };
}
module.exports = { adjust, matchesSource };
