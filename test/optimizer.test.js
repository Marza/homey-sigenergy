'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_OPTIMIZER,
  validateOptimizer,
  replay,
  simulate,
} = require('../lib/optimization/simulator');
const { resolveOperation, assertReadOnly } = require('../lib/operation-mode');
const slot = (gridWh, essWh = 0) => ({
  t: Math.floor(Date.now() / 900000) * 900000,
  gridWh,
  essWh,
  coverageMs: 900000,
});
test('learning mode always prevents writes even if user requests control', () => {
  assert.equal(
    resolveOperation({ mode: 'control', allowHardwareWrites: true }).allowHardwareWrites,
    false,
  );
  assert.throws(assertReadOnly, /disabled/);
});
test('optimizer defaults valid and ranges checked', () => {
  assert.equal(validateOptimizer({}).batteryCapacityKWh, 42);
  assert.throws(() => validateOptimizer({ capStepKW: 0 }));
  assert.throws(() => validateOptimizer({ reserveMinPercent: 90, reserveMaxPercent: 20 }));
});
test('replay uses ESS charging sign to infer demand', () => {
  const result = replay([slot(1000, 250)], { ...DEFAULT_OPTIMIZER, initialSocPercent: 80 }, 4, 20);
  assert.equal(result.validSlots, 1);
  assert.ok(result.dischargedKWh > 0);
  assert.ok(result.peakKW <= 5);
});
test('cold battery discharge cap can be configured', () => {
  const result = replay(
    [slot(2500)],
    { ...DEFAULT_OPTIMIZER, maxDischargeKW: 2, initialSocPercent: 80 },
    4,
    20,
  );
  assert.ok(result.peakKW >= 8);
});
test('empty history cannot produce valid recommendation', () => {
  assert.equal(simulate([], {}).status, 'insufficient-data');
});
test('reserve prevents discharge below floor', () => {
  const result = replay([slot(2500)], { ...DEFAULT_OPTIMIZER, initialSocPercent: 20 }, 4, 20);
  assert.equal(result.dischargedKWh, 0);
});
