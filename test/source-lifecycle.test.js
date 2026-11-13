'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { diagnostics } = require('../lib/diagnostics');
class Settings extends EventEmitter {
  constructor(values = {}) {
    super();
    this.values = new Map(Object.entries(values));
  }
  get(key) {
    return this.values.get(key);
  }
  set(key, value) {
    this.values.set(key, value);
    this.emit('set', key);
  }
}
function load(file, overrides) {
  const full = path.join(__dirname, '..', file),
    requireFile = createRequire(full),
    module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(full, 'utf8'),
    { module, require: (id) => (id in overrides ? overrides[id] : requireFile(id)) },
    { filename: full },
  );
  return module.exports;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = { gridMode: 0, soc: 60, capacityKWh: 42, gridW: 2000, pvW: 1000, essW: 500 };
function deviceFixture({
  snapshotRead = async () => snapshot,
  evdcRead = async () => ({ soc: 0, powerW: 0 }),
  batteryRead = async () => ({
    values: {},
    errors: { soh: 'Unsupported' },
    readAt: new Date().toISOString(),
  }),
} = {}) {
  const settings = new Settings(),
    capabilities = new Map(),
    readers = [];
  class Reader {
    constructor(config) {
      this.config = config;
      readers.push(this);
    }
    snapshot() {
      return snapshotRead(this);
    }
    batteryTelemetry() {
      return batteryRead(this);
    }
    close() {
      this.closed = true;
    }
  }
  const Device = load('drivers/sigenergy/device.js', {
    homey: { Device: class {} },
    '../../lib/modbus': { SigenergyReader: Reader },
    '../../lib/charging/evdc': { readEvdc: evdcRead },
  });
  const device = new Device();
  device.homey = {
    settings,
    setInterval: () => 1,
    clearInterval() {},
    app: { history: { append() {}, event() {} } },
    flow: { getTriggerCard: () => ({ trigger: async () => {} }) },
  };
  device.getSettings = () => ({
    host: '192.0.2.10',
    port: 502,
    unitId: 247,
    pollSeconds: 10,
    evdcEnabled: true,
  });
  device.setCapabilityValue = async (key, value) => capabilities.set(key, value);
  device.setAvailable = async () => {
    device.available = true;
  };
  device.setUnavailable = async () => {
    device.available = false;
  };
  device.error = device.log = () => {};
  return { device, settings, capabilities, readers };
}

test('device publishes EVDC state on first failure, recovers, disables and shuts down', async () => {
  let fail = true;
  const { device, settings, capabilities } = deviceFixture({
    evdcRead: async () => {
      if (fail) throw new Error('timeout');
      return { soc: 0, powerW: 0 };
    },
  });
  await device.onInit();
  await tick();
  let d = diagnostics(settings);
  assert.equal(d.sigenergy.status, 'ok');
  assert.equal(d.evdc.status, 'error');
  assert.equal(d.evdc.enabled, true);
  assert.equal(capabilities.get('measure_ev_soc'), null);
  assert.equal(d.battery.status, 'error');
  assert.equal(device.available, true);
  fail = false;
  await device.poll();
  d = diagnostics(settings);
  assert.equal(d.evdc.status, 'ok');
  assert.equal(capabilities.get('measure_ev_soc'), 0);
  await device.onSettings({ newSettings: { ...device.getSettings(), evdcEnabled: false } });
  await tick();
  assert.equal(diagnostics(settings).evdc.status, 'disabled');
  assert.equal(capabilities.get('measure_ev_soc'), null);
  await device.onDeleted();
  assert.equal(diagnostics(settings).sigenergy.status, 'disabled');
});

test('results from a reader replaced during a poll cannot republish old source data', async () => {
  let resolve;
  const oldRead = new Promise((done) => {
    resolve = done;
  });
  const f = deviceFixture({
    snapshotRead: (reader) =>
      reader.config.host === '192.0.2.10' ? oldRead : Promise.resolve(snapshot),
  });
  await f.device.onInit();
  await tick();
  await f.device.onSettings({
    newSettings: { ...f.device.getSettings(), host: '192.0.2.11', evdcEnabled: false },
  });
  resolve(snapshot);
  await tick();
  assert.equal(f.settings.get('sigenergyStatus'), null);
  assert.equal(f.readers[0].closed, true);
  await f.device.poll();
  assert.equal(diagnostics(f.settings).sigenergy.status, 'ok');
});

function appFixture(read) {
  class Reader {
    snapshot() {
      return read();
    }
    close() {}
  }
  const App = load('app.js', {
    homey: { App: class {} },
    './lib/nibe/smo-s40': { SmoS40Reader: Reader },
  });
  const app = new App(),
    settings = new Settings({ nibeHost: '192.0.2.30' });
  app.homey = { settings, setInterval: () => 1, clearInterval() {} };
  app.log = app.error = app.refreshRecommendation = () => {};
  app.refreshPrices = async () => {};
  return { app, settings };
}

test('Nibe failure, recovery and disable/re-enable invalidate earlier readings without restart', async () => {
  let fail = true;
  const { app, settings } = appFixture(async () => {
    if (fail) throw new Error('ECONNREFUSED');
    return { outdoorC: -2 };
  });
  await app.onInit();
  await tick();
  assert.equal(app.getDiagnostics().nibe.status, 'error');
  fail = false;
  await app.pollNibe();
  assert.equal(app.getDiagnostics().nibe.status, 'ok');
  assert.equal(app.getTemperatureContext().outdoorC, -2);
  settings.set('nibeHost', '');
  assert.equal(app.getDiagnostics().nibe.status, 'disabled');
  assert.equal(app.getTemperatureContext().outdoorC, null);
  settings.set('nibeHost', '192.0.2.30');
  assert.equal(app.getDiagnostics().nibe.status, 'no-data');
  await app.pollNibe();
  assert.equal(app.getDiagnostics().nibe.status, 'ok');
  await app.onUninit();
  assert.equal(settings.listenerCount('set'), 0);
});

test('changing Nibe configuration while a read is pending discards the old result', async () => {
  let resolve,
    first = true;
  const oldRead = new Promise((done) => {
    resolve = done;
  });
  const { app, settings } = appFixture(() => {
    if (first) {
      first = false;
      return oldRead;
    }
    return Promise.resolve({ outdoorC: -3 });
  });
  await app.onInit();
  settings.set('nibePort', 503);
  resolve({ outdoorC: 20 });
  await tick();
  assert.equal(settings.get('nibeStatus'), null);
  assert.equal(app.getDiagnostics().nibe.status, 'no-data');
  await app.pollNibe();
  assert.equal(app.getTemperatureContext().outdoorC, -3);
  await app.onUninit();
});
