'use strict';
const { SLOT_MS: Q } = require('../history-format');
const {
  matchesSource,
  solarWh,
  observedSolarWh,
  daylightThresholdWh,
} = require('./solar-adjustment');

// Each archived issue owns the quarters from its start up to the next issue's start.
// Within that range only the last decision available at the quarter boundary counts.
function solarAccuracy(issues, key, rows, source, now) {
  const actual = new Map();
  const firstQuarter = Math.max(issues[0]?.start ?? Infinity, source?.since ?? Infinity);
  const closedThrough = Math.floor(now / Q) * Q;
  for (const row of rows) {
    if (row.t >= firstQuarter && row.t < closedThrough) actual.set(row.t, row);
  }
  let daylight = 0,
    adjusted = 0,
    paired = 0;
  const original = { absoluteErrorWh: 0, over: 0 };
  const corrected = { absoluteErrorWh: 0, over: 0 };
  for (const [i, issue] of issues.entries()) {
    if (issue.key !== key || !matchesSource(issue, source)) continue;
    const end = Math.min(closedThrough, issue.start + 96 * Q, issues[i + 1]?.start ?? Infinity);
    const threshold = daylightThresholdWh(issue);
    const revisions = issue.adjustments ?? [];
    let next = 0;
    for (let t = issue.start; t < end; t += Q) {
      if (t < source.since || t < issue.at) continue;
      while (next < revisions.length && revisions[next].at <= t) next++;
      const forecast = solarWh(issue, t);
      if (forecast === null || forecast < threshold) continue;
      daylight++;
      const revision = revisions[next - 1];
      if (!revision?.wh || revision.at < source.since) continue;
      const prediction = revision.wh[(t - revision.start) / Q];
      if (!Number.isFinite(prediction)) continue;
      adjusted++;
      const wh = observedSolarWh(actual.get(t));
      if (wh === null) continue;
      paired++;
      original.absoluteErrorWh += Math.abs(forecast - wh);
      original.over += Number(forecast > wh);
      corrected.absoluteErrorWh += Math.abs(prediction - wh);
      corrected.over += Number(prediction > wh);
    }
  }
  function metrics(totals) {
    return { maeWh: paired ? totals.absoluteErrorWh / paired : null, over: totals.over };
  }
  return { daylight, adjusted, paired, original: metrics(original), corrected: metrics(corrected) };
}
module.exports = { solarAccuracy };
