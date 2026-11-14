'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { HistoryStore, SLOT_MS } = require('../lib/history');
const { dailyFromSlots, dayBounds, parseExport } = require('../lib/history-format');
const { energyHistory, getEnergyHistory } = require('../lib/pricing/energy-history');
const { evaluateEnergySlots } = require('../lib/pricing/cost-model');
const api = require('../api'),
  manifest = require('../app.json');
const T = Date.parse('2026-06-10T10:00:00Z');
function fixture(time = T) {
  let now = time,
    fail = false;
  const map = new Map();
  const settings = {
    get: (k) => map.get(k),
    set: (k, v) => {
      if (fail) throw Error('storage failed');
      map.set(k, v);
    },
  };
  const store = new HistoryStore(settings, () => now);
  return {
    store,
    map,
    settings,
    clock: (t) => {
      now = t;
    },
    fail: (value) => {
      fail = value;
    },
  };
}
const near = (a, b, tol = 1e-7) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
function full(t, imp = 100, exp = 50) {
  return {
    schema: 2,
    t,
    n: 1,
    counts: { gridW: 1 },
    sum: { gridW: (imp - exp) * 4 },
    min: { gridW: (imp - exp) * 4 },
    max: { gridW: (imp - exp) * 4 },
    gridWh: imp - exp,
    importWh: imp,
    exportWh: exp,
    coverageMs: SLOT_MS,
    directionalCoverageMs: SLOT_MS,
  };
}
test('signed trapezoids split within-interval zero crossings and quarter boundaries', () => {
  for (const [a, b, imp, exp] of [
    [3600, 3600, 30, 0],
    [-3600, -3600, 0, 30],
    [0, 0, 0, 0],
    [0, 3600, 15, 0],
    [0, -3600, 0, 15],
    [6000, -3000, 50 / 3, 25 / 6],
    [-6000, 3000, 25 / 6, 50 / 3],
  ]) {
    for (const offset of [0, SLOT_MS - 15000]) {
      const f = fixture(T + offset + 30000);
      f.store.append({ gridW: a }, T + offset);
      f.store.append({ gridW: b }, T + offset + 30000);
      f.store.flush();
      const rows = f.store.getSlots();
      near(
        rows.reduce((n, r) => n + r.importWh, 0),
        imp,
      );
      near(
        rows.reduce((n, r) => n + r.exportWh, 0),
        exp,
      );
      assert.equal(
        rows.reduce((n, r) => n + r.directionalCoverageMs, 0),
        30000,
      );
      for (const row of rows) {
        assert.ok(row.importWh >= 0 && row.exportWh >= 0);
        near(row.importWh - row.exportWh, row.gridWh);
        assert.equal(row.directionalCoverageMs, row.coverageMs);
      }
    }
  }
});
test('flush/retry and restart preserve recorded directions without inventing energy across gaps', () => {
  const f = fixture(T + 10000);
  f.store.append({ gridW: 3600 }, T);
  f.store.append({ gridW: 3600 }, T + 10000);
  f.fail(true);
  assert.throws(() => f.store.flush());
  assert.equal(f.map.has('historyState'), false);
  f.fail(false);
  f.store.flush();
  near(f.store.getSlots()[0].importWh, 10);
  f.clock(T + 20000);
  f.store.append({ gridW: 3600 }, T + 20000);
  f.store.flush();
  near(f.store.getSlots()[0].importWh, 20);
  const restarted = new HistoryStore(f.settings, () => T + 40000);
  restarted.append({ gridW: 3600 }, T + 30000);
  restarted.append({ gridW: 3600 }, T + 40000);
  restarted.flush();
  near(restarted.getSlots()[0].importWh, 30);
  assert.equal(restarted.getSlots()[0].directionalCoverageMs, 30000);
  restarted.append({ gridW: null }, T + 45000);
  restarted.append({ gridW: -3600 }, T + 50000);
  restarted.append({ gridW: -3600 }, T + 60000);
  f.clock(T + 60000);
  restarted.flush();
  near(restarted.getSlots()[0].exportWh, 10);
  assert.equal(restarted.getSlots()[0].coverageMs, 40000);
  restarted.append({ gridW: 3600 }, T + 130001);
  f.clock(T + 130001);
  restarted.flush();
  assert.equal(restarted.getSlots()[0].coverageMs, 40000);
});
test('net-only upgrade coverage cannot be borrowed to qualify new directional volumes', () => {
  const f = fixture(T + SLOT_MS);
  const old = full(T, 890, 0);
  delete old.importWh;
  delete old.exportWh;
  delete old.directionalCoverageMs;
  old.coverageMs = SLOT_MS - 10000;
  f.map.set('historyState', {
    schema: 3,
    timezone: 'Europe/Stockholm',
    slots: [old],
    daily: [],
    events: [],
    legacyDaily: [],
  });
  f.store.append({ gridW: 3600 }, T + SLOT_MS - 10000);
  f.store.append({ gridW: 3600 }, T + SLOT_MS);
  f.store.flush();
  const row = f.store.getSlots()[0];
  near(row.gridWh, 900);
  near(row.importWh, 10);
  assert.equal(row.coverageMs, SLOT_MS);
  assert.equal(row.directionalCoverageMs, 10000);
  const summary = energyHistory(f.store.getSlots(), T + SLOT_MS + 1);
  assert.equal(summary.completeQuarters, 0);
  assert.equal(summary.importKWh, null);
  const file = f.store.export();
  assert.equal(file.schema, 4);
  assert.equal(parseExport(file, T + SLOT_MS).slots[0].directionalCoverageMs, 10000);
  const settings = {
    energyTaxExVatSekPerKWh: 0,
    gridImportExVatSekPerKWh: 0,
    gridExportBenefitSekPerKWh: 0,
    gridExportFeeSekPerKWh: 0,
    vatRate: 0,
    batteryWearSekPerKWh: 0,
  };
  const partial = { ...full(T, 1, 1), directionalCoverageMs: 10000 };
  assert.equal(
    evaluateEnergySlots([partial], { [T]: { importSekPerKWh: 1, exportSekPerKWh: 1 } }, settings)
      .status,
    'insufficient-data',
  );
  delete partial.directionalCoverageMs;
  assert.equal(
    evaluateEnergySlots([partial], { [T]: { importSekPerKWh: 1, exportSekPerKWh: 1 } }, settings)
      .status,
    'provisional',
  ); // Explicit external API input remains supported.
});
test('version 4 export/restore preserves directional data; old valid files remain accepted and malformed fields fail', () => {
  const f = fixture(T + SLOT_MS);
  for (let dt = 0; dt <= SLOT_MS; dt += 60000) f.store.append({ gridW: 3600 }, T + dt);
  const file = f.store.export();
  assert.equal(file.schema, 4);
  near(file.slots[0].importWh, 900);
  const target = fixture(T + SLOT_MS);
  target.store.import(file);
  near(target.store.getSlots()[0].importWh, 900);
  assert.equal(target.store.export().daily[0].directionalCoverageMs, SLOT_MS);
  const legacy = structuredClone(file);
  legacy.schema = 3;
  for (const row of [...legacy.slots, ...legacy.daily])
    for (const key of ['importWh', 'exportWh', 'directionalCoverageMs']) delete row[key];
  assert.equal(parseExport(legacy, T + SLOT_MS).slots[0].importWh, undefined);
  for (const mutate of [
    (r) => {
      delete r.exportWh;
    },
    (r) => {
      r.importWh = -1;
    },
    (r) => {
      r.exportWh = NaN;
    },
    (r) => {
      r.directionalCoverageMs = SLOT_MS + 1;
    },
    (r) => {
      r.gridWh = 0;
    },
    (r) => {
      r.directionalCoverageMs = 0;
    },
  ]) {
    const bad = structuredClone(file);
    mutate(bad.slots[0]);
    assert.throws(() => parseExport(bad, T + SLOT_MS));
  }
  const oldVersion = structuredClone(file);
  oldVersion.schema = 3;
  assert.throws(() => parseExport(oldVersion, T + SLOT_MS), /schema 4/);
  const badDaily = structuredClone(file);
  badDaily.daily[0].exportWh = -1;
  assert.throws(() => parseExport(badDaily, T + SLOT_MS));
});
test('daily directional aggregates respect 23/25-hour days and cannot be truncated by retention', () => {
  for (const date of ['2026-03-29', '2026-10-25']) {
    const b = dayBounds(date);
    const rows = [];
    for (let t = b.start; t < b.end; t += SLOT_MS) rows.push(full(t, 100, 25));
    const day = dailyFromSlots(rows, [], b.end + 1)[0];
    assert.equal(day.directionalCoverageMs, b.durationMs);
    assert.equal(day.importWh, rows.length * 100);
    assert.equal(day.exportWh, rows.length * 25);
    assert.equal(day.status, 'complete');
    assert.deepEqual(dailyFromSlots(rows.slice(2), [day], b.end + 1)[0], day);
    const mixed = rows.map((r) => ({ ...r }));
    delete mixed[0].importWh;
    delete mixed[0].exportWh;
    delete mixed[0].directionalCoverageMs;
    const partial = dailyFromSlots(mixed, [], b.end + 1)[0];
    assert.equal(partial.coverageMs, b.durationMs);
    assert.equal(partial.directionalCoverageMs, b.durationMs - SLOT_MS);
  }
});
test('private economic history exposes only complete closed directional quarters and explicit gaps, not net-only estimates', () => {
  const partial = { ...full(T + 2 * SLOT_MS), directionalCoverageMs: 10000 };
  const records = [
    { ...full(T), host: 'private-host', token: 'private-token' },
    partial,
    full(T + 3 * SLOT_MS),
    full(T + 4 * SLOT_MS),
  ];
  const result = energyHistory(records, T + 4 * SLOT_MS + 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.expectedQuarters, 4);
  assert.equal(result.completeQuarters, 2);
  assert.equal(result.excludedQuarters, 1);
  assert.equal(result.missingQuarters, 1);
  assert.equal(result.openQuarterPresent, true);
  near(result.importKWh, 0.2);
  near(result.exportKWh, 0.1);
  assert.equal(result.slots.length, 2);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(result.financiallyComparable, false);
  const ready = energyHistory([full(T), full(T + SLOT_MS)], T + 2 * SLOT_MS);
  assert.equal(ready.status, 'ready');
  assert.equal(energyHistory([], T).status, 'collecting');
  assert.equal(energyHistory([], T).importKWh, null);
  for (const rows of [null, [full(T), full(T)], [{ t: 1 }], [full(T + SLOT_MS)]])
    assert.equal(energyHistory(rows, T).status, 'unavailable');
  assert.equal(energyHistory([full(T)], NaN).status, 'unavailable');
});
test('authenticated energy-history route only reads committed history and tolerates storage failure', async () => {
  assert.deepEqual(manifest.api.getEconomicHistory, {
    method: 'GET',
    path: '/economics/energy-history',
    public: false,
  });
  const t = Math.floor(Date.now() / SLOT_MS) * SLOT_MS - SLOT_MS;
  const homey = {
    app: { history: { getSlots: () => [full(t)] } },
    settings: { set: () => assert.fail('No writes') },
  };
  const result = await api.getEconomicHistory({ homey });
  assert.equal(result.status, 'ready');
  assert.equal(result.slots[0].t, t);
  homey.app.history.getSlots = () => {
    throw Error('private storage failure');
  };
  assert.equal(getEnergyHistory(homey).status, 'unavailable');
});
