'use strict';

// Deliberately decision-only: hardware actions require verified local adapters.
const GRID = Object.freeze({ ON_GRID: 'on-grid', OFF_GRID: 'off-grid', UNKNOWN: 'unknown' });
function decodeGridMode(raw) {
  if (raw === 0) return GRID.ON_GRID;
  if (raw === 1 || raw === 2) return GRID.OFF_GRID;
  return GRID.UNKNOWN;
}
class IslandController {
  constructor({ restoreDelayMs = 300000, now = () => Date.now() } = {}) {
    this.now = now;
    this.restoreDelayMs = restoreDelayMs;
    this.mode = GRID.UNKNOWN;
    this.gridRestoredAt = null;
  }
  update(raw, soc) {
    const observed = decodeGridMode(raw);
    if (observed === GRID.OFF_GRID) {
      this.mode = GRID.OFF_GRID;
      this.gridRestoredAt = null;
    } else if (observed === GRID.UNKNOWN) {
      this.mode = GRID.UNKNOWN;
      this.gridRestoredAt = null;
    } else if (this.mode !== GRID.ON_GRID) {
      if (this.gridRestoredAt === null) this.gridRestoredAt = this.now();
      if (this.now() - this.gridRestoredAt >= this.restoreDelayMs) this.mode = GRID.ON_GRID;
    }
    const validSoc = Number.isFinite(soc) && soc >= 0 && soc <= 100;
    const critical = validSoc && soc < 25;
    const restricted = this.mode !== GRID.ON_GRID;
    return {
      mode: this.mode,
      observed,
      soc: validSoc ? soc : null,
      evStopRequested: restricted,
      nibeModeRequested: restricted ? (critical ? 'critical' : 'economy') : 'normal',
      suspendEconomicOptimization: restricted,
      // No direct EVDC/Nibe commands are sent by this version.
      controlApplied: false,
    };
  }
  communicationLost() { return this.update(null, null); }
}
module.exports = { GRID, decodeGridMode, IslandController };
