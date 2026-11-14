'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const api = require('../api'),
  manifest = require('../app.json');
const { getCounterDiagnostics } = require('../lib/energy/diagnostics');
const { PROFILE } = require('../lib/energy/meters');
test('authenticated diagnostics distinguish raw source energy from normalized Energy totals and omit private metadata', async () => {
  assert.deepEqual(manifest.api.getEnergyCounters, {
    method: 'GET',
    path: '/energy/counters',
    public: false,
  });
  const now = Date.now();
  const snapshot = {
    readAt: now,
    maxAgeMs: 30000,
    meterProfile: PROFILE,
    solarSource: 'combined',
    selfPvW: 1200,
    thirdPartyPvW: 3400,
    pvW: 4600,
    host: 'private-host',
    sourceKey: 'private-key',
    meters: {
      readAt: now,
      sourceValues: { solar: 76543, imported: 100, unknown: 99, token: 'private-token' },
      values: { solar: 0.1, imported: 100, exported: 0 },
      errors: {},
      state: { secret: 'private-state' },
    },
  };
  const homey = {
    drivers: {
      getDriver: (id) => {
        assert.equal(id, 'sigenergy');
        return { getDevices: () => [{ getEnergySnapshot: () => snapshot }] };
      },
    },
  };
  const result = await api.getEnergyCounters({ homey });
  assert.equal(result.sources[0].solarSource, 'combined');
  assert.equal(result.sources[0].raw.solar, 76543);
  assert.equal(result.sources[0].published.solar, 0.1);
  assert.equal(result.sources[0].powerFresh, true);
  assert.equal(result.sources[0].powerReadAt, now);
  assert.deepEqual(result.sources[0].solarPowerW, {
    selfPvW: 1200,
    thirdPartyPvW: 3400,
    pvW: 4600,
  });
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!('unknown' in result.sources[0].raw));
  assert.equal(getCounterDiagnostics(homey, now + 40000).sources[0].powerFresh, false);
  snapshot.meters.values.solar = Infinity;
  assert.ok(!('solar' in getCounterDiagnostics(homey).sources[0].published));
});
test('missing snapshots expose no invented zero or identifiers', () => {
  const homey = {
    drivers: {
      getDriver: () => ({
        getDevices: () => [
          { getEnergySnapshot: () => null, getData: () => ({ id: 'private-id' }) },
        ],
      }),
    },
  };
  const result = getCounterDiagnostics(homey);
  assert.equal(result.sources[0].profile, 'disabled');
  assert.deepEqual(result.sources[0].raw, {});
  assert.equal(result.sources[0].readAt, null);
  assert.equal(result.sources[0].powerReadAt, null);
  assert.deepEqual(result.sources[0].solarPowerW, {});
  assert.equal(result.sources[0].powerFresh, false);
});
