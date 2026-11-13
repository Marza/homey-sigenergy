'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryStore, SLOT_MS, SLOT_RETENTION } = require('../lib/history');
function setup(now = 1800000000000) {
  const map = new Map();
  const settings = { get: key => map.get(key), set: (key, value) => map.set(key, structuredClone(value)) };
  return { history: new HistoryStore(settings, () => now), settings };
}
test('stores aggregated samples and integrates adjacent power readings', () => {
  const t = 1800000000000;
  const { history, settings } = setup(t + 10000);
  history.append({ gridW: 1000, soc: 50 }, t);
  history.append({ gridW: 2000, soc: 52 }, t + 10000);
  history.flush();
  const rows = settings.get('historySlots');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].max.gridW, 2000);
  assert.ok(Math.abs(rows[0].gridWh - (1500 * 10 / 3600)) < 0.001);
  assert.equal(settings.get('historyDaily').length, 1);
});
test('flush is idempotent', () => {
  const { history, settings } = setup();
  history.append({ gridW: 100 }, 1800000000000);
  history.flush(); history.flush();
  assert.equal(settings.get('historySlots')[0].n, 1);
});
test('retention removes old slots', () => {
  const now = 1800000000000;
  const { history, settings } = setup(now);
  history.append({ gridW: 100 }, now - (SLOT_RETENTION + 5) * SLOT_MS);
  history.append({ gridW: 200 }, now);
  history.flush();
  assert.equal(settings.get('historySlots').length, 1);
});
test('events bounded and sensitive properties excluded', () => {
  const { history, settings } = setup();
  for (let i = 0; i < 510; i++) history.event('backup-mode', { mode: 'off-grid', token: 'secret' });
  assert.equal(settings.get('historyEvents').length, 500);
  assert.equal(settings.get('historyEvents')[0].token, undefined);
});
test('export contains no configuration secrets', () => {
  const { history, settings } = setup();
  settings.set('tibberToken', 'secret');
  history.append({ gridW: 100 }, 1800000000000);
  const exported = history.export();
  assert.equal(exported.schema, 2);
  assert.equal(JSON.stringify(exported).includes('secret'), false);
});
test('invalid values are ignored', () => {
  const { history, settings } = setup();
  history.append({ gridW: NaN, pvW: Infinity }, 1800000000000);
  history.flush();
  assert.equal(settings.get('historySlots'), undefined);
});

const T = 1800000000000; // Aligned quarter-hour boundary.
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('interleaved plant and EVDC samples preserve plant energy, coverage and per-field means', () => {
  const combined = setup(T + 30000), plantOnly = setup(T + 30000);
  for (let i = 0; i < 3; i++) {
    const plant = { gridW: 1000 + i * 1000, pvW: 0, essW: -500, soc: 60 + i };
    combined.history.append(plant, T + i * 10000);
    plantOnly.history.append(plant, T + i * 10000);
    combined.history.append({ evW: 4000, evSoc: 40 + i }, T + i * 10000 + 100);
    // Flushing between polls must not break either stream's continuity.
    combined.history.flush(); plantOnly.history.flush();
  }
  const row = combined.settings.get('historySlots')[0];
  const baseline = plantOnly.settings.get('historySlots')[0];
  assert.equal(row.schema, 2);
  assert.equal(row.n, 6);
  assert.deepEqual(row.counts, { gridW: 3, pvW: 3, essW: 3, soc: 3, evW: 3, evSoc: 3 });
  assert.equal(row.gridWh, baseline.gridWh);
  assert.equal(row.essWh, baseline.essWh);
  assert.equal(row.coverageMs, 20000);
  near(row.sum.gridW / row.counts.gridW, 2000);
  near(row.sum.soc / row.counts.soc, 61);
  near(row.sum.evSoc / row.counts.evSoc, 41);
  near(row.evWh, 4000 * 20 / 3600);
});

test('an EVDC outage cannot interrupt plant coverage or bridge a long EV gap', () => {
  const { history, settings } = setup(T + 90000);
  for (let seconds = 0; seconds <= 80; seconds += 10) {
    history.append({ gridW: 3600, essW: -1800, soc: 50 }, T + seconds * 1000);
    if (seconds === 0 || seconds === 10 || seconds === 80) {
      history.append({ evW: 7200 }, T + seconds * 1000);
    }
  }
  history.flush();
  const row = settings.get('historySlots')[0];
  assert.equal(row.coverageMs, 80000);
  near(row.gridWh, 80);
  near(row.essWh, -40);
  near(row.evWh, 20);
  assert.equal(row.counts.gridW, 9);
  assert.equal(row.counts.evW, 3);
});

test('splits a linearly changing signed power interval at a quarter boundary exactly once', () => {
  const { history, settings } = setup(T + SLOT_MS + 10000);
  history.append({ gridW: -3600, essW: -1800 }, T + SLOT_MS - 10000);
  history.flush();
  history.append({ gridW: 3600, essW: 1800 }, T + SLOT_MS + 10000);
  history.flush();
  const [before, after] = settings.get('historySlots');
  assert.equal(before.coverageMs, 10000);
  assert.equal(after.coverageMs, 10000);
  near(before.gridWh, -5); near(after.gridWh, 5);
  near(before.essWh, -2.5); near(after.essWh, 2.5);
  near(before.gridWh + after.gridWh, 0);
  assert.equal(before.counts.gridW, 1);
  assert.equal(after.counts.gridW, 1);
  history.flush();
  assert.deepEqual(settings.get('historySlots'), [before, after]);
});

test('sample on the exact boundary ends the previous quarter without inventing new coverage', () => {
  const { history, settings } = setup(T + SLOT_MS);
  history.append({ gridW: 3600 }, T + SLOT_MS - 10000);
  history.append({ gridW: 3600 }, T + SLOT_MS);
  history.flush();
  const [before, after] = settings.get('historySlots');
  near(before.gridWh, 10);
  assert.equal(before.coverageMs, 10000);
  assert.equal(after.coverageMs, 0);
  assert.equal(after.gridWh, undefined);
});

test('rejects duplicate/backward observations per field but accepts complementary fields at the same time', () => {
  const { history, settings } = setup(T + 30000);
  history.append({ gridW: 1000 }, T);
  history.append({ gridW: 3000 }, T + 10000);
  history.append({ gridW: 9000 }, T + 5000);
  history.append({ gridW: 9000, evW: 7200 }, T + 10000);
  history.append({ gridW: 5000, evW: 7200 }, T + 20000);
  history.flush();
  const row = settings.get('historySlots')[0];
  assert.deepEqual(row.counts, { gridW: 3, evW: 2 });
  assert.equal(row.sum.gridW, 9000);
  assert.equal(row.coverageMs, 20000);
  near(row.gridWh, (2000 * 10 + 4000 * 10) / 3600);
  near(row.evWh, 20);
});

test('invalid values break only their own continuity and never count as zero', () => {
  const { history, settings } = setup(T + 30000);
  history.append({ gridW: 1000, evW: 3600 }, T);
  history.append({ gridW: NaN, evW: 3600 }, T + 10000);
  history.append({ gridW: 3000, evW: 3600 }, T + 20000);
  history.append({ gridW: 4000 }, T + 30000);
  history.flush();
  const row = settings.get('historySlots')[0];
  assert.equal(row.counts.gridW, 3);
  assert.equal(row.sum.gridW, 8000);
  assert.equal(row.coverageMs, 10000);
  near(row.gridWh, 3500 * 10 / 3600);
  near(row.evWh, 20);
});

test('long gaps do not create energy or coverage even across a boundary', () => {
  const { history, settings } = setup(T + SLOT_MS + 60001);
  history.append({ gridW: 3600 }, T + SLOT_MS - 1);
  history.append({ gridW: 3600 }, T + SLOT_MS + 60000);
  history.flush();
  for (const row of settings.get('historySlots')) {
    assert.equal(row.coverageMs, 0);
    assert.equal(row.gridWh, undefined);
  }
});

test('restart preserves counts and energy but does not integrate across the restart', () => {
  const { history, settings } = setup(T + 40000);
  history.append({ gridW: 3600 }, T);
  history.append({ gridW: 3600 }, T + 10000);
  history.flush();
  const restarted = new HistoryStore(settings, () => T + 40000);
  restarted.append({ gridW: 7200 }, T + 20000);
  restarted.append({ gridW: 7200 }, T + 30000);
  restarted.flush();
  const row = settings.get('historySlots')[0];
  assert.equal(row.counts.gridW, 4);
  assert.equal(row.sum.gridW, 21600);
  assert.equal(row.coverageMs, 20000);
  near(row.gridWh, 30);
});

test('legacy history is preserved without attributing its unknown counts or coverage to new samples', () => {
  const { history, settings } = setup(T + 10000);
  const old = { t: T - SLOT_MS, n: 2, sum: { gridW: 2000 }, min: { gridW: 1000 }, max: { gridW: 1000 }, gridWh: 250, coverageMs: 900000 };
  const active = { ...old, t: T };
  settings.set('historySlots', [old, active]);
  history.append({ gridW: 3600 }, T);
  history.append({ gridW: 3600 }, T + 10000);
  history.flush();
  const [preserved, current] = settings.get('historySlots');
  assert.deepEqual(preserved, old);
  assert.deepEqual(current.legacy, active);
  assert.equal(current.schema, 2);
  assert.equal(current.counts.gridW, 2);
  assert.equal(current.coverageMs, 10000);
  near(current.gridWh, 10);
  history.append({ gridW: 3600 }, T + 20000);
  history.flush();
  assert.deepEqual(settings.get('historySlots')[1].legacy, active);
});

test('a failed slot write can be retried without losing or duplicating pending energy', () => {
  const map = new Map(); let fail = true;
  const settings = { get: k => map.get(k), set(k, v) {
    if (k === 'historySlots' && fail) { fail = false; throw new Error('storage failure'); }
    map.set(k, structuredClone(v));
  } };
  const history = new HistoryStore(settings, () => T + 10000);
  history.append({ gridW: 3600 }, T);
  history.append({ gridW: 3600 }, T + 10000);
  assert.throws(() => history.flush(), /storage failure/);
  history.flush(); history.flush();
  const row = settings.get('historySlots')[0];
  assert.equal(row.counts.gridW, 2);
  assert.equal(row.coverageMs, 10000);
  near(row.gridWh, 10);
});

test('a full hour of interleaved observations supplies four complete quarters to the tariff estimator', () => {
  const { calculateDemandCharge } = require('../lib/demand-tariff');
  const t = Date.parse('2026-01-12T09:00:00Z');
  const { history, settings } = setup(t + 3600000 + 100);
  for (let seconds = 0; seconds <= 3600; seconds += 10) {
    history.append({ gridW: 3600, essW: -1800, soc: 50 }, t + seconds * 1000);
    history.append({ evW: 7200, evSoc: 40 }, t + seconds * 1000 + 100);
    if (seconds % 60 === 0) history.flush();
  }
  history.flush();
  const hours = settings.get('historySlots').filter(row => row.t < t + 3600000);
  assert.equal(hours.length, 4);
  for (const row of hours) {
    assert.equal(row.coverageMs, SLOT_MS);
    near(row.gridWh, 900);
    near(row.essWh, -450);
    near(row.sum.gridW / row.counts.gridW, 3600);
  }
  const charge = calculateDemandCharge(hours, {
    start: '07:00', end: '20:00', weekdays: [1], peakCount: 1,
    distinctDays: true, rateSekPerKw: 100,
  }, '2026-01');
  assert.equal(charge.status, 'provisional');
  assert.equal(charge.eligibleHours, 1);
  near(charge.averageKw, 3.6);
  near(charge.estimatedSek, 360);
});

test('the supported one-minute boundary interval is integrated while invalid timestamps are rejected', () => {
  const { history, settings } = setup(T + SLOT_MS + 30000);
  for (const ms of [NaN, Infinity, T + 0.5]) assert.throws(() => history.append({ gridW: 3600 }, ms), /timestamp/);
  history.append({ gridW: 3600 }, T + SLOT_MS - 30000);
  history.append({ gridW: 3600 }, T + SLOT_MS + 30000);
  history.flush();
  const rows = settings.get('historySlots');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.coverageMs, 30000);
    near(row.gridWh, 30);
  }
});
