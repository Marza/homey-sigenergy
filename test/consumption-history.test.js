'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  { createRequire } = require('node:module');
const {
  normalizeConsumption,
  mergeHistory,
  validateState,
} = require('../lib/pricing/consumption-history');
const { calculateDemandCharge } = require('../lib/demand-tariff');
const { getOverview } = require('../widgets/energy-overview/api');
const from = Date.parse('2026-11-01T00:00:00+01:00'),
  to = from + 13 * 86400000;
const metadata = { from, to, fetchedAt: new Date(to).toISOString(), configRevision: 'revision' };
const row = (t, kWh = 1) => ({
  from: new Date(t).toISOString(),
  to: new Date(t + 3600000).toISOString(),
  consumption: kWh,
  consumptionUnit: 'kWh',
});
const tariff = {
  start: '07:00',
  end: '20:00',
  weekdays: [1, 2, 3, 4, 5],
  months: [11],
  calendar: 'se-telge',
  peakCount: 5,
  distinctDays: true,
  rateSekPerKw: 100,
};
test('hourly consumption stays hourly, zero is valid and null is missing', () => {
  const r = normalizeConsumption(
    [row(from, 0), row(from + 3600000, null), row(from + 7200000, 2), row(from + 7200000, 2)],
    metadata,
  );
  assert.equal(r.state.hours.length, 2);
  assert.equal(r.state.hours[0].importWh, 0);
  assert.equal(r.state.hours[1].importWh, 2000);
  assert.equal(r.unavailableRows, 1);
  assert.equal(r.duplicateRows, 1);
  assert.equal(r.missingHours, 310);
  assert.ok(!JSON.stringify(r.state).includes('essWh'));
  assert.ok(!JSON.stringify(r.state).includes('coverageMs'));
});
test('bad intervals, units, duplicate conflicts and invalid stored state are rejected', () => {
  for (const rows of [
    [row(from, -1)],
    [{ ...row(from), consumptionUnit: 'Wh' }],
    [{ ...row(from), to: new Date(from + 900000).toISOString() }],
    [row(from, 1), row(from, 2)],
    [null],
    Array(769).fill(row(from)),
  ])
    assert.throws(() => normalizeConsumption(rows, metadata));
  const state = normalizeConsumption([row(from)], metadata).state;
  for (const patch of [
    { schema: 2 },
    { fetchedAt: 'bad' },
    { configRevision: '' },
    { to: from },
    { hours: [state.hours[0], state.hours[0]] },
    { hours: [{ t: from, importWh: Infinity }] },
  ])
    assert.throws(() => validateState({ ...state, ...patch }));
  assert.throws(() => normalizeConsumption('invalid', metadata));
  assert.throws(() => normalizeConsumption([row(to)], metadata));
});
test('merges are idempotent and never silently overwrite or cross source revisions', () => {
  const a = normalizeConsumption([row(from)], metadata).state,
    b = normalizeConsumption([row(from + 3600000)], metadata).state;
  assert.deepEqual(mergeHistory(null, a), a);
  const merged = mergeHistory(a, b);
  assert.equal(merged.hours.length, 2);
  assert.deepEqual(mergeHistory(merged, a), merged);
  assert.throws(() => mergeHistory(a, { ...b, configRevision: 'different' }));
  assert.throws(() => mergeHistory(a, normalizeConsumption([row(from, 2)], metadata).state));
});
test('meter demand ranks real hourly import on distinct days without quarter-hour fabrication', () => {
  const rows = [2, 3, 4, 5, 6].map((day, i) =>
    row(Date.parse(`2026-11-${String(day).padStart(2, '0')}T09:00Z`), 6 + i),
  );
  rows.push(row(Date.parse('2026-11-02T10:00Z'), 20));
  const state = normalizeConsumption(rows, metadata).state;
  const r = calculateDemandCharge([], tariff, '2026-11', { nowMs: to, meterHours: state.hours });
  assert.equal(r.averageKw, 10.8);
  assert.equal(r.estimatedSek, 1080);
  assert.equal(r.measurementBasis, 'tibber-meter-import');
  assert.equal(r.eligibleHours, 6);
  assert.equal(r.coverage.completeHours, 6);
  assert.ok(r.coverage.missingHours > 0);
  assert.deepEqual(
    r.selectedPeaks.map((p) => p.kw),
    [20, 10, 9, 8, 7],
  );
  assert.throws(() =>
    calculateDemandCharge([{ t: from }], tariff, '2026-11', { meterHours: state.hours }),
  );
  assert.throws(() =>
    calculateDemandCharge([], tariff, '2026-11', { meterHours: [...state.hours, state.hours[0]] }),
  );
});
test('runtime binding prevents stale/wrong-home reference while preserving inverter history', () => {
  const file = path.join(__dirname, '../app.js'),
    requireApp = createRequire(file),
    module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    require: (id) => (id === 'homey' ? { App: class {} } : requireApp(id)),
  });
  const state = normalizeConsumption([row(from)], {
      ...metadata,
      to: Math.floor(Date.now() / 3600000) * 3600000,
      fetchedAt: new Date().toISOString(),
    }).state,
    values = {
      sourceConfig: { tibber: { revision: 'revision' } },
      demandTariff: tariff,
      tibberConsumptionHistory: state,
    };
  const app = new module.exports();
  app.homey = { settings: { get: (key) => values[key] } };
  assert.equal(app.getMeterDemandCharge('2026-11').measurementBasis, 'tibber-meter-import');
  values.sourceConfig.tibber.revision = 'changed';
  assert.equal(app.getMeterDemandCharge('2026-11').status, 'configuration-changed');
  values.sourceConfig.tibber.revision = 'revision';
  values.tibberConsumptionHistory = { ...state, schema: 9 };
  assert.equal(app.getMeterDemandCharge('2026-11').status, 'invalid-meter-history');
  delete values.tibberConsumptionHistory;
  assert.equal(app.getMeterDemandCharge('2026-11').status, 'no-meter-history');
  delete values.demandTariff;
  assert.equal(app.getMeterDemandCharge('2026-11').status, 'not-configured');
});
test('widget exposes only matching reference summaries, never the imported household time series', () => {
  const state = normalizeConsumption([row(from)], {
      ...metadata,
      to: Math.floor(Date.now() / 3600000) * 3600000,
      fetchedAt: new Date().toISOString(),
    }).state,
    values = {
      sourceConfig: { tibber: { revision: 'revision' } },
      tibberConsumptionHistory: state,
      tibberConsumptionSync: {
        configRevision: 'revision',
        status: 'error',
        token: 'private-sync-token',
        lastSuccessAt: '2026-11-12T10:00Z',
      },
      meterDemandEstimate: {
        month: '2026-11',
        status: 'provisional',
        averageKw: 3,
        estimatedSek: 300,
        secret: 'private',
        coverage: { missingHours: 1 },
      },
    };
  const homey = { settings: { get: (key) => values[key] } };
  assert.equal(getOverview({ homey }).values.meterDemandEstimate.averageKw, 3);
  assert.ok(!JSON.stringify(getOverview({ homey })).includes('private'));
  assert.ok(!JSON.stringify(getOverview({ homey })).includes('importWh'));
  assert.equal(getOverview({ homey }).values.meterDemandEstimate.sync.status, 'error');
  assert.ok(!JSON.stringify(getOverview({ homey })).includes('private-sync-token'));
  delete values.tibberConsumptionHistory;
  assert.equal(getOverview({ homey }).values.meterDemandEstimate.sync.status, 'error');
  values.sourceConfig.tibber.revision = 'other';
  assert.equal(getOverview({ homey }).values.meterDemandEstimate, null);
});

test('repeated autumn clock hours remain distinct and unknown metadata is rejected', () => {
  const rows = [
    {
      from: '2026-10-25T02:00:00+02:00',
      to: '2026-10-25T02:00:00+01:00',
      consumption: 1,
      consumptionUnit: 'kWh',
    },
    {
      from: '2026-10-25T02:00:00+01:00',
      to: '2026-10-25T03:00:00+01:00',
      consumption: 2,
      consumptionUnit: 'kWh',
    },
  ];
  const m = {
    from: Date.parse(rows[0].from),
    to: Date.parse(rows[1].to),
    fetchedAt: '2026-10-26T00:00Z',
    configRevision: 'r',
  };
  assert.equal(normalizeConsumption(rows, m).state.hours.length, 2);
  assert.throws(() => normalizeConsumption(rows, { ...m, token: 'not-allowed' }));
});
