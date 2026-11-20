'use strict';
const { calculationSlots } = require('../history');
const Q = 900000;
function energyValid(s) {
  return (
    s?.schema === 2 &&
    s.coverageMs === Q &&
    s.directionalCoverageMs === Q &&
    Number.isFinite(s.gridWh) &&
    Number.isFinite(s.importWh) &&
    s.importWh >= 0 &&
    Number.isFinite(s.exportWh) &&
    s.exportWh >= 0 &&
    Math.abs(s.importWh - s.exportWh - s.gridWh) <= 1e-6
  );
}
function batteryValid(s) {
  return s?.essCoverageMs === Q && Number.isFinite(s?.essWh);
}
function evEnergyValid(s) {
  return s?.schema === 2 && s.fieldCoverageMs?.evW === Q && Number.isFinite(s.evWh);
}
function evacEnergyValid(s) {
  return (
    s?.schema === 2 && s.fieldCoverageMs?.evacW === Q && Number.isFinite(s.evacWh) && s.evacWh >= 0
  );
}
function readComparableSlots(homey, { raw = false } = {}) {
  try {
    const history = homey.app.history;
    const rows = raw && history.getSlots ? history.getSlots() : calculationSlots(history);
    const seen = new Set();
    if (!Array.isArray(rows) || rows.length > 3072) return null;
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.t) || row.t < 0 || row.t % Q || seen.has(row.t)) return null;
      seen.add(row.t);
    }
    return rows;
  } catch {
    return null;
  }
}
// One local snapshot and one set of eligibility predicates for both inspection and replay.
// The API report deliberately excludes all raw readings, prices, terms, IDs and fingerprints.
module.exports = { energyValid, batteryValid, evEnergyValid, evacEnergyValid, readComparableSlots };
