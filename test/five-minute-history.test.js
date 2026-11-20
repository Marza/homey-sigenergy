'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { HistoryStore } = require('../lib/history');
const { bounded, MAX_STATE_BYTES, dayBounds, parseExport } = require('../lib/history-format');
const { FIVE_MS: F, validParts } = require('../lib/energy/five-minute');
const { getPowerHistory } = require('../lib/energy/dashboard-history');
const { start } = dayBounds('2026-11-19');
function fixture(now = start + 6 * F) {
  const map = new Map(),
    settings = { get: (k) => map.get(k), set: (k, v) => map.set(k, v) };
  const history = new HistoryStore(settings, () => now);
  const report = (at = now) => getPowerHistory({ app: { history } }, { date: '2026-11-19' }, at);
  return { map, settings, history, report };
}
test('one integration produces distinct five-minute power for all six channels and conserves quarter Wh across flushes', () => {
  const { history, report } = fixture();
  for (let i = 0; i <= 30; i++) {
    // A triangular charge peak in the first five minutes.
    const w = i <= 10 ? (5 - Math.abs(5 - i)) * 2000 : 0;
    history.append({ gridW: w, essW: -w, pvW: 1200, evW: w, evacW: 0 }, start + i * 30000);
    if (i % 2 === 0) history.observeHouseholdCounter(String(100 + i), start + i * 30000);
    if (i % 3 === 0) history.flush();
  }
  history.flush();
  const { points } = report(start + 3 * F);
  assert.deepEqual(
    points.map((p) => p.durationMs),
    [F, F, F],
  );
  assert.deepEqual(
    points.map((p) => p.kw.grid),
    [5, 0, 0],
  );
  assert.equal(points[0].kw.battery, 5);
  assert.equal(points[0].kw.dc, -5);
  assert.equal(Math.abs(points[0].kw.ac), 0);
  assert.equal(points[0].kw.solar, 1.2);
  assert.equal(points[0].kw.house, -1.2);
  const row = history.getSlots()[0];
  assert.ok(Math.abs(points.reduce((v, p) => v + (p.kw.grid * F) / 3600, 0) - row.gridWh) < 1e-6);
  const backup = history.export();
  assert.equal(backup.schema, 14);
  assert.deepEqual(parseExport(backup, start + 6 * F).slots, backup.slots);
  assert.throws(() => parseExport({ ...backup, schema: 13 }, start + 6 * F), /version 14/);
  backup.slots[0].fiveMinute.gridW[1] = F + 1;
  assert.throws(() => parseExport(backup, start + 6 * F), /five-minute/);
});
test('split a ramp and household counter at a five-minute boundary, preserving direction and coverage', () => {
  const { history, report } = fixture();
  for (let seconds = 0; seconds <= 600; seconds += 10) {
    const at = start + seconds * 1000;
    history.append({ gridW: seconds * 10 - 3000, evW: seconds === 100 ? null : 2000 }, at);
  }
  history.observeHouseholdCounter('100', start + F - 15000);
  history.observeHouseholdCounter('106', start + F + 45000);
  history.flush();
  const row = history.getSlots()[0];
  assert.deepEqual(row.fiveMinute.household, [15, 15000, 45, 45000, 3]);
  assert.ok(validParts(row));
  assert.deepEqual(
    report(start + 2 * F + 30000).points.map((p) => Number(p.kw.grid.toFixed(9))),
    [-1.5, 1.5],
  );
  assert.deepEqual(
    report(start + 2 * F + 30000).points.map((p) =>
      p.kw.dc === null ? null : Number(p.kw.dc.toFixed(9)),
    ),
    [null, -2],
  );
  assert.equal(report(start + F).points.length, 1);
});
test('a missing channel stays unknown and pre-upgrade history retains its quarter resolution', () => {
  const { history, report } = fixture();
  for (let i = 0; i <= 15; i++) {
    history.append({ gridW: i === 7 ? null : 3000, pvW: 0 }, start + i * 60000);
  }
  history.flush();
  assert.deepEqual(
    report(start + 3 * F).points.map((p) => p.kw.grid),
    [3, null, 3],
  );
  assert.deepEqual(
    report(start + 3 * F).points.map((p) => p.kw.solar),
    [0, 0, 0],
  );
  const compressed = history.export();
  const legacy = structuredClone(compressed);
  delete legacy.slots[0].fiveMinute;
  legacy.schema = 8;
  const old = fixture();
  old.history.import(legacy);
  for (let i = 0; i <= 5; i++) old.history.append({ gridW: 5000 }, start + 3 * F + i * 60000);
  old.history.flush();
  const mixed = old.report(start + 4 * F).points;
  assert.deepEqual(
    mixed.map((p) => p.durationMs),
    [3 * F, F],
  );
  assert.ok(Math.abs(mixed[1].kw.grid - 5) < 1e-9);
});
test('storage pressure coarsens older detail without losing the quarter or the newest detail', () => {
  const { history } = fixture();
  for (let i = 0; i <= 30; i++) history.append({ gridW: 1000 }, start + i * 60000);
  history.flush();
  const state = { slots: history.getSlots(), padding: '' };
  state.padding = 'x'.repeat(MAX_STATE_BYTES - Buffer.byteLength(JSON.stringify(state)) + 4);
  const trimmed = bounded(state);
  assert.equal(trimmed.slots[0].fiveMinute, undefined);
  assert.deepEqual(trimmed.slots[1].fiveMinute, state.slots[1].fiveMinute);
  assert.equal(trimmed.slots[0].gridWh, state.slots[0].gridWh);
});
test('five-minute days follow elapsed Stockholm time on both clock changes', () => {
  for (const [date, count] of [
    ['2026-03-29', 276],
    ['2026-10-25', 300],
  ]) {
    const day = dayBounds(date);
    const row = {
      t: day.start,
      gridWh: 250,
      fieldCoverageMs: { gridW: 3 * F },
      fiveMinute: { gridW: [80, F, 80, F] },
    };
    const points = getPowerHistory(
      { app: { history: { getSlots: () => [row] } } },
      { date },
      day.end,
    ).points;
    assert.equal(points.length, count);
    assert.equal(points.at(-1).t + F, day.end);
  }
});
test('a restarted reader retains completed subintervals without bridging the restart gap', () => {
  const { history, settings } = fixture();
  for (let i = 0; i <= 5; i++) history.append({ gridW: 1200 }, start + i * 60000);
  history.flush();
  const resumed = new HistoryStore(settings, () => start + 3 * F);
  for (let i = 6; i <= 15; i++) resumed.append({ gridW: 1200 }, start + i * 60000);
  resumed.flush();
  const points = getPowerHistory(
    { app: { history: resumed } },
    { date: '2026-11-19' },
    start + 3 * F,
  ).points;
  assert.deepEqual(
    points.map((p) => p.kw.grid),
    [1.2, null, 1.2],
  );
});
