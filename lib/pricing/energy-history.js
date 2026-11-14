'use strict';
const { SLOT_MS, SLOT_RETENTION } = require('../history-format');
function energyHistory(slots, now = Date.now()) {
  const base = {
    advisoryOnly: true,
    financiallyComparable: false,
    basis: 'sampled-power-or-imported-history',
    approximation: 'linear-interpolation-between-samples',
  };
  const unavailable = () => ({ ...base, status: 'unavailable', slots: [] });
  if (!Number.isSafeInteger(now) || !Array.isArray(slots) || slots.length > SLOT_RETENTION)
    return unavailable();
  const end = Math.floor(now / SLOT_MS) * SLOT_MS;
  const seen = new Set();
  for (const row of slots) {
    if (
      !Number.isSafeInteger(row?.t) ||
      row.t < 0 ||
      row.t % SLOT_MS !== 0 ||
      row.t > end ||
      seen.has(row.t)
    )
      return unavailable();
    seen.add(row.t);
  }
  const closed = slots
    .filter((s) => s.t < end && s.t >= end - SLOT_RETENTION * SLOT_MS)
    .sort((a, b) => a.t - b.t);
  const complete = closed.filter(
    (s) =>
      s.schema === 2 &&
      s.coverageMs === SLOT_MS &&
      s.directionalCoverageMs === SLOT_MS &&
      Number.isFinite(s.gridWh) &&
      Number.isFinite(s.importWh) &&
      s.importWh >= 0 &&
      Number.isFinite(s.exportWh) &&
      s.exportWh >= 0 &&
      Math.abs(s.importWh - s.exportWh - s.gridWh) <= 1e-6,
  );
  const expected = closed.length ? (end - closed[0].t) / SLOT_MS : 0;
  const importKWh = complete.reduce((sum, s) => sum + s.importWh / 1000, 0);
  const exportKWh = complete.reduce((sum, s) => sum + s.exportWh / 1000, 0);
  if (!Number.isFinite(importKWh) || !Number.isFinite(exportKWh)) return unavailable();
  return {
    ...base,
    status:
      complete.length && complete.length === expected
        ? 'ready'
        : complete.length
          ? 'partial'
          : 'collecting',
    windowFrom: closed[0]?.t ?? null,
    windowTo: closed.length ? end : null,
    expectedQuarters: expected,
    presentClosedQuarters: closed.length,
    completeQuarters: complete.length,
    excludedQuarters: closed.length - complete.length,
    missingQuarters: expected - closed.length,
    openQuarterPresent: seen.has(end),
    importKWh: complete.length ? importKWh : null,
    exportKWh: complete.length ? exportKWh : null,
    slots: complete.map(({ t, gridWh, importWh, exportWh, coverageMs, directionalCoverageMs }) => ({
      t,
      gridWh,
      importWh,
      exportWh,
      coverageMs,
      directionalCoverageMs,
    })),
  };
}
function getEnergyHistory(homey, now = Date.now()) {
  let slots;
  try {
    slots = homey.app.history.getSlots();
  } catch {
    /* Fail closed on unreadable storage. */
  }
  return energyHistory(slots, now);
}
module.exports = { energyHistory, getEnergyHistory };
