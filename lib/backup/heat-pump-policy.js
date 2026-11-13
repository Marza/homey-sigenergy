'use strict';
// Nibe's existing tariff schedule remains authoritative. Advisory only.
function heatPumpPolicy({ gridMode, batterySoc, tariffActive = false, gridPowerLimit = false }) {
  const reasons = [];
  if (tariffActive) reasons.push('DEMAND_TARIFF');
  if (gridPowerLimit) reasons.push('GRID_POWER_LIMIT');
  if (gridMode !== 'on-grid') reasons.push('ISLAND_OR_UNKNOWN');
  const critical =
    gridMode !== 'on-grid' && Number.isFinite(batterySoc) && batterySoc >= 0 && batterySoc < 25;
  return {
    auxiliaryHeatBlockRequested: reasons.length > 0,
    reasons,
    modeRequested: gridMode === 'on-grid' ? 'normal' : critical ? 'critical' : 'economy',
    controlApplied: false,
    note: 'Advisory only. Existing Nibe tariff schedule is not modified; safety and frost protection remain under Nibe control.',
  };
}
module.exports = { heatPumpPolicy };
