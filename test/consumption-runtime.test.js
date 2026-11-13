'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { shouldSync, monthWindow } = require('../lib/pricing/consumption-sync');
class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = new Map([
      ['tibberToken', 'private-token'],
      ['tibberHomeId', 'home'],
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
function fixture(fetchConsumption, settings = new Settings()) {
  const file = path.join(__dirname, '../app.js'),
    req = createRequire(file),
    module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    require: (id) =>
      id === 'homey'
        ? { App: class {} }
        : id === './lib/pricing/consumption-sync'
          ? { shouldSync, fetchConsumption }
          : req(id),
  });
  const app = new module.exports(),
    timers = [],
    cleared = [];
  app.homey = {
    settings,
    setInterval: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearInterval: (t) => cleared.push(t),
  };
  app.log = app.error = () => {};
  app.pollNibe = app.refreshPrices = async () => {};
  return { app, settings, timers, cleared };
}
function state({ now, configRevision }) {
  return {
    schema: 1,
    source: 'tibber-consumption',
    resolution: 'HOURLY',
    configRevision,
    fetchedAt: now.toISOString(),
    ...monthWindow(now),
    hours: [],
  };
}
const n = new Date('2026-11-13T12:00Z');
test('daily runtime fetch keeps inverter history intact, persists corrections and success across restart', async () => {
  let calls = 0;
  const f = fixture(async (o) => {
    calls++;
    return state(o);
  });
  await f.app.onInit();
  const original = JSON.stringify(f.app.history.getSlots());
  assert.equal(calls, 0);
  assert.equal(f.app.consumptionTimer.ms, 300000);
  await f.app.refreshConsumption(n);
  assert.equal(calls, 1);
  assert.equal(f.settings.get('tibberConsumptionSync').status, 'ok');
  assert.equal(JSON.stringify(f.app.history.getSlots()), original);
  await f.app.refreshConsumption(n);
  assert.equal(calls, 1);
  const restarted = fixture(async (o) => {
    calls++;
    return state(o);
  }, f.settings);
  await f.app.onUninit();
  await restarted.app.onInit();
  await restarted.app.refreshConsumption(n);
  assert.equal(calls, 1);
  await restarted.app.refreshConsumption(new Date(+n + 86400000));
  assert.equal(calls, 2);
  assert.ok(f.cleared.includes(f.app.consumptionTimer));
  await restarted.app.onUninit();
});
test('failed refresh preserves last good history, records only safe status and retries after one hour', async () => {
  let fail = false,
    calls = 0;
  const f = fixture(async (o) => {
    calls++;
    if (fail) throw Error('private-token private-home');
    return state(o);
  });
  await f.app.onInit();
  await f.app.refreshConsumption(n);
  const previous = f.settings.get('tibberConsumptionHistory');
  fail = true;
  const next = new Date(+n + 86400000);
  await f.app.refreshConsumption(next);
  assert.equal(f.settings.get('tibberConsumptionHistory'), previous);
  assert.equal(f.settings.get('tibberConsumptionSync').status, 'error');
  assert.ok(!JSON.stringify(f.settings.get('tibberConsumptionSync')).includes('private-token'));
  await f.app.refreshConsumption(next);
  assert.equal(calls, 2);
  await f.app.refreshConsumption(new Date(+next + 3600000));
  assert.equal(calls, 3);
  await f.app.onUninit();
});
test('concurrent requests, changed credentials, disabled token and shutdown cannot publish obsolete results', async () => {
  let resolve;
  const f = fixture(
    (o) =>
      new Promise((r) => {
        resolve = () => r(state(o));
      }),
  );
  await f.app.onInit();
  const pending = f.app.refreshConsumption(n);
  await f.app.refreshConsumption(n);
  f.settings.set('tibberHomeId', 'new-home');
  resolve();
  await pending;
  assert.equal(f.settings.get('tibberConsumptionHistory'), undefined);
  f.settings.set('tibberToken', '');
  await f.app.refreshConsumption(n);
  assert.equal(f.app.consumptionRefreshing, false);
  f.settings.set('tibberToken', 'other-token');
  const shutdown = f.app.refreshConsumption(n);
  await f.app.onUninit();
  resolve();
  await shutdown;
  assert.equal(f.settings.get('tibberConsumptionHistory'), undefined);
  await f.app.refreshConsumption(n);
  assert.equal(f.app.consumptionRefreshing, false);
});

test('first month hour waits rather than suppressing fetching for the whole day', async () => {
  let calls = 0;
  const f = fixture(async (o) => {
    calls++;
    return monthWindow(o.now).to === monthWindow(o.now).from ? null : state(o);
  });
  await f.app.onInit();
  const midnight = new Date('2026-12-01T00:05+01:00');
  await f.app.refreshConsumption(midnight);
  assert.equal(f.settings.get('tibberConsumptionSync').status, 'waiting');
  assert.equal(f.settings.get('tibberConsumptionSync').lastSuccessAt, null);
  await f.app.refreshConsumption(new Date(+midnight + 3600000));
  assert.equal(calls, 2);
  assert.equal(f.settings.get('tibberConsumptionSync').status, 'ok');
  await f.app.onUninit();
});
