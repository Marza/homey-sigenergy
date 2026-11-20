'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { HistoryStore } = require('../lib/history');
const {
  CounterGapRecovery,
  effectiveSlot,
  validateRecovery,
} = require('../lib/energy/gap-recovery');
const { parseExport } = require('../lib/history-format');
const T = 1800000000000,
  Q = 900000;
const binding = { key: 'SYNTHETIC_CONNECTION:0', solarKey: 'SYNTHETIC_SOLAR:0' };
const power = { gridW: 3600, essW: 1800, pvW: 7200 };
const counters = (seconds) => ({
  durationMs: 50,
  values: {
    imported: String(1000 + seconds / 10),
    exported: '2000',
    charged: String(3000 + seconds / 20),
    discharged: '4000',
    solar: String(5000 + seconds / 5),
  },
});
function fixture() {
  let now = T,
    fail = false;
  const data = {},
    events = [],
    writes = [];
  const settings = {
    get: (k) => structuredClone(data[k]),
    set: (k, v) => {
      if (fail) throw Error('synthetic failure');
      data[k] = structuredClone(v);
      writes.push(k);
    },
  };
  const history = new HistoryStore(settings, () => now, { record: (...e) => events.push(e) });
  return { history, data, events, writes, settings, at: (n) => (now = n), fail: (v) => (fail = v) };
}
function sample(f, seconds, value = power) {
  f.at(T + seconds * 1000);
  f.history.append(value);
}
function observe(f, seconds, change = {}) {
  sample(f, seconds);
  f.history.observeCounters({ ...counters(seconds), ...change }, binding);
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
test('short same-quarter counter intervals repair independent energy channels and preserve actual observations', () => {
  const f = fixture();
  for (let s = 0; s <= 900; s += 10) {
    if (s > 60 && s < 180) continue;
    sample(f, s);
    if ([0, 60, 180].includes(s)) f.history.observeCounters(counters(s), binding);
    if (s % 60 === 0) f.history.flush();
  }
  const raw = f.history.getSlots()[0],
    effective = f.history.getEnergySlots()[0];
  assert.equal(raw.coverageMs, Q - 120000);
  assert.equal(raw.essCoverageMs, Q - 120000);
  assert.equal(effective.coverageMs, Q);
  assert.equal(effective.directionalCoverageMs, Q);
  assert.equal(effective.essCoverageMs, Q);
  assert.equal(effective.fieldCoverageMs.pvW, Q - 120000);
  assert.equal(effective.energyFieldCoverageMs.pvW, Q);
  near(effective.gridWh, 900);
  near(effective.importWh, 900);
  near(effective.exportWh, 0);
  near(effective.essWh, 450);
  near(effective.pvWh, 1800);
  assert.deepEqual(effective.counts, raw.counts);
  assert.deepEqual(effective.sum, raw.sum);
  assert.deepEqual(effective.counterRecoveredChannels, ['grid', 'battery', 'solar']);
  assert.equal(f.events.filter((e) => e[1] === 'counter-gap-recovered').length, 3);
  const before = JSON.stringify(f.data.historyState);
  f.history.flush();
  assert.equal(JSON.stringify(f.data.historyState), before);
});
test('counter corrections replace the already integrated share rather than adding the whole counter delta twice', () => {
  const f = fixture();
  observe(f, 0);
  observe(f, 60);
  sample(f, 70);
  sample(f, 140);
  for (let s = 150; s <= 180; s += 10) sample(f, s);
  f.history.observeCounters(counters(180), binding);
  f.history.flush();
  const raw = f.history.getSlots()[0],
    r = f.history.getEnergySlots()[0];
  assert.equal(raw.coverageMs, 110000);
  assert.equal(r.coverageMs, 180000);
  near(raw.importWh, 110);
  near(raw.counterRecovery.grid.correctionWh.importWh, 70);
  near(r.importWh, 180);
});
test('write failures preserve both measurements and recovery for retry; version 8 backup restores provenance', () => {
  const f = fixture();
  observe(f, 0);
  sample(f, 120);
  f.history.observeCounters(counters(120), binding);
  f.fail(true);
  assert.throws(() => f.history.flush());
  assert.equal(f.events.filter((e) => e[1] === 'counter-gap-recovered').length, 0);
  f.fail(false);
  f.history.flush();
  const file = f.history.export();
  assert.equal(file.schema, 8);
  const g = fixture();
  g.at(T + 120000);
  g.history.import(file);
  near(g.history.getEnergySlots()[0].importWh, 120);
  assert.deepEqual(
    g.history.getSlots()[0].counterRecovery,
    f.history.getSlots()[0].counterRecovery,
  );
  g.history.flush();
  near(g.history.getEnergySlots()[0].importWh, 120);
  assert.throws(() => parseExport({ ...file, schema: 6 }, T + 120000), /version 7/);
  const bad = structuredClone(file);
  bad.slots[0].counterRecovery.grid.correctionWh.extra = 123;
  assert.throws(() => parseExport(bad, T + 120000), /counter recovery/);
});
test('no bridge across restart, source changes, imports, off-grid intervals or long gaps', () => {
  for (const scenario of [
    'restart',
    'connection',
    'solar-source',
    'off-grid',
    'long',
    'slow',
    'reset',
    'spike',
    'missing',
  ]) {
    const f = fixture();
    observe(f, 0);
    f.history.flush();
    let time = 120;
    if (scenario === 'restart') f.history.counterRecovery.reset();
    if (scenario === 'connection')
      f.history.append({ gridW: null, essW: null, pvW: null }, T + 1000, 'connection-changed');
    if (scenario === 'off-grid')
      f.history.append({ gridW: null, essW: null, pvW: null }, T + 1000, 'off-grid');
    if (scenario === 'long') time = 360;
    sample(f, time);
    const raw = counters(time),
      b = { ...binding };
    if (scenario === 'slow') raw.durationMs = 2001;
    if (scenario === 'reset') Object.keys(raw.values).forEach((k) => (raw.values[k] = '0'));
    if (scenario === 'spike') Object.keys(raw.values).forEach((k) => (raw.values[k] = '999999999'));
    if (scenario === 'missing') raw.values = {};
    if (scenario === 'solar-source') b.solarKey = 'OTHER_SOURCE';
    f.history.observeCounters(raw, b);
    f.history.flush();
    const row = f.history.getSlots()[0];
    if (scenario === 'solar-source') {
      assert.equal(row.counterRecovery.solar, undefined);
      assert.ok(row.counterRecovery.grid);
    } else assert.equal(row.counterRecovery, undefined, scenario);
  }
});
test('counter quantization never supplies power samples or SOC and invalid metadata is ignored or rejected', () => {
  const f = fixture();
  observe(f, 0);
  sample(f, 120);
  f.history.observeCounters(counters(120), binding);
  f.history.flush();
  const raw = f.history.getSlots()[0];
  assert.equal(raw.counts.soc, undefined);
  assert.equal(raw.max.gridW, 3600);
  for (const change of [
    { coverageMs: Q + 1 },
    { maxCollectionSkewMs: 9999 },
    { to: T + Q + 1 },
    { correctionWh: { importWh: 10, exportWh: 0, gridWh: 999 } },
  ]) {
    const row = structuredClone(raw);
    Object.assign(row.counterRecovery.grid, change);
    assert.throws(() => validateRecovery(row));
    assert.equal(effectiveSlot(row), row);
  }
});
test('negative/positive power crossings and independent partial counter channels are handled without repeated repair', () => {
  const r = new CounterGapRecovery();
  r.observe('gridW', { ms: T, value: 3600 }, { ms: T + 10000, value: -3600 }, 'invalid-sample');
  r.observe(
    'gridW',
    { ms: T + 10000, value: -3600 },
    { ms: T + 90000, value: -3600 },
    'invalid-sample',
  );
  r.accept({ durationMs: 0, values: { imported: '1000', exported: '2000' } }, binding, T);
  const patches = r.accept(
    { durationMs: 0, values: { imported: '1002', exported: '2004' } },
    binding,
    T + 90000,
  );
  assert.equal(patches.length, 1);
  assert.equal(patches[0].coverageMs, 80000);
  near(patches[0].correctionWh.importWh, 17.5);
  near(patches[0].correctionWh.exportWh, 37.5);
  assert.deepEqual(
    r.accept({ durationMs: 0, values: { imported: '1002', exported: '2004' } }, binding, T + 90000),
    [],
  );
  assert.deepEqual(
    r.accept({ durationMs: 0, values: { imported: '1002', exported: '2004' } }, binding, T + 80000),
    [],
  );
  assert.deepEqual(r.accept({ values: {} }, binding, T + 100000), []);
});

test('a nominal endpoint at a quarter boundary cannot attribute next-quarter counter collection to the previous quarter', () => {
  const r = new CounterGapRecovery();
  r.accept(counters(780), binding, T + 780000);
  r.observe(
    'gridW',
    { ms: T + 780000, value: 3600 },
    { ms: T + 900000, value: 3600 },
    'invalid-sample',
  );
  r.observe(
    'essW',
    { ms: T + 780000, value: 1800 },
    { ms: T + 900000, value: 1800 },
    'invalid-sample',
  );
  r.observe(
    'pvW',
    { ms: T + 780000, value: 7200 },
    { ms: T + 900000, value: 7200 },
    'invalid-sample',
  );
  assert.deepEqual(r.accept(counters(900), binding, T + 900000), []);
});

test('combined solar requires both component counters and rejects a hidden reset despite a rising sum', () => {
  const r = new CounterGapRecovery(),
    b = { ...binding, solarMode: 'combined' };
  r.accept({ durationMs: 0, values: { solar: '3000' }, solarComponents: ['1000', '2000'] }, b, T);
  r.observe('pvW', { ms: T, value: 7200 }, { ms: T + 120000, value: 7200 }, 'invalid-sample');
  assert.deepEqual(
    r.accept(
      { durationMs: 0, values: { solar: '3100' }, solarComponents: ['1101', '1999'] },
      b,
      T + 120000,
    ),
    [],
  );
  assert.deepEqual(r.accept({ durationMs: 0, values: { solar: '3200' } }, b, T + 240000), []);
  r.accept(
    { durationMs: 0, values: { solar: '3300' }, solarComponents: ['1150', '2150'] },
    b,
    T + 300000,
  );
  r.observe(
    'pvW',
    { ms: T + 300000, value: 7200 },
    { ms: T + 420000, value: 7200 },
    'invalid-sample',
  );
  const recovered = r.accept(
    { durationMs: 0, values: { solar: '3350' }, solarComponents: ['1175', '2175'] },
    b,
    T + 420000,
  );
  assert.equal(recovered.length, 1);
  near(recovered[0].correctionWh.pvWh, 500);
});

test('a diagnostic callback failure after a committed recovery cannot retain pending energy for double-counting', () => {
  const f = fixture();
  observe(f, 0);
  sample(f, 120);
  f.history.observeCounters(counters(120), binding);
  f.history.diagnostics = {
    record: () => {
      throw Error('synthetic logger failure');
    },
  };
  assert.doesNotThrow(() => f.history.flush());
  assert.equal(f.history.pending.size, 0);
  assert.equal(f.history.pendingRepairs.length, 0);
  const first = JSON.stringify(f.data.historyState);
  f.history.flush();
  assert.equal(JSON.stringify(f.data.historyState), first);
  near(f.history.getEnergySlots()[0].importWh, 120);
});
