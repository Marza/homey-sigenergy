'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  { createRequire } = require('node:module'),
  { EventEmitter } = require('node:events');
const { calendar } = require('../lib/pricing/coverage');
function cache() {
  const now = new Date(),
    days = calendar(now);
  return {
    schema: 2,
    homeId: 'fixture-home',
    selectedHomeId: 'fixture-home',
    resolution: 'QUARTER_HOURLY',
    currency: 'SEK',
    fetchedAt: now.toISOString(),
    prices: Array.from({ length: (days.tomorrow.end - days.today.start) / 900000 }, (_, i) => ({
      start: new Date(days.today.start + i * 900000).toISOString(),
      end: new Date(days.today.start + (i + 1) * 900000).toISOString(),
      price: 0.5,
    })),
  };
}
class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = new Map([
      ['tibberToken', 'test-token'],
      ['tibberHomeId', 'fixture-home'],
    ]);
  }
  get(k) {
    return this.values.get(k);
  }
  set(k, v) {
    this.values.set(k, v);
    this.emit('set', k);
  }
}
function appFixture(fetchPrices, settings = new Settings(), planner) {
  const file = path.join(__dirname, '../app.js'),
    requireApp = createRequire(file),
    module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(file, 'utf8'),
    {
      module,
      require: (id) =>
        id === 'homey'
          ? { App: class {} }
          : id === './lib/pricing/tibber'
            ? { fetchTibberPrices: fetchPrices }
            : planner && id === './lib/energy/battery-plan-report'
              ? { getBatteryPlan: planner }
              : requireApp(id),
    },
    { filename: file },
  );
  const app = new module.exports();
  app.homey = { settings, setInterval: () => 1, clearInterval() {} };
  app.log = app.error = app.refreshRecommendation = () => {};
  app.pollNibe = async () => {};
  return { app, settings };
}
test('price refresh preserves usable cache after failure and across an offline restart', async () => {
  let fail = false;
  const fetchPrices = async () => {
    if (fail) throw new Error('network failure test-token');
    return cache();
  };
  const { app, settings } = appFixture(fetchPrices);
  await app.onInit();
  settings.set('sourceConfig', {
    ...settings.get('sourceConfig'),
    sigenergy: { configured: true, enabled: true },
  });
  settings.set('sigenergyStatus', { readAt: new Date().toISOString() });
  settings.set('backupStatus', {
    mode: 'on-grid',
    suspendEconomicOptimization: false,
    observedAt: new Date().toISOString(),
  });
  const before = settings.get('priceCache');
  assert.equal(app.getDiagnostics().tibber.usable, true);
  fail = true;
  await assert.rejects(
    app.refreshPrices(),
    (error) => !error.message.includes('test-token') && !error.cause,
  );
  assert.equal(settings.get('priceCache'), before);
  assert.equal(app.getDiagnostics().tibber.status, 'error');
  assert.equal(app.getDiagnostics().tibber.usable, true);
  await app.onUninit();
  const restarted = appFixture(fetchPrices, settings).app;
  await restarted.onInit();
  assert.equal(settings.get('priceCache'), before);
  assert.equal(restarted.getDiagnostics().tibber.usable, true);
  await restarted.onUninit();
});
test('credentials changed during a request invalidate its result without publishing old data', async () => {
  let next = async () => cache();
  const { app, settings } = appFixture(() => next());
  await app.onInit();
  settings.set('sourceConfig', {
    ...settings.get('sourceConfig'),
    sigenergy: { configured: true, enabled: true },
  });
  settings.set('sigenergyStatus', { readAt: new Date().toISOString() });
  settings.set('backupStatus', {
    mode: 'on-grid',
    suspendEconomicOptimization: false,
    observedAt: new Date().toISOString(),
  });
  const before = settings.get('priceCache');
  let resolve;
  next = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = app.refreshPrices();
  settings.set('tibberToken', 'new-token');
  assert.equal(app.getDiagnostics().tibber.usable, false);
  assert.equal(settings.get('priceLastAttemptAt'), null);
  resolve(cache());
  await pending;
  assert.equal(settings.get('priceCache'), before);
  next = async () => cache();
  await app.refreshPrices();
  assert.equal(app.getDiagnostics().tibber.usable, true);
  settings.set('tibberToken', '');
  assert.equal(app.getDiagnostics().tibber.status, 'disabled');
  await app.refreshPrices();
  await app.onUninit();
});
test('legacy and expired caches cannot silently provide inferred prices to plans', async () => {
  const { app, settings } = appFixture(async () => cache());
  await app.onInit();
  settings.set('sourceConfig', {
    ...settings.get('sourceConfig'),
    sigenergy: { configured: true, enabled: true },
  });
  settings.set('sigenergyStatus', { readAt: new Date().toISOString() });
  settings.set('backupStatus', {
    mode: 'on-grid',
    suspendEconomicOptimization: false,
    observedAt: new Date().toISOString(),
  });
  const before = settings.get('priceCache');
  settings.set('priceCache', { ...before, schema: 1 });
  assert.equal(app.getDiagnostics().tibber.usable, false);
  settings.set('priceCache', before);
  const expiredAt = new Date(Date.parse(before.prices.at(-1).end) + 1000);
  const { priceStatus } = require('../lib/pricing/coverage');
  assert.equal(priceStatus(Object.fromEntries(settings.values), expiredAt.getTime()).usable, false);
  settings.set('sigenergyStatus', { readAt: expiredAt.toISOString() });
  settings.set('backupStatus', {
    mode: 'on-grid',
    suspendEconomicOptimization: false,
    observedAt: expiredAt.toISOString(),
  });
  await app.onUninit();
});
module.exports = {};

test('Homey refreshes one shared battery plan without widget requests and discards invalid advice', async () => {
  const widget = require('../widgets/battery-plan/api');
  let runs = 0,
    fail = false;
  const planner = ({ settings }) => {
    runs++;
    if (fail) throw Error('Calculation failed');
    return {
      now: Date.now(),
      chargeLimitKW: settings.get('batteryTelemetry')?.values.chargePowerLimitKW,
      plan: [{ action: 'buy' }],
    };
  };
  const { app, settings } = appFixture(async () => cache(), new Settings(), planner);
  const timers = new Map();
  app.homey.setInterval = (fn, ms) => {
    timers.set(fn, ms);
    return fn;
  };
  app.homey.clearInterval = (fn) => timers.delete(fn);
  const read = () => widget.getPlan({ homey: { app } });
  await app.onInit();
  assert.equal(runs, 1);
  const tick = app.historyTimer;
  assert.equal(timers.get(tick), 60000);
  settings.set('sourceConfig', {
    ...settings.get('sourceConfig'),
    sigenergy: { configured: true, enabled: true },
  });
  settings.set('sigenergyStatus', { readAt: new Date().toISOString() });
  settings.set('backupStatus', {
    mode: 'on-grid',
    suspendEconomicOptimization: false,
    observedAt: new Date().toISOString(),
  });
  settings.set('batteryTelemetry', { values: { chargePowerLimitKW: 8 } });
  tick();
  assert.equal(runs, 2);
  assert.equal(read().chargeLimitKW, 8);
  assert.strictEqual(read(), read());
  assert.equal(runs, 2);
  assert.throws(() => app.getLatestBatteryPlan(read().now + 120001));
  settings.set('backupStatus', {
    mode: 'off-grid',
    suspendEconomicOptimization: true,
    observedAt: new Date().toISOString(),
  });
  assert.equal(read().reason, 'grid');
  assert.equal(read().plan.length, 0);
  settings.set('householdImportLimits', { importLimitKW: 10 });
  assert.throws(read);
  fail = true;
  tick();
  assert.throws(read);
  fail = false;
  tick();
  assert.equal(runs, 4);
  await app.onUninit();
  assert.ok(!timers.has(tick));
  assert.throws(read);
  await app.onInit();
  assert.equal(runs, 5);
  await app.onUninit();
});
