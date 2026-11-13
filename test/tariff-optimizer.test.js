'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTariffScenarios } = require('../lib/optimization/tariff-optimizer');
const tariff = {
  start: '07:00',
  end: '20:00',
  weekdays: [1, 2, 3, 4, 5],
  months: [1],
  rateSekPerKw: 100,
  peakCount: 5,
  distinctDays: true,
};
const config = {
  minCapKW: 3,
  maxCapKW: 4,
  capStepKW: 0.1,
  reserveMinPercent: 20,
  reserveMaxPercent: 20,
  initialSocPercent: 90,
  batteryCapacityKWh: 42,
};
function hour(day, kw) {
  const t = Date.parse(`2026-01-${day}T09:00:00Z`);
  return Array.from({ length: 4 }, (_, i) => ({
    t: t + i * 900000,
    gridWh: kw * 250,
    essWh: 0,
    coverageMs: 900000,
  }));
}
const slots = [12, 13, 14, 15, 16].flatMap((day, i) => hour(day, 6 + i));
test('same five-hour model is used for baseline and counterfactual', () => {
  const r = evaluateTariffScenarios(slots, config, tariff, '2026-01');
  assert.equal(r.status, 'provisional');
  assert.equal(r.baseline.averageKw, 8);
  assert.equal(r.best.simulatedAverageKw, 3);
  assert.equal(r.best.demandSavingSek, 500);
  assert.equal(r.financiallyComparable, false);
  assert.equal(r.best.netSavingSek, null);
  assert.equal(r.best.capKW, 3);
});
test('not enough complete hourly peaks gives no savings', () => {
  const r = evaluateTariffScenarios(slots.slice(0, 12), config, tariff, '2026-01');
  assert.equal(r.status, 'insufficient-data');
});
test('incomplete replay does not invent a counterfactual peak', () => {
  const rows = slots.map((s, i) => (i === 1 ? { ...s, coverageMs: 1000 } : s));
  const r = evaluateTariffScenarios(rows, config, tariff, '2026-01');
  assert.equal(r.status, 'insufficient-data');
});
