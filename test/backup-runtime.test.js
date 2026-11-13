'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { backupAdvisory } = require('../lib/source-status');
const { IslandController } = require('../lib/backup/island-controller');
const { getOverview } = require('../widgets/energy-overview/api');
const { heatPumpPolicy } = require('../lib/backup/heat-pump-policy');

function healthy(now = Date.now()) {
  return {
    sourceConfig: { sigenergy: { configured: true, enabled: true } },
    sigenergyStatus: { readAt: new Date(now).toISOString() },
    backupStatus: {
      mode: 'on-grid',
      soc: 60,
      suspendEconomicOptimization: false,
      observedAt: new Date(now).toISOString(),
    },
  };
}
test('advice requires fresh plant data and an explicitly restored fresh grid decision', () => {
  const now = Date.now();
  assert.equal(backupAdvisory(healthy(now), now).restricted, false);
  for (const mutate of [
    (v) => {
      delete v.backupStatus;
    },
    (v) => {
      v.backupStatus.mode = 'off-grid';
    },
    (v) => {
      v.backupStatus.mode = 'unknown';
    },
    (v) => {
      delete v.backupStatus.suspendEconomicOptimization;
    },
    (v) => {
      v.backupStatus.suspendEconomicOptimization = true;
    },
    (v) => {
      v.backupStatus.observedAt = new Date(now - 30001).toISOString();
    },
    (v) => {
      v.backupStatus.observedAt = new Date(now + 1).toISOString();
    },
    (v) => {
      v.sigenergyStatus.readAt = new Date(now - 30001).toISOString();
    },
    (v) => {
      v.sigenergyStatus.readAt = new Date(now + 1).toISOString();
    },
    (v) => {
      v.sigenergyError = 'timeout';
    },
    (v) => {
      v.sourceConfig.sigenergy.enabled = false;
    },
    (v) => {
      v.sourceConfig.sigenergy.since = new Date(now + 1).toISOString();
    },
  ]) {
    const values = healthy(now);
    mutate(values);
    const advisory = backupAdvisory(values, now);
    assert.equal(advisory.restricted, true);
    assert.equal(advisory.controlApplied, false);
  }
  const values = healthy(now);
  values.sourceConfig.sigenergy.maxAgeMs = 60000;
  values.backupStatus.observedAt = new Date(now - 45000).toISOString();
  assert.equal(backupAdvisory(values, now).restricted, false);
});
test('restoration waits through startup, resets on communication gaps and clock rollback', () => {
  let now = 0;
  const c = new IslandController({ now: () => now, maxGapMs: 30000 });
  assert.equal(c.update(0, 60).suspendEconomicOptimization, true);
  for (now = 10000; now <= 300000; now += 10000) c.update(0, 60);
  assert.equal(c.mode, 'on-grid');
  now = 350001;
  assert.equal(c.update(0, 60).mode, 'unknown');
  now = 340000;
  assert.equal(c.update(0, 60).mode, 'unknown');
  assert.equal(c.gridRestoredAt, now);
  assert.equal(c.update(2, 20).nibeModeRequested, 'critical');
  for (const soc of [-1, NaN, 101, undefined]) {
    assert.equal(c.update(1, soc).nibeModeRequested, 'economy');
    assert.equal(heatPumpPolicy({ gridMode: 'unknown', batterySoc: soc }).modeRequested, 'economy');
  }
  assert.equal(c.communicationLost().controlApplied, false);
});
test('runtime clears saved advice at transitions, blocks both charging entry points and keeps qualified history', async () => {
  const file = path.join(__dirname, '../app.js');
  const requireApp = createRequire(file),
    module = { exports: {} };
  let now = Date.now();
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  vm.runInNewContext(
    fs.readFileSync(file, 'utf8'),
    {
      module,
      Date: Clock,
      require: (id) => (id === 'homey' ? { App: class {} } : requireApp(id)),
    },
    { filename: file },
  );
  class Settings extends EventEmitter {
    constructor() {
      super();
      this.values = new Map(Object.entries(healthy(now)));
    }
    get(key) {
      return this.values.get(key);
    }
    set(key, value) {
      this.values.set(key, value);
      this.emit('set', key);
    }
  }
  const settings = new Settings(),
    timers = [];
  const app = new module.exports();
  app.homey = {
    settings,
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval() {},
  };
  app.log = app.error = () => {};
  app.pollNibe = app.refreshPrices = async () => {};
  await app.onInit();
  assert.equal(settings.get('backupStatus'), null);
  assert.equal(settings.get('optimizationRecommendation').status, 'backup-restricted');
  assert.equal(app.getChargingPreview(null).slots.length, 0);
  assert.equal(app.getPricePlan(20).status, 'backup-restricted');
  for (const [key, value] of Object.entries(healthy(now))) settings.set(key, value);
  assert.equal(app.getPricePlan(20).status, 'no-prices');
  assert.equal(settings.get('optimizationRecommendation').status, 'insufficient-data');
  settings.set('nibeStatus', { readAt: new Clock().toISOString(), readings: { outdoorC: 4 } });
  settings.set('backupStatus', {
    ...healthy(now).backupStatus,
    mode: 'off-grid',
    soc: 20,
    suspendEconomicOptimization: true,
  });
  assert.equal(settings.get('optimizationRecommendation').status, 'backup-restricted');
  assert.equal(settings.get('nibeStatus').policy.modeRequested, 'critical');
  assert.equal(settings.get('nibeStatus').policy.controlApplied, false);
  settings.set('backupStatus', { ...settings.get('backupStatus'), soc: 60 });
  assert.equal(settings.get('nibeStatus').policy.modeRequested, 'economy');
  const history = app.getOptimizationPreview();
  assert.equal(history.historicalOnly, true);
  assert.equal(history.backupAdvisory.restricted, true);
  assert.equal(app.getAdvancedOptimizationPreview().historicalOnly, true);
  for (const [key, value] of Object.entries(healthy(now))) settings.set(key, value);
  now += 31000;
  timers.find((t) => t.ms === 60000).fn();
  assert.equal(settings.get('optimizationRecommendation').status, 'backup-restricted');
  assert.equal(app.getPricePlan(20).status, 'backup-restricted');
  assert.equal(settings.get('nibeStatus').readAt, new Date(now - 31000).toISOString());
  await app.onUninit();
});
test('Dashboard suppresses an old saved recommendation using current source freshness', () => {
  const now = Date.now(),
    values = healthy(now);
  values.optimizationRecommendation = { status: 'illustrative', capKW: 4, reservePercent: 30 };
  const homey = { settings: { get: (key) => values[key] } };
  assert.equal(getOverview({ homey }, now).values.optimizationRecommendation.capKW, 4);
  const stale = getOverview({ homey }, now + 31000).values.optimizationRecommendation;
  assert.equal(stale.status, 'backup-restricted');
  assert.equal(stale.capKW, undefined);
  assert.match(stale.reason, /pausade/);
});
