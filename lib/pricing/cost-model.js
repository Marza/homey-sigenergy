'use strict';

// Monetary inputs are SEK/kWh unless explicitly named otherwise. Prices are
// marginal amounts: fixed subscription fees and demand charges are separate.
function finite(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}
function validateCostSettings(settings) {
  if (!settings || typeof settings !== 'object') throw new Error('Cost settings required');
  const s = {
    energyTaxExVatSekPerKWh: finite(settings.energyTaxExVatSekPerKWh, 'energy tax'),
    gridImportExVatSekPerKWh: finite(settings.gridImportExVatSekPerKWh, 'grid import fee'),
    gridExportBenefitSekPerKWh: finite(settings.gridExportBenefitSekPerKWh, 'grid export benefit'),
    gridExportFeeSekPerKWh: finite(settings.gridExportFeeSekPerKWh ?? 0, 'grid export fee'),
    vatRate: finite(settings.vatRate, 'VAT rate'),
    batteryWearSekPerKWh: finite(settings.batteryWearSekPerKWh ?? 0, 'battery wear'),
  };
  if (
    s.vatRate < 0 ||
    s.vatRate > 1 ||
    Object.entries(s).some(([key, value]) => key !== 'gridExportBenefitSekPerKWh' && value < 0)
  ) {
    throw new Error('Invalid cost settings');
  }
  return s;
}
// Tibber consumption total is already VAT-inclusive. Do not add VAT again.
// Production price is an actual signed payout in SEK/kWh, not a purchase price.
function calculateMarginalPrices({
  tibberImportInclVatSekPerKWh,
  tibberExportSekPerKWh,
  settings,
}) {
  const s = validateCostSettings(settings);
  const importPrice = finite(tibberImportInclVatSekPerKWh, 'Tibber import price');
  const exportPrice = finite(tibberExportSekPerKWh, 'Tibber export price');
  return {
    importSekPerKWh:
      importPrice + (s.gridImportExVatSekPerKWh + s.energyTaxExVatSekPerKWh) * (1 + s.vatRate),
    exportSekPerKWh: exportPrice + s.gridExportBenefitSekPerKWh - s.gridExportFeeSekPerKWh,
    components: {
      tibberImportInclVatSekPerKWh: importPrice,
      gridImportInclVatSekPerKWh: s.gridImportExVatSekPerKWh * (1 + s.vatRate),
      energyTaxInclVatSekPerKWh: s.energyTaxExVatSekPerKWh * (1 + s.vatRate),
      tibberExportSekPerKWh: exportPrice,
      gridExportBenefitSekPerKWh: s.gridExportBenefitSekPerKWh,
      gridExportFeeSekPerKWh: s.gridExportFeeSekPerKWh,
    },
    verified: false,
  };
}
function evaluateEnergySlots(slots, priceByTimestamp, settings) {
  validateCostSettings(settings);
  let importKWh = 0,
    exportKWh = 0,
    importCostSek = 0,
    exportRevenueSek = 0;
  for (const slot of slots) {
    if (
      !Number.isFinite(slot?.t) ||
      !Number.isFinite(slot?.gridWh) ||
      slot.coverageMs < 12 * 60 * 1000
    ) {
      return { status: 'insufficient-data', reason: 'Incomplete grid energy interval' };
    }
    const prices = priceByTimestamp?.[slot.t];
    if (
      !prices ||
      !Number.isFinite(prices.importSekPerKWh) ||
      !Number.isFinite(prices.exportSekPerKWh)
    ) {
      return { status: 'insufficient-data', reason: 'Import or export price missing' };
    }
    const kWh = slot.gridWh / 1000;
    if (kWh >= 0) {
      importKWh += kWh;
      importCostSek += kWh * prices.importSekPerKWh;
    } else {
      exportKWh -= kWh;
      exportRevenueSek -= kWh * prices.exportSekPerKWh;
    }
  }
  return {
    status: 'provisional',
    importKWh,
    exportKWh,
    importCostSek,
    exportRevenueSek,
    netEnergySek: importCostSek - exportRevenueSek,
    advisoryOnly: true,
  };
}
function totalScenarioCost({ energy, demandChargeSek, dischargeKWh, settings }) {
  const s = validateCostSettings(settings);
  if (
    energy?.status !== 'provisional' ||
    !Number.isFinite(demandChargeSek) ||
    !Number.isFinite(dischargeKWh) ||
    dischargeKWh < 0
  )
    return null;
  const wearSek = dischargeKWh * s.batteryWearSekPerKWh;
  return {
    energySek: energy.netEnergySek,
    demandChargeSek,
    wearSek,
    totalSek: energy.netEnergySek + demandChargeSek + wearSek,
    advisoryOnly: true,
  };
}
module.exports = {
  validateCostSettings,
  calculateMarginalPrices,
  evaluateEnergySlots,
  totalScenarioCost,
};
