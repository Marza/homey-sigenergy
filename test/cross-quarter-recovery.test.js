'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { HistoryStore } = require('../lib/history');
const {
  CounterGapRecovery,
  effectiveSlot,
  validateRecovery,
} = require('../lib/energy/gap-recovery');
const { applyRepairs } = require('../lib/energy/recovery-metadata');
const { parseExport, pruneSlots, SLOT_RETENTION } = require('../lib/history-format');
const { DataDiagnostics } = require('../lib/data-diagnostics');
const { energyHistory } = require('../lib/pricing/energy-history');
const T = 1800000000000,
  Q = 900000;
const binding = { key: 'SYNTHETIC_EPOCH:0', solarKey: 'SYNTHETIC_SOLAR:0' };
const power = { gridW: 3600, essW: 1800, pvW: 7200 };
const raw = (s) => ({
  durationMs: 50,
  values: {
    imported: String(1000 + s / 10),
    exported: '2000',
    charged: String(3000 + s / 20),
    discharged: '4000',
    solar: String(5000 + s / 5),
  },
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
function fixture() {
  let now = T,
    fail = false;
  const data = {},
    events = [];
  const settings = {
    get: (k) => structuredClone(data[k]),
    set: (k, v) => {
      if (fail) throw Error('synthetic storage failure');
      data[k] = structuredClone(v);
    },
  };
  return {
    history: new HistoryStore(settings, () => now, { record: (...e) => events.push(e) }),
    settings,
    data,
    events,
    at: (n) => (now = T + n * 1000),
    fail: (v) => (fail = v),
  };
}
function collect(
  f,
  {
    start = 0,
    end = 1800,
    old = 840,
    next = 960,
    gapStart = 870,
    gapEnd = 960,
    mutate = () => {},
  } = {},
) {
  for (let s = start; s <= end; s += 10) {
    if (s > gapStart && s < gapEnd) continue;
    f.at(s);
    f.history.append(power);
    if (s === old || s === next) {
      const counters = raw(s);
      mutate(counters, s);
      f.history.observeCounters(counters, binding);
    }
    if (s % 60 === 0) f.history.flush();
  }
  f.history.flush();
  return f;
}
test('a positive cross-quarter counter delta partitions only the missing share, with exact energy conservation', () => {
  const f = collect(fixture());
  const rows = f.history.getSlots().slice(0, 2),
    effective = f.history.getEnergySlots().slice(0, 2);
  for (const [i, s] of rows.entries()) {
    assert.equal(s.coverageMs, Q - [30000, 60000][i]);
    assert.equal(s.counterRecovery.grid.parts[0].allocation.method, 'missing-time-proportional');
    assert.deepEqual(s.counterRecovery.grid.parts[0].allocation.missingMs, [30000, 60000]);
    assert.equal(s.counterRecovery.grid.coverageMs, [30000, 60000][i]);
    assert.equal(effective[i].coverageMs, Q);
    assert.equal(effective[i].essCoverageMs, Q);
    assert.equal(effective[i].energyFieldCoverageMs.pvW, Q);
    near(effective[i].gridWh, 900);
    near(effective[i].importWh, 900);
    near(effective[i].essWh, 450);
    near(effective[i].pvWh, 1800);
    assert.deepEqual(effective[i].sum, s.sum);
    assert.deepEqual(effective[i].counts, s.counts);
    near(s.counterRecovery.grid.correctionWh.importWh, [30, 60][i]);
  }
  near(
    effective.reduce((n, r) => n + r.importWh, 0),
    1800,
  );
  assert.equal(f.events.filter((e) => e[1] === 'counter-gap-recovered').length, 6);
  assert.equal(f.history.pendingRepairs.length, 0);
  const stored = JSON.stringify(f.data);
  f.history.flush();
  assert.equal(JSON.stringify(f.data), stored);
});
test('proportional allocation is explicitly an estimate when power during the gap is unknown', () => {
  const r = new CounterGapRecovery();
  const at = T + 840000;
  r.accept(raw(840), binding, at);
  for (const key of ['gridW', 'essW', 'pvW'])
    r.observe(
      key,
      { ms: at, value: power[key] },
      { ms: T + 960000, value: power[key] },
      'sample-delay',
    );
  const patches = r.accept(raw(960), binding, T + 960000);
  assert.equal(patches.length, 6);
  const grid = patches.filter((p) => p.channel === 'grid');
  assert.deepEqual(
    grid.map((p) => p.coverageMs),
    [60000, 60000],
  );
  near(
    grid.reduce((n, p) => n + p.correctionWh.importWh, 0),
    120,
  );
  assert.equal(grid[0].allocation.correctionWh.importWh, 120);
});
test('a fully observed side receives no invented correction, while the missing side is still recoverable', () => {
  const f = fixture();
  f.at(840);
  f.history.append(power);
  f.history.observeCounters(raw(840), binding);
  for (let s = 850; s <= 900; s += 10) {
    f.at(s);
    f.history.append(power);
  }
  f.at(910);
  f.history.append({ gridW: null, essW: null, pvW: null });
  f.at(960);
  f.history.append(power);
  f.history.observeCounters(raw(960), binding);
  f.history.flush();
  const rows = f.history.getSlots();
  assert.equal(rows[0].counterRecovery, undefined);
  assert.deepEqual(rows[1].counterRecovery.grid.parts[0].allocation.missingMs, [0, 60000]);
  near(f.history.getEnergySlots()[1].importWh, 60);
});
test('failed writes retry both sides once, and a missing/overlapping/full target rejects the entire channel batch', () => {
  const f = collect(fixture(), { end: 960 });
  const file = f.history.export();
  const g = fixture();
  g.at(960);
  g.history.import(file);
  // Generate another independent pair and make its persistence fail.
  const retry = fixture();
  retry.at(840);
  retry.history.append(power);
  retry.history.observeCounters(raw(840), binding);
  retry.at(960);
  retry.history.append(power);
  retry.history.observeCounters(raw(960), binding);
  retry.fail(true);
  assert.throws(() => retry.history.flush());
  assert.equal(retry.events.filter((e) => e[1] === 'counter-gap-recovered').length, 0);
  assert.equal(retry.history.pendingRepairs.length, 6);
  retry.fail(false);
  retry.history.flush();
  assert.equal(retry.events.filter((e) => e[1] === 'counter-gap-recovered').length, 6);
  const before = JSON.stringify(retry.data);
  retry.history.flush();
  assert.equal(JSON.stringify(retry.data), before);
  const patches = retry.history.counterRecovery;
  assert.ok(patches);
  const make = () => {
    const r = new CounterGapRecovery();
    r.accept(raw(840), binding, T + 840000);
    r.observe(
      'gridW',
      { ms: T + 840000, value: 3600 },
      { ms: T + 960000, value: 3600 },
      'sample-delay',
    );
    return r.accept(raw(960), binding, T + 960000);
  };
  for (const mode of ['missing-row', 'full', 'overlap', 'missing-patch', 'duplicate']) {
    const source = retry.history.getSlots();
    for (const row of source) delete row.counterRecovery;
    const map = new Map(source.map((row) => [row.t, row]));
    let repairs = make();
    if (mode === 'missing-row') map.delete(T + Q);
    if (mode === 'full') map.get(T + Q).coverageMs = Q;
    if (mode === 'overlap') map.get(T + Q).counterRecovery = file.slots[1].counterRecovery;
    if (mode === 'missing-patch') repairs = repairs.slice(0, 1);
    if (mode === 'duplicate') repairs.push(repairs[0]);
    const saved = structuredClone([...map]);
    applyRepairs(map, repairs);
    assert.deepEqual([...map], saved, mode);
  }
});
test('backup preserves allocation evidence, rejects metadata tampering and supports old version 7', () => {
  const f = collect(fixture()),
    file = f.history.export();
  assert.equal(file.schema, 16);
  const g = fixture();
  g.at(1800);
  g.history.import(file);
  assert.deepEqual(g.history.getSlots(), f.history.getSlots());
  assert.deepEqual(g.history.getEnergySlots(), f.history.getEnergySlots());
  assert.throws(() => parseExport({ ...file, schema: 7 }, T + 1800000), /version 8/);
  for (const change of [
    (p) => (p.allocation.method = 'guessed'),
    (p) => (p.allocation.missingMs = [30000, 70000]),
    (p) => (p.allocation.from += 1),
    (p) => (p.allocation.to += Q),
    (p) => (p.correctionWh.importWh += 1),
    (p) => (p.allocation.correctionWh.importWh = -1),
    (p) => (p.maxCollectionSkewMs = 4000),
    (p) => (p.to += 1),
    (p) => (p.coverageMs -= 1),
  ]) {
    const bad = structuredClone(file);
    change(bad.slots[0].counterRecovery.grid.parts[0]);
    assert.throws(() => parseExport(bad, T + 1800000), /counter recovery/);
    assert.equal(effectiveSlot(bad.slots[0]), bad.slots[0]);
  }
  const old = structuredClone(file);
  old.schema = 7;
  for (const row of old.slots) delete row.fiveMinute;
  for (const r of old.slots) delete r.counterRecovery;
  assert.doesNotThrow(() => parseExport(old, T + 1800000));
  // A retained/imported single quarter keeps its own explicit share, never the whole counter delta.
  const single = { ...file, slots: [file.slots[1]], daily: [], events: [] };
  assert.doesNotThrow(() => parseExport(single, T + 1800000));
  near(effectiveSlot(single.slots[0]).importWh, 900);
  const retained = pruneSlots(file.slots, T + Q + SLOT_RETENTION * Q);
  assert.equal(retained.length, 2);
  near(effectiveSlot(retained[0]).importWh, 900);
});
test('no counter bridge across restarts, imports, source changes, off-grid, long gaps, resets or invalid collection', () => {
  for (const scenario of [
    'restart',
    'import',
    'connection',
    'solar-source',
    'off-grid',
    'long',
    'slow',
    'reset',
    'spike',
    'missing',
    'hidden-solar-reset',
  ]) {
    const f = fixture();
    f.at(840);
    f.history.append(power);
    f.history.observeCounters(raw(840), binding);
    f.history.flush();
    if (scenario === 'restart') f.history.counterRecovery.reset();
    if (scenario === 'import') f.history.import(f.history.export());
    if (['connection', 'off-grid'].includes(scenario)) {
      f.at(850);
      f.history.append(
        { gridW: null, essW: null, pvW: null },
        undefined,
        scenario === 'connection' ? 'connection-changed' : 'off-grid',
      );
    }
    const s = scenario === 'long' ? 1800 : 960;
    f.at(s);
    f.history.append(power);
    const c = raw(s),
      b = { ...binding };
    if (scenario === 'solar-source') b.solarKey = 'DIFFERENT_SYNTHETIC_SOURCE';
    if (scenario === 'slow') c.durationMs = 2001;
    if (scenario === 'reset') for (const k of Object.keys(c.values)) c.values[k] = '0';
    if (scenario === 'spike') for (const k of Object.keys(c.values)) c.values[k] = '999999999';
    if (scenario === 'missing') c.values = {};
    if (scenario === 'hidden-solar-reset') {
      b.solarMode = 'combined';
      c.solarComponents = ['1', '2'];
    }
    f.history.observeCounters(c, b);
    f.history.flush();
    for (const row of f.history.getSlots()) {
      if (['solar-source', 'hidden-solar-reset'].includes(scenario)) {
        assert.equal(row.counterRecovery?.solar, undefined);
        assert.ok(row.counterRecovery?.grid);
      } else assert.equal(row.counterRecovery, undefined, scenario);
    }
  }
});
test('boundary probes are deferred, but a reset/source change observed there must invalidate the held anchor', () => {
  for (const boundary of [900, 899.5]) {
    const r = new CounterGapRecovery();
    r.accept(raw(840), binding, T + 840000);
    r.observe(
      'gridW',
      { ms: T + 840000, value: 3600 },
      { ms: T + 960000, value: 3600 },
      'sample-delay',
    );
    assert.deepEqual(r.accept(raw(900), binding, T + boundary * 1000), []);
    const repairs = r.accept(raw(960), binding, T + 960000);
    assert.equal(repairs.length, 2);
  }
  for (const b of [{ ...binding, key: 'NEW_EPOCH' }, binding]) {
    const r = new CounterGapRecovery();
    r.accept(raw(840), binding, T + 840000);
    r.observe(
      'gridW',
      { ms: T + 840000, value: 3600 },
      { ms: T + 960000, value: 3600 },
      'sample-delay',
    );
    const c = raw(900);
    if (b === binding) c.values.imported = '0';
    r.accept(c, b, T + 900000);
    assert.deepEqual(r.accept(raw(960), b, T + 960000), []);
  }
});
test('negative quantization residuals are not spread into physically negative missing import/solar energy', () => {
  const r = new CounterGapRecovery();
  r.accept(raw(840), binding, T + 840000);
  r.observe(
    'gridW',
    { ms: T + 840000, value: 3600 },
    { ms: T + 850000, value: 3600 },
    'invalid-sample',
  );
  r.observe(
    'gridW',
    { ms: T + 850000, value: 3600 },
    { ms: T + 960000, value: 3600 },
    'sample-delay',
  );
  const c = raw(960);
  c.values.imported = raw(840).values.imported;
  assert.deepEqual(
    r.accept(c, binding, T + 960000).filter((p) => p.channel === 'grid'),
    [],
  );
});
test('allocation metadata can coexist with later ordinary repairs without duplicate energy or unlabelled quarter coverage', () => {
  const f = collect(fixture(), { end: 960 });
  f.at(1080);
  f.history.append(power);
  f.history.observeCounters(raw(1080), binding);
  f.history.flush();
  const row = f.history.getSlots()[1];
  assert.equal(row.counterRecovery.grid.parts.length, 2);
  validateRecovery(row);
  near(effectiveSlot(row).importWh, 180);
  const homey = { settings: f.settings, app: { history: f.history } };
  const report = new DataDiagnostics(f.settings, () => T + 1800000).report(
    homey,
    { hours: 1 },
    T + 1800000,
  );
  assert.equal(report.recovery.crossQuarterQuarters, 2);
  assert.equal(report.quality.channels.grid.counterEstimatedMs, 210000);
  const energy = energyHistory(f.history.getEnergySlots(), T + 1800000);
  assert.equal(energy.counterRecoveredQuarters, 1);
  const rawGrid = f.history.getSlots().reduce((n, r) => n + (r.gridWh || 0), 0);
  assert.ok(rawGrid < 1080);
});
test('a gap across midnight/DST uses elapsed UTC durations and never reconstructs power peaks or SOC', () => {
  for (const boundary of [
    Date.parse('2026-11-17T00:00Z'),
    Date.parse('2026-03-29T01:00Z'),
    Date.parse('2026-10-25T01:00Z'),
  ]) {
    const r = new CounterGapRecovery();
    r.accept(raw(840), binding, boundary - 60000);
    r.observe(
      'gridW',
      { ms: boundary - 60000, value: 3600 },
      { ms: boundary + 60000, value: 3600 },
      'sample-delay',
    );
    const patches = r.accept(raw(960), binding, boundary + 60000);
    assert.equal(patches.length, 2);
    assert.deepEqual(
      patches.map((p) => p.coverageMs),
      [60000, 60000],
    );
    near(
      patches.reduce((n, p) => n + p.correctionWh.gridWh, 0),
      120,
    );
    assert.ok(patches.every((p) => !('soc' in p) && !('max' in p)));
  }
});

test('bidirectional grid flow and net battery discharge retain their signs in both allocated shares', () => {
  const f = fixture();
  f.at(840);
  f.history.append({ gridW: -3600, essW: -1800, pvW: 7200 });
  f.history.observeCounters(raw(840), binding);
  f.at(960);
  f.history.append({ gridW: -3600, essW: -1800, pvW: 7200 });
  const c = raw(840);
  for (const [key, increment] of [
    ['imported', 8],
    ['exported', 12],
    ['charged', 4],
    ['discharged', 10],
    ['solar', 15],
  ])
    c.values[key] = String(Number(c.values[key]) + increment);
  f.history.observeCounters(c, binding);
  f.history.flush();
  for (const row of f.history.getEnergySlots()) {
    near(row.importWh, 40);
    near(row.exportWh, 60);
    near(row.gridWh, -20);
    near(row.essWh, -30);
    near(row.pvWh, 75);
  }
});
test('combined solar positive/zero recovery requires both components and cannot hide a reset at a boundary', () => {
  for (const mode of ['positive', 'zero', 'reset']) {
    const r = new CounterGapRecovery(),
      b = { ...binding, solarMode: 'combined' };
    r.accept(
      { durationMs: 50, values: { solar: '3000' }, solarComponents: ['1000', '2000'] },
      b,
      T + 840000,
    );
    r.observe('pvW', { ms: T + 840000, value: 0 }, { ms: T + 960000, value: 0 }, 'sample-delay');
    const components =
      mode === 'positive' ? ['1006', '2010'] : mode === 'zero' ? ['1000', '2000'] : ['999', '2017'];
    const repairs = r.accept(
      {
        durationMs: 50,
        values: { solar: String(components.reduce((n, v) => n + Number(v), 0)) },
        solarComponents: components,
      },
      b,
      T + 960000,
    );
    if (mode === 'reset') assert.deepEqual(repairs, []);
    else {
      assert.equal(repairs.length, 2);
      near(
        repairs.reduce((n, p) => n + p.correctionWh.pvWh, 0),
        mode === 'zero' ? 0 : 160,
      );
    }
  }
});
test('overlapping ledger segments cannot mask an equally long unobserved ledger hole', () => {
  const r = new CounterGapRecovery();
  r.accept(raw(840), binding, T + 840000);
  for (const [from, to] of [
    [840, 870],
    [860, 880],
    [890, 960],
  ])
    r.observe(
      'gridW',
      { ms: T + from * 1000, value: 3600 },
      { ms: T + to * 1000, value: 3600 },
      'sample-delay',
    );
  assert.deepEqual(r.accept(raw(960), binding, T + 960000), []);
});

test('an existing ordinary correction is preserved when a later boundary allocation adds partition evidence', () => {
  const f = fixture();
  for (let s = 0; s <= 1800; s += 10) {
    if ((s > 60 && s < 180) || (s > 870 && s < 960)) continue;
    f.at(s);
    f.history.append(power);
    if ([0, 60, 180, 840, 960].includes(s)) f.history.observeCounters(raw(s), binding);
    if (s % 60 === 0) f.history.flush();
  }
  f.history.flush();
  const first = f.history.getSlots()[0];
  assert.equal(first.counterRecovery.grid.parts.length, 2);
  assert.equal(first.counterRecovery.grid.parts[0].allocation, undefined);
  assert.equal(first.counterRecovery.grid.coverageMs, 150000);
  validateRecovery(first);
  for (const r of f.history.getEnergySlots().slice(0, 2)) near(r.importWh, 900);
});

test('partition evidence cannot bypass export versioning and malformed pending batches cannot block raw history', () => {
  const f = collect(fixture()),
    file = f.history.export(),
    bad = structuredClone(file);
  bad.schema = 7;
  bad.slots[0].counterRecovery.grid = bad.slots[0].counterRecovery.grid.parts[0];
  for (const row of bad.slots.slice(1)) delete row.counterRecovery;
  for (const k of ['battery', 'solar']) delete bad.slots[0].counterRecovery[k];
  assert.throws(() => parseExport(bad, T + 1800000), /counter recovery/);
  assert.equal(effectiveSlot(bad.slots[0]), bad.slots[0]);
  const map = new Map(f.history.getSlots().map((row) => [row.t, row]));
  const before = structuredClone([...map]);
  for (const allocation of [
    {},
    { from: T, to: T + 1, missingMs: 'invalid' },
    { from: T, to: T + 1, missingMs: [0, -1] },
  ])
    assert.doesNotThrow(() => applyRepairs(map, [{ t: T, channel: 'grid', allocation }]));
  assert.deepEqual([...map], before);
});

test('complete cross-quarter estimates retain provenance in readiness and hourly aggregation without enabling control', () => {
  const { fixture: ready } = require('./fixtures/readiness.cjs');
  const { hourlyEnergy } = require('../lib/pricing/hourly-energy');
  const f = collect(fixture()),
    context = ready({ hours: 4, now: T + 4 * 3600000 });
  const rawRows = f.history.getSlots().slice(0, 2);
  context.rows.splice(0, 2, ...rawRows);
  context.homey.app.history.getEnergySlots = () => context.rows.map(effectiveSlot);
  const energy = energyHistory(context.rows.map(effectiveSlot), context.now);
  const hourly = hourlyEnergy(energy, null, false, context.now);
  assert.equal(hourly.counterRecoveredHours, 1);
  assert.equal(hourly.hours[0].source, 'sigenergy-counter-gap-estimate');
  near(hourly.hours[0].importWh, 2300);
});
