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
  assert.equal(grid.frequencyReader.unitId, 3);
  assert.equal(phaseReaders({ ...config, gridFrequencyUnitId: 7 }).grid.frequencyReader.unitId, 7);
  assert.equal(phaseReaders({ host: config.host }).grid.frequencyReader, null);
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
  grid.frequencyReader.gridFrequency = async () => {
    count++;
    if (fail) throw Error('unavailable');
    return 50.02;
  };
  await pollPhaseCurrent(homey, 'grid', grid, () => true);
  assert.equal(seen[0].frequencyHz, 50.02);
  fail = true;
  await pollPhaseCurrent(homey, 'grid', grid, () => true);
  assert.equal(seen[1].frequencyHz, null);
  assert.deepEqual(currents[1], [0, 2, 3]);
  onGrid = false;
  await pollPhaseCurrent(homey, 'grid', grid, () => true);
  assert.equal(count, 2);
  assert.equal(seen[2].frequencyHz, undefined);
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
