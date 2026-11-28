'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { historySettings, pack, unpack } = require('../lib/packed-history');
const { GridDay } = require('../lib/energy/grid-day');
const { HistoryStore } = require('../lib/history');
const { getHistoryOverview } = require('../api');

test('first commit packs a legacy snapshot atomically and keeps all committed quarters across restart', () => {
  const raw = new Map();
  const now = Date.now();
  const legacy = new HistoryStore(raw, () => now);
  legacy.append({ gridW: 200 }, now);
  legacy.flush();
  const before = legacy.export();
  const settings = historySettings(raw);
  const migrated = new HistoryStore(settings, () => now);
  migrated.event('test');
  const stored = raw.get('historyState');
  assert.equal(stored.encoding, 'gzip-json-v1');
  assert.equal(stored.slots, undefined);
  assert.equal(stored.bytes, Buffer.byteLength(JSON.stringify(settings.get('historyState'))));
  const restart = new HistoryStore(settings, () => now);
  assert.deepEqual(restart.export().slots, before.slots);
  assert.equal(
    getHistoryOverview({ homey: { app: { history: restart } } }).slotCount,
    before.slots.length,
  );
  raw.set('historyState', { ...stored, data: 'broken' });
  assert.throws(() => new HistoryStore(settings));
  assert.equal(raw.get('historyState').data, 'broken');
});
test('old grid hours are packed on checkpoint, including inactive hours, and a failed write retries', () => {
  const now = Date.UTC(2026, 10, 21, 12);
  const at = now - 3600000;
  const raw = new Map([['gridDayHour11', [{ at, binding: 'site', data: { amps: [2, 3, 4] } }]]]);
  let fail = true;
  const store = new GridDay(
    {
      get: (k) => raw.get(k),
      set(k, v) {
        if (fail) throw Error('write');
        raw.set(k, v);
      },
    },
    () => now,
  );
  assert.throws(() => store.flush(), /write/);
  assert.ok(Array.isArray(raw.get('gridDayHour11')));
  fail = false;
  store.flush();
  assert.equal(raw.get('gridDayHour11').encoding, 'gzip-json-v1');
  assert.deepEqual(new GridDay(raw, () => now).report('site'), store.report('site'));
});
test('invalid encoding and oversized decoded lengths are rejected before use', () => {
  const value = pack({ n: 1 });
  assert.deepEqual(unpack(value), { n: 1 });
  for (const changes of [
    { encoding: 'unknown' },
    { bytes: 9e9 },
    { bytes: 1 },
    { bytes: value.bytes + 1 },
  ])
    assert.throws(() => unpack({ ...value, ...changes }));
});

test('a committed snapshot is detached and a later settings replacement remains visible', () => {
  const now = Date.now();
  const raw = new Map();
  const store = new HistoryStore(historySettings(raw), () => now);
  store.append({ gridW: 111 }, now);
  const next = store.flush();
  const saved = raw.get('historyState');
  const expected = next.slots[0].sum.gridW;
  next.slots[0].sum.gridW = -1;
  assert.equal(store.getSlots()[0].sum.gridW, expected);
  const legacy = unpack(saved);
  legacy.slots[0].sum.gridW = 456;
  raw.set('historyState', legacy);
  const slots = store.getSlots();
  assert.equal(slots[0].sum.gridW, 456);
  slots[0].sum.gridW = 0;
  assert.equal(raw.get('historyState').slots[0].sum.gridW, 456);
});

test('grid event order and extrema survive a wrapped hour and repeated reports', () => {
  const hour = 3600000;
  const end = Date.UTC(2026, 10, 28, 12, 20);
  const times = [end - 24 * hour + 10000, end - 3600000, end - 10000, end];
  const raw = new Map();
  let now = times[0];
  const store = new GridDay(raw, () => now);
  for (const [i, at] of times.entries()) {
    now = at;
    store.append('site', { amps: [i, 0, 0], gridMode: i % 2 }, at);
    store.flush();
  }
  for (const grid of [store, new GridDay(raw, () => now)]) {
    const first = grid.report('site');
    assert.deepEqual(
      first.events.map((e) => e.at),
      times,
    );
    assert.equal(first.phaseCurrentSamples, 4);
    assert.equal(Math.max(...first.bins.map((b) => b.max)), 3);
    assert.deepEqual(grid.report('site'), first);
    assert.ok(grid.hours.filter((h) => h.rows?.length).length <= 1);
  }
});
