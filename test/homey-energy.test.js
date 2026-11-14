'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const {
  ROLES,
  project,
  sourceDevice,
  createDriver,
  createDevice,
} = require('../lib/energy/reporting');
const manifest = require('../app.json');
const Homey = { Driver: class {}, Device: class {} };
const snapshot = (extra = {}) => ({
  generation: 1,
  readAt: Date.now(),
  maxAgeMs: 30000,
  gridW: 300,
  pvW: 1000,
  essW: -400,
  soc: 60,
  gridMode: 0,
  ...extra,
});
function fixture(role = 'grid', initial = snapshot()) {
  let data = initial,
    parents = [];
  const writes = [],
    cleared = [],
    timers = [],
    values = new Map();
  const parent = {
    getData: () => ({ id: 'plant' }),
    getName: () => 'Plant',
    getEnergySnapshot: () => data,
  };
  parents = [parent];
  const Device = createDevice(Homey, role),
    device = new Device();
  const capabilities = new Set(['measure_power']);
  device.hasCapability = (id) => capabilities.has(id);
  device.addCapability = async (id) => capabilities.add(id);
  device.getSettings = () => ({ enabled: true });
  device.getData = () => ({ id: 'energy', sourceId: 'plant' });
  device.setCapabilityValue = async (k, v) => {
    writes.push([k, v]);
    values.set(k, v);
  };
  device.setUnavailable = async () => {
    device.available = false;
  };
  device.setAvailable = async () => {
    device.available = true;
  };
  device.error = () => {};
  device.homey = {
    drivers: {
      getDriver: (id) => {
        assert.equal(id, 'sigenergy');
        return { getDevices: () => parents };
      },
    },
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval: (id) => cleared.push(id),
  };
  return {
    device,
    parent,
    values,
    writes,
    timers,
    cleared,
    set: (dataNext) => {
      data = dataNext;
    },
    remove: () => {
      parents = [];
    },
  };
}
test('native Energy manifest separates grid, solar and battery without control capabilities or modifying plant pairing', () => {
  const source = manifest.drivers.find((d) => d.id === 'sigenergy');
  assert.ok(!source.capabilities.includes('measure_power'));
  for (const role of ROLES) {
    const driver = manifest.drivers.find((d) => d.id === 'energy-' + role);
    assert.ok(driver.capabilities.includes('measure_power'));
    assert.ok(!driver.capabilities.some((c) => /target_power|onoff/.test(c)));
    assert.equal(driver.pair[0].navigation.next, 'add_devices');
    assert.equal(driver.settings[0].value, true);
    assert.ok(fs.existsSync(path.join(__dirname, '../drivers', driver.id, 'assets/icon.svg')));
    for (const file of ['driver.js', 'device.js']) {
      const module = { exports: {} };
      vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, '../drivers', driver.id, file), 'utf8'),
        { module, require: (id) => (id === 'homey' ? Homey : require('../lib/energy/reporting')) },
      );
      assert.equal(typeof module.exports, 'function');
    }
  }
  assert.equal(manifest.drivers.find((d) => d.id === 'energy-grid').energy.cumulative, true);
  assert.equal(manifest.drivers.find((d) => d.id === 'energy-solar').class, 'solarpanel');
  assert.equal(manifest.drivers.find((d) => d.id === 'energy-battery').energy.homeBattery, true);
});
test('directions and measured zero are preserved; invalid, future, stale and off-grid values stay unavailable', () => {
  const s = snapshot();
  assert.deepEqual(project('grid', s), { power: 300 });
  assert.deepEqual(project('solar', s), { power: 1000 });
  assert.deepEqual(project('battery', s), { power: -400, soc: 60 });
  for (const role of ROLES)
    assert.equal(project(role, snapshot({ gridW: 0, pvW: 0, essW: 0 })).power, 0);
  assert.equal(project('grid', snapshot({ gridW: -500 })).power, -500);
  assert.equal(project('battery', snapshot({ essW: 500 })).power, 500);
  for (const broken of [
    null,
    snapshot({ readAt: NaN }),
    snapshot({ readAt: Date.now() + 100000 }),
    snapshot({ readAt: Date.now() - 40000 }),
    snapshot({ maxAgeMs: 0 }),
    snapshot({ maxAgeMs: NaN }),
  ])
    assert.equal(project('grid', broken), null);
  for (const gridMode of [1, 2, 99, null])
    assert.equal(project('grid', snapshot({ gridMode })), null);
  assert.equal(project('solar', snapshot({ pvW: -1 })), null);
  assert.equal(project('grid', snapshot({ gridW: Infinity })), null);
  assert.equal(project('battery', snapshot({ essW: 1e9 })), null);
  assert.equal(project('battery', snapshot({ soc: -1 })).soc, null);
  assert.equal(project('battery', snapshot({ soc: 101 })).soc, null);
  assert.throws(() => project('unknown', s));
  assert.throws(() => createDriver(Homey, 'unknown'));
  assert.throws(() => createDevice(Homey, 'unknown'));
});
test('pairing explicitly links each role to a plant and omits already paired/invalid sources', async () => {
  for (const role of ROLES) {
    const { device, parent } = fixture(role);
    const Driver = createDriver(Homey, role),
      driver = new Driver();
    driver.homey = device.homey;
    driver.getDevices = () => [];
    const listed = await driver.onPairListDevices();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].data.sourceId, 'plant');
    assert.equal(listed[0].data.id, JSON.stringify(['plant', role]));
    driver.getDevices = () => [{ getData: () => ({ sourceId: 'plant' }) }];
    assert.equal((await driver.onPairListDevices()).length, 0);
    assert.equal(sourceDevice(device.homey, 'plant'), parent);
    assert.equal(sourceDevice(device.homey, 'absent'), null);
    assert.equal(sourceDevice(device.homey, ''), null);
  }
});
test('fresh values are read from the shared parent; loss/staleness clears them and recovery restores them', async () => {
  for (const role of ROLES) {
    const f = fixture(role);
    await f.device.onInit();
    assert.equal(f.device.available, true);
    assert.equal(f.timers[0].ms, 5000);
    assert.equal(f.writes[0][1], null);
    f.set(null);
    await f.device.queueEnergy();
    assert.equal(f.values.get('measure_power'), null);
    assert.equal(f.device.available, false);
    f.set(snapshot({ readAt: Date.now() - 60000 }));
    await f.device.queueEnergy();
    assert.equal(f.device.available, false);
    f.set(snapshot());
    await f.device.queueEnergy();
    assert.equal(f.device.available, true);
    await f.device.onSettings({ newSettings: { enabled: false } });
    assert.equal(f.values.get('measure_power'), null);
    assert.equal(f.device.available, false);
    await f.device.onSettings({ newSettings: { enabled: true } });
    assert.equal(f.device.available, true);
    f.remove();
    await f.device.queueEnergy();
    assert.equal(f.device.available, false);
    await f.device.onDeleted();
    assert.ok(f.cleared.length);
    await f.device.queueEnergy();
    assert.equal(f.values.get('measure_power'), null);
  }
});
test('missing driver/parent at startup remains unavailable and can recover without new Modbus readers', async () => {
  const f = fixture();
  const original = f.device.homey.drivers.getDriver;
  f.device.homey.drivers.getDriver = () => {
    throw Error('not ready');
  };
  await f.device.onInit();
  assert.equal(f.device.available, false);
  f.device.homey.drivers.getDriver = original;
  await f.timers[0].fn();
  assert.equal(f.device.available, true);
  await f.device.onUninit();
});
test('in-flight source replacement and settings disable cannot republish an old available measurement', async () => {
  for (const action of ['replace', 'disable', 'stop']) {
    const f = fixture();
    await f.device.onInit();
    let resolve;
    const setter = f.device.setCapabilityValue;
    f.device.setCapabilityValue = (key, value) =>
      value === 300
        ? new Promise((r) => {
            resolve = async () => {
              await setter(key, value);
              r();
            };
          })
        : setter(key, value);
    const pending = f.device.queueEnergy();
    await new Promise((r) => setImmediate(r));
    assert.equal(f.device.queueEnergy(), pending);
    let change;
    if (action === 'replace') f.set(snapshot({ generation: 2 }));
    else if (action === 'disable')
      change = f.device.onSettings({ newSettings: { enabled: false } });
    else change = f.device.onUninit();
    await resolve();
    await pending;
    if (change) await change;
    assert.equal(f.values.get('measure_power'), null);
    assert.equal(f.device.available, false);
    if (action !== 'stop') await f.device.onUninit();
  }
});
test('failed capability writes mark the device unavailable and a later timer can recover', async () => {
  const f = fixture('battery');
  await f.device.onInit();
  const setter = f.device.setCapabilityValue;
  f.device.setCapabilityValue = async (k, v) => {
    if (v !== null) throw Error('write failed');
    return setter(k, v);
  };
  await assert.rejects(f.device.queueEnergy(), /write failed/);
  assert.equal(f.device.available, false);
  assert.equal(f.values.get('measure_power'), null);
  f.device.setCapabilityValue = setter;
  await f.device.queueEnergy();
  assert.equal(f.device.available, true);
  f.device.setCapabilityValue = async (k, v) => {
    if (k === 'measure_power' && v === null) throw Error('clear failed');
    return setter(k, v);
  };
  await assert.rejects(f.device.clearEnergy(), /clear failed/);
  assert.equal(f.device.available, false);
  assert.equal(f.values.get('measure_battery'), null);
  f.device.setCapabilityValue = setter;
  await f.device.onUninit();
});

test('existing Energy devices gain kWh fields once and keep native Energy exclusion configuration', async () => {
  const { PROFILE, CAPABILITIES } = require('../lib/energy/meters');
  for (const role of ROLES) {
    const f = fixture(
      role,
      snapshot({
        meterProfile: PROFILE,
        meters: {
          readAt: Date.now(),
          values: { imported: 12, exported: 3, solar: 24, charged: 5, discharged: 4 },
          errors: {},
        },
      }),
    );
    const added = [];
    f.device.addCapability = async (id) => {
      added.push(id);
      f.device.hasCapability = (cap) => added.includes(cap) || cap === 'measure_power';
    };
    await f.device.onInit();
    assert.deepEqual(added, [...Object.values(CAPABILITIES[role]), 'measure_energy_status']);
    assert.equal(f.values.get('measure_energy_status'), 'ok');
    for (const cap of Object.values(CAPABILITIES[role]))
      assert.equal(typeof f.values.get(cap), 'number');
    await f.device.onUninit();
    await f.device.onInit();
    assert.equal(added.length, Object.keys(CAPABILITIES[role]).length + 1);
    f.set(
      snapshot({
        meterProfile: PROFILE,
        meters: {
          readAt: Date.now(),
          values: {},
          errors: { imported: 'reset-required', exported: 'reset-required' },
        },
      }),
    );
    await f.device.queueEnergy();
    assert.equal(f.device.available, true);
    for (const cap of Object.values(CAPABILITIES[role])) assert.equal(f.values.get(cap), null);
    await f.device.onUninit();
  }
});
