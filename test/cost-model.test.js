'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateMarginalPrices,
  evaluateEnergySlots,
  totalScenarioCost,
} = require('../lib/pricing/cost-model');
const settings = {
  energyTaxExVatSekPerKWh: 0.36,
  gridImportExVatSekPerKWh: 0.2,
  gridExportBenefitSekPerKWh: 0.04,
  vatRate: 0.25,
  batteryWearSekPerKWh: 0.12,
};
test('Tibber import includes VAT and network/tax VAT applied once', () => {
  const p = calculateMarginalPrices({
    tibberImportInclVatSekPerKWh: 0.8,
    tibberExportSekPerKWh: 0.3,
    settings,
  });
  assert.equal(p.importSekPerKWh, 1.5);
  assert.equal(p.exportSekPerKWh, 0.33999999999999997);
});
test('negative Tibber export prices are preserved', () => {
  const p = calculateMarginalPrices({
    tibberImportInclVatSekPerKWh: -0.1,
    tibberExportSekPerKWh: -0.2,
    settings,
  });
  assert.ok(p.exportSekPerKWh < 0);
});
test('net energy cost subtracts export revenue', () => {
  const p = {
    1: { importSekPerKWh: 1.5, exportSekPerKWh: 0.4 },
    2: { importSekPerKWh: 1.5, exportSekPerKWh: 0.4 },
  };
  const energy = evaluateEnergySlots(
    [
      { t: 1, gridWh: 1000, coverageMs: 900000 },
      { t: 2, gridWh: -500, coverageMs: 900000 },
    ],
    p,
    settings,
  );
  assert.equal(energy.netEnergySek, 1.3);
  assert.ok(
    Math.abs(
      totalScenarioCost({ energy, demandChargeSek: 10, dischargeKWh: 2, settings }).totalSek -
        11.54,
    ) < 1e-9,
  );
});
test('missing export price fails closed', () => {
  assert.equal(
    evaluateEnergySlots(
      [{ t: 1, gridWh: 1000, coverageMs: 900000 }],
      { 1: { importSekPerKWh: 1 } },
      settings,
    ).status,
    'insufficient-data',
  );
});
test('invalid settings rejected', () => {
  assert.throws(() =>
    calculateMarginalPrices({
      tibberImportInclVatSekPerKWh: 1,
      tibberExportSekPerKWh: 1,
      settings: { ...settings, vatRate: -1 },
    }),
  );
});
