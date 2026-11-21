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
