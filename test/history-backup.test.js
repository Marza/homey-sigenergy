'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { HistoryStore } = require('../lib/history');
const { exportBackup, previewBackup, restoreBackup } = require('../lib/history-backup');
const { bounds, replaceMonth } = require('../lib/pricing/consumption-archive');
const now = Date.parse('2026-11-13T12:00Z');
function fixture() {
  const map = new Map([
    ['sourceConfig', { tibber: { revision: 'r' } }],
    ['tibberToken', 'private-token'],
  ]);
  let fail = null;
  const settings = {
    get: (k) => map.get(k),
    set: (k, v) => {
      if (k === fail) throw Error('storage failed');
      map.set(k, structuredClone(v));
    },
  };
  const history = new HistoryStore(settings, () => now);
  history.append({ gridW: 3600 }, now - 10000);
  history.append({ gridW: 3600 }, now);
  const homey = { settings, app: { history } };
  const b = bounds('2026-10');
  const state = {
    schema: 1,
    source: 'tibber-consumption',
    resolution: 'HOURLY',
    configRevision: 'r',
    fetchedAt: new Date(now).toISOString(),
    ...b,
    hours: [{ t: b.from, importWh: 10 }],
  };
  settings.set('tibberConsumptionArchive', replaceMonth(null, state, new Date(now)));
  return {
    homey,
    map,
    fail: (k) => {
      fail = k;
    },
  };
}
test('combined backup round trip includes archive, no token/config/sync, supports legacy files and is idempotent', () => {
  const f = fixture(),
    file = exportBackup(f.homey);
  assert.equal(file.meter.months[0].month, '2026-10');
  assert.equal(file.history.schema, 5);
  assert.ok(!JSON.stringify(file).includes('private-token'));
  const before = JSON.stringify([...f.map]);
  const preview = previewBackup(f.homey, file);
  assert.equal(preview.meterHours, 1);
  assert.equal(preview.meterConflicts, 1);
  assert.equal(JSON.stringify([...f.map]), before);
  assert.equal(restoreBackup(f.homey, file).restored, true);
  const meter = structuredClone(f.map.get('tibberConsumptionArchive'));
  restoreBackup(f.homey, file);
  assert.deepEqual(f.map.get('tibberConsumptionArchive'), meter);
  assert.equal(restoreBackup(f.homey, file.history).restored, true);
  assert.equal(f.map.get('historyState').slots[0].gridWh, 10);
});
test('different configuration requires an explicit binding confirmation; disabled Tibber cannot bind', () => {
  const f = fixture(),
    file = exportBackup(f.homey);
  file.meter.configRevision = 'old';
  file.meter.months[0].state.configRevision = 'old';
  assert.equal(previewBackup(f.homey, file).meterBindingRequired, true);
  assert.throws(() => restoreBackup(f.homey, file), /Confirm/);
  assert.equal(restoreBackup(f.homey, { backup: file, confirmMeterBinding: true }).restored, true);
  assert.equal(f.map.get('tibberConsumptionArchive').configRevision, 'r');
  f.map.set('tibberToken', '');
  assert.throws(() => previewBackup(f.homey, file), /Configure Tibber/);
});
test('both parts are validated before writes; no unknown fields or malformed archives are accepted', () => {
  const f = fixture(),
    file = exportBackup(f.homey),
    before = JSON.stringify([...f.map]);
  for (const invalid of [
    { ...file, token: 'secret' },
    { ...file, schema: 2 },
    { ...file, exportedAt: 'invalid' },
    { ...file, history: { invalid: true } },
    { ...file, meter: { invalid: true } },
    { backup: file, confirmMeterBinding: 'yes' },
    { backup: file, confirmMeterBinding: true, token: 'secret' },
    { ...file, padding: 'x'.repeat(8 * 1024 * 1024) },
  ])
    assert.throws(() => restoreBackup(f.homey, invalid));
  assert.equal(JSON.stringify([...f.map]), before);
});
test('a failed meter write does not import inverter history; a later history failure reports partial state and retry is safe', () => {
  const f = fixture(),
    file = exportBackup(f.homey);
  file.meter.months[0].state.hours.push({
    t: file.meter.months[0].state.from + 3600000,
    importWh: 22,
  });
  const before = JSON.stringify(f.map.get('historyState'));
  f.fail('tibberConsumptionArchive');
  assert.throws(() => restoreBackup(f.homey, file));
  assert.equal(JSON.stringify(f.map.get('historyState')), before);
  f.fail('historyState');
  assert.throws(() => restoreBackup(f.homey, file), /Meter references saved/);
  assert.equal(f.map.get('tibberConsumptionArchive').months[0].state.hours.length, 2);
  f.fail(null);
  assert.equal(restoreBackup(f.homey, file).restored, true);
  assert.equal(f.map.get('historyState').slots[0].gridWh, 10);
});
