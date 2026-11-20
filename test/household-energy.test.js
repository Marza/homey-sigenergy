'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SigenergyReader } = require('../lib/modbus');
const { HistoryStore, SLOT_MS } = require('../lib/history');
const { DataDiagnostics } = require('../lib/data-diagnostics');

const T = 1800000000000;
const end = T + 3600000;
function setup(now = end) {
  const state = new Map();
  const settings = {
    get: (key) => state.get(key),
    set: (key, value) => state.set(key, structuredClone(value)),
  };
  const diagnostics = new DataDiagnostics(settings, () => now);
  const history = new HistoryStore(settings, () => now, diagnostics);
  const observe = (raw, seconds, reason) =>
    history.observeHouseholdCounter(raw, T + seconds * 1000, reason);
  const report = () => diagnostics.report({ settings, app: { history } }, { hours: 1 });
  return { history, observe, report };
}

test('read register 30228 once at plant ID 247 as an unsigned four-word centi-kWh counter', async () => {
  const reader = new SigenergyReader({ unitId: 247 });
  reader.read = async (...args) => {
    assert.deepEqual(args, [30228, 4, 1000]);
    return [0, 1, 0, 5];
  };
  assert.equal(await reader.householdEnergyCounter(), '4294967301');
  reader.unitId = 1;
  await assert.rejects(reader.householdEnergyCounter(), /plant unit 247/);
});

test('a counter reset leaves a labelled gap and resumes without adding a reset or rebound jump', () => {
  const { history, observe, report } = setup();
  assert.equal(observe('10000', 0), null);
  assert.equal(observe('10010', 60), 6);
  assert.equal(observe('100', 120), null);
  assert.equal(observe('102', 180), null);
  assert.equal(observe('105', 240), 1.8);
  assert.equal(observe('1', 300), null);
  assert.equal(observe('106', 360), null);
  assert.equal(observe('107', 420), 0.6);
  history.flush();
  const row = history.getSlots()[0];
  assert.equal(row.householdWh, 140);
  assert.equal(row.householdCoverageMs, 180000);
  assert.equal(row.householdEstimatedMs, 0);
  const diagnostic = report();
  assert.deepEqual(diagnostic.quality.channels.household, {
    available: true,
    energyWh: 140,
    observedMs: 180000,
    counterEstimatedMs: 0,
    unknownMs: 3420000,
  });
  assert.ok(diagnostic.gaps.household.ranges[0].reasons.includes('counter-reset'));
});

test('failed, late and restarted reads leave unknown time while a measured zero counts as coverage', () => {
  const { history, observe, report } = setup();
  observe('200', 0);
  assert.equal(observe('200', 60), 0);
  observe(null, 90, 'modbus-timeout');
  assert.equal(observe('280', 120), null);
  assert.equal(observe('282', 180), 1.2);
  assert.equal(observe('382', 300), null);
  assert.equal(observe('385', 360), 1.8);
  history.append({}, T + 400000, 'connection-changed');
  assert.equal(observe('390', 420), null);
  history.flush();
  const [row] = history.getSlots();
  assert.equal(row.householdWh, 50);
  assert.equal(row.householdCoverageMs, 180000);
  const diagnostic = report();
  assert.equal(diagnostic.quality.channels.household.unknownMs, 3420000);
  assert.ok(diagnostic.gaps.household.ranges[0].reasons.includes('modbus-timeout'));
  assert.ok(diagnostic.gaps.household.ranges[0].reasons.includes('sample-delay'));

  const empty = setup();
  assert.equal(empty.report().quality.channels.household.energyWh, null);
  empty.observe('53', 10);
  empty.observe('53', 70);
  empty.history.flush();
  assert.equal(empty.report().quality.channels.household.energyWh, 0);
});

test('energy across a quarter boundary is preserved and its allocation is marked estimated in backups', () => {
  const { history, observe, report } = setup();
  observe('200', 870);
  assert.equal(observe('212', 930), 7.2);
  const file = history.export();
  assert.equal(file.schema, 14);
  assert.deepEqual(
    file.slots.map((s) => [s.t, s.householdWh, s.householdCoverageMs, s.householdEstimatedMs]),
    [
      [T, 60, 30000, 30000],
      [T + SLOT_MS, 60, 30000, 30000],
    ],
  );
  assert.equal(report().quality.channels.household.counterEstimatedMs, 60000);
  const restored = setup().history;
  assert.throws(() => restored.import({ ...file, schema: 9 }), /version 10/);
  const bad = structuredClone(file);
  bad.slots[0].householdEstimatedMs += 1;
  assert.throws(() => restored.import(bad), /household coverage/i);
  restored.import(file);
  assert.deepEqual(restored.getSlots(), file.slots);
});

test('resuming after restoring an open quarter cannot add overlapping household coverage', () => {
  const old = setup();
  for (let seconds = 0; seconds <= 900; seconds += 60)
    old.observe(String(100 + seconds / 60), seconds);
  const backup = old.history.export();
  const restored = setup(T + 300000);
  restored.history.import(backup);
  restored.observe('105', 300);
  restored.observe('106', 360);
  const [quarter] = restored.history.export().slots;
  assert.equal(quarter.householdWh, 150);
  assert.equal(quarter.householdCoverageMs, SLOT_MS);
});
