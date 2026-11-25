'use strict';

// Deliberately decision-only: hardware actions require verified local adapters.
const GRID = Object.freeze({ ON_GRID: 'on-grid', OFF_GRID: 'off-grid', UNKNOWN: 'unknown' });
function decodeGridMode(raw) {
  if (raw === 0) return GRID.ON_GRID;
  if (raw === 1 || raw === 2) return GRID.OFF_GRID;
  return GRID.UNKNOWN;
}
class IslandController {
  constructor({ restoreDelayMs = 300000, maxGapMs = Infinity, now = () => Date.now() } = {}) {
    this.now = now;
    this.maxGapMs = maxGapMs;
    this.lastObservedAt = null;
    this.islandSince = null;
    this.restoreDelayMs = restoreDelayMs;
    this.mode = GRID.UNKNOWN;
    this.gridRestoredAt = null;
  }
  update(raw, soc) {
    const time = this.now();
    if (
      this.lastObservedAt !== null &&
      (time < this.lastObservedAt || time - this.lastObservedAt > this.maxGapMs)
    ) {
      this.mode = GRID.UNKNOWN;
      this.islandSince = null;
      this.gridRestoredAt = null;
    }
    this.lastObservedAt = time;
    const observed = decodeGridMode(raw);
    if (observed !== GRID.OFF_GRID) this.islandSince = null;
    if (observed === GRID.OFF_GRID) {
      this.islandSince ??= time;
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
      islandSince: this.islandSince,
      islandDurationMs: this.islandSince === null ? 0 : time - this.islandSince,
      soc: validSoc ? soc : null,
      evStopRequested: restricted,
      nibeModeRequested: restricted ? (critical ? 'critical' : 'economy') : 'normal',
      suspendEconomicOptimization: restricted,
      // Advisory only. The optional Nibe interlock reports its own acknowledgement.
      controlApplied: false,
    };
  }
  communicationLost() {
    return this.update(null, null);
  }
}
module.exports = { GRID, decodeGridMode, IslandController };
