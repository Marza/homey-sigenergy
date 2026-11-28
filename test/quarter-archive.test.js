'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryStore, SLOT_MS: Q } = require('../lib/history');
const { historySettings, pack } = require('../lib/packed-history');
const { getBatteryPlan } = require('../lib/energy/battery-plan-report');
const { getPowerHistory } = require('../lib/energy/dashboard-history');

function fixture(start) {
  let now = start,
    fail;
  const data = new Map(),
    reads = [],
    writes = [];
  const settings = {
    get: (k) => (reads.push(k), data.get(k)),
    set(k, v) {
      if (k === fail) throw Error('write interrupted');
      writes.push(k);
      data.set(k, v);
    },
    unset: (k) => data.delete(k),
    getKeys: () => [...data.keys()],
  };
  const clock = () => now;
  const restart = () => new HistoryStore(historySettings(settings), clock);
  const store = restart(),
    old = new HistoryStore(new Map(), clock);
  function append(t, gridW = 1000) {
    now = t;
    for (const s of [store, old]) s.append({ gridW }, t);
  }
  function flush() {
    old.flush({ snapshot: false });
    store.flush({ snapshot: false });
  }
  return {
    store,
    old,
    settings,
    data,
    reads,
    writes,
    restart,
    append,
    flush,
    fail: (k) => {
      fail = k;
    },
    setTime: (t) => {
      now = t;
    },
  };
}
test('open checkpoints, range reads and planner refreshes leave closed partitions alone', () => {
  const t = Date.UTC(2026, 10, 28, 12);
  const f = fixture(t);
  for (const at of [t - 2 * 86400000, t - 86400000, t - Q, t, t + 10000]) {
    f.append(at);
    f.flush();
  }
  f.reads.length = f.writes.length = 0;
  f.append(t + 20000);
  f.flush();
  assert.deepEqual(f.writes, ['historyState']);
  assert.ok(f.reads.every((k) => k === 'historyState'));
  assert.deepEqual(f.store.read(), f.old.read());
  f.reads.length = 0;
  assert.deepEqual(
    f.store.getSlots(t - 86400000, t - 86400000 + Q),
    f.old.getSlots(t - 86400000, t - 86400000 + Q),
  );
  assert.equal(f.reads.filter((k) => k.startsWith('quarterDay-')).length, 1);
  const homey = { app: { history: f.store }, settings: f.settings };
  f.reads.length = 0;
  const plan = getBatteryPlan(homey, t + 20000);
  assert.ok(f.reads.some((k) => k.startsWith('quarterDay-')));
  f.reads.length = 0;
  assert.deepEqual(getBatteryPlan(homey, t + 20000), plan);
  assert.ok(!f.reads.some((k) => k.startsWith('quarterDay-')));
  f.store.observeMinute('soc', 70, t + 60000);
  f.setTime(t + 60000);
  f.store.flush({ snapshot: false });
  f.reads.length = 0;
  assert.equal(getBatteryPlan(homey, t + 60000).measured.at(-1).soc, 70);
  assert.ok(!f.reads.some((k) => k.startsWith('quarterDay-')));
  f.settings.set('gridPhaseCurrent', { binding: 'another-meter' });
  f.reads.length = 0;
  getBatteryPlan(homey, t + 60000);
  assert.ok(f.reads.some((k) => k.startsWith('quarterDay-')));
  f.reads.length = 0;
  getPowerHistory(homey, { date: '2026-11-27' }, t + 20000);
  assert.equal(f.reads.filter((k) => k.startsWith('quarterDay-')).length, 1);
});
test('interrupted migration and rollover publish either the previous snapshot or the complete retry', () => {
  const t = Date.parse('2026-10-24T21:45:00Z'); // local midnight and the autumn DST day
  const f = fixture(t);
  f.old.append({ gridW: 100 }, t - Q);
  f.old.flush();
  f.data.set('historyState', pack(f.old.read()));
  f.append(t);
  f.fail('historyState');
  const previous = f.restart().read();
  assert.throws(() => f.store.flush({ snapshot: false }), /interrupted/);
  assert.deepEqual(f.restart().read(), previous);
  f.fail(null);
  f.flush();
  for (const at of [t + 10000, t + Q, t + Q + 10000, t + 8 * Q, t + 12 * Q]) {
    const before = f.store.read();
    f.append(at);
    f.fail('historyState');
    assert.throws(() => f.store.flush({ snapshot: false }), /interrupted/);
    assert.deepEqual(f.restart().read(), before);
    f.fail(null);
    f.flush();
    assert.deepEqual(f.restart().export(), f.old.export());
  }
  const day = f.data.get('historyState').days[0];
  f.data.delete('quarterDay-' + day.date + '-' + day.bank);
  assert.throws(() => f.restart(), /damaged/);
});
test('retained days and reported totals match the single snapshot across retention expiry', () => {
  const t = Date.parse('2026-03-28T22:45:00Z');
  const f = fixture(t);
  for (const at of [
    t,
    t + Q,
    t + Q + 10000,
    t + Q * 4,
    t + Q * 5,
    t + 32 * 86400000,
    t + 32 * 86400000 + 10000,
    t + 32 * 86400000 + Q,
  ]) {
    f.append(at);
    f.flush();
    assert.deepEqual(f.store.read(), f.old.read());
  }
});

test('a restart during a midnight counter repair keeps energy and checkpoint on the same revision', () => {
  const midnight = Date.parse('2026-11-27T23:00:00Z');
  const f = fixture(midnight - 60000);
  f.store.setHouseholdSource('test-meter');
  f.store.observeHouseholdCounter('1000', midnight - 60000);
  f.store.flush({ snapshot: false });
  f.setTime(midnight + 60000);
  let recovered = f.restart();
  recovered.setHouseholdSource('test-meter');
  recovered.observeHouseholdCounter('1012', midnight + 60000);
  f.fail('historyState');
  assert.throws(() => recovered.flush({ snapshot: false }), /interrupted/);
  f.fail(null);
  recovered = f.restart();
  assert.equal(recovered.read().householdCheckpoint.value, 1000);
  recovered.setHouseholdSource('test-meter');
  recovered.observeHouseholdCounter('1012', midnight + 60000);
  recovered.flush({ snapshot: false });
  const rows = f.restart().getSlots();
  assert.deepEqual(
    rows.map((r) => r.householdWh),
    [60, 60],
  );
  assert.deepEqual(
    rows.map((r) => r.householdRecoveredMs),
    [60000, 60000],
  );
  assert.equal(f.restart().read().householdCheckpoint.value, 1012);
  const before = recovered.export();
  recovered.import(before);
  assert.deepEqual(recovered.export(), before);
});

test('near-budget changes compact the oldest optional detail and keep later writes incremental', () => {
  const { MAX_STATE_BYTES, bytes } = require('../lib/history-format');
  const t = Date.UTC(2026, 10, 28, 12);
  const f = fixture(t);
  const state = f.store.read();
  // Simulate a large retained set with optional detail in an old day block.
  state.slots = [
    {
      t: t - 86400000,
      gridWh: 100,
      coverageMs: 0,
      phaseCurrent: { padding: 'x'.repeat(MAX_STATE_BYTES - 2200) },
    },
  ];
  f.data.set('historyState', pack(state));
  f.append(t);
  f.flush();
  f.setTime(t + 60000);
  f.store.observeMinute('soc', 70, t + 60000);
  f.store.flush({ snapshot: false });
  const next = f.store.read();
  assert.equal(next.slots[0].gridWh, 100);
  assert.equal(next.slots[0].phaseCurrent, undefined);
  assert.ok(bytes(next) < MAX_STATE_BYTES);
  f.reads.length = f.writes.length = 0;
  f.append(t + 70000);
  f.flush();
  assert.deepEqual(f.writes, ['historyState']);
  assert.ok(f.reads.every((k) => k === 'historyState'));
});
