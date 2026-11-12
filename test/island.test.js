'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IslandController, decodeGridMode } = require('../lib/backup/island-controller');
test('decode all documented modes and unknowns', () => {
  assert.equal(decodeGridMode(0), 'on-grid');
  assert.equal(decodeGridMode(1), 'off-grid');
  assert.equal(decodeGridMode(2), 'off-grid');
  assert.equal(decodeGridMode(3), 'unknown');
});
test('island mode immediately requests EV stop and Nibe economy', () => {
  const c = new IslandController(); const s = c.update(1, 70);
  assert.equal(s.evStopRequested, true); assert.equal(s.nibeModeRequested, 'economy');
  assert.equal(s.controlApplied, false);
});
test('critical reserve under 25 percent', () => {
  const c = new IslandController(); assert.equal(c.update(2, 20).nibeModeRequested, 'critical');
});
test('restoration requires continuous stable grid', () => {
  let time = 0; const c = new IslandController({ now: () => time, restoreDelayMs: 300000 });
  c.update(1, 70); assert.equal(c.update(0, 70).mode, 'off-grid');
  time = 299999; assert.equal(c.update(0, 70).mode, 'off-grid');
  time = 300000; assert.equal(c.update(0, 70).mode, 'on-grid');
});
test('unknown grid state fails closed and resets restoration', () => {
  let time = 0; const c = new IslandController({ now: () => time });
  c.update(1, 60); c.update(0, 60); time = 100000;
  const s = c.communicationLost(); assert.equal(s.mode, 'unknown'); assert.equal(s.evStopRequested, true);
  assert.equal(c.update(0, 60).mode, 'unknown');
});
