'use strict';
const {
  validateCostContract,
  calculateMarginalPrices,
  evaluateEnergySlots,
  totalScenarioCost,
} = require('./cost-model');
const QUARTER = 900000;
const unavailable = (reason) => ({
  status: 'unavailable',
  reason,
  advisoryOnly: true,
  financiallyComparable: false,
});
// Explicit, user-supplied inputs are not independently verified contract evidence.
function compareEconomicScenarios(input, contract) {
  let settings;
  try {
    settings = validateCostContract(contract);
  } catch {
    return unavailable('cost-settings-missing-or-invalid');
  }
  if (
    !input ||
    ![1, 2].includes(input.schema) ||
    input.currency !== 'SEK' ||
    !['importSource', 'exportSource'].every(
      (k) => typeof input[k] === 'string' && input[k].trim() && input[k].length <= 300,
    ) ||
    input.importIncludesEnergyTax !== settings.importIncludesEnergyTax
  )
    return unavailable('price-provenance-missing-or-incompatible');
  const basis = settings.importPriceBasis || 'total-incl-vat';
  if (
    (input.schema === 1 && basis !== 'total-incl-vat') ||
    (input.schema === 2 && input.importPriceBasis !== basis)
  )
    return unavailable('price-basis-missing-or-incompatible');
  const { baseline, scenario, prices } = input;
  if (
    !Array.isArray(prices) ||
    !prices.length ||
    prices.length > 3072 ||
    ![baseline, scenario].every((s) => Array.isArray(s?.slots) && s.slots.length === prices.length)
  )
    return unavailable('intervals-missing-or-mismatched');
  // A cheaper scenario cannot be funded by depleting more stored battery energy.
  for (const key of ['initialStoredKWh', 'finalStoredKWh']) {
    if (
      ![baseline, scenario].every((s) => Number.isFinite(s[key]) && s[key] >= 0) ||
      Math.abs(baseline[key] - scenario[key]) > 1e-6
    )
      return unavailable('battery-boundaries-missing-or-mismatched');
  }
  const sorted = prices.slice().sort((a, b) => a?.t - b?.t),
    byTime = {};
  try {
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      if (
        !Number.isSafeInteger(p?.t) ||
        p.t < 0 ||
        p.t % QUARTER !== 0 ||
        p.end !== p.t + QUARTER ||
        (i && p.t !== sorted[i - 1].end)
      )
        return unavailable('price-intervals-invalid-or-gapped');
      byTime[p.t] = calculateMarginalPrices({
        tibberImportInclVatSekPerKWh:
          input.schema === 1
            ? p.importInclVatSekPerKWh
            : basis === 'total-incl-vat'
              ? p.importPriceSekPerKWh
              : undefined,
        spotImportExVatSekPerKWh:
          input.schema === 2 && basis === 'spot-ex-vat' ? p.importPriceSekPerKWh : undefined,
        tibberExportSekPerKWh: p.exportSekPerKWh,
        settings,
      });
    }
  } catch {
    return unavailable('import-or-export-price-missing');
  }
  const costs = [];
  for (const s of [baseline, scenario]) {
    if (!s.slots.every((slot) => Object.hasOwn(byTime, slot?.t)))
      return unavailable('energy-price-intervals-mismatched');
    const energy = evaluateEnergySlots(s.slots, byTime, settings);
    const cost = totalScenarioCost({
      energy,
      demandChargeSek: s.demandChargeSek,
      dischargeKWh: s.dischargeKWh,
      settings,
    });
    if (!cost || s.demandChargeSek < 0) return unavailable('energy-or-cost-components-incomplete');
    costs.push({
      ...cost,
      importKWh: energy.importKWh,
      exportKWh: energy.exportKWh,
      importCostSek: energy.importCostSek,
      exportRevenueSek: energy.exportRevenueSek,
    });
  }
  if (
    costs.some((cost) =>
      Object.values(cost).some((v) => typeof v === 'number' && !Number.isFinite(v)),
    )
  )
    return unavailable('cost-overflow');
  const netSavingSek = costs[0].totalSek - costs[1].totalSek;
  if (!Number.isFinite(netSavingSek)) return unavailable('cost-overflow');
  return {
    status: 'provisional',
    advisoryOnly: true,
    financiallyComparable: true,
    inputVerification: 'user-supplied',
    scope: 'supplied-intervals',
    from: sorted[0].t,
    to: sorted.at(-1).end,
    intervals: sorted.length,
    provenance: {
      contractSource: settings.source,
      checkedOn: settings.checkedOn,
      importSource: input.importSource.trim(),
      exportSource: input.exportSource.trim(),
      importPriceBasis: basis,
      exportVatApplication: 'as-supplied-no-added-vat',
    },
    baseline: costs[0],
    scenario: costs[1],
    netSavingSek,
    fixedChargesIncluded: false,
  };
}
module.exports = { compareEconomicScenarios };
