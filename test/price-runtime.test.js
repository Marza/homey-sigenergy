'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  { createRequire } = require('node:module'),
  { EventEmitter } = require('node:events');
const { calendar } = require('../lib/pricing/coverage');
const { DEFAULTS } = require('../lib/charging/planner');
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
      ['chargingConfig', structuredClone(DEFAULTS)],
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
function appFixture(fetchPrices, settings = new Settings()) {
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
  const plan = app.getPricePlan(50);
  assert.equal(plan.advisoryOnly, true);
  assert.equal(plan.currency, 'SEK');
  assert.equal(plan.pricing.status, 'error');
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
  assert.equal(app.getPricePlan(50).status, 'no-prices');
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
  assert.equal(app.getPricePlan(10).status, 'no-prices');
  settings.set('priceCache', before);
  const expiredAt = new Date(Date.parse(before.prices.at(-1).end) + 1000);
  settings.set('sigenergyStatus', { readAt: expiredAt.toISOString() });
  settings.set('backupStatus', {
    mode: 'on-grid',
    suspendEconomicOptimization: false,
    observedAt: expiredAt.toISOString(),
  });
  assert.equal(app.getPricePlan(10, expiredAt).status, 'expired-prices');
  await app.onUninit();
});
module.exports = {};
