'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GridDay } = require('../lib/energy/grid-day');
const { phaseReaders, pollPhaseCurrent } = require('../lib/energy/phase-reader');
const { SigenergyReader } = require('../lib/modbus');
const { getGridDay } = require('../api');
const T = Date.parse('2026-11-21T23:55:00Z'),
  DAY = 86400000;

test('raw ten-second readings survive restart and yield observed extrema and means within 24 hours', async () => {
  const settings = new Map();
  let now = T;
  const read = () => new GridDay(settings, () => now);
  let store = read();
  const add = (offset, amps, frequencyHz = 50) => {
    now = T + offset;
    store.append('site', { amps, frequencyUnit: 1, frequencyHz }, now);
  };
  add(0, [0, 5, 15]);
  add(0, [100, 0, 0]);
  add(10000, [7, null, 0], null);
  add(20000, [2, 10, 5], 50.02);
  add(600000, [1, 11, 8]);
  store.flush();
  store = read();
  assert.deepEqual(store.report('site').bins[0], { t: T, count: 3, min: 0, max: 7, mean: 3 });
  assert.deepEqual(store.report('site', 'amps', 1).bins[0], {
    t: T,
    count: 2,
    min: 5,
    max: 10,
    mean: 7.5,
  });
  assert.deepEqual(store.report('site', 'frequencyHz', 0, 2).bins, []);
  assert.equal(store.report('site', 'frequencyHz', 0, 1).bins[0].count, 2);
  assert.equal(store.report('site').bins.length, 2);
  assert.equal(store.report('other').bins.length, 0);
  assert.throws(() => store.report('site', 'bad'), /mätserie/);
  settings.set('gridPhaseCurrent', { binding: 'site', profile: 'gateway', frequencyUnit: 1 });
  const result = await getGridDay({
    homey: { app: { gridDay: store }, settings },
    body: { metric: 'frequencyHz', phase: 0 },
  });
  assert.equal(result.frequencyUnit, 1);
  assert.equal(result.bins[0].max, 50.02);
  now = T + DAY + 10000;
  assert.equal(store.report('site').bins[0].count, 1);
  add(DAY + 10000, [3, 4, 5]);
  store.flush();
  store = read();
  assert.deepEqual(
    store.report('site').bins.map((b) => b.mean),
    [2, 1, 3],
  );
  now += DAY;
  store.flush();
  assert.ok(
    [...settings.entries()]
      .filter(([k]) => k.startsWith('gridDayHour'))
      .every(([, rows]) => rows.length === 0),
  );
});

test('the Gateway frequency uses only the selected inverter on-grid, and its failure preserves phase data', async () => {
  const config = { host: 'example.invalid', port: 502, evdcEnabled: true, evdcUnitId: 3 };
  const { grid } = phaseReaders(config);
  assert.equal(grid.profile, 'gateway');
  assert.equal(grid.reader.unitId, 247);
  assert.equal(grid.inverterReader.unitId, 3);
  assert.equal(phaseReaders({ ...config, gridFrequencyUnitId: 7 }).grid.inverterReader.unitId, 7);
  assert.equal(phaseReaders({ host: config.host }).grid.inverterReader, null);
  const seen = [],
    currents = [];
  const homey = {
    settings: new Map(),
    app: {
      gridDay: { append: (_binding, data) => seen.push(data) },
      history: { observePhaseCurrent: (_src, _key, a) => currents.push(a) },
    },
  };
  let onGrid = true,
    fail = false,
    count = 0;
  grid.reader.gatewayPhases = async () => ({ onGrid, amps: [0, 2, 3], volts: [230, 231, 232] });
  grid.inverterReader.inverterGridReadings = async () => {
    count++;
    if (fail) throw Error('unavailable');
    return { frequencyHz: 50.02, inverterVolts: [231.62, 231.23, 226.45] };
  };
  await pollPhaseCurrent(homey, 'grid', grid, () => true);
  assert.equal(seen[0].frequencyHz, 50.02);
  assert.deepEqual(seen[0].inverterVolts, [231.62, 231.23, 226.45]);
  assert.deepEqual(seen[0].volts, [230, 231, 232]);
  fail = true;
  await pollPhaseCurrent(homey, 'grid', grid, () => true);
  assert.equal(seen[1].frequencyHz, null);
  assert.deepEqual(currents[1], [0, 2, 3]);
  onGrid = false;
  await pollPhaseCurrent(homey, 'grid', grid, () => true);
  assert.equal(count, 2);
  assert.equal(seen[2].frequencyHz, undefined);
  assert.equal(seen[2].inverterVolts, undefined);
});

test('unsupported voltage or power blocks leave current-only firmware usable', async () => {
  const r = new SigenergyReader({ host: 'example.invalid', unitId: 247 });
  r.read = async (addr) => {
    if (addr === 30004) return [1, 0, 0, 0, 0, 1];
    if (addr === 30292) return [0, 0, 0x7fff, 0xffff, 0, 150];
    throw Error('unsupported');
  };
  const d = await r.gatewayPhases();
  assert.deepEqual(d.amps, [0, null, 1.5]);
  assert.deepEqual(d.volts, [null, null, null]);
  assert.deepEqual(d.activeKW, [null, null, null]);
  assert.equal(d.onGrid, false);
});

test('the V2.9 temperature word and reserved words cannot masquerade as gateway phase voltages', async () => {
  const r = new SigenergyReader({ host: 'example.invalid', unitId: 247 });
  r.read = async (addr) =>
    addr === 30004
      ? [1, 0, 0, 0, 0, 0]
      : addr === 30286
        ? [121, 65535, 65535, 65535, 65535, 65535, 0, 613, 0, 584, 0, 420]
        : Array(12).fill(0);
  const data = await r.gatewayPhases();
  assert.deepEqual(data.volts, [null, null, null]);
  assert.deepEqual(data.amps, [6.13, 5.84, 4.2]);
});

test('inverter phases use their documented words, preserve genuine zero and keep frequency on older firmware', async () => {
  const reader = new SigenergyReader({ host: 'example.invalid', unitId: 1 });
  const words = [5001, 0, 2, 0, 0, 0, 0, 0, 0, 0, 23162, 0, 23123, 0, 22645];
  reader.read = async (...args) => {
    assert.deepEqual(args, [31002, 15, 1000]);
    return words;
  };
  assert.deepEqual(await reader.inverterGridReadings(), {
    frequencyHz: 50.01,
    inverterVolts: [231.62, 231.23, 226.45],
  });
  words[0] = 65535;
  words[9] = 65535;
  words[10] = 65535;
  words[12] = 0;
  assert.deepEqual(await reader.inverterGridReadings(), {
    frequencyHz: null,
    inverterVolts: [null, 0, 226.45],
  });
  words[2] = 0;
  words[9] = 0;
  words[10] = 23000;
  assert.deepEqual((await reader.inverterGridReadings()).inverterVolts, [230, null, null]);
  reader.read = async (_addr, count) => {
    if (count === 15) throw Error('unsupported');
    return [4998];
  };
  assert.deepEqual(await reader.inverterGridReadings(), {
    frequencyHz: 49.98,
    inverterVolts: null,
  });
});

test('24-hour voltage charts use only observed values from the requested phase, source and inverter', () => {
  const settings = new Map(),
    now = T + 86400000;
  let store = new GridDay(settings, () => now);
  for (const [offset, unit, l2] of [
    [0, 1, 280],
    [10000, 1, 220],
    [20000, 1, 230],
    [30000, 1, null],
    [40000, 3, 260],
  ]) {
    store.append(
      'site',
      { volts: [200, 201, 202], inverterVolts: [233, l2, 216], frequencyUnit: unit },
      T + offset,
    );
  }
  store.flush();
  store = new GridDay(settings, () => now);
  assert.deepEqual(store.report('site', 'inverterVolts', 1, 1).bins, [
    { t: T, min: 220, mean: 225, max: 230, count: 2 },
  ]);
  assert.equal(store.report('site', 'inverterVolts', 2, 1).bins[0].mean, 216);
  assert.equal(store.report('site', 'volts', 1).bins[0].mean, 201);
});
