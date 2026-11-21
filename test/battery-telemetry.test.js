'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, _parent, _isMain) {
  if (request === 'modbus-serial') return class FakeModbus {};
  return originalLoad.apply(this, arguments);
};
const { validateBatteryTelemetry, OPTIONAL_BATTERY_REGISTERS } = require('../lib/modbus');
Module._load = originalLoad;
test('battery register catalogue includes cutoffs and dynamic power', () => {
  assert.equal(OPTIONAL_BATTERY_REGISTERS.dischargePowerLimitKW.address, 30049);
  assert.equal(OPTIONAL_BATTERY_REGISTERS.dischargeCutoffSoc.address, 30086);
});
test('reject implausible and inverted cutoff values', () => {
  assert.deepEqual(
    validateBatteryTelemetry({ soh: 120, chargeCutoffSoc: 10, dischargeCutoffSoc: 90 }),
    {},
  );
});
test('optional probe records rejected values as individual register errors', async () => {
  const { SigenergyReader } = require('../lib/modbus');
  const reader = new SigenergyReader({ host: '192.0.2.10' });
  reader.read = async (address, count) => Array(count).fill(65535);
  const result = await reader.batteryTelemetry();
  assert.deepEqual(result.values, {});
  assert.deepEqual(
    Object.keys(result.errors).sort(),
    Object.keys(OPTIONAL_BATTERY_REGISTERS).sort(),
  );
});
