'use strict';
const { sourceStatus, batteryValues, MAX_AGE_MS } = require('../source-status');
// Counterfactual replay using estimated unshaved load = grid import - ESS discharge.
// SigEnergy sign convention: positive ESS power is charging.
const DEFAULT_OPTIMIZER = Object.freeze({
  enabled: true,
  minCapKW: 3,
  maxCapKW: 6,
  capStepKW: 0.1,
  reserveMinPercent: 15,
  reserveMaxPercent: 40,
  reserveStepPercent: 5,
  backupReservePercent: 15,
  batteryCapacityKWh: 42,
  initialSocPercent: 65,
  maxDischargeKW: 10,
  maxChargeKW: 10,
  roundTripEfficiency: 0.9,
  batteryWearSekPerKWh: 0.15,
  minCoverageFraction: 0.8,
});
function validateOptimizer(input) {
  const c = { ...DEFAULT_OPTIMIZER, ...input };
  for (const key of [
    'minCapKW',
    'maxCapKW',
    'capStepKW',
    'reserveMinPercent',
    'reserveMaxPercent',
    'reserveStepPercent',
    'backupReservePercent',
    'batteryCapacityKWh',
    'initialSocPercent',
    'maxDischargeKW',
    'maxChargeKW',
    'roundTripEfficiency',
    'batteryWearSekPerKWh',
    'minCoverageFraction',
  ]) {
    if (!Number.isFinite(c[key])) throw new Error(`Invalid ${key}`);
  }
  if (
    c.minCapKW < 0.5 ||
    c.maxCapKW > 20 ||
    c.minCapKW > c.maxCapKW ||
    c.capStepKW <= 0 ||
    c.reserveMinPercent < 0 ||
    c.reserveMaxPercent > 100 ||
    c.reserveMinPercent > c.reserveMaxPercent ||
    c.reserveStepPercent <= 0 ||
    c.backupReservePercent < 0 ||
    c.backupReservePercent > 100 ||
    c.initialSocPercent < 0 ||
    c.initialSocPercent > 100 ||
    c.batteryCapacityKWh <= 0 ||
    c.maxDischargeKW <= 0 ||
    c.maxChargeKW <= 0 ||
    c.roundTripEfficiency <= 0 ||
    c.roundTripEfficiency > 1 ||
    c.batteryWearSekPerKWh < 0 ||
    c.minCoverageFraction <= 0 ||
    c.minCoverageFraction > 1
  )
    throw new Error('Optimizer parameters out of range');
  return c;
}
function* range(min, max, step) {
  for (let i = 0; i < 200 && min + i * step <= max + 1e-8; i++)
    yield Math.round((min + i * step) * 1000) / 1000;
}
function effectiveBatteryConfig(input, telemetry, options = {}) {
  const base = validateOptimizer(input);
  if (!options.autoBatteryValues || !telemetry) return base;
  const status =
    options.status ||
    sourceStatus({
      readAt: telemetry.readAt,
      errors: telemetry.errors,
      availableFields: Object.keys(telemetry.values || {}).filter(
        (k) => !['soc', 'capacityKWh'].includes(k) && !telemetry.errors?.[k],
      ).length,
      now: options.now ?? Date.now(),
      maxAgeMs: MAX_AGE_MS.battery,
    });
  const v = batteryValues(telemetry, status);
  const c = { ...base };
  if (Number.isFinite(v.capacityKWh) && v.capacityKWh > 0) c.batteryCapacityKWh = v.capacityKWh;
  if (Number.isFinite(v.soc) && v.soc >= 0 && v.soc <= 100) c.initialSocPercent = v.soc;
  if (Number.isFinite(v.dischargePowerLimitKW) && v.dischargePowerLimitKW > 0) {
    c.maxDischargeKW = Math.min(c.maxDischargeKW, v.dischargePowerLimitKW);
  }
  if (Number.isFinite(v.chargePowerLimitKW) && v.chargePowerLimitKW > 0) {
    c.maxChargeKW = Math.min(c.maxChargeKW, v.chargePowerLimitKW);
  }
  if (Number.isFinite(v.dischargeCutoffSoc))
    c.backupReservePercent = Math.max(c.backupReservePercent, v.dischargeCutoffSoc);
  return validateOptimizer(c);
}
function replay(slots, input, capKW, reservePercent) {
  const c = validateOptimizer(input);
  let soc = c.initialSocPercent;
  let missingKWh = 0,
    dischargeKWh = 0,
    peakKW = 0,
    valid = 0,
    missing = 0;
  const eta = Math.sqrt(c.roundTripEfficiency);
  const floor = Math.max(c.backupReservePercent, reservePercent);
  const sorted = [...slots].sort((a, b) => a.t - b.t);
  for (const row of sorted) {
    if (
      !Number.isFinite(row.t) ||
      !Number.isFinite(row.gridWh) ||
      !Number.isFinite(row.essWh) ||
      !Number.isFinite(row.coverageMs) ||
      row.coverageMs < 12 * 60 * 1000
    ) {
      missing++;
      continue;
    }
    valid++;
    // Estimate demand without historical ESS dispatch. Export is clamped to zero.
    const loadKW = Math.max(0, (row.gridWh + row.essWh) / 250);
    const neededKW = Math.max(0, loadKW - capKW);
    const energyAvailableKWh = Math.max(0, ((soc - floor) / 100) * c.batteryCapacityKWh) * eta;
    const suppliedKWh = Math.min(neededKW * 0.25, c.maxDischargeKW * 0.25, energyAvailableKWh);
    soc = Math.max(floor, soc - (suppliedKWh / eta / c.batteryCapacityKWh) * 100);
    dischargeKWh += suppliedKWh;
    missingKWh += Math.max(0, neededKW * 0.25 - suppliedKWh);
    peakKW = Math.max(peakKW, loadKW - suppliedKWh / 0.25);
    // No assumed recharge: conservative. Future versions model prices/PV and battery schedule.
  }
  return {
    capKW,
    reservePercent,
    validSlots: valid,
    excludedSlots: missing,
    coverageFraction: valid / (valid + missing || 1),
    remainingSocPercent: soc,
    peakKW,
    unshavedKWh: missingKWh,
    dischargedKWh: dischargeKWh,
    wearCostSek: dischargeKWh * c.batteryWearSekPerKWh,
    status:
      valid && valid / (valid + missing) >= c.minCoverageFraction
        ? 'illustrative'
        : 'insufficient-data',
  };
}
function simulate(slots, input) {
  const c = validateOptimizer(input),
    candidates = [];
  for (const cap of range(c.minCapKW, c.maxCapKW, c.capStepKW)) {
    for (const reserve of range(c.reserveMinPercent, c.reserveMaxPercent, c.reserveStepPercent)) {
      candidates.push(replay(slots, c, cap, reserve));
    }
  }
  // No invented financial optimum: peak approximation is not the verified tariff formula.
  candidates.sort((a, b) => a.peakKW - b.peakKW || a.wearCostSek - b.wearCostSek);
  return {
    status: candidates[0]?.status || 'insufficient-data',
    model: 'conservative-no-recharge',
    advisoryOnly: true,
    note: 'Not a tariff or savings forecast; historical ESS dispatch, missing intervals, temperatures and PV schedules limit accuracy.',
    candidates,
    bestIllustrative: candidates[0] || null,
  };
}
module.exports = { DEFAULT_OPTIMIZER, validateOptimizer, replay, simulate, effectiveBatteryConfig };
