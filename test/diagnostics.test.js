'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceStatus, diagnostics } = require('../lib/diagnostics');
const { temperatureContext } = require('../lib/optimization/temperature');
test('diagnostics distinguishes fresh, stale, missing, disabled and error', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(
    sourceStatus({ readAt: new Date(now - 1000).toISOString(), now, maxAgeMs: 5000 }).status,
    'ok',
  );
  assert.equal(
    sourceStatus({ readAt: new Date(now - 6000).toISOString(), now, maxAgeMs: 5000 }).status,
    'stale',
  );
  assert.equal(sourceStatus({ now, maxAgeMs: 5000 }).status, 'no-data');
  assert.equal(sourceStatus({ enabled: false, now, maxAgeMs: 5000 }).status, 'disabled');
  assert.equal(sourceStatus({ error: 'timeout', now, maxAgeMs: 5000 }).status, 'error');
});
test('diagnostics never reports control enabled', () => {
  const values = {
    sourceConfig: { sigenergy: { configured: true, enabled: true } },
    nibeHost: '192.0.2.2',
    sigenergyStatus: { readAt: new Date().toISOString() },
  };
  const d = diagnostics({ get: (k) => values[k] });
  assert.equal(d.controlEnabled, false);
  assert.equal(d.sigenergy.status, 'ok');
  assert.equal(d.nibe.status, 'no-data');
});
test('temperature model uses actual fresh BMS limits, never guessed derating', () => {
  const now = Date.now();
  const fresh = temperatureContext({
    outdoorC: -12,
    dischargeLimitKW: 3.5,
    observedAt: new Date(now).toISOString(),
    now,
  });
  assert.equal(fresh.dischargeLimitKW, 3.5);
  assert.equal(fresh.confidence, 'measured-bms-limit');
  const stale = temperatureContext({
    outdoorC: -12,
    dischargeLimitKW: 3.5,
    observedAt: new Date(now - 700000).toISOString(),
    now,
  });
  assert.equal(stale.dischargeLimitKW, null);
  assert.equal(stale.confidence, 'unknown');
});

test('future, invalid and pre-configuration timestamps never produce usable data', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  for (const readAt of ['bad-date', null, new Date(now + 1).toISOString()]) {
    const status = sourceStatus({ readAt, now, maxAgeMs: 5000 });
    assert.equal(status.usable, false);
    assert.notEqual(status.status, 'ok');
  }
  assert.equal(
    sourceStatus({
      readAt: new Date(now - 1000).toISOString(),
      since: new Date(now).toISOString(),
      now,
      maxAgeMs: 5000,
    }).status,
    'no-data',
  );
});

test('EVDC enablement is authoritative before the first successful sample', () => {
  const now = Date.now(),
    readAt = new Date(now - 1000).toISOString();
  const values = {
    sourceConfig: { evdc: { configured: true, enabled: true } },
    evdcEnabled: false,
  };
  const read = () => diagnostics({ get: (k) => values[k] }, now).evdc;
  assert.equal(read().status, 'no-data');
  values.evdcError = 'timeout';
  assert.equal(read().status, 'error');
  values.lastEvdc = { readAt };
  values.evdcError = null;
  assert.equal(read().status, 'ok');
  values.sourceConfig.evdc.enabled = false;
  assert.equal(read().status, 'disabled');
  assert.equal(read().usable, false);
  values.sourceConfig.evdc = {
    configured: true,
    enabled: true,
    since: new Date(now).toISOString(),
  };
  assert.equal(read().status, 'no-data');
});

test('optional battery failures are partial or failed, including per-field filtering', () => {
  const { batteryValues } = require('../lib/diagnostics');
  const now = Date.now();
  const values = {
    sourceConfig: { sigenergy: { configured: true, enabled: true } },
    batteryTelemetry: {
      readAt: new Date(now).toISOString(),
      values: { capacityKWh: 42, soc: 60 },
      errors: { chargePowerLimitKW: 'unsupported', dischargePowerLimitKW: 'timeout' },
    },
  };
  const read = () => diagnostics({ get: (k) => values[k] }, now).battery;
  assert.equal(read().status, 'error');
  assert.deepEqual(batteryValues(values.batteryTelemetry, read()), {});
  values.batteryTelemetry.values.soh = 98;
  assert.equal(read().status, 'partial');
  values.batteryTelemetry.values.dischargePowerLimitKW = 3;
  assert.equal(batteryValues(values.batteryTelemetry, read()).dischargePowerLimitKW, undefined);
  delete values.batteryTelemetry.errors.dischargePowerLimitKW;
  assert.equal(batteryValues(values.batteryTelemetry, read()).dischargePowerLimitKW, 3);
  values.sigenergyError = 'ECONNREFUSED';
  assert.equal(read().usable, false);
});

test('Nibe config changes and disablement invalidate previous successes and errors', () => {
  const { nibeKey } = require('../lib/diagnostics');
  const now = Date.now(),
    values = { nibeHost: '192.0.2.20', nibeStatus: { readAt: new Date(now).toISOString() } };
  values.sourceConfig = { nibe: { connectionKey: nibeKey(values) } };
  const read = () => diagnostics({ get: (k) => values[k] }, now).nibe;
  assert.equal(read().status, 'ok');
  values.nibeHost = '192.0.2.21';
  values.nibeError = 'old failure';
  assert.equal(read().status, 'no-data');
  values.nibeHost = '';
  assert.equal(read().status, 'disabled');
});

test('temperature context and automatic battery values reject future timestamps consistently', () => {
  const { effectiveBatteryConfig, DEFAULT_OPTIMIZER } = require('../lib/optimization/simulator');
  const now = Date.now(),
    future = new Date(now + 60000).toISOString();
  assert.equal(
    temperatureContext({
      outdoorC: -5,
      outdoorObservedAt: future,
      dischargeLimitKW: 2,
      observedAt: future,
      now,
    }).outdoorC,
    null,
  );
  assert.equal(
    temperatureContext({ dischargeLimitKW: 2, observedAt: future, now }).dischargeLimitKW,
    null,
  );
  assert.equal(
    effectiveBatteryConfig(
      DEFAULT_OPTIMIZER,
      { readAt: future, values: { capacityKWh: 5 } },
      { autoBatteryValues: true, now },
    ).batteryCapacityKWh,
    42,
  );
  const status = sourceStatus({
    readAt: new Date(now).toISOString(),
    error: 'timeout',
    now,
    maxAgeMs: 600000,
  });
  assert.equal(
    effectiveBatteryConfig(
      DEFAULT_OPTIMIZER,
      { readAt: new Date(now).toISOString(), values: { capacityKWh: 5 } },
      { autoBatteryValues: true, status },
    ).batteryCapacityKWh,
    42,
  );
});

test('browser copies are identical to the shared status implementation', () => {
  const fs = require('node:fs'),
    path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../lib/source-status.js'), 'utf8');
  for (const file of [
    'settings/source-status.js',
    'widgets/energy-overview/public/source-status.js',
  ])
    assert.equal(
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      source,
      'Run node scripts/sync-source-status.js',
    );
});
