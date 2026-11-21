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

test('optional battery telemetry decodes three blocks with independent offsets and scales', async () => {
  const { SigenergyReader } = require('../lib/modbus');
  const r = new SigenergyReader({});
  const calls = [];
  r.read = async (addr, count) => {
    calls.push([addr, count]);
    return {
      30047: [0, 7000, 0, 9000],
      30064: [0, 700, 0, 800, 0, 3500, 0, 4500],
      30085: [950, 100, 980],
    }[addr];
  };
  const result = await r.batteryTelemetry();
  assert.deepEqual(calls, [
    [30047, 4],
    [30064, 8],
    [30085, 3],
  ]);
  assert.deepEqual(result.values, {
    chargePowerLimitKW: 7,
    dischargePowerLimitKW: 9,
    availableChargeKWh: 7,
    availableDischargeKWh: 8,
    nominalChargeKW: 3.5,
    nominalDischargeKW: 4.5,
    chargeCutoffSoc: 95,
    dischargeCutoffSoc: 10,
    soh: 98,
  });
});
test('optional blocks isolate unsupported registers and retry transient failures next probe', async () => {
  const { SigenergyReader } = require('../lib/modbus');
  const r = new SigenergyReader({});
  r.read = async (address, count) => {
    if (address === 30085 && count === 3) throw Object.assign(Error('too many'), { modbusCode: 3 });
    if (address === 30086 || address === 30064) throw Error('unavailable');
    return Array(count).fill(0);
  };
  const result = await r.batteryTelemetry();
  assert.equal(result.values.soh, 0);
  assert.equal(result.values.chargeCutoffSoc, 0);
  assert.ok(result.errors.dischargeCutoffSoc);
  assert.ok(result.errors.nominalChargeKW);
  assert.equal(result.values.chargePowerLimitKW, 0);
});
