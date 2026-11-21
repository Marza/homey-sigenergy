'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { SigenergyReader } = require('../lib/modbus');
const { PROFILE } = require('../lib/energy/meters');
const { HistoryStore } = require('../lib/history');
const { METERS, meterInterval, validFlow } = require('../lib/energy/meter-flow');
const { getEnergyFlow } = require('../lib/energy/dashboard-history');
const base = Object.fromEntries(METERS.map((key) => [key, 100]));
test('read one synchronized V2.9 block, reuse the selected meters, and read household watts', async () => {
  const reader = new SigenergyReader({ host: 'example.invalid' });
  reader.read = async (address, length) => {
    if (address === 30282) {
      assert.equal(length, 2);
      return [0, 2923];
    }
    assert.deepEqual([address, length], [30228, 44]);
    return METERS.flatMap((_, i) => [0, 0, 0, i]);
  };
  const meters = await reader.flowMeterSnapshot();
  assert.equal(meters.dcIn, 6);
  assert.equal(meters.gridOut, 9);
  assert.equal(await reader.householdPower(), 2923);
  const raw = await reader.energyCounters(PROFILE, 'combined', meters);
  assert.deepEqual(raw.values, {
    solar: '5',
    charged: '4',
    discharged: '5',
    imported: '8',
    exported: '9',
  });
  assert.deepEqual(raw.solarComponents, ['2', '3']);
  assert.equal((await reader.energyCounters(PROFILE, 'third-party', meters)).values.solar, '3');
  reader.read = async () => [0xffff, 0xffff];
  assert.equal(await reader.householdPower(), null);
  await assert.rejects(reader.flowMeterSnapshot(), /Incomplete/);
});
test('minute allocation preserves direction, losses and meter granularity', () => {
  const interval = meterInterval(
    base,
    { ...base, thirdPartySolar: 106, gridIn: 104, house: 105, dcIn: 103 },
    60000,
  );
  assert.ok(validFlow(interval));
  assert.deepEqual(interval.input, [60, 0, 0, 40, 0]);
  assert.deepEqual(interval.output, [0, 30, 50, 0, 0]);
  assert.deepEqual(interval.links.slice(0, 5), [0, 18, 30, 0, 0]);
  assert.equal(
    interval.links.reduce((a, b) => a + b),
    80,
  );
  const reverse = meterInterval(base, { ...base, batteryIn: 101, batteryOut: 102 }, 60000);
  assert.ok(reverse.links.every((n) => n === 0));
  for (const changes of [{ gridIn: 99 }, { ac: null }, { dcOut: 10000 }])
    assert.equal(meterInterval(base, { ...base, ...changes }, 60000), null);
  assert.equal(meterInterval(base, base, 900001), null);
});
test('split intervals across midnight, merge once, round trip and never bridge gaps, resets or source changes', () => {
  const midnight = Date.parse('2026-10-01T22:00:00Z');
  const data = new Map();
  const settings = { get: (k) => data.get(k), set: (k, v) => data.set(k, v) };
  const store = new HistoryStore(settings, () => midnight + 600000);
  const read = (time, delta, binding = 'site') =>
    store.observeFlowMeters(
      { ...base, house: 100 + delta, thirdPartySolar: 100 + delta },
      midnight + time,
      binding,
    );
  read(-30000, 0);
  read(30000, 8);
  store.flush();
  read(90000, 14);
  store.flush();
  store.flush();
  read(100000, 1);
  read(110000, 18);
  read(120000, 18, 'other');
  read(260000, 24, 'other');
  store.flush();
  const report = getEnergyFlow(
    { app: { history: store } },
    { date: 'today', period: 'day' },
    midnight + 600000,
  );
  assert.deepEqual(report.meters.links, [{ from: 'solar', to: 'house', kWh: 0.1 }]);
  assert.equal(report.meters.ms, 230000);
  const backup = store.export();
  assert.equal(backup.schema, 16);
  assert.equal(store.previewImport(backup).conflictingSlots, 0);
  assert.throws(() => store.previewImport({ ...backup, schema: 11 }), /version 12/);
  const restarted = new HistoryStore(settings, () => midnight + 600000);
  restarted.import(backup);
  restarted.observeFlowMeters(base, midnight + 620000, 'other');
  restarted.observeFlowMeters(base, midnight + 680000, 'other');
  assert.deepEqual(restarted.export().slots, backup.slots);
  backup.slots[0].meterFlow.links[0] = 1e5;
  assert.throws(() => store.previewImport(backup), /Invalid meter flow/);
});
test('one partial block serves valid meters without a second read; illegal address is remembered per reader', async () => {
  const reader = new SigenergyReader({ host: 'fixture' });
  let calls = 0;
  reader.read = async () => {
    calls++;
    return METERS.flatMap((key) =>
      key === 'thirdPartySolar' ? [65535, 65535, 65535, 65535] : [0, 0, 0, 10],
    );
  };
  const meters = await reader.flowMeterSnapshot();
  assert.equal(meters.thirdPartySolar, null);
  const selected = await reader.energyCounters(PROFILE, 'combined', meters);
  assert.equal(selected.values.imported, '10');
  assert.equal(selected.values.solar, undefined);
  assert.equal(selected.errors.solar, 'unavailable');
  assert.equal(calls, 1);
  reader.read = async () => {
    calls++;
    throw Object.assign(Error('Illegal address'), { modbusCode: 2 });
  };
  await assert.rejects(reader.flowMeterSnapshot(), /Illegal/);
  await assert.rejects(reader.flowMeterSnapshot(), /unsupported/);
  assert.equal(calls, 2);
});
test('one stored house total survives flush, restart, export and individual-register fallback', () => {
  const data = new Map(),
    settings = { get: (k) => data.get(k), set: (k, v) => data.set(k, v) };
  const start = Date.parse('2026-10-01T06:00:00Z');
  const store = new HistoryStore(settings, () => start + 900000);
  function observe(offset, delta, wide = true) {
    const values = { ...base, gridIn: 100 + delta, house: 100 + delta };
    store.observeFlowMeters(wide ? values : undefined, start + offset, 'plant');
    store.observeHouseholdCounter(String(values.house), start + offset);
    store.flush();
  }
  observe(0, 0);
  observe(60000, 6);
  observe(120000, 12);
  const stored = data.get('historyState').slots[0];
  assert.equal(stored.householdWh, undefined);
  assert.equal(stored.householdFromFlow, true);
  const restarted = new HistoryStore(settings, () => start + 900000);
  assert.equal(restarted.getSlots()[0].householdWh, 120);
  assert.equal(restarted.export().slots[0].householdCoverageMs, 120000);
  assert.equal(restarted.previewImport(restarted.export()).conflictingSlots, 0);
  observe(180000, 18, false);
  assert.equal(store.getSlots()[0].householdWh, 180);
  assert.equal(store.getSlots()[0].meterFlow.ms, 120000);
});
test('full meter and raw coverage use the shared net grid and ESS once, partial coverage preserves the sampled basis', () => {
  const { calculationSlot } = require('../lib/history');
  const { meterInterval, addFlow, emptyFlow } = require('../lib/energy/meter-flow');
  const minute = meterInterval(base, { ...base, gridIn: 103, batteryOut: 101, house: 104 }, 60000);
  const row = {
    schema: 2,
    coverageMs: 900000,
    directionalCoverageMs: 900000,
    essCoverageMs: 900000,
    gridWh: 430,
    importWh: 430,
    exportWh: 0,
    essWh: -145,
    meterFlow: addFlow(emptyFlow(), minute, 15),
  };
  const result = calculationSlot(row);
  assert.deepEqual(
    [result.gridWh, result.importWh, result.exportWh, result.essWh],
    [450, 450, 0, -150],
  );
  assert.equal(result.meteredGrid, true);
  assert.equal(row.importWh, 430);
  assert.equal(calculationSlot({ ...row, coverageMs: 0 }).meteredGrid, undefined);
  assert.equal(calculationSlot({ ...row, meterFlow: minute }).gridWh, 430);
});
test('storage pressure can discard diagram links without changing the grid/battery calculation', () => {
  const { bounded, MAX_STATE_BYTES } = require('../lib/history-format');
  const { calculationSlot } = require('../lib/history');
  const { emptyFlow, addFlow } = require('../lib/energy/meter-flow');
  const meterFlow = addFlow(
    emptyFlow(),
    meterInterval(base, { ...base, gridIn: 105, batteryIn: 101, house: 104 }, 60000),
    15,
  );
  const row = {
    schema: 2,
    coverageMs: 900000,
    directionalCoverageMs: 900000,
    essCoverageMs: 900000,
    meterFlow,
  };
  const state = { slots: [row], padding: '' };
  state.padding = 'x'.repeat(MAX_STATE_BYTES - Buffer.byteLength(JSON.stringify(state)) + 10);
  const trimmed = bounded(state).slots[0];
  assert.equal(trimmed.meterFlow.links, null);
  const { exportState, parseExport } = require('../lib/history-format');
  const now = Date.now();
  const slot = {
    ...trimmed,
    t: Math.floor(now / 900000) * 900000,
    n: 0,
    counts: {},
    min: {},
    max: {},
    sum: {},
    gridWh: 0,
    essWh: 0,
    exportWh: 0,
    importWh: 0,
  };
  const backup = exportState({ slots: [slot], daily: [], events: [], legacyDaily: [] }, now);
  assert.equal(backup.schema, 13);
  assert.deepEqual(parseExport(backup, now).slots[0], slot);
  assert.throws(() => parseExport({ ...backup, schema: 12 }, now), /version 13/);
  assert.ok(validFlow(trimmed.meterFlow));
  for (const key of ['importWh', 'exportWh', 'gridWh', 'essWh'])
    assert.equal(calculationSlot(row)[key], calculationSlot(trimmed)[key]);
});
