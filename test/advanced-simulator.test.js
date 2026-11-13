'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replayWithRecharge, compareScenarios } = require('../lib/optimization/advanced-simulator');
const { DEFAULT_OPTIMIZER } = require('../lib/optimization/simulator');
const base = {
  ...DEFAULT_OPTIMIZER,
  batteryCapacityKWh: 10,
  initialSocPercent: 60,
  backupReservePercent: 20,
  maxChargeKW: 4,
  maxDischargeKW: 5,
  minCoverageFraction: 0.8,
};
const row = (t, gridWh = 1000, essWh = 0) => ({ t, gridWh, essWh, coverageMs: 850000 });
test('no recharge inferred from PV or grid energy', () => {
  const result = replayWithRecharge([row(0), row(900000)], base, { capKW: 2, reservePercent: 20 });
  assert.equal(result.rechargeKWh, 0);
  assert.ok(result.remainingSocPercent < 60);
});
test('explicit surplus is bounded by charging power and capacity', () => {
  const result = replayWithRecharge([row(0, 0)], base, {
    capKW: 4,
    reservePercent: 20,
    surplusKWh: { 0: 5 },
  });
  assert.equal(result.rechargeKWh, 1);
  assert.ok(result.remainingSocPercent > 60);
});
test('cold-limited max discharge prevents reaching cap', () => {
  const result = replayWithRecharge(
    [row(0, 2500)],
    { ...base, maxDischargeKW: 2 },
    { capKW: 4, reservePercent: 20 },
  );
  assert.equal(result.peakKW, 8);
});
test('missing prices are not treated as zero cost', () => {
  const result = replayWithRecharge([row(0)], base, { capKW: 3, reservePercent: 20 });
  assert.equal(result.pricedImportSek, null);
});
test('full price coverage calculates energy cost', () => {
  const result = replayWithRecharge([row(0, 500)], base, {
    capKW: 3,
    reservePercent: 20,
    pricesSekPerKWh: { 0: 2 },
  });
  assert.equal(result.pricedImportSek, 1);
});
test('invalid intervals are excluded', () => {
  const result = replayWithRecharge([row(0), { ...row(900000), coverageMs: 1000 }], base, {
    capKW: 3,
    reservePercent: 20,
  });
  assert.equal(result.status, 'insufficient-data');
  assert.equal(result.excludedSlots, 1);
});
test('comparison returns read-only candidates', () => {
  const result = compareScenarios([row(0)], {
    ...base,
    minCapKW: 3,
    maxCapKW: 3.1,
    capStepKW: 0.1,
    reserveMinPercent: 20,
    reserveMaxPercent: 20,
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.advisoryOnly, true);
});
