'use strict';
const { validateOptimizer } = require('./simulator');
const SLOT_HOURS = 0.25;
/**
 * Replay only explicit counterfactual inputs. Historical grid + ESS is not enough to
 * infer spare solar production, so recharge requires a separately supplied surplusKWh.
 * Prices must be timestamp-matched and are optional. No billing claims are made.
 */
function replayWithRecharge(slots, config, options = {}) {
  const c = validateOptimizer(config);
  const capKW = options.capKW;
  const reservePercent = options.reservePercent;
  if (!Number.isFinite(capKW) || !Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 100) {
    throw new Error('Invalid scenario');
  }
  const eta = Math.sqrt(c.roundTripEfficiency);
  const floor = Math.max(reservePercent, c.backupReservePercent);
  let soc = Math.max(floor, c.initialSocPercent);
  let peakKW = 0, dischargeKWh = 0, rechargeKWh = 0, uncoveredKWh = 0;
  const simulatedSlots = [];
  let importKWh = 0, pricedImportSek = 0, pricedSlots = 0, validSlots = 0, excludedSlots = 0;
  for (const slot of [...slots].sort((a, b) => a.t - b.t)) {
    if (!Number.isFinite(slot.t) || !Number.isFinite(slot.gridWh) || !Number.isFinite(slot.essWh) ||
        !Number.isFinite(slot.coverageMs) || slot.coverageMs < 12 * 60 * 1000) {
      excludedSlots++;
      continue;
    }
    validSlots++;
    const demandKW = Math.max(0, (slot.gridWh + slot.essWh) / 250);
    const requiredKWh = Math.max(0, demandKW - capKW) * SLOT_HOURS;
    const availableKWh = Math.max(0, (soc - floor) / 100 * c.batteryCapacityKWh) * eta;
    const delivered = Math.min(requiredKWh, c.maxDischargeKW * SLOT_HOURS, availableKWh);
    soc -= delivered / eta / c.batteryCapacityKWh * 100;
    dischargeKWh += delivered;
    uncoveredKWh += requiredKWh - delivered;
    const gridKW = Math.max(0, demandKW - delivered / SLOT_HOURS);
    peakKW = Math.max(peakKW, gridKW);
    importKWh += gridKW * SLOT_HOURS;
    simulatedSlots.push({ t: slot.t, gridWh: gridKW * 250, coverageMs: slot.coverageMs });
    const price = options.pricesSekPerKWh?.[slot.t];
    if (Number.isFinite(price)) { pricedImportSek += gridKW * SLOT_HOURS * price; pricedSlots++; }
    // Only externally established unused PV may recharge; do not reuse pvWh blindly.
    const surplus = options.surplusKWh?.[slot.t];
    if (Number.isFinite(surplus) && surplus > 0) {
      const roomKWh = Math.max(0, (100 - soc) / 100 * c.batteryCapacityKWh);
      const charged = Math.min(surplus, c.maxChargeKW * SLOT_HOURS, roomKWh / eta);
      soc += charged * eta / c.batteryCapacityKWh * 100;
      rechargeKWh += charged;
    }
    soc = Math.min(100, Math.max(floor, soc));
  }
  const coverage = validSlots / (validSlots + excludedSlots || 1);
  return {
    capKW, reservePercent, status: validSlots && coverage >= c.minCoverageFraction ? 'illustrative' : 'insufficient-data',
    validSlots, excludedSlots, coverageFraction: coverage, peakKW, uncoveredKWh,
    dischargeKWh, rechargeKWh, remainingSocPercent: soc, importKWh, simulatedSlots,
    wearCostSek: dischargeKWh * c.batteryWearSekPerKWh,
    pricedImportSek: pricedSlots === validSlots ? pricedImportSek : null,
    pricedSlots, advisoryOnly: true,
  };
}
function compareScenarios(slots, config, options = {}) {
  const c = validateOptimizer(config);
  const results = [];
  for (let cap = c.minCapKW; cap <= c.maxCapKW + 1e-8; cap += c.capStepKW) {
    for (let reserve = c.reserveMinPercent; reserve <= c.reserveMaxPercent + 1e-8; reserve += c.reserveStepPercent) {
      results.push(replayWithRecharge(slots, c, { ...options, capKW: Math.round(cap * 1000) / 1000, reservePercent: reserve }));
    }
  }
  results.sort((a, b) => a.peakKW - b.peakKW || a.uncoveredKWh - b.uncoveredKWh || a.wearCostSek - b.wearCostSek);
  return { model: 'explicit-surplus-recharge', advisoryOnly: true,
    note: 'Illustrative only: no validated network tariff, no inferred PV surplus, and no guaranteed future battery limits.',
    candidates: results, bestIllustrative: results[0] || null };
}
module.exports = { replayWithRecharge, compareScenarios };
