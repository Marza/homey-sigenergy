'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recommend } = require('../lib/optimization/recommendation');
const { DEFAULT_OPTIMIZER } = require('../lib/optimization/simulator');
test('no recommendation without history', () => {
  assert.equal(recommend([], DEFAULT_OPTIMIZER).status, 'insufficient-data');
});
test('recommendation is advisory and has 0.1 kW increments', () => {
  const t = Date.now();
  const slots = Array.from({ length: 12 }, (_, i) => ({
    t: t + i * 900000,
    gridWh: 500,
    essWh: 0,
    coverageMs: 900000,
  }));
  const r = recommend(slots, DEFAULT_OPTIMIZER);
  assert.equal(r.status, 'illustrative');
  assert.equal(r.advisoryOnly, true);
  assert.equal(Math.round(r.capKW * 10), r.capKW * 10);
  assert.equal(r.tariffVerified, false);
});
