'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const energy = require('../widgets/energy-flow/api');
const power = require('../widgets/power-history/api');
const { SLOT_MS: Q, dayBounds } = require('../lib/history-format');

function row(t, changes = {}) {
  return {
    t,
    schema: 2,
    coverageMs: Q,
    directionalCoverageMs: Q,
    gridWh: 80,
    importWh: 100,
    exportWh: 20,
    essWh: -25,
    essCoverageMs: Q,
    pvWh: 75,
    evWh: 10,
    evacWh: 0,
    householdWh: 90,
    householdCoverageMs: Q,
    householdEstimatedMs: 0,
    fieldCoverageMs: { pvW: Q, evW: Q, evacW: Q },
    ...changes,
  };
}
const history = (rows) => ({ app: { history: { getEnergySlots: () => rows } } });

test('energy flows retain import and export and distinguish measured zero from missing', () => {
  const { start } = dayBounds('2026-11-20');
  const homey = history([
    row(start),
    row(start + Q, {
      gridWh: -150,
      importWh: 0,
      exportWh: 150,
      essWh: 55,
      evWh: -5,
      householdCoverageMs: Q - 1,
      fieldCoverageMs: { pvW: Q - 1, evW: Q },
      energyFieldCoverageMs: { pvW: Q },
      counterRecoveredChannels: ['solar'],
    }),
    row(start + 4 * Q, { pvWh: 100000 }),
  ]);
  const r = energy.getHistory({ homey, params: { date: 'today', period: 'day' } }, start + 4.5 * Q);
  assert.equal(r.range.expectedQuarters, 4);
  assert.equal(r.estimatedQuarters, 1);
  assert.deepEqual(r.totals.grid, { inKWh: 0.1, outKWh: 0.17, quarters: 2 });
  assert.deepEqual(r.totals.battery, { inKWh: 0.025, outKWh: 0.055, quarters: 2 });
  assert.deepEqual(r.totals.dc, { inKWh: 0.005, outKWh: 0.01, quarters: 2 });
  assert.deepEqual(r.totals.ac, { inKWh: 0, outKWh: 0, quarters: 1 });
  assert.deepEqual(r.totals.house, { inKWh: 0, outKWh: 0.09, quarters: 1 });
  assert.deepEqual(r.totals.solar, { inKWh: 0.15, outKWh: 0, quarters: 2 });
});

test('the chart preserves data gaps and signed quarter averages', () => {
  const { start } = dayBounds('2026-11-20');
  const homey = history([
    row(start),
    row(start + 2 * Q, { householdEstimatedMs: 10000, essCoverageMs: 0, gridWh: 9 }),
  ]);
  const r = power.getHistory({ homey, params: { date: '2026-11-20' } }, start + 3 * Q);
  assert.equal(r.points.length, 3);
  assert.deepEqual(r.points[0].kw, {
    grid: 0.32,
    solar: 0.3,
    battery: 0.1,
    dc: -0.04,
    ac: -0,
    house: -0.36,
  });
  assert.ok(Object.values(r.points[1].kw).every((value) => value === null));
  assert.equal(r.points[2].kw.grid, null);
  assert.equal(r.points[2].kw.battery, null);
  assert.equal(r.points[2].estimated, true);
});

test('dates follow local calendar weeks, months and both Stockholm clock changes', () => {
  for (const [date, quarters] of [
    ['2026-03-29', 92],
    ['2026-10-25', 100],
  ]) {
    const { start, end } = dayBounds(date);
    const result = power.getHistory({ homey: history([row(start)]), params: { date } }, end);
    assert.equal(result.points.length, quarters);
    assert.equal(result.points.at(-1).t + Q, end);
  }
  const now = dayBounds('2026-11-20').start + Q;
  const homey = history([]);
  const period = (date, period) => energy.getHistory({ homey, params: { date, period } }, now);
  assert.equal(period('today', 'week').range.start, dayBounds('2026-11-16').start);
  assert.equal(period('today', 'month').range.start, dayBounds('2026-11-01').start);
  assert.equal(period('2026-10-31', 'month').range.next, '2026-11-01');
  assert.equal(period('2026-10-31', 'month').range.previous, null);
  assert.deepEqual(period('today', 'week').totals.dc, { inKWh: null, outKWh: null, quarters: 0 });
  for (const date of ['2026-09-30', '2026-11-21', '2026-11-99', '2026-11-2', undefined])
    assert.equal(period(date, 'day').status, 'invalid-period');
  assert.equal(period('today', 'year').status, 'invalid-period');
  const bad = power.getHistory({ homey: history(null), params: { date: 'today' } }, now);
  assert.equal(bad.status, 'unavailable');
  assert.equal(bad.range.date, '2026-11-20');
});
