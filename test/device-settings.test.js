'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('settings change connects with new settings before Homey updates getSettings', async () => {
  const readers = [];
  class Reader {
    constructor(settings) {
      this.settings = settings;
      readers.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../drivers/sigenergy/device.js'), 'utf8'),
    {
      module,
      require(id) {
        if (id === 'homey') return { Device: class {} };
        if (id === '../../lib/modbus') return { SigenergyReader: Reader };
        if (id === '../../lib/charging/evdc') return {};
        if (id === '../../lib/backup/island-controller')
          return require('../lib/backup/island-controller');
        throw new Error(`Unexpected dependency: ${id}`);
      },
    },
    { filename: path.join(__dirname, '../drivers/sigenergy/device.js') },
  );
  const device = new module.exports();
  const oldSettings = { host: '192.0.2.10', port: 502, unitId: 247, pollSeconds: 10 };
  const newSettings = { ...oldSettings, host: '192.0.2.20', port: 503, unitId: 1, pollSeconds: 20 };
  const cleared = [],
    intervals = [];
  device.getSettings = () => oldSettings;
  const values = new Map();
  device.setCapabilityValue = async () => {};
  device.error = () => {};
  device.homey = {
    settings: { get: (key) => values.get(key), set: (key, value) => values.set(key, value) },
    setInterval(callback, ms) {
      intervals.push(ms);
      return intervals.length;
    },
    clearInterval(timer) {
      cleared.push(timer);
    },
  };
  device.poll = async () => {};
  device.startReader();
  assert.equal(readers[0].settings, oldSettings);
  await device.onSettings({
    oldSettings,
    newSettings,
    changedKeys: ['host', 'port', 'unitId', 'pollSeconds'],
  });
  assert.equal(readers[0].closed, true);
  assert.equal(readers[1].settings, newSettings);
  assert.deepEqual(cleared, [1]);
  assert.deepEqual(intervals, [10000, 20000]);
});
