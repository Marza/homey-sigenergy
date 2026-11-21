'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { HistoryStore } = require('../lib/history');
const { parseExport } = require('../lib/history-format');
const Q = 900000,
  H = 3600000,
  END = Date.parse('2026-06-11T20:00Z'),
  START = END - 12 * H;
test('independent power coverage starts with new observations and survives export and restore', () => {
  let now = START + Q;
  const map = new Map(),
    settings = { get: (k) => map.get(k), set: (k, v) => map.set(k, structuredClone(v)) },
    h = new HistoryStore(settings, () => now);
  for (let t = START; t <= START + Q; t += 30000)
    h.append({ gridW: -1000, pvW: 2000, essW: 0, evW: 0 }, t);
  h.flush();
  const row = h.getSlots()[0];
  assert.deepEqual(row.fieldCoverageMs, { gridW: Q, pvW: Q, essW: Q, evW: Q });
  const file = h.export();
  assert.equal(file.schema, 14);
  assert.doesNotThrow(() => parseExport(file, now));
  const restoredMap = new Map();
  const restored = new HistoryStore(
    { get: (k) => restoredMap.get(k), set: (k, v) => restoredMap.set(k, v) },
    () => now,
  );
  restored.import(file);
  assert.deepEqual(restored.getSlots()[0].fieldCoverageMs, row.fieldCoverageMs);
  assert.throws(() => parseExport({ ...file, schema: 5 }, now), /schema 6/);
  const old = structuredClone(file);
  old.schema = 5;
  delete old.slots[0].fiveMinute;
  delete old.slots[0].fieldCoverageMs;
  assert.doesNotThrow(() => parseExport(old, now));
  const bad = structuredClone(file);
  bad.slots[0].fieldCoverageMs.pvW = Q + 1;
  assert.throws(() => parseExport(bad, now));
  now += Q;
  const next = new HistoryStore(settings, () => now);
  next.append({ gridW: -1000, pvW: 2000, essW: 0 }, now - 30000);
  next.append({ gridW: -1000, pvW: 2000, essW: 0 }, now);
  next.flush();
  assert.equal(next.getSlots().find((s) => s.t === START + Q).fieldCoverageMs.pvW, 30000);
});
test('upgrade coverage never borrows older grid/ESS duration or bridges invalid PV samples', () => {
  const map = new Map(),
    settings = { get: (k) => map.get(k), set: (k, v) => map.set(k, structuredClone(v)) };
  const h = new HistoryStore(settings, () => START + Q);
  for (let t = START; t <= START + Q; t += 30000)
    h.append({ gridW: 1000, pvW: t === START + Q / 2 ? null : 2000, essW: 0 }, t);
  h.flush();
  assert.equal(h.getSlots()[0].fieldCoverageMs.pvW, Q - 60000);
  assert.equal(h.getSlots()[0].fieldCoverageMs.gridW, Q);
  const old = map.get('historyState');
  delete old.slots[0].fiveMinute;
  delete old.slots[0].fieldCoverageMs;
  settings.set('historyState', old);
  const fresh = new HistoryStore(settings, () => START + Q + 30000);
  fresh.append({ gridW: 1000, pvW: 2000, essW: 0 }, START + Q - 30000);
  fresh.append({ gridW: 1000, pvW: 2000, essW: 0 }, START + Q);
  fresh.flush();
  assert.equal(fresh.getSlots()[0].fieldCoverageMs.pvW, 30000);
  assert.doesNotThrow(() => fresh.export());
});
