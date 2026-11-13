'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  { createRequire } = require('node:module'),
  { EventEmitter } = require('node:events');
const { tariffKey } = require('../lib/tariff-config');
class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = new Map();
  }
  get(key) {
    return this.values.get(key);
  }
  set(key, value) {
    this.values.set(key, value);
    this.emit('set', key);
  }
}
test('tariff edits refresh the demand estimate without triggering expensive scenario replay', async () => {
  const file = path.join(__dirname, '../app.js'),
    requireApp = createRequire(file),
    module = { exports: {} };
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-11-20T12:00:00Z']));
    }
    static now() {
      return Date.parse('2026-11-20T12:00:00Z');
    }
  }
  vm.runInNewContext(
    fs.readFileSync(file, 'utf8'),
    { module, Date: Clock, require: (id) => (id === 'homey' ? { App: class {} } : requireApp(id)) },
    { filename: file },
  );
  const app = new module.exports(),
    settings = new Settings();
  app.homey = { settings, setInterval: () => 1, clearInterval() {} };
  app.log = app.error = () => {};
  app.pollNibe = app.refreshPrices = async () => {};
  let scenarioCalls = 0;
  const periodic = app.refreshRecommendation.bind(app);
  app.refreshRecommendation = () => {
    scenarioCalls++;
    return periodic();
  };
  await app.onInit();
  settings.set('sourceConfig', {
    ...settings.get('sourceConfig'),
    sigenergy: { configured: true, enabled: true },
  });
  settings.set('sigenergyStatus', { readAt: new Clock().toISOString() });
  settings.set('backupStatus', {
    mode: 'on-grid',
    suspendEconomicOptimization: false,
    observedAt: new Clock().toISOString(),
  });
  const history = app.history;
  const callsBeforeTariff = scenarioCalls;
  app.history = {
    getSlots: () =>
      [3, 4, 5, 6, 7].flatMap((kw, i) =>
        Array.from({ length: 4 }, (_, q) => ({
          t: Date.parse('2026-11-12T07:00:00Z') + i * 3600000 + q * 900000,
          gridWh: kw * 250,
          essWh: 0,
          coverageMs: 900000,
        })),
      ),
    flush: () => history.flush(),
  };
  const tariff = {
    start: '07:00',
    end: '20:00',
    weekdays: [4],
    months: [11],
    peakCount: 3,
    distinctDays: false,
    rateSekPerKw: 100,
  };
  settings.set('demandTariff', tariff);
  assert.equal(settings.get('demandEstimate').averageKw, 6);
  assert.equal(settings.get('demandEstimate').tariffKey, tariffKey(tariff));
  const edited = { ...tariff, peakCount: 5 };
  settings.set('demandTariff', edited);
  assert.equal(settings.get('demandEstimate').averageKw, 5);
  assert.equal(settings.get('demandEstimate').tariffKey, tariffKey(edited));
  assert.equal(scenarioCalls, callsBeforeTariff);
  assert.equal(settings.get('tariffOptimization').status, 'pending');
  app.refreshRecommendation();
  assert.equal(settings.get('tariffOptimization').baseline.tariffKey, tariffKey(edited));
  settings.set('demandTariff', { ...edited, rateSekPerKw: 0 });
  assert.equal(settings.get('demandEstimate').estimatedSek, 0);
  settings.set('demandTariff', { ...edited, months: [] });
  assert.equal(settings.get('demandEstimate').status, 'error');
  app.refreshRecommendation();
  assert.equal(settings.get('tariffOptimization').status, 'error');
  settings.set('demandTariff', null);
  assert.equal(settings.get('demandEstimate').status, 'not-configured');
  assert.equal(settings.get('tariffOptimization').status, 'not-configured');
  assert.equal(settings.get('operationMode').allowHardwareWrites, false);
  await app.onUninit();
  assert.equal(settings.listenerCount('set'), 0);
});
