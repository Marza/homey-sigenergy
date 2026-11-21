'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryStore } = require('../lib/history');
const { parseExport } = require('../lib/history-format');
const { validMinuteMeans } = require('../lib/energy/minute-means');

const start = Date.parse('2026-11-21T08:00:00Z');
const minute = 60000;

test('minute observations retain aligned arithmetic means and counts across flush, restart and restore', () => {
  let at = start,
    fail = false;
  const settings = new Map();
  const create = () =>
    new HistoryStore(
      {
        get: (key) => settings.get(key),
        set: (key, value) => {
          if (fail) throw Error('write failed');
          settings.set(key, value);
        },
      },
      () => at,
    );
  let history = create();
  const sample = (offset, field, value) => {
    at = start + offset;
    history.observeMinute(field, value, at);
  };
  sample(0, 'soc', 0);
  sample(0, 'evSoc', 90);
  sample(0, 'outdoorC', -4);
  sample(minute, 'soc', 60);
  sample(minute, 'outdoorC', null);
  sample(minute + 1000, 'soc', 80);
  fail = true;
  assert.throws(() => history.flush(), /write failed/);
  fail = false;
  history.flush();
  history = create();
  sample(minute + 5000, 'soc', 99);
  sample(5 * minute - 1, 'outdoorC', 0);
  sample(5 * minute, 'soc', 80);
  sample(5 * minute, 'evSoc', 101);
  sample(5 * minute, 'outdoorC', -2);
  sample(14 * minute, 'outdoorC', -6);
  const file = history.export();
  assert.equal(file.schema, 17);
  assert.throws(() => parseExport({ ...file, schema: 16 }, at), /version 17/);
  assert.deepEqual(parseExport(file, at).slots, file.slots);
  const [first] = file.slots;
  assert.deepEqual(first.minuteMeans.soc, [
    { mean: 30, count: 2, lastMinute: 1 },
    { mean: 80, count: 1, lastMinute: 0 },
    null,
  ]);
  assert.deepEqual(first.minuteMeans.evSoc, [{ mean: 90, count: 1, lastMinute: 0 }, null, null]);
  assert.deepEqual(first.minuteMeans.outdoorC, [{ mean: -3, count: 4, lastMinute: 14 }]);
  assert.equal(first.counts.soc, 3);
  const restored = new Map();
  history = new HistoryStore(restored, () => at);
  history.import(file);
  sample(15 * minute - 1, 'outdoorC', 90);
  sample(15 * minute, 'outdoorC', 0);
  sample(15 * minute, 'soc', 100);
  history.flush();
  const [original, next] = history.getSlots();
  assert.deepEqual(original, first);
  assert.equal(next.t, start + 15 * minute);
  assert.deepEqual(next.minuteMeans.outdoorC, [{ mean: 0, count: 1, lastMinute: 0 }]);
  assert.deepEqual(next.minuteMeans.soc, [{ mean: 100, count: 1, lastMinute: 0 }, null, null]);
});

test('backup validation rejects impossible counts, bins and sensor values', () => {
  const bin = { mean: 50, count: 1, lastMinute: 0 };
  for (const fields of [
    {},
    { soc: [bin] },
    { bad: [bin] },
    { evSoc: [null, null, null] },
    { outdoorC: [{ ...bin, mean: -3276.8 }] },
    { soc: [{ ...bin, mean: -1 }, null, null] },
    { evSoc: [null, { ...bin, count: 2 }, null] },
    { outdoorC: [{ ...bin, lastMinute: 15 }] },
    { outdoorC: [{ ...bin, extra: 0 }] },
  ])
    assert.equal(validMinuteMeans(fields), false);
});
