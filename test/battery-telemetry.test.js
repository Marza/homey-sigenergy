'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'modbus-serial') return class FakeModbus {};
  return originalLoad.apply(this, arguments);
};
const { validateBatteryTelemetry, OPTIONAL_BATTERY_REGISTERS } = require('../lib/modbus');
Module._load = originalLoad;
const { DEFAULT_OPTIMIZER, effectiveBatteryConfig } = require('../lib/optimization/simulator');
test('battery register catalogue includes cutoffs and dynamic power', () => {
  assert.equal(OPTIONAL_BATTERY_REGISTERS.dischargePowerLimitKW.address, 30049);
  assert.equal(OPTIONAL_BATTERY_REGISTERS.dischargeCutoffSoc.address, 30086);
});
test('reject implausible and inverted cutoff values', () => {
  assert.deepEqual(validateBatteryTelemetry({ soh: 120, chargeCutoffSoc: 10, dischargeCutoffSoc: 90 }), {});
});
test('fresh telemetry limits power and raises safety floor', () => {
  const result = effectiveBatteryConfig(DEFAULT_OPTIMIZER, {
    readAt: new Date().toISOString(), values: { capacityKWh: 41.5, soc: 50, dischargePowerLimitKW: 3, dischargeCutoffSoc: 20 },
  }, { autoBatteryValues: true });
  assert.equal(result.maxDischargeKW, 3);
  assert.equal(result.batteryCapacityKWh, 41.5);
  assert.equal(result.backupReservePercent, 20);
});
test('stale telemetry and manual mode use manual values', () => {
  const telemetry = { readAt: '2020-01-01T00:00:00Z', values: { capacityKWh: 10 } };
  assert.equal(effectiveBatteryConfig(DEFAULT_OPTIMIZER, telemetry, { autoBatteryValues: true }).batteryCapacityKWh, 42);
  assert.equal(effectiveBatteryConfig(DEFAULT_OPTIMIZER, { ...telemetry, readAt: new Date().toISOString() }, { autoBatteryValues: false }).batteryCapacityKWh, 42);
});
test('default cap step is 0.1 kW', () => assert.equal(DEFAULT_OPTIMIZER.capStepKW, 0.1));

test('optional probe records rejected values as individual register errors', async () => {
  const { SigenergyReader } = require('../lib/modbus');
  const reader = new SigenergyReader({ host: '192.0.2.10' });
  reader.read = async (address, count) => Array(count).fill(65535);
  const result = await reader.batteryTelemetry();
  assert.deepEqual(result.values, {});
  assert.deepEqual(Object.keys(result.errors).sort(), Object.keys(OPTIONAL_BATTERY_REGISTERS).sort());
});
