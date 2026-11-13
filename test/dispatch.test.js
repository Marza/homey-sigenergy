'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateSolar, efficiencyAt, DEFAULT_PROFILE } = require('../lib/charging/dispatch');
const base = {
  surplusKW: 6,
  evConnected: true,
  evSoc: 40,
  homeSoc: 50,
  evValuePerKWh: 2,
  homeValuePerKWh: 1,
  exportPricePerKWh: 0,
};
test('interpolates power dependent efficiency', () => {
  assert.equal(efficiencyAt(DEFAULT_PROFILE.ev.points, 7), 0.92);
  assert.ok(
    efficiencyAt(DEFAULT_PROFILE.ev.points, 3) < efficiencyAt(DEFAULT_PROFILE.ev.points, 7),
  );
});
test('prioritizes car when its stored energy is more valuable', () => {
  const result = allocateSolar(base);
  assert.equal(result.evKW, 6);
  assert.equal(result.homeKW, 0);
});
test('prioritizes home when car is at solar target', () => {
  const result = allocateSolar({ ...base, evSoc: 80 });
  assert.equal(result.evKW, 0);
  assert.equal(result.homeKW, 6);
});
test('exports when export price exceeds stored energy value', () => {
  const result = allocateSolar({ ...base, exportPricePerKWh: 3 });
  assert.equal(result.exportKW, 6);
});
test('does not schedule EV below minimum supported power', () => {
  const result = allocateSolar({ ...base, surplusKW: 1, homeSoc: 100 });
  assert.equal(result.evKW, 0);
  assert.equal(result.exportKW, 1);
});
test('disconnected car never charges', () => {
  assert.equal(allocateSolar({ ...base, evConnected: false }).evKW, 0);
});
test('headroom limits charging and leaves excess for export', () => {
  const result = allocateSolar({ ...base, gridHeadroomKW: 2 });
  assert.ok(result.evKW + result.homeKW <= 2);
  assert.ok(result.exportKW >= 4);
});
test('rejects invalid SoC', () => {
  assert.throws(() => allocateSolar({ ...base, evSoc: 105 }), /Invalid/);
});
