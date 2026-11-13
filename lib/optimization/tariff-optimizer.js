'use strict';
const { validateOptimizer } = require('./simulator');
const { calculateDemandCharge, validateTariff, localParts } = require('../demand-tariff');
const { replayWithRecharge } = require('./advanced-simulator');

// Counterfactual estimates are never invoices. All hours must use identical inputs.
function evaluateTariffScenarios(slots, config, tariff, month, options = {}) {
  validateTariff(tariff);
  const c = validateOptimizer(config);
  const calculationTime = { nowMs: options.nowMs ?? Date.now() };
  const baseline = calculateDemandCharge(slots, tariff, month, calculationTime);
  if (baseline.status !== 'provisional')
    return {
      status: 'insufficient-data',
      advisoryOnly: true,
      scope: 'observed-hours',
      coverage: baseline.coverage,
      reason: `Otillräckligt med kompletta timtoppar (krav: ${tariff.peakCount}).`,
      baseline,
    };
  const monthSlots = (slots || []).filter(
    (s) => Number.isFinite(s?.t) && localParts(s.t).month === month,
  );
  const results = [];
  for (let cap = c.minCapKW; cap <= c.maxCapKW + 1e-8; cap += c.capStepKW) {
    for (
      let reserve = c.reserveMinPercent;
      reserve <= c.reserveMaxPercent + 1e-8;
      reserve += c.reserveStepPercent
    ) {
      const capKW = Math.round(cap * 1000) / 1000;
      const replay = replayWithRecharge(monthSlots, c, {
        ...options,
        capKW,
        reservePercent: reserve,
      });
      if (replay.status !== 'illustrative' || replay.validSlots !== monthSlots.length) continue;
      // Replay has to return every simulated quarter, not only the maximum.
      const simulated = calculateDemandCharge(
        replay.simulatedSlots,
        tariff,
        month,
        calculationTime,
      );
      if (simulated.status !== 'provisional' || simulated.eligibleHours !== baseline.eligibleHours)
        continue;
      const demandSavingSek = baseline.estimatedSek - simulated.estimatedSek;
      const energyDeltaSek =
        replay.pricedImportSek === null || !Number.isFinite(options.baselineEnergySek)
          ? null
          : options.baselineEnergySek - replay.pricedImportSek;
      const netSavingSek =
        energyDeltaSek === null ? null : demandSavingSek + energyDeltaSek - replay.wearCostSek;
      results.push({
        capKW,
        reservePercent: reserve,
        simulatedAverageKw: simulated.averageKw,
        simulatedDemandSek: simulated.estimatedSek,
        demandSavingSek,
        energyDeltaSek,
        wearCostSek: replay.wearCostSek,
        netSavingSek,
        uncoveredKWh: replay.uncoveredKWh,
        dischargeKWh: replay.dischargeKWh,
        eligibleHours: simulated.eligibleHours,
      });
    }
  }
  // Financial ranking is permitted only with matching complete price inputs.
  const financiallyComparable = results.length > 0 && results.every((r) => r.netSavingSek !== null);
  const eligible = results.filter((r) => r.uncoveredKWh <= 0.001);
  eligible.sort((a, b) =>
    financiallyComparable
      ? b.netSavingSek - a.netSavingSek || a.wearCostSek - b.wearCostSek
      : b.demandSavingSek - a.demandSavingSek || a.wearCostSek - b.wearCostSek,
  );
  return {
    status: eligible.length ? 'provisional' : 'insufficient-data',
    advisoryOnly: true,
    tariffVerified: false,
    month,
    scope: 'observed-hours',
    coverage: baseline.coverage,
    baseline,
    candidates: results,
    best: eligible[0] || null,
    financiallyComparable,
    note: 'Historisk kontrafaktisk simulering, inte framtida besparing eller verifierad faktura. Tariffvillkor och historiktäckning måste verifieras.',
  };
}
module.exports = { evaluateTariffScenarios };
