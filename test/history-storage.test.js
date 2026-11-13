'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryStore, SLOT_MS, SLOT_RETENTION } = require('../lib/history');
const { dayBounds, dateKey, dailyFromSlots, MAX_STATE_BYTES } = require('../lib/history-format');
const JAN = Date.parse('2026-01-01T00:00:00Z');
function setup(start = JAN) {
  let now = start,
    fail = false;
  const data = new Map(),
    writes = [];
  const settings = {
    get: (key) => structuredClone(data.get(key)),
    set(key, value) {
      if (fail) throw new Error('simulated write failure');
      writes.push(key);
      data.set(key, structuredClone(value));
    },
  };
  return {
    settings,
    writes,
    store: new HistoryStore(settings, () => now),
    at: (value) => {
      now = value;
    },
    fail: (value) => {
      fail = value;
    },
  };
}
function slot(t, gridWh = 1000) {
  return {
    schema: 2,
    t,
    n: 2,
    counts: { gridW: 2 },
    sum: { gridW: gridWh * 8 },
    min: { gridW: gridWh * 4 },
    max: { gridW: gridWh * 4 },
    gridWh,
    coverageMs: SLOT_MS,
  };
}
function backup(slots = [], daily = [], events = []) {
  return { schema: 2, exportedAt: new Date(JAN).toISOString(), slots, daily, events };
}

test('a 31-day billing month remains available on its last day', () => {
  const s = setup(Date.parse('2026-10-31T22:50:00Z'));
  const start = dayBounds('2026-10-01').start;
  s.settings.set('historySlots', [slot(start)]);
  s.store.append({ gridW: 4000 }, Date.parse('2026-10-31T22:50:00Z'));
  s.store.flush();
  assert.ok(s.settings.get('historyState').slots.some((row) => row.t === start));
  assert.equal(SLOT_RETENTION, 32 * 96);
});

test('Stockholm daily duration and quarters follow both daylight-saving transitions', () => {
  for (const [date, hours] of [
    ['2026-03-29', 23],
    ['2026-10-25', 25],
  ]) {
    const { start, end, durationMs } = dayBounds(date);
    assert.equal(durationMs, hours * 3600000);
    const rows = [];
    for (let t = start; t < end; t += SLOT_MS) rows.push(slot(t));
    const [daily] = dailyFromSlots(rows, [], end);
    assert.equal(daily.date, date);
    assert.equal(daily.slots, hours * 4);
    assert.equal(daily.coverageMs, durationMs);
    assert.equal(daily.status, 'complete');
    assert.equal(daily.gridWh, hours * 4000);
  }
  assert.equal(dateKey(Date.parse('2026-01-01T23:30:00Z')), '2026-01-02');
});

test('trimming raw history cannot overwrite the archived daily total with a suffix', () => {
  const { start, end } = dayBounds('2026-01-01');
  const rows = Array.from({ length: 96 }, (_, i) => slot(start + i * SLOT_MS));
  const full = dailyFromSlots(rows, [], end);
  const later = dailyFromSlots(rows.slice(48), full, end + 32 * 86400000);
  assert.deepEqual(later, full);
  const gap = dailyFromSlots([rows[0], rows.at(-1)], full, end + 32 * 86400000);
  assert.deepEqual(gap, full);
});

test('one canonical write commits slots and local daily totals, and retries do not double energy', () => {
  const s = setup(JAN + 20000);
  s.store.append({ gridW: 3600 }, JAN);
  s.store.append({ gridW: 3600 }, JAN + 10000);
  s.fail(true);
  assert.throws(() => s.store.flush(), /write failure/);
  assert.equal(s.settings.get('historyState'), undefined);
  s.fail(false);
  s.store.flush();
  s.store.flush();
  assert.deepEqual(s.writes, ['historyState']);
  const state = s.settings.get('historyState');
  assert.equal(state.slots[0].gridWh, 10);
  assert.equal(state.daily[0].gridWh, 10);
  const restarted = new HistoryStore(s.settings, () => JAN + 40000);
  restarted.append({ gridW: 3600 }, JAN + 20000);
  restarted.append({ gridW: 3600 }, JAN + 30000);
  restarted.flush();
  assert.equal(s.settings.get('historyState').slots[0].gridWh, 20);
  assert.equal(s.settings.get('historyState').daily[0].gridWh, 20);
});

test('old UTC daily history is preserved separately during migration', () => {
  const s = setup(JAN + 10000);
  const legacy = {
    date: '2026-01-01',
    slots: 2,
    gridWh: 123,
    pvWh: 0,
    essWh: 0,
    evWh: 0,
    peakGridW: 1000,
  };
  s.settings.set('historyDaily', [legacy]);
  s.store.append({ gridW: 3600 }, JAN);
  s.store.append({ gridW: 3600 }, JAN + 10000);
  s.store.flush();
  const state = s.settings.get('historyState');
  assert.deepEqual(state.legacyDaily, [legacy]);
  assert.equal(state.daily[0].timezone, 'Europe/Stockholm');
  assert.equal(state.daily[0].gridWh, 10);
  assert.deepEqual(s.settings.get('historyDaily'), [legacy]);
});

test('versioned export round trips, preview does not write, and repeated merges are idempotent', () => {
  const source = setup(JAN + 10000);
  source.store.append({ gridW: 3600 }, JAN);
  source.store.append({ gridW: 3600 }, JAN + 10000);
  source.store.event('backup-mode', { mode: 'on-grid' }, JAN);
  const file = source.store.export();
  assert.equal(file.schema, 3);
  assert.equal(file.format, 'com.local.sigenergy.history');
  const target = setup(JAN + 20000);
  const before = target.writes.length;
  const preview = target.store.previewImport(file);
  assert.equal(target.writes.length, before);
  assert.equal(preview.slots, 1);
  target.store.import(file);
  const restored = target.store.export();
  target.store.import(restored);
  assert.deepEqual(target.store.export().slots, restored.slots);
  assert.deepEqual(target.store.export().events, restored.events);
  assert.equal(target.store.export().daily[0].gridWh, 10);
});

test('legacy UI export aliases are accepted and overlap never adds or replaces live energy', () => {
  const s = setup(JAN + 10000);
  s.store.append({ gridW: 3600 }, JAN);
  s.store.append({ gridW: 3600 }, JAN + 10000);
  s.store.flush();
  const file = {
    schema: 2,
    exportedAt: new Date(JAN).toISOString(),
    historySlots: [slot(JAN, 900)],
    historyDaily: [],
    historyEvents: [],
  };
  assert.equal(s.store.previewImport(file).conflictingSlots, 1);
  s.store.import(file);
  assert.equal(s.store.export().slots[0].gridWh, 10);
});

test('malformed and credential-bearing imports leave both state and pending data untouched', () => {
  const s = setup(JAN + 20000);
  s.store.append({ gridW: 3600 }, JAN);
  s.store.append({ gridW: 3600 }, JAN + 10000);
  const malformed = [
    '{bad json',
    {},
    { ...backup(), schema: 99 },
    { ...backup(), tibberToken: 'secret' },
    backup([slot(JAN), slot(JAN)]),
    backup([{ ...slot(JAN), coverageMs: SLOT_MS + 1 }]),
    backup([{ ...slot(JAN), t: JAN + 1 }]),
    backup([{ ...slot(JAN), counts: { gridW: -1 } }]),
    backup([{ ...slot(JAN), legacy: { ...slot(JAN), token: 'secret' } }]),
    backup([], [], [{ t: JAN, type: 'backup-mode', token: 'secret' }]),
  ];
  for (const file of malformed) assert.throws(() => s.store.import(file));
  assert.deepEqual(s.writes, []);
  s.store.flush();
  assert.equal(s.store.export().slots[0].gridWh, 10);
});

test('a failed restore write keeps the previous state and pending samples available for retry', () => {
  const s = setup(JAN + SLOT_MS + 10000);
  s.store.append({ gridW: 3600 }, JAN + SLOT_MS);
  s.store.append({ gridW: 3600 }, JAN + SLOT_MS + 10000);
  s.fail(true);
  assert.throws(() => s.store.import(backup([slot(JAN)])), /write failure/);
  s.fail(false);
  s.store.import(backup([slot(JAN)]));
  const file = s.store.export();
  assert.equal(file.slots.length, 2);
  assert.equal(file.slots[1].gridWh, 10);
});

test('a full synthetic retention window fits the explicit storage budget', () => {
  const s = setup(JAN + (SLOT_RETENTION - 1) * SLOT_MS);
  const rows = Array.from({ length: SLOT_RETENTION }, (_, i) => slot(JAN + i * SLOT_MS));
  const preview = s.store.previewImport(backup(rows));
  assert.equal(preview.slots, SLOT_RETENTION);
  assert.ok(preview.bytes < MAX_STATE_BYTES);
  s.store.import(backup(rows));
  assert.equal(s.store.export().slots.length, SLOT_RETENTION);
});

test('an imported archived day survives after all its raw quarters age out', () => {
  const { start, end } = dayBounds('2026-01-01');
  const s = setup(end + 33 * 86400000);
  const rows = Array.from({ length: 96 }, (_, i) => slot(start + i * SLOT_MS));
  s.store.import(backup(rows));
  assert.equal(s.store.export().slots.length, 0);
  assert.equal(s.store.export().daily[0].gridWh, 96000);
  s.store.import(backup(rows.map((row) => slot(row.t, 900))));
  assert.equal(s.store.export().daily[0].gridWh, 96000);
  s.store.append({ gridW: 3600 }, end + 33 * 86400000);
  s.store.flush();
  assert.equal(s.store.export().daily[0].gridWh, 96000);
});

test('daily retention follows calendar dates and expired legacy days are removed only from the new state', () => {
  const now = Date.parse('2026-01-01T12:00:00Z'),
    s = setup(now);
  const legacy = {
    date: '2023-01-01',
    slots: 1,
    gridWh: 10,
    pvWh: 0,
    essWh: 0,
    evWh: 0,
    peakGridW: 1000,
  };
  s.settings.set('historyDaily', [legacy]);
  s.store.append({ gridW: 3600 }, now);
  s.store.flush();
  assert.deepEqual(s.store.export().legacyDaily, []);
  assert.deepEqual(s.settings.get('historyDaily'), [legacy]);
});

test('invalid timestamps, future events and unsupported replacement requests cannot be restored', () => {
  const s = setup(JAN);
  for (const file of [
    backup([slot(JAN + SLOT_MS)]),
    backup([], [], [{ t: JAN + 120000, type: 'backup-mode' }]),
    { ...backup(), mode: 'replace' },
    {
      ...backup(),
      daily: [
        { date: '2026-99-01', slots: 0, gridWh: 0, pvWh: 0, essWh: 0, evWh: 0, peakGridW: null },
      ],
    },
  ])
    assert.throws(() => s.store.import(file));
  assert.deepEqual(s.writes, []);
});

test('storage budget rejection happens before any state is written', () => {
  const s = setup(JAN + (SLOT_RETENTION - 1) * SLOT_MS);
  const fields = ['gridW', 'pvW', 'essW', 'soc', 'evW', 'evSoc'];
  const stats = Object.fromEntries(fields.map((k) => [k, 1234567890123]));
  const rows = Array.from({ length: SLOT_RETENTION }, (_, i) => {
    const t = JAN + i * SLOT_MS;
    const old = {
      t,
      n: 1,
      sum: stats,
      min: stats,
      max: stats,
      coverageMs: SLOT_MS,
      gridWh: 1234567890123,
      pvWh: 1234567890123,
      essWh: 1234567890123,
      evWh: 1234567890123,
    };
    return {
      ...old,
      schema: 2,
      counts: Object.fromEntries(fields.map((k) => [k, 1])),
      legacy: old,
    };
  });
  const events = Array.from({ length: 500 }, (_, i) => ({
    t: JAN + i,
    type: 'backup-mode',
    mode: 'x'.repeat(500),
    observed: 'x'.repeat(500),
    requested: 'x'.repeat(500),
    reason: 'x'.repeat(500),
  }));
  assert.throws(() => s.store.import(backup(rows, [], events)), /budget/);
  assert.deepEqual(s.writes, []);
});
