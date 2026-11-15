'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { DataDiagnostics, readFailureReason, KEY, LIMIT } = require('../lib/data-diagnostics');
const { HistoryStore } = require('../lib/history');
const api = require('../api');
const { fixture } = require('./fixtures/readiness.cjs');
const T = Date.parse('2026-06-10T12:00Z'),
  Q = 900000,
  H = 3600000;
function setup() {
  let now = T,
    failure = false;
  const data = {},
    writes = [];
  const settings = {
    get: (k) => structuredClone(data[k]),
    set(k, v) {
      if (failure) throw Error('PRIVATE failure');
      data[k] = structuredClone(v);
      writes.push(k);
    },
  };
  const diagnostics = new DataDiagnostics(settings, () => now);
  return { data, settings, writes, diagnostics, at: (n) => (now = n), fail: (v) => (failure = v) };
}
test('classified Modbus reasons contain no upstream text, addresses or credentials', () => {
  for (const [error, reason] of [
    [{ code: 'ECONNREFUSED', message: 'PRIVATE_IP' }, 'modbus-refused'],
    [{ code: 'EHOSTUNREACH' }, 'modbus-unreachable'],
    [{ code: 'ETIMEDOUT' }, 'modbus-timeout'],
    [{ message: 'Timed out PRIVATE_TOKEN' }, 'modbus-timeout'],
    [{ message: 'PRIVATE_TOKEN' }, 'modbus-read-error'],
    [null, 'modbus-read-error'],
  ])
    assert.equal(readFailureReason(error), reason);
});
test('journal merges an observed outage, survives restart and bounds retention without storing arbitrary data', () => {
  const f = setup();
  f.at(T + 20000);
  f.diagnostics.record('grid', 'modbus-timeout', T, T + 10000);
  f.diagnostics.record('grid', 'modbus-timeout', T, T + 20000);
  assert.deepEqual(f.data[KEY].events, [
    { source: 'grid', reason: 'modbus-timeout', from: T, to: T + 20000 },
  ]);
  f.diagnostics.record('PRIVATE_SOURCE', 'PRIVATE_TOKEN');
  f.diagnostics.record('grid', 'PRIVATE_TOKEN');
  f.diagnostics.record('grid', 'sample-delay', T + 30000, T + 40000);
  assert.equal(f.data[KEY].events.length, 1);
  const restarted = new DataDiagnostics(f.settings, () => T + 20000);
  assert.equal(restarted.read().since, T + 20000);
  assert.equal(restarted.read().events.length, 1);
  for (let i = 1; i <= LIMIT + 2; i++) {
    f.at(T + 20000 + i);
    f.diagnostics.record('app', 'app-started');
  }
  assert.equal(f.data[KEY].events.length, LIMIT);
  assert.equal(f.data[KEY].dropped, 3);
  assert.doesNotMatch(JSON.stringify(f.data[KEY]), /PRIVATE/);
  f.at(T + 33 * 24 * H);
  f.diagnostics.flush();
  assert.equal(f.data[KEY].events.length, 0, 'periodic cleanup needs no new incident');
  f.diagnostics.record('app', 'app-started');
  assert.equal(f.data[KEY].events.length, 1);
});
test('journal failures preserve pending observations, retry safely and do not overwrite corrupt state', () => {
  const f = setup();
  f.fail(true);
  assert.doesNotThrow(() => f.diagnostics.record('storage', 'history-write-failed'));
  assert.equal(f.diagnostics.healthy, false);
  assert.equal(f.diagnostics.pending.length, 1);
  f.fail(false);
  f.diagnostics.flush();
  f.diagnostics.flush();
  assert.equal(f.data[KEY].events.length, 1);
  assert.equal(f.diagnostics.healthy, true);
  f.data[KEY] = { schema: 999, secret: 'PRIVATE' };
  f.diagnostics.record('app', 'app-started');
  assert.equal(f.diagnostics.healthy, false);
  assert.equal(f.data[KEY].schema, 999);
  assert.throws(() => f.diagnostics.read(), /invalid-diagnostics/);
});
test('history records real outage intervals, changed causes and long gaps without inventing energy', () => {
  const f = setup();
  const history = new HistoryStore(f.settings, () => T, f.diagnostics);
  const sample = { gridW: 3600, essW: 1800, pvW: 7200 };
  history.append(sample, T);
  f.at(T + 10000);
  history.append({ gridW: null, essW: null, pvW: null }, T + 10000, 'modbus-timeout');
  f.at(T + 20000);
  history.append({ gridW: null }, T + 20000, 'off-grid');
  f.at(T + 30000);
  history.append(sample, T + 30000);
  history.flush();
  const events = f.diagnostics.read().events;
  assert.ok(
    events.some(
      (e) =>
        e.source === 'grid' && e.reason === 'modbus-timeout' && e.from === T && e.to === T + 10000,
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.source === 'grid' &&
        e.reason === 'off-grid' &&
        e.from === T + 10000 &&
        e.to === T + 30000,
    ),
  );
  assert.ok(events.some((e) => e.source === 'battery' && e.to === T + 30000));
  assert.equal(history.getSlots()[0].coverageMs, 0);
  f.at(T + 100000);
  history.append(sample, T + 100000);
  history.flush();
  assert.ok(
    f.diagnostics
      .read()
      .events.some(
        (e) => e.reason === 'sample-delay' && e.from === T + 30000 && e.to === T + 100000,
      ),
  );
  assert.equal(history.getSlots()[0].coverageMs, 0);
});
test('a failed history write is retried without lost samples and reports recovery', () => {
  const f = setup();
  let fail = false;
  const settings = {
    get: f.settings.get,
    set: (k, v) => {
      if (fail && k === 'historyState') throw Error('PRIVATE');
      f.settings.set(k, v);
    },
  };
  const history = new HistoryStore(settings, () => T + 20000, f.diagnostics);
  f.at(T + 20000);
  history.append({ gridW: 3600 }, T);
  history.append({ gridW: 3600 }, T + 10000);
  fail = true;
  assert.throws(() => history.flush());
  assert.throws(() => history.flush());
  assert.equal(history.pending.size, 1);
  assert.equal(
    f.diagnostics.read().events.filter((e) => e.reason === 'history-write-failed').length,
    1,
  );
  fail = false;
  history.flush();
  history.flush();
  assert.equal(history.getSlots()[0].gridWh, 10);
  assert.ok(f.diagnostics.read().events.some((e) => e.reason === 'history-write-recovered'));
});
test('diagnostic API shows unknown historical causes and source-specific recorded events without writes or private values', async () => {
  const f = fixture();
  const d = new DataDiagnostics(f.homey.settings, () => f.now);
  f.homey.app.dataDiagnostics = d;
  f.rows[0].coverageMs = Q - 1;
  f.rows[0].directionalCoverageMs = Q - 1;
  f.rows[2].essCoverageMs = 0;
  delete f.data.tibberHistoryPriceCache.rows[1].production;
  const before = JSON.stringify(f.data);
  const r = await api.getDataDiagnostics({ homey: f.homey, body: { hours: 4 } });
  assert.equal(JSON.stringify(f.data), before, 'report must not persist anything');
  assert.equal(r.gaps.grid.missing, 1);
  assert.deepEqual(r.gaps.grid.ranges[0].reasons, []);
  assert.equal(r.gaps.battery.missing, 1);
  assert.equal(r.gaps.solar.missing, 0);
  assert.equal(r.prices.production.missing, 1);
  assert.equal(r.prices.consumption.missing, 0);
  d.record('grid', 'modbus-timeout', f.rows[0].t, f.rows[0].t + 10000);
  const r2 = d.report(f.homey, { hours: 4 });
  assert.deepEqual(r2.gaps.grid.ranges[0].reasons, ['modbus-timeout']);
  assert.deepEqual(r2.gaps.battery.ranges[0].reasons, []);
  assert.doesNotMatch(
    JSON.stringify(r2),
    /PRIVATE|SECRET|price"|unitPrice|costContract|unitId|host/,
  );
  assert.equal(r2.events.length, 1);
  for (const input of [
    null,
    {},
    { hours: 0 },
    { hours: 769 },
    { hours: 1.5 },
    { hours: 4, secret: 1 },
  ])
    assert.throws(() => d.report(f.homey, input), /invalid-diagnostic-window/);
});
test('unreadable history/journal and missing price service are explicit, while date ranges are bounded', () => {
  const f = fixture();
  const d = new DataDiagnostics(f.homey.settings, () => f.now);
  f.homey.app.history.getSlots = () => {
    throw Error('PRIVATE');
  };
  f.data[KEY] = { schema: 1, since: 0, events: [{ source: 'PRIVATE' }], dropped: 0 };
  f.homey.app.tibberHistoryPrices = null;
  const report = d.report(f.homey, { hours: 24 });
  assert.equal(report.journalHealthy, false);
  assert.equal(report.storage.readable, false);
  assert.equal(report.gaps.grid.available, false);
  assert.equal(report.prices.available, false);
  assert.equal(report.recordingSince, null);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  const many = fixture({ hours: 168 });
  const diag = new DataDiagnostics(many.homey.settings, () => many.now);
  for (let i = 0; i < many.rows.length; i += 2) many.rows[i].essCoverageMs = 0;
  const r = diag.report(many.homey, { hours: 168 });
  assert.equal(r.gaps.battery.truncated, true);
  assert.equal(r.gaps.battery.ranges.length, 100);
});

test('hourly recovery counts use the selected diagnostic period, including missing quarters and quarter-offset windows', () => {
  const f = fixture({ hours: 12 });
  for (const row of f.rows) {
    row.coverageMs = 0;
    row.directionalCoverageMs = 0;
  }
  f.data.tibberHistoryPriceCache.networkEnergy = f.data.tibberHistoryPriceCache.rows.map((r) => ({
    t: r.t,
    importWh: 1000,
    exportWh: 0,
  }));
  const d = new DataDiagnostics(f.homey.settings, () => f.now);
  const before = JSON.stringify(f.data);
  assert.equal(d.report(f.homey, { hours: 12 }).recovery.tibberFilledHours, 12);
  assert.equal(d.report(f.homey, { hours: 4 }).recovery.tibberFilledHours, 4);
  assert.equal(d.report(f.homey, { hours: 1 }).recovery.tibberFilledHours, 1);
  assert.equal(d.report(f.homey, { hours: 24 }).recovery.tibberFilledHours, 12);
  assert.equal(d.report(f.homey, { hours: 24 }).recovery.hourlyMissing, 12);
  const offset = d.report(f.homey, { hours: 1 }, f.now + Q);
  assert.equal(offset.recovery.tibberFilledHours, 1);
  assert.equal(offset.prices.to - offset.prices.from, H);
  f.homey.app.history.getSlots = () => [];
  assert.equal(
    d.report(f.homey, { hours: 4 }).recovery.tibberFilledHours,
    4,
    'confirmed meter hours can fill wholly absent local records',
  );
  f.homey.app.history.getSlots = () => {
    throw Error('synthetic read failure');
  };
  assert.equal(
    d.report(f.homey, { hours: 4 }).recovery.tibberFilledHours,
    0,
    'storage failures must stay unavailable',
  );
  assert.equal(JSON.stringify(f.data), before);
});
