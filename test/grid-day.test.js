'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GridDay } = require('../lib/energy/grid-day');
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
  assert.throws(() => store.report('site', 'frequencyHz'), /mätserie/); // Older inverter samples never become gateway Hz.
  assert.equal(store.report('site').bins.length, 2);
  assert.equal(store.report('other').bins.length, 0);
  assert.throws(() => store.report('site', 'bad'), /mätserie/);
  settings.set('gridPhaseCurrent', { binding: 'site', profile: 'gateway', frequencyUnit: 1 });
  const result = await getGridDay({
    homey: { app: { gridDay: store }, settings },
    body: { metric: 'amps', phase: 0 },
  });
  assert.equal(result.profile, 'gateway');
  assert.equal(result.bins[0].max, 7);
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

test('grid mode and sampled grid alarms follow the source, actual timestamps and gaps', () => {
  const store = new GridDay(new Map(), () => T + 90000);
  const add = (s, gridMode, gridAlarms) =>
    store.append('site', { gridMode, gridAlarms }, T + s * 1000);
  add(0, 0, 0);
  add(10, 0, 0);
  add(20, 0, 16);
  add(30, 1, 16);
  add(40, 1, null);
  add(70, 2, 0);
  store.append('other', { gridMode: 0, gridAlarms: 32 }, T + 80000);
  const { events, bins } = store.report('site');
  assert.deepEqual(bins, []);
  assert.deepEqual(
    events.map((e) => [(e.at - T) / 1000, e.mode, e.alarms, e.resumed]),
    [
      [0, 0, 0, true],
      [20, 0, 16, false],
      [30, 1, 16, false],
      [40, 1, null, false],
      [70, 2, 0, true],
    ],
  );
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
  assert.equal(d.gridMode, 1);
  assert.equal(d.gridAlarms, null);
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
