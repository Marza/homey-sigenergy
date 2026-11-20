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

test('backup Flow tokens are requests and publish before a pending optional probe; loss clears restoration', async () => {
  let finishProbe,
    fail = false;
  const { device, settings } = deviceFixture({
    snapshotRead: async () => {
      if (fail) throw new Error('timeout');
      return { ...snapshot, gridMode: 1, soc: 20 };
    },
    batteryRead: () =>
      new Promise((resolve) => {
        finishProbe = resolve;
      }),
  });
  const tokens = [];
  device.homey.flow.getTriggerCard = () => ({
    trigger: async (value) => {
      tokens.push(value);
    },
  });
  await device.onInit();
  await tick();
  assert.equal(settings.get('backupStatus').mode, 'off-grid');
  assert.equal(settings.get('backupStatus').controlApplied, false);
  assert.equal(tokens[0].ev_stop_requested, true);
  assert.equal(tokens[0].nibe_mode, 'critical');
  assert.equal(tokens[0].mode, 'off-grid');
  finishProbe({ values: {}, errors: {}, readAt: new Date().toISOString() });
  await tick();
  fail = true;
  await device.poll();
  assert.equal(settings.get('backupStatus').mode, 'unknown');
  assert.equal(settings.get('backupStatus').suspendEconomicOptimization, true);
  assert.equal(tokens.at(-1).nibe_mode, 'economy');
  await device.onUninit();
});
const snapshot = { gridMode: 0, soc: 60, capacityKWh: 42, gridW: 2000, pvW: 1000, essW: 500 };
function deviceFixture({
  snapshotRead = async () => snapshot,
  evacRead,
  evdcRead = async () => ({ values: { soc: 0, powerW: 0 }, powerReadAt: Date.now() }),
  phaseRead = async () => [0, 0, 0],
  energyRead = async () => ({ values: {} }),
  householdRead = async () => '123456',
  flowRead = async () => {
    throw Error('unsupported');
  },
  batteryRead = async () => ({
    values: {},
    errors: { soh: 'Unsupported' },
    readAt: new Date().toISOString(),
  }),
} = {}) {
  const settings = new Settings(),
    capabilities = new Map(),
    readers = [],
    samples = [];
  class Reader {
    constructor(config) {
      this.config = config;
      readers.push(this);
    }
    snapshot(solarSource) {
      return snapshotRead(this, solarSource);
    }
    read(...args) {
      return evacRead(this, ...args);
    }
    energyCounters(profile, solarSource) {
      return energyRead(profile, solarSource);
    }
    flowMeterSnapshot() {
      return flowRead();
    }
    householdPower() {
      return 1234;
    }
    householdEnergyCounter() {
      return householdRead();
    }
    batteryTelemetry() {
      return batteryRead(this);
    }
    phaseCurrents(source) {
      return phaseRead(this, source);
    }
    close() {
      this.closed = true;
    }
  }
  const Device = load('drivers/sigenergy/device.js', {
    homey: { Device: class {} },
    '../../lib/modbus': { SigenergyReader: Reader },
    '../../lib/energy/phase-reader': load('lib/energy/phase-reader.js', {
      '../modbus': { SigenergyReader: Reader },
    }),
    '../../lib/charging/modbus-telemetry': {
      ...require('../lib/charging/modbus-telemetry'),
      readEvdc: evdcRead,
    },
  });
  const device = new Device();
  device.homey = {
    settings,
    setInterval: () => 1,
    clearInterval() {},
    app: { history: { append: (...args) => samples.push(args), event() {} } },
    flow: { getTriggerCard: () => ({ trigger: async () => {} }) },
  };
  device.getSettings = () => ({
    host: '192.0.2.10',
    port: 502,
    unitId: 247,
    pollSeconds: 10,
    evdcEnabled: true,
    evdcUnitId: 7,
  });
  device.setCapabilityValue = async (key, value) => capabilities.set(key, value);
  device.setAvailable = async () => {
    device.available = true;
  };
  device.setUnavailable = async () => {
    device.available = false;
  };
  device.error = device.log = () => {};
  return { device, settings, capabilities, readers, samples };
}

test('device publishes EVDC state on first failure, recovers, disables and shuts down', async () => {
  let fail = true;
  const { device, settings, capabilities } = deviceFixture({
    evdcRead: async () => {
      return fail
        ? {
            values: {},
            errors: { powerW: 'timeout' },
            powerFailure: Error('timeout'),
            powerReadAt: Date.now(),
          }
        : { values: { soc: 0, powerW: 0 }, powerReadAt: Date.now() };
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
  await device.pollCharger('evdc');
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

test('EVDC uses its own inverter address and marks failed power reads as gaps', async () => {
  let values = { powerW: 7200 };
  const powerFailure = Error('timeout');
  const { device, settings, capabilities, readers, samples } = deviceFixture({
    evdcRead: async () => ({
      values,
      errors: values.powerW === undefined ? { powerW: 'timeout' } : { soc: 'unavailable' },
      powerFailure: values.powerW === undefined ? powerFailure : undefined,
      powerReadAt: Date.now(),
    }),
  });
  await device.onInit();
  await tick();
  assert.deepEqual(
    readers.map((reader) => reader.config.unitId),
    [247, 7, 7],
  );
  assert.equal(capabilities.get('measure_ev_power'), 7200);
  assert.equal(capabilities.get('measure_ev_soc'), null);
  assert.equal(diagnostics(settings).evdc.status, 'partial');

  values = { soc: 50 };
  await device.pollCharger('evdc');
  assert.deepEqual({ ...samples.at(-1)[0] }, { evW: null, evSoc: 50 });
  assert.equal(samples.at(-1)[2], 'modbus-timeout');
  assert.equal(capabilities.get('measure_ev_power'), null);
  assert.equal(device.available, true);

  await device.onSettings({ newSettings: { ...device.getSettings(), evdcUnitId: 247 } });
  await tick();
  assert.equal(readers.length, 4);
  assert.ok(readers.slice(0, 3).every((reader) => reader.closed));
  assert.match(settings.get('evdcError'), /Modbus-ID/);
  await device.onUninit();
});

test('EVAC uses its own endpoint, publishes cumulative energy and records separate power', async () => {
  let fail = false;
  const { device, settings, capabilities, readers, samples } = deviceFixture({
    evacRead: async (reader, address, count) => {
      assert.equal(reader.config.host, '192.0.2.20');
      assert.equal(reader.config.unitId, 9);
      assert.equal(address, 32000);
      assert.equal(count, 5);
      if (fail) throw Error('timeout');
      return [5, 0, 12345, 0, 11000];
    },
  });
  const originalSettings = device.getSettings();
  device.getSettings = () => ({
    ...originalSettings,
    evacEnabled: true,
    evacHost: '192.0.2.20',
    evacUnitId: 9,
  });
  await device.onInit();
  await tick();
  assert.deepEqual(
    readers.map((reader) => reader.config.unitId),
    [247, 7, 7, 9],
  );
  assert.ok(samples.some(([sample]) => sample.evacW === 11000 && sample.evW === undefined));
  assert.equal(capabilities.get('measure_evac_power'), 11000);
  assert.equal(capabilities.get('measure_evac_energy'), 123.45);
  assert.equal(diagnostics(settings).evac.status, 'ok');
  fail = true;
  await device.pollCharger('evac');
  assert.equal(samples.at(-1)[0].evacW, null);
  assert.equal(samples.at(-1)[2], 'modbus-timeout');
  assert.equal(capabilities.get('measure_evac_power'), null);
  assert.equal(diagnostics(settings).evac.status, 'error');
  assert.equal(diagnostics(settings).evdc.status, 'ok');
  assert.equal(device.available, true);
  await device.onUninit();
  assert.equal(readers.at(-1).closed, true);
});

test('the device polls inverter and grid phase current on their separate Modbus endpoints', async () => {
  const { device, settings, readers } = deviceFixture({
    phaseRead: async (reader, source) => {
      const { host, port, unitId } = reader.config;
      if (source === 'inverter') {
        assert.deepEqual([host, port, unitId], ['192.0.2.10', 502, 7]);
        return [8, 7, 6];
      }
      assert.equal(source, 'grid');
      assert.deepEqual([host, port, unitId], ['192.0.2.12', 1502, 4]);
      return [11, 24, 9];
    },
  });
  const configured = device.getSettings();
  device.getSettings = () => ({
    ...configured,
    phaseMeterHost: '192.0.2.12',
    phaseMeterPort: 1502,
    phaseMeterUnitId: 4,
  });
  const observed = [];
  device.homey.app.history.observePhaseCurrent = (source, _binding, amps) =>
    observed.push([source, amps]);
  await device.onInit();
  await tick();
  assert.deepEqual(settings.get('inverterPhaseCurrent').amps, [8, 7, 6]);
  assert.deepEqual(settings.get('gridPhaseCurrent').amps, [11, 24, 9]);
  assert.deepEqual(observed, [
    ['grid', [11, 24, 9]],
    ['inverter', [8, 7, 6]],
  ]);
  await device.onUninit();
  assert.ok(readers.every((reader) => reader.closed));
});

test('a complete meter block supplies the history and household diagnostic from the same read', async () => {
  const meters = { house: 43 };
  const { device, settings } = deviceFixture({
    flowRead: () => meters,
    householdRead: () => {
      throw Error('unexpected separate read');
    },
  });
  const base = device.getSettings();
  device.getSettings = () => ({ ...base, energyMetersProfile: 'sigenergy-v29-statistics' });
  device.getStoreValue = () => undefined;
  device.setStoreValue = async () => {};
  const received = [];
  device.homey.app.history.observeFlowMeters = (...args) => received.push(args);
  await device.onInit();
  await tick();
  assert.equal(received.length, 1);
  assert.equal(received[0][0], meters);
  assert.equal(settings.get('householdCounterStatus').totalKWh, 0.43);
  assert.equal(settings.get('householdCounterStatus').powerW, 1234);
  await device.onUninit();
});

test('the V2.9 profile reads household energy without invalidating site data on failure', async () => {
  let failure = false;
  const { device, settings } = deviceFixture({
    householdRead: async () => {
      if (failure) throw Error('timeout');
      return '123456';
    },
  });
  const base = device.getSettings();
  device.getSettings = () => ({ ...base, energyMetersProfile: 'sigenergy-v29-statistics' });
  device.getStoreValue = () => undefined;
  device.setStoreValue = async () => {};
  const seen = [];
  device.homey.app.history.observeHouseholdCounter = (...args) => {
    seen.push(args);
    return args[0] ? 0 : null;
  };
  await device.onInit();
  await tick();
  assert.equal(settings.get('householdCounterStatus').totalKWh, 1234.56);
  assert.equal(settings.get('householdCounterStatus').averageKW, 0);
  assert.equal(diagnostics(settings).household.status, 'ok');
  failure = true;
  device.lastEnergyProbeAt = null;
  await device.poll();
  assert.equal(settings.get('householdCounterStatus'), null);
  assert.equal(diagnostics(settings).household.status, 'error');
  assert.equal(seen.at(-1)[0], null);
  assert.equal(seen.at(-1)[2], 'modbus-timeout');
  assert.equal(diagnostics(settings).sigenergy.status, 'ok');
  assert.equal(device.available, true);
  await device.onUninit();
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
  resolve({ ...snapshot, gridW: 999999 });
  await tick();
  assert.ok(!f.samples.some(([sample]) => sample.gridW === 999999));
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

test('shared Energy snapshots follow plant success, reader replacement, communication loss and shutdown', async () => {
  let fail = false;
  const { device } = deviceFixture({
    snapshotRead: async () => {
      if (fail) throw Error('offline');
      return snapshot;
    },
  });
  assert.equal(device.getEnergySnapshot(), null);
  await device.onInit();
  await tick();
  const first = device.getEnergySnapshot();
  assert.equal(first.gridW, 2000);
  assert.equal(first.pvW, 1000);
  assert.equal(first.essW, 500);
  assert.equal(first.capacityKWh, 42);
  assert.ok(Number.isFinite(first.readAt));
  assert.equal(first.generation, device.generation);
  fail = true;
  await device.poll();
  assert.equal(device.getEnergySnapshot(), null);
  fail = false;
  await device.poll();
  assert.ok(device.getEnergySnapshot());
  const oldGeneration = device.generation;
  device.startReader({ ...device.getSettings(), pollSeconds: 20 });
  assert.equal(device.getEnergySnapshot(), null);
  await tick();
  assert.ok(device.getEnergySnapshot().generation > oldGeneration);
  assert.equal(device.getEnergySnapshot().maxAgeMs, 60000);
  await device.onUninit();
  assert.equal(device.getEnergySnapshot(), null);
});

test('optional counter probing commits high-water marks before publish and never invalidates power on counter/store failure', async () => {
  const { PROFILE } = require('../lib/energy/meters');
  let raw = '1000',
    failRead = false,
    failWrite = false,
    stored;
  const { device } = deviceFixture({
    energyRead: async () => {
      if (failRead) throw Error('unsupported');
      return {
        values: { solar: raw, imported: raw, exported: raw, charged: raw, discharged: raw },
      };
    },
  });
  const settings = device.getSettings();
  device.getSettings = () => ({ ...settings, energyMetersProfile: PROFILE, energyCounterEpoch: 0 });
  device.getStoreValue = () => stored;
  device.setStoreValue = async (_key, state) => {
    if (failWrite) throw Error('disk');
    stored = structuredClone(state);
  };
  await device.onInit();
  await tick();
  assert.equal(device.getEnergySnapshot().meters.values.solar, 10);
  assert.equal(stored.channels.solar.raw, '1000');
  raw = '1050';
  failWrite = true;
  device.lastEnergyProbeAt = 0;
  await device.poll();
  assert.equal(Object.keys(device.getEnergySnapshot().meters.values).length, 0);
  assert.equal(stored.channels.solar.raw, '1000');
  assert.equal(device.available, true);
  failWrite = false;
  device.lastEnergyProbeAt = 0;
  await device.poll();
  assert.equal(device.getEnergySnapshot().meters.values.solar, 10.5);
  failRead = true;
  device.lastEnergyProbeAt = 0;
  await device.poll();
  assert.equal(device.getEnergySnapshot().gridW, 2000);
  assert.equal(Object.keys(device.getEnergySnapshot().meters.values).length, 0);
  assert.equal(device.available, true);
  await device.onUninit();
});

test('solar source selection reaches the shared probe and preserves an existing native zero until acknowledgement', async () => {
  const { PROFILE } = require('../lib/energy/meters');
  let stored;
  const modes = [];
  const { device } = deviceFixture({
    energyRead: async (_profile, mode) => {
      modes.push(mode);
      return {
        values: {
          solar: mode === 'combined' ? '7654300' : '0',
          imported: '1000',
          exported: '1000',
          charged: '1000',
          discharged: '1000',
        },
      };
    },
  });
  const settings = { ...device.getSettings(), energyMetersProfile: PROFILE, energyCounterEpoch: 0 };
  device.getSettings = () => settings;
  device.getStoreValue = () => stored;
  device.setStoreValue = async (_key, state) => {
    stored = structuredClone(state);
  };
  await device.onInit();
  await tick();
  assert.equal(device.getEnergySnapshot().meters.values.solar, 0);
  await device.onSettings({ newSettings: { ...settings, energySolarSource: 'combined' } });
  await tick();
  assert.equal(modes.at(-1), 'combined');
  assert.equal(device.getEnergySnapshot().solarSource, 'combined');
  assert.equal(device.getEnergySnapshot().meters.errors.solar, 'source-changed');
  assert.equal(device.getEnergySnapshot().meters.sourceValues.solar, 76543);
  assert.equal(device.getEnergySnapshot().meters.values.imported, 10);
  await device.onUninit();
});

test('selected solar watts reach native Energy, plant capability and history, including loss/recovery and source changes', async () => {
  const { project } = require('../lib/energy/reporting');
  const { HistoryStore } = require('../lib/history');
  let third = 3400;
  const modes = [];
  const { device, capabilities } = deviceFixture({
    snapshotRead: async (_reader, mode) => {
      modes.push(mode);
      return {
        ...snapshot,
        selfPvW: 1000,
        thirdPartyPvW: mode === 'self' ? null : third,
        pvW:
          mode === 'self'
            ? 1000
            : third === null
              ? null
              : mode === 'combined'
                ? 1000 + third
                : third,
      };
    },
  });
  let now = Date.now();
  const history = new HistoryStore(new Settings(), () => now++);
  device.homey.app.history = history;
  const settings = { ...device.getSettings(), energySolarSource: 'combined' };
  device.getSettings = () => settings;
  await device.onInit();
  await tick();
  const check = (expected) => {
    assert.equal(device.getEnergySnapshot().pvW, expected);
    assert.equal(project('solar', device.getEnergySnapshot())?.power ?? null, expected);
    assert.equal(capabilities.get('measure_pv_power'), expected);
    assert.equal(history.lastSamples.get('pvW').value, expected);
    assert.equal(device.getEnergySnapshot().gridW, 2000);
    assert.equal(device.getEnergySnapshot().essW, 500);
    assert.equal(device.available, true);
  };
  check(4400);
  assert.equal(device.getEnergySnapshot().thirdPartyPvW, 3400);
  now += 10000;
  third = null;
  await device.poll();
  check(null);
  now += 10000;
  third = 4000;
  await device.poll();
  check(5000);
  // Neither a failed read nor recovery bridges the missing solar interval.
  assert.ok([...history.pending.values()].every((row) => !row.pvWh));
  now += 10000;
  await device.onSettings({ newSettings: { ...settings, energySolarSource: 'self' } });
  await tick();
  check(1000);
  assert.equal(modes.at(-1), 'self');
  assert.ok([...history.pending.values()].every((row) => !row.pvWh));
  now += 10000;
  await device.poll();
  assert.ok([...history.pending.values()].some((row) => row.pvWh > 0));
  await device.onUninit();
});

test('grid history breaks continuity on off-grid readings, communication loss and reader replacement', async () => {
  let gridMode = 0,
    fail = false;
  const samples = [];
  const { device } = deviceFixture({
    snapshotRead: async () => {
      if (fail) throw Object.assign(Error('PRIVATE address'), { code: 'ETIMEDOUT' });
      return { ...snapshot, gridMode };
    },
  });
  const reasons = [],
    events = [];
  device.homey.app.dataDiagnostics = { record: (...args) => events.push(args) };
  device.homey.app.history.append = (value, _ms, reason) => {
    samples.push(value);
    reasons.push(reason);
  };
  await device.onInit();
  await tick();
  assert.equal(samples.find((s) => s.gridW === 2000).gridW, 2000);
  gridMode = 1;
  await device.poll();
  assert.equal(samples.filter((s) => Object.hasOwn(s, 'gridW')).at(-1).gridW, null);
  assert.equal(reasons.filter(Boolean).at(-1), 'off-grid');
  gridMode = 0;
  fail = true;
  await device.poll();
  assert.equal(samples.at(-1).gridW, null);
  assert.equal(samples.at(-1).essW, null);
  assert.equal(samples.at(-1).pvW, null);
  assert.equal(reasons.filter(Boolean).at(-1), 'modbus-timeout');
  fail = false;
  await device.poll();
  assert.equal(samples.filter((s) => Object.hasOwn(s, 'gridW')).at(-1).gridW, 2000);
  device.startReader({ ...device.getSettings(), host: '192.0.2.11' });
  assert.equal(samples.at(-1).gridW, null);
  assert.equal(samples.at(-1).essW, null);
  assert.equal(reasons.filter(Boolean).at(-1), 'connection-changed');
  assert.ok(events.some((e) => e[0] === 'plant' && e[1] === 'connection-changed'));
  await tick();
  await device.onUninit();
});

test('diagnostics record initial read failures before any valid sample and distinguish publication failures', async () => {
  let fail = true;
  const { device } = deviceFixture({
    snapshotRead: async () => {
      if (fail) throw Object.assign(Error('PRIVATE_ADDRESS'), { code: 'ECONNREFUSED' });
      return snapshot;
    },
  });
  const events = [];
  device.homey.app.dataDiagnostics = { record: (...args) => events.push(args) };
  await device.onInit();
  await tick();
  assert.ok(events.some((e) => e[0] === 'plant' && e[1] === 'modbus-refused'));
  assert.equal(device.pollFailure.reason, 'modbus-refused');
  fail = false;
  await device.poll();
  assert.equal(device.pollFailure, null);
  device.setCapabilityValue = async () => {
    throw Error('PRIVATE_VALUE');
  };
  await device.poll();
  assert.equal(device.pollFailure.reason, 'plant-processing-error');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  await device.onUninit();
});

test('an ongoing blocked polling loop is diagnosed without starting overlapping Modbus reads', async () => {
  let release,
    reads = 0;
  const { device } = deviceFixture({
    snapshotRead: () => {
      reads++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const events = [];
  device.homey.app.dataDiagnostics = { record: (...args) => events.push(args) };
  await device.onInit();
  await tick();
  device.pollStartedAt = Date.now() - 61000;
  await device.poll();
  assert.equal(reads, 1);
  assert.ok(events.some((e) => e[0] === 'plant' && e[1] === 'slow-poll' && e[3] - e[2] >= 61000));
  release(snapshot);
  await tick();
  assert.equal(device.polling, false);
  await device.onUninit();
});

test('gap recovery reuses the optional counter probe after persistence and cannot hide valid Energy totals on recovery failure', async () => {
  const { PROFILE } = require('../lib/energy/meters');
  let reads = 0,
    stored,
    failStore = false,
    resetCounters = false;
  const { device } = deviceFixture({
    energyRead: async () => {
      reads++;
      return {
        durationMs: 10,
        values: {
          solar: resetCounters ? '0' : '1000',
          imported: resetCounters ? '0' : '2000',
          exported: resetCounters ? '0' : '3000',
          charged: resetCounters ? '0' : '4000',
          discharged: resetCounters ? '0' : '5000',
        },
      };
    },
  });
  const settings = { ...device.getSettings(), energyMetersProfile: PROFILE };
  device.getSettings = () => settings;
  device.getStoreValue = () => stored;
  device.setStoreValue = async (_key, value) => {
    if (failStore) throw Error('synthetic');
    stored = value;
  };
  const observed = [];
  device.homey.app.history.observeCounters = (raw, binding) => {
    assert.ok(stored);
    observed.push({ raw, binding });
  };
  await device.onInit();
  await tick();
  assert.equal(reads, 1);
  assert.equal(observed.length, 1);
  assert.ok(observed[0].raw.durationMs >= 10);
  assert.equal(device.getEnergySnapshot().meters.values.imported, 20);
  resetCounters = true;
  device.lastEnergyProbeAt = 0;
  await device.poll();
  assert.equal(observed.length, 2);
  assert.deepEqual(
    Object.keys(observed[1].raw.values),
    [],
    'native reset-required channels cannot supply recovery',
  );
  resetCounters = false;
  failStore = true;
  device.lastEnergyProbeAt = 0;
  await device.poll();
  assert.equal(observed.length, 2);
  failStore = false;
  device.homey.app.history.observeCounters = () => {
    throw Error('synthetic');
  };
  device.lastEnergyProbeAt = 0;
  await device.poll();
  assert.equal(device.getEnergySnapshot().meters.values.imported, 20);
  await device.onUninit();
});
