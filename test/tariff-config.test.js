'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../lib/tariff-config');
const { validateTariff, calculateDemandCharge } = require('../lib/demand-tariff');
const { evaluateTariffScenarios } = require('../lib/optimization/tariff-optimizer');
const tariff = () => ({
  start: '07:00',
  end: '20:00',
  weekdays: [1, 2, 3, 4, 5],
  months: [11, 12, 1, 2, 3],
  peakCount: 3,
  rateSekPerKw: 100,
  distinctDays: true,
});
const form = () => ({
  start: '07:00',
  end: '20:00',
  weekdays: '1,2,3,4,5',
  months: [11, 12, 1, 2, 3],
  allYear: false,
  peakCount: '3',
  rateSekPerKw: '100',
  distinctDays: 'true',
});
test('the estimator and browser use the same validation rules', () => {
  assert.equal(validateTariff, T.validateTariff);
  for (const file of [
    'settings/tariff-config.js',
    'widgets/energy-overview/public/tariff-config.js',
  ])
    assert.equal(
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      fs.readFileSync(path.join(__dirname, '../lib/tariff-config.js'), 'utf8'),
    );
  assert.deepEqual(validateTariff(tariff()), { from: 420, to: 1200 });
});
test('season and zero fee are explicit; all-year omits months', () => {
  assert.deepEqual(T.parseTariffForm(form()), tariff());
  const all = T.parseTariffForm({
    ...form(),
    allYear: true,
    rateSekPerKw: '0',
    distinctDays: 'false',
  });
  assert.equal(all.months, undefined);
  assert.equal(all.rateSekPerKw, 0);
  assert.equal(all.distinctDays, false);
});
test('UI and backend reject non-hour boundaries, duplicate/out-of-range selections and invalid numbers', () => {
  for (const patch of [
    { start: '07:30' },
    { end: '19:15' },
    { start: '20:00', end: '07:00' },
    { end: '24:00' },
    { weekdays: [] },
    { weekdays: [1, 1] },
    { weekdays: [7] },
    { weekdays: [1.5] },
    { weekdays: ['1'] },
    { months: [] },
    { months: [1, 1] },
    { months: [0] },
    { months: [13] },
    { months: [1.5] },
    { months: null },
    { peakCount: 0 },
    { peakCount: 32 },
    { peakCount: 1.5 },
    { rateSekPerKw: -1 },
    { rateSekPerKw: NaN },
    { rateSekPerKw: Infinity },
    { rateSekPerKw: '100' },
    { distinctDays: null },
  ])
    assert.throws(() => validateTariff({ ...tariff(), ...patch }));
  for (const patch of [
    { start: '' },
    { end: '19:30' },
    { weekdays: '1,,3' },
    { weekdays: '1,' },
    { weekdays: '' },
    { weekdays: '7' },
    { weekdays: '1,1' },
    { peakCount: '' },
    { peakCount: '2.5' },
    { rateSekPerKw: ' ' },
    { rateSekPerKw: 'NaN' },
    { distinctDays: '' },
    { allYear: undefined },
    { months: [] },
  ])
    assert.throws(() => T.parseTariffForm({ ...form(), ...patch }));
  for (const value of [null, undefined, [], true]) assert.throws(() => validateTariff(value));
});
test('result identity ignores selection order but changes with tariff meaning or month', () => {
  const base = tariff(),
    key = T.tariffKey(base);
  assert.equal(T.tariffKey({ ...base, weekdays: [5, 4, 3, 2, 1], months: [1, 2, 3, 11, 12] }), key);
  for (const patch of [
    { start: '08:00' },
    { end: '19:00' },
    { weekdays: [1] },
    { months: [11] },
    { peakCount: 5 },
    { rateSekPerKw: 101 },
    { distinctDays: false },
  ])
    assert.notEqual(T.tariffKey({ ...base, ...patch }), key);
  assert.equal(
    T.tariffKey({ ...base, months: undefined }),
    T.tariffKey({ ...base, months: Array.from({ length: 12 }, (_, i) => i + 1) }),
  );
  const now = new Date('2026-11-30T23:30:00Z');
  assert.equal(T.currentMonth(now), '2026-12');
  assert.equal(T.matchesResult({ month: '2026-12', tariffKey: key }, base, now), true);
  assert.equal(T.matchesResult({ month: '2026-11', tariffKey: key }, base, now), false);
  assert.equal(
    T.matchesResult({ month: '2026-12', tariffKey: key }, { ...base, peakCount: 5 }, now),
    false,
  );
  assert.equal(T.matchesResult({}, null, now), false);
});
test('labels use configured peak count and never imply a default for invalid data', () => {
  assert.equal(T.peakLabel({ ...tariff(), peakCount: 1 }), 'Medel av 1 timtopp');
  for (const peakCount of [3, 5])
    assert.equal(T.peakLabel({ ...tariff(), peakCount }), `Medel av ${peakCount} timtoppar`);
  assert.equal(T.peakLabel(null), 'Medel av timtoppar');
  assert.equal(T.peakLabel({ ...tariff(), peakCount: 0 }), 'Medel av timtoppar');
});
test('three- and five-peak estimates carry the exact configuration key', () => {
  const slots = [12, 13, 14, 15, 16].flatMap((day, i) =>
    Array.from({ length: 4 }, (_, q) => ({
      t: Date.parse(`2026-01-${day}T09:00:00Z`) + q * 900000,
      gridWh: (i + 1) * 250,
      coverageMs: 900000,
    })),
  );
  for (const count of [3, 5]) {
    const config = { ...tariff(), peakCount: count };
    const result = calculateDemandCharge(slots, config, '2026-01');
    assert.equal(result.status, 'provisional');
    assert.equal(result.peakCount, count);
    assert.equal(result.selectedPeaks.length, count);
    assert.equal(result.tariffKey, T.tariffKey(config));
    const insufficient = evaluateTariffScenarios([], {}, config, '2026-01');
    assert.match(insufficient.reason, new RegExp(`krav: ${count}`));
  }
});
