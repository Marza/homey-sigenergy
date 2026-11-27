'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { solarAccuracy } = require('../lib/energy/solar-accuracy');
const Q = 900000;
const start = Date.parse('2026-11-27T09:00Z');
const time = (i) => start + i * Q;
const source = { key: 'pv', since: time(-20) };
const issue = (i, wh, adjustments) => ({
  at: time(i) - 60000,
  start: time(i),
  key: 'roof',
  source: 'pv',
  roofs: [{ kwp: 2, wh }],
  adjustments,
});
const revision = (i, wh) => ({ at: time(i) - 1000, start: time(i), wh });
const row = (i, pvWh, ms = Q) => ({ t: time(i), pvWh, fieldCoverageMs: { pvW: ms } });

test('scores each completed daylight quarter once using its active weather issue and revision', () => {
  const first = issue(0, Array(12).fill(200), [
    revision(0, [150, 150, 150, 150, 150, 150]),
    revision(1, [110, 110, 110, 110]),
    revision(2, null),
  ]);
  const next = issue(
    3,
    [50, 50, 50, null, 8, 0, 100, 100, 100, 100],
    [revision(4, [80, 80, 80, 80, 0, 100, 200, 200, 200])],
  );
  const rows = [
    row(0, 100),
    row(1, 110),
    row(2, 10),
    row(3, 0),
    row(4, 0),
    row(5, 100),
    row(6, 0),
    row(7, 0),
    row(8, 0),
    { ...row(9, 20, Q - 1), energyFieldCoverageMs: { pvW: Q } },
    row(11, 0),
  ];
  const result = solarAccuracy([first, next], 'roof', rows, source, time(11) + 1);
  assert.deepEqual(result, {
    daylight: 8,
    adjusted: 6,
    paired: 4,
    original: { maeWh: 72.5, over: 3 },
    corrected: { maeWh: 37.5, over: 2 },
  });
});

test('scores the current source and roof configuration and cannot borrow discontinued corrections', () => {
  const old = issue(0, Array(8).fill(50), [revision(0, Array(8).fill(75))]);
  const legacy = { ...issue(1, [100]), key: 'old roof' };
  const changed = { ...issue(2, [100]), source: 'old meter' };
  const active = issue(3, [10, 20, 20], [revision(3, [20, 20, 20]), revision(5, [30])]);
  const issues = [old, legacy, changed, active];
  const rows = [0, 1, 2, 3, 4, 5].map((i) => row(i, 30));
  const report = (src) => solarAccuracy(issues, 'roof', rows, src, time(6));
  assert.equal(report(source).paired, 4);
  assert.deepEqual(report({ ...source, since: time(3) }), {
    daylight: 3,
    adjusted: 1,
    paired: 1,
    original: { maeWh: 10, over: 0 },
    corrected: { maeWh: 0, over: 0 },
  });
  assert.deepEqual(report(null), {
    daylight: 0,
    adjusted: 0,
    paired: 0,
    original: { maeWh: null, over: 0 },
    corrected: { maeWh: null, over: 0 },
  });
});

test('legacy issues only contribute daylight opportunities and all roofs need weather data', () => {
  const original = issue(0, [0, 4, 7, 25]);
  original.roofs.push({ kwp: 2, wh: [0, 15, 13, null] });
  const report = solarAccuracy([original], 'roof', [], source, time(4));
  assert.equal(report.daylight, 1);
  assert.equal(report.paired, 0);
  assert.equal(report.original.maeWh, null);
});
