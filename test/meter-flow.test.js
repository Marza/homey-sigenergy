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
  assert.equal(meterInterval(base, base, 90001), null);
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
  const report = getEnergyFlow(
    { app: { history: store } },
    { date: 'today', period: 'day' },
    midnight + 600000,
  );
  assert.deepEqual(report.meters.links, [{ from: 'solar', to: 'house', kWh: 0.1 }]);
  assert.equal(report.meters.ms, 90000);
  const backup = store.export();
  assert.equal(backup.schema, 12);
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
