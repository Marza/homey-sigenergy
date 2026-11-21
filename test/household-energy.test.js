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

test('a bound household counter repairs a timeout within one quarter and qualifies for the forecast', () => {
  const { history, observe, report } = setup();
  history.setHouseholdSource('plant:epoch-1');
  observe('1000', 0);
  observe(null, 60, 'modbus-timeout');
  observe(null, 120, 'modbus-timeout');
  observe('1000', 180); // A valid zero covers the entire outage.
  observe('1072', 900);
  history.flush();
  const row = history.getSlots()[0];
  assert.equal(row.householdWh, 720);
  assert.equal(row.householdCoverageMs, SLOT_MS);
  assert.equal(row.householdRecoveredMs, SLOT_MS);
  assert.equal(row.householdEstimatedMs, 0);
  const d = report();
  assert.equal(d.quality.channels.household.recoveredMs, SLOT_MS);
  assert.equal(d.quality.channels.household.observedMs, SLOT_MS);
  assert.ok(d.events.some((e) => e.reason === 'counter-gap-recovered' && e.source === 'household'));
  const { HouseholdForecast } = require('../lib/energy/household-forecast');
  const model = new HouseholdForecast(history.settings, history);
  assert.equal(model.report(T + 86400000 - SLOT_MS).forecastKW[0], 2.88);
});

test('restart recovers a boundary delta once, with independent quarter and five-minute provenance', () => {
  const { history, observe } = setup();
  history.setHouseholdSource('meter:0');
  observe('100', 600);
  history.flush();
  const restarted = new HistoryStore(history.settings, () => end);
  restarted.append({}, T + 850000, 'reader-started');
  restarted.setHouseholdSource('meter:0');
  restarted.observeHouseholdCounter('160', T + 1200000);
  restarted.flush();
  restarted.observeHouseholdCounter('160', T + 1200000);
  restarted.flush();
  const file = restarted.export();
  assert.equal(file.schema, 15);
  assert.equal(JSON.stringify(file).includes('meter:0'), false);
  assert.equal(file.householdCheckpoint, undefined);
  const { point } = require('../lib/energy/five-minute');
  for (const [i, row] of file.slots.entries()) {
    assert.equal(row.householdWh, 300);
    assert.equal(row.householdRecoveredMs, 300000);
    assert.equal(row.householdEstimatedMs, 300000);
    const p = point(row, i === 0 ? 2 : 0);
    assert.equal(p.kw.house, -3.6);
    assert.equal(p.estimated, true);
  }
  const restored = setup().history;
  restored.import(file);
  assert.deepEqual(restored.getSlots(), file.slots);
  assert.throws(() => restored.import({ ...file, schema: 14 }), /version 15/);
  const bad = structuredClone(file);
  bad.slots[0].householdRecoveredMs++;
  assert.throws(() => restored.import(bad), /recovery duration/);
});

test('atomic checkpoint survives a failed flush, an abrupt restart, and a later retry without double counting', () => {
  const { history, observe } = setup();
  history.setHouseholdSource('meter');
  observe('1000', 0);
  observe('1005', 60);
  history.flush();
  const settings = history.settings;
  const write = settings.set;
  observe('1010', 120);
  settings.set = () => {
    throw Error('storage unavailable');
  };
  assert.throws(() => history.flush(), /unavailable/);
  assert.equal(settings.get('historyState').householdCheckpoint.value, 1005);
  settings.set = write;
  const restarted = new HistoryStore(settings, () => end);
  restarted.setHouseholdSource('meter');
  restarted.observeHouseholdCounter('1015', T + 180000);
  settings.set = () => {
    throw Error('retry');
  };
  assert.throws(() => restarted.flush(), /retry/);
  settings.set = write;
  restarted.flush();
  restarted.flush();
  const [r] = restarted.getSlots();
  assert.equal(r.householdWh, 150);
  assert.equal(r.householdCoverageMs, 180000);
  assert.equal(r.householdRecoveredMs, 120000);
  assert.equal(settings.get('historyState').householdCheckpoint.value, 1015);
});

test('changed source, reset, invalid counter, time reversal and long outages cannot bridge energy', () => {
  const { history, observe } = setup();
  history.setHouseholdSource('meter:1');
  observe('10000', 0);
  observe(null, 60, 'modbus-timeout');
  assert.equal(observe('10020', 59), null);
  assert.equal(observe('5', 120), null);
  assert.equal(observe('10020', 180), null);
  history.setHouseholdSource('meter:2');
  assert.equal(observe('10030', 240), null);
  assert.equal(observe('10040', 1141), null); // More than 15 minutes.
  assert.equal(observe('broken', 1200), null);
  assert.equal(observe('10041', 1260), null);
  assert.equal(observe('10042', 1320), 0.6);
  history.setHouseholdSource(null);
  const restarted = new HistoryStore(history.settings, () => end);
  restarted.setHouseholdSource('meter:2');
  assert.equal(restarted.observeHouseholdCounter('10043', T + 1380000), null);
  const row = restarted.export().slots[0];
  assert.equal(row.householdWh, 10);
  assert.equal(row.householdRecoveredMs, undefined);
});
