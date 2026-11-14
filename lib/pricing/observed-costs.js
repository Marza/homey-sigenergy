'use strict';
const { createHash } = require('node:crypto');
const { getEnergyHistory } = require('./energy-history');
const HOUR = 3600000,
  QUARTER = 900000;
const { validateCostContract } = require('./cost-model');
function contractHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(validateCostContract(value)))
    .digest('hex');
}
function observedCosts(homey, session, cache, options, now = Date.now()) {
  const energy = getEnergyHistory(homey, now);
  const base = {
    advisoryOnly: true,
    financiallyComparable: false,
    scope: 'indicative-observed-hourly-energy',
    priceResolution: 'HOURLY',
    priceBasis: 'historical-effective-unit-price',
    approximation: 'hourly-effective-price-applied-to-sampled-energy',
    excludes: ['fixed-fees', 'demand-charges', 'battery-wear', 'counterfactual-savings'],
    energyStatus: energy.status,
    eligibleEnergyQuarters: energy.completeQuarters || 0,
  };
  if (energy.status === 'unavailable') return { ...base, status: 'energy-unavailable' };
  if (
    !session?.homeId ||
    !cache ||
    cache.revision !== session.revision ||
    !Number.isFinite(cache.fetchedAt) ||
    cache.fetchedAt > now ||
    !Array.isArray(cache.rows)
  )
    return { ...base, status: 'no-prices' };
  let contract,
    network = false;
  if (options?.includeNetwork) {
    try {
      contract = validateCostContract(homey.settings.get('costContract'));
      network =
        options.revision === session.revision &&
        options.costHash === contractHash(contract) &&
        contract.importPriceBasis === 'spot-ex-vat' &&
        !contract.importIncludesEnergyTax;
    } catch {
      /* No stale or invalid manual assumptions. */
    }
    if (!network) return { ...base, status: 'network-confirmation-required' };
  }
  const prices = new Map(cache.rows.map((r) => [r.t, r]));
  const groups = new Map();
  for (const slot of energy.slots) {
    const t = Math.floor(slot.t / HOUR) * HOUR;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(slot);
  }
  const hours = [...groups.entries()]
    .filter(
      ([t, slots]) =>
        slots.length === 4 && slots.every((s, i) => s.t === t + i * QUARTER) && t + HOUR <= now,
    )
    .map(([t, slots]) => ({
      t,
      importWh: slots.reduce((sum, s) => sum + s.importWh, 0),
      exportWh: slots.reduce((sum, s) => sum + s.exportWh, 0),
    }));
  let importKWh = 0,
    exportKWh = 0,
    importCostSek = 0,
    exportRevenueSek = 0,
    matched = 0,
    missing = 0,
    productionMissing = 0;
  const unusedEnergyQuarters = energy.slots.length - hours.length * 4;
  for (const s of hours) {
    const p = prices.get(s.t);
    if (!p) {
      missing++;
      continue;
    }
    if (!p.production) {
      productionMissing++;
      continue;
    }
    if (!Number.isFinite(p.consumption?.price) || !Number.isFinite(p.production.price)) {
      missing++;
      continue;
    }
    // Effective unit prices are used as returned; no supplier additions or VAT are added again.
    const purchase =
      p.consumption.price +
      (network
        ? (contract.energyTaxExVatSekPerKWh + contract.gridImportExVatSekPerKWh) *
          (1 + contract.vatRate)
        : 0);
    const sale =
      p.production.price +
      (network ? contract.gridExportBenefitSekPerKWh - contract.gridExportFeeSekPerKWh : 0);
    importKWh += s.importWh / 1000;
    exportKWh += s.exportWh / 1000;
    importCostSek += (s.importWh / 1000) * purchase;
    exportRevenueSek += (s.exportWh / 1000) * sale;
    matched++;
  }
  if (![importKWh, exportKWh, importCostSek, exportRevenueSek].every(Number.isFinite))
    return { ...base, status: 'invalid-cost-data' };
  return {
    ...base,
    status: matched ? 'indicative-hourly' : 'no-matched-hours',
    currency: 'SEK',
    priceFetchedAt: cache.fetchedAt,
    componentBasis: network ? 'tibber-plus-confirmed-manual-network' : 'tibber-trade-only',
    matchedHours: matched,
    missingPriceHours: missing,
    missingProductionHours: productionMissing,
    unusedEnergyQuarters,
    eligibleEnergyHours: hours.length,
    excludedEnergyQuarters: energy.excludedQuarters || 0,
    missingEnergyQuarters: energy.missingQuarters || 0,
    windowFrom: energy.windowFrom,
    windowTo: energy.windowTo,
    totals: matched
      ? {
          importKWh,
          exportKWh,
          importCostSek,
          exportRevenueSek,
          netCostSek: importCostSek - exportRevenueSek,
        }
      : null,
  };
}
module.exports = { observedCosts, contractHash };
