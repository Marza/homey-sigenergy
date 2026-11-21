'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryStore } = require('../lib/history');
const { METERS } = require('../lib/energy/meter-flow');
const { qualityReport } = require('../lib/data-quality');
const { getPowerHistory } = require('../lib/energy/dashboard-history');
const { parseExport } = require('../lib/history-format');

const Q = 900000;
const T = Date.parse('2026-11-21T08:00:00Z');
const binding = { key: 'plant:0', solarKey: 'plant:solar:0' };
const channels = ['grid', 'solar', 'battery', 'ev', 'evac', 'household'];
const powers = { gridW: 3600, pvW: 3600, essW: 3600, evW: 3600, evacW: 3600 };
function scenario({
  start = 120000,
  elapsed = Q,
  beforeMs = 10000,
  interrupted = true,
  imported = false,
  reset = false,
  idle = false,
  maxGapMs,
} = {}) {
  let time = T + start;
  const values = new Map();
  const settings = {
    get: (k) => structuredClone(values.get(k)),
    set: (k, v) => values.set(k, structuredClone(v)),
  };
  const create = () => new HistoryStore(settings, () => time);
  let store = create();
  const sample = (offset, counts) => {
    time = T + start + offset;
    store.append(powers, time, undefined, maxGapMs);
    const v = String(counts);
    const read = (values, b, channel) =>
      store.observeCounters({ durationMs: 20, values }, b, channel);
    read({ imported: v, exported: '40', charged: v, discharged: '40', solar: v }, binding);
    read({ dcIn: v, dcOut: '40' }, { key: 'dc' }, 'ev');
    read({ ac: v }, { key: 'ac' }, 'evac');
    const meters = Object.fromEntries(
      METERS.map((k) => [
        k,
        ['gridIn', 'ac', 'house', 'batteryIn', 'dcIn', 'selfSolar'].includes(k) ? counts : 40,
      ]),
    );
    store.observeFlowMeters(meters, time, binding.key, maxGapMs);
    store.observeHouseholdCounter(v, time, undefined, maxGapMs);
  };
  store.setHouseholdSource(binding.key);
  sample(0, 100);
  if (beforeMs) {
    time += beforeMs;
    store.append(powers, time, undefined, maxGapMs);
  }
  store.flush();
  if (interrupted) {
    store = create();
    if (imported) store.import(store.export());
    time += 1000;
    store.append(
      Object.fromEntries(Object.keys(powers).map((k) => [k, null])),
      time,
      'reader-started',
    );
    store.setHouseholdSource(binding.key);
  }
  sample(elapsed, reset ? 0 : idle ? 100 : 100 + Math.round(elapsed / 10000));
  store.flush();
  const file = store.export();
  return { store, file, settings, time, rows: store.getSlots() };
}
test('local restart persists six independent meters and deducts already committed samples across quarter boundaries', () => {
  const { store, file, rows, settings, time } = scenario();
  assert.equal(file.schema, 16);
  assert.ok(!JSON.stringify(file).includes('Checkpoint'));
  const sum = (field) => store.getEnergySlots().reduce((n, r) => n + (r[field] || 0), 0);
  for (const field of ['gridWh', 'essWh', 'pvWh', 'evWh', 'evacWh', 'householdWh'])
    assert.equal(sum(field), 900, field);
  for (const k of channels.slice(0, 5)) {
    assert.equal(
      rows.reduce((n, r) => n + r.counterRecovery[k].coverageMs, 0),
      890000,
      k,
    );
  }
  assert.equal(sum('householdRecoveredMs'), Q);
  assert.equal(
    rows.reduce((n, r) => n + r.meterFlow.recoveredMs, 0),
    Q,
  );
  assert.ok(rows.every((r) => r.meterFlow.links.every((v) => v === 0)));
  const quality = qualityReport(rows, T, T + 2 * Q, null);
  for (const ch of channels) assert.equal(quality.channels[ch].unknownMs, Q, ch);
  const chart = getPowerHistory(
    { settings, app: { history: store } },
    { date: 'today' },
    T + 2 * Q,
  );
  const middle = chart.points.find((p) => p.t === T + 300000);
  assert.ok(middle.estimated);
  assert.deepEqual(middle.kw, {
    grid: 3.6,
    solar: 3.6,
    battery: -3.6,
    dc: -3.6,
    ac: -3.6,
    house: -3.6,
  });
  const bad = structuredClone(file);
  bad.slots[0].counterRecovery.ev.parts[0].bins[1]++;
  assert.throws(() => parseExport(bad, time), /Invalid counter recovery/);
  assert.throws(() => parseExport({ ...file, schema: 15 }, time), /version 16/);
  const restarted = new HistoryStore(settings, () => time);
  restarted.flush();
  assert.deepEqual(restarted.getEnergySlots(), store.getEnergySlots());
});
test('accept exactly fifteen minutes on quarter boundaries; a longer interval, reset or import cannot repair energy', () => {
  const { store } = scenario({ start: 0, beforeMs: 0 });
  const r = store.getEnergySlots()[0];
  for (const field of ['gridWh', 'pvWh', 'essWh', 'evWh', 'evacWh', 'householdWh'])
    assert.equal(r[field], 900, field);
  for (const options of [{ elapsed: Q + 1 }, { reset: true }, { imported: true }]) {
    const { rows } = scenario(options);
    assert.ok(
      rows.every((r) => !r.counterRecovery && !r.householdRecoveredMs && !r.meterFlow?.recoveredMs),
    );
  }
});

test('idle meter deltas across a restart repair coverage with zero energy', () => {
  const { store } = scenario({ start: 0, beforeMs: 0, idle: true });
  const row = store.getEnergySlots()[0];
  for (const k of ['gridWh', 'pvWh', 'essWh', 'evWh', 'evacWh', 'householdWh'])
    assert.equal(row[k], 0);
  assert.deepEqual([...row.counterRecoveredChannels].sort(), [
    'battery',
    'ev',
    'evac',
    'grid',
    'solar',
  ]);
  assert.equal(row.householdRecoveredMs, Q);
});

test('a silent polling delay spanning 10 and 50 seconds assigns the measured delta by missing duration', () => {
  const { rows, store } = scenario({
    start: Q - 10000,
    elapsed: 60000,
    beforeMs: 0,
    interrupted: false,
    maxGapMs: 15000,
  });
  const effective = store.getEnergySlots();
  for (const [index, ms] of [10000, 50000].entries()) {
    const row = rows[index];
    for (const channel of channels.slice(0, 5)) {
      assert.equal(row.counterRecovery[channel].coverageMs, ms);
      assert.deepEqual(row.counterRecovery[channel].parts[0].allocation.missingMs, [10000, 50000]);
    }
    assert.equal(row.coverageMs, 0);
    for (const key of ['gridWh', 'essWh', 'pvWh', 'evWh', 'evacWh', 'householdWh'])
      assert.equal(effective[index][key], ms / 1000, key);
    assert.equal(row.householdRecoveredMs, ms);
    assert.equal(row.meterFlow.recoveredMs, ms);
    assert.ok(row.meterFlow.links.every((wh) => wh === 0));
  }
});
test('normal jitter up to 15 seconds at a ten-second poll retains sampled power coverage', () => {
  const { rows } = scenario({
    start: 0,
    elapsed: 15000,
    beforeMs: 0,
    interrupted: false,
    maxGapMs: 15000,
  });
  assert.equal(rows[0].coverageMs, 15000);
  assert.equal(rows[0].counterRecovery, undefined);
  assert.equal(rows[0].householdRecoveredMs, undefined);
  assert.equal(rows[0].meterFlow.recoveredMs, undefined);
});
