'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceStatus, diagnostics } = require('../lib/diagnostics');
const { temperatureContext } = require('../lib/optimization/temperature');
test('diagnostics distinguishes fresh, stale, missing, disabled and error', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(sourceStatus({ readAt: new Date(now - 1000).toISOString(), now, maxAgeMs: 5000 }).status, 'ok');
  assert.equal(sourceStatus({ readAt: new Date(now - 6000).toISOString(), now, maxAgeMs: 5000 }).status, 'stale');
  assert.equal(sourceStatus({ now, maxAgeMs: 5000 }).status, 'no-data');
  assert.equal(sourceStatus({ enabled: false, now, maxAgeMs: 5000 }).status, 'disabled');
  assert.equal(sourceStatus({ error: 'timeout', now, maxAgeMs: 5000 }).status, 'error');
});
test('diagnostics never reports control enabled', () => {
  const values = { nibeHost: '192.0.2.2', sigenergyStatus: { readAt: new Date().toISOString() } };
  const d = diagnostics({ get: k => values[k] });
  assert.equal(d.controlEnabled, false);
  assert.equal(d.sigenergy.status, 'ok');
  assert.equal(d.nibe.status, 'no-data');
});
test('temperature model uses actual fresh BMS limits, never guessed derating', () => {
  const now = Date.now();
  const fresh = temperatureContext({ outdoorC: -12, dischargeLimitKW: 3.5, observedAt: new Date(now).toISOString(), now });
  assert.equal(fresh.dischargeLimitKW, 3.5);
  assert.equal(fresh.confidence, 'measured-bms-limit');
  const stale = temperatureContext({ outdoorC: -12, dischargeLimitKW: 3.5, observedAt: new Date(now - 700000).toISOString(), now });
  assert.equal(stale.dischargeLimitKW, null);
  assert.equal(stale.confidence, 'unknown');
});
