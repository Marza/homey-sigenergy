'use strict';
const { effectiveSlot } = require('./energy/gap-recovery');
const { SLOT_MS: Q, SLOT_RETENTION } = require('./history-format');
const H = 3600000;
const duration = (n) => Number.isSafeInteger(n) && n >= 0 && n <= Q;
// Reject ambiguous snapshots instead of letting Map silently select a duplicate row.
function validSnapshot(slots, now) {
  if (!Array.isArray(slots) || slots.length > SLOT_RETENTION) return false;
  const seen = new Set();
  for (const row of slots) {
    if (
      !Number.isSafeInteger(row?.t) ||
      row.t < 0 ||
      row.t % Q !== 0 ||
      row.t > Math.floor(now / Q) * Q ||
      seen.has(row.t)
    )
      return false;
    seen.add(row.t);
  }
  return true;
}
function coverage(row, channel, projected = false) {
  if (row?.schema !== 2) return null;
  if (channel === 'grid') {
    // A fresh anchor-only row has no integrated energy yet; this establishes
    // zero observed duration, never positive coverage inferred from samples.
    const n =
      row.directionalCoverageMs ??
      (row.coverageMs === 0 && row.importWh === undefined && row.exportWh === undefined
        ? 0
        : undefined);
    if (!duration(n) || !duration(row.coverageMs) || n > row.coverageMs) return null;
    if (n === 0) return 0;
    if (
      !Number.isFinite(row.gridWh) ||
      !Number.isFinite(row.importWh) ||
      row.importWh < 0 ||
      !Number.isFinite(row.exportWh) ||
      row.exportWh < 0 ||
      (n === row.coverageMs && Math.abs(row.importWh - row.exportWh - row.gridWh) > 1e-6)
    )
      return null;
    return n;
  }
  const n =
      channel === 'battery'
        ? (row.essCoverageMs ?? (row.essWh === undefined ? 0 : undefined))
        : ((projected ? row.energyFieldCoverageMs : row.fieldCoverageMs)?.pvW ??
          (row.pvWh === undefined ? 0 : undefined)),
    wh = channel === 'battery' ? row.essWh : row.pvWh;
  if (!duration(n) || (n > 0 && (!Number.isFinite(wh) || (channel === 'solar' && wh < 0))))
    return null;
  return n;
}
function hourlySources(hourly, from, to, readable) {
  const available = readable && hourly?.status !== 'unavailable' && Array.isArray(hourly?.hours);
  const counts = { sampledHours: 0, withCounterEstimateHours: 0, tibberHours: 0 };
  if (available) {
    const map = new Map();
    for (const row of hourly.hours) {
      if (!Number.isSafeInteger(row?.t) || row.t % H || row.t < from || row.t >= to) continue;
      // Duplicate hours are ambiguous, including a valid row followed by an invalid row.
      map.set(row.t, map.has(row.t) ? null : row);
    }
    const keys = {
      'sigenergy-sampled': 'sampledHours',
      'sigenergy-counter-gap-estimate': 'withCounterEstimateHours',
      'tibber-meter-hourly': 'tibberHours',
    };
    for (const row of map.values()) {
      if (
        row &&
        Object.hasOwn(keys, row.source) &&
        Number.isFinite(row.importWh) &&
        row.importWh >= 0 &&
        Number.isFinite(row.exportWh) &&
        row.exportWh >= 0
      )
        counts[keys[row.source]]++;
    }
  }
  return {
    available,
    from,
    to,
    totalHours: (to - from) / H,
    ...Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, available ? n : null])),
    unknownHours: available
      ? (to - from) / H - Object.values(counts).reduce((a, b) => a + b, 0)
      : null,
  };
}
// Durations describe valid energy integration, not sample counts or instant power readings.
// Hourly meter fallback is deliberately a separate denominator, never invented quarters.
function qualityReport(slots, from, to, hourly) {
  const available = validSnapshot(slots, to),
    totalMs = to - from,
    channels = {};
  for (const channel of ['grid', 'battery', 'solar']) {
    let observedMs = 0,
      counterEstimatedMs = 0;
    if (available) {
      for (const row of slots) {
        if (row.t < from || row.t >= to) continue;
        const raw = coverage(row, channel),
          effective = effectiveSlot(row),
          projected = coverage(effective, channel, true);
        observedMs += raw ?? 0;
        if (
          raw !== null &&
          effective !== row &&
          effective.counterRecoveredChannels.includes(channel) &&
          projected !== null &&
          projected >= raw
        )
          counterEstimatedMs += projected - raw;
      }
    }
    channels[channel] = {
      available,
      observedMs: available ? observedMs : null,
      counterEstimatedMs: available ? counterEstimatedMs : null,
      unknownMs: available ? totalMs - observedMs - counterEstimatedMs : null,
    };
  }
  return {
    schema: 1,
    from,
    to,
    totalMs,
    channels,
    hourlyGrid: hourlySources(hourly, Math.floor(from / H) * H, Math.floor(to / H) * H, available),
  };
}
module.exports = { qualityReport, validSnapshot };
