'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSolarPreview, previewSolar } = require('../lib/charging/solar-preview');
const api = require('../api');
const manifest = require('../app.json');
const now = Date.parse('2026-06-10T10:00:00Z');
const snapshot = () => ({
  readAt: now - 1000,
  maxAgeMs: 30000,
  generation: 1,
  gridMode: 0,
  gridW: -5000,
  pvW: 8000,
  essW: 1000,
  soc: 50,
  capacityKWh: 20,
  solarSource: 'combined',
  host: 'private-host',
});
const input = () => ({
  durationMinutes: 5,
  priority: 'home-first',
  home: { enabled: true, targetSoc: 80, maxPowerKW: 4, efficiency: 0.9 },
  ev: {
    connected: true,
    soc: 40,
    observedAt: new Date(now - 1000).toISOString(),
    targetSoc: 80,
    currentPowerKW: 0,
    minPowerKW: 1.5,
    maxPowerKW: 7,
  },
});
const evConfig = { usableBatteryKWh: 60, chargingEfficiency: 0.9, maxChargingPowerKW: 6 };
const preview = (options = {}) =>
  createSolarPreview({
    snapshot: snapshot(),
    input: input(),
    evConfig,
    advisory: { restricted: false },
    now,
    ...options,
  });
const watts = (r, d) => r.allocations.find((a) => a.destination === d).additionalKW;
function conserved(r) {
  assert.ok(
    Math.abs(r.allocations.reduce((n, a) => n + a.additionalKW, 0) - r.budget.availableSolarKW) <
      0.00001,
  );
  assert.equal(r.advisoryOnly, true);
  assert.equal(r.controlApplied, false);
  assert.ok(!JSON.stringify(r).includes('private'));
}
test('instantaneous export budget respects existing charging and explicit priorities without requiring prices', () => {
  const r = preview();
  conserved(r);
  assert.equal(r.budget.availableSolarKW, 5);
  assert.equal(watts(r, 'home'), 3);
  assert.equal(watts(r, 'ev'), 2);
  assert.equal(watts(r, 'export'), 0);
  assert.equal(r.assumptions.consumers.home.currentKW, 1);
  assert.equal(r.assumptions.economicRanking, false);
  assert.equal(r.observed.solarSource, 'combined');
  assert.equal(Date.parse(r.validUntil), now + 29000);
  const i = input();
  i.priority = 'ev-first';
  const ev = preview({ input: i });
  conserved(ev);
  assert.equal(watts(ev, 'ev'), 5);
  assert.equal(watts(ev, 'home'), 0);
});
test('battery-supplied exports and nighttime production are never labelled available solar', () => {
  for (const [patch, expected] of [
    [{ gridW: -5000, essW: -3000 }, 2],
    [{ gridW: -5000, essW: -7000 }, 0],
    [{ gridW: 1000, essW: 1000 }, 0],
    [{ gridW: 0 }, 0],
    [{ gridW: -5000, pvW: 0, essW: -5000 }, 0],
    [{ gridW: -9000, pvW: 1000, essW: 0 }, 1],
  ]) {
    const r = preview({ snapshot: { ...snapshot(), ...patch } });
    conserved(r);
    assert.equal(r.budget.availableSolarKW, expected);
    assert.equal(r.status, expected ? 'preview' : 'no-surplus');
    if (patch.essW < 0) {
      assert.equal(watts(r, 'home'), 0);
      assert.equal(r.assumptions.consumers.home.dischargeBlocked, true);
    }
  }
});
test('capacity/SoC room, ongoing charging and EV minimum bound additional power over the full scenario', () => {
  const i = input();
  i.durationMinutes = 15;
  i.home.targetSoc = 51;
  i.home.maxPowerKW = 20;
  const r = preview({ input: i });
  assert.equal(watts(r, 'home'), 0); // Baseline charge alone exceeds target room.
  i.home.enabled = false;
  i.ev.soc = 79.9;
  i.ev.targetSoc = 80;
  const near = preview({ input: i });
  assert.equal(watts(near, 'ev'), 0); // Too little energy room for minimum charging power.
  i.ev.currentPowerKW = 2;
  assert.equal(watts(preview({ input: i }), 'ev'), 0);
  i.ev.soc = 40;
  i.ev.currentPowerKW = 5;
  i.ev.minPowerKW = 1.5;
  const alreadyCharging = preview({ input: i });
  assert.equal(watts(alreadyCharging, 'ev'), 1); // saved 6 kW total maximum
  i.ev.currentPowerKW = 0;
  i.ev.minPowerKW = 6;
  const low = preview({ input: i });
  assert.equal(watts(low, 'ev'), 0);
  assert.equal(watts(low, 'export'), 5);
  i.ev.connected = false;
  assert.equal(watts(preview({ input: i }), 'export'), 5);
  const disabled = {
    durationMinutes: 5,
    priority: 'home-first',
    home: { enabled: false },
    ev: { connected: false },
  };
  assert.equal(watts(preview({ input: disabled, evConfig: null }), 'export'), 5);
  const full = input();
  full.home.targetSoc = 50;
  full.ev.targetSoc = 40;
  assert.equal(watts(preview({ input: full }), 'export'), 5);
  // A target crossed only by the EXTRA allocation is capped by stored energy / efficiency.
  const cap = input();
  cap.home.targetSoc = 51;
  cap.home.maxPowerKW = 10;
  cap.ev.connected = false;
  const capped = preview({ input: cap, snapshot: { ...snapshot(), essW: 0 } });
  assert.ok(Math.abs(watts(capped, 'home') - 2.666667) < 0.000001);
  assert.ok(capped.allocations.find((a) => a.destination === 'home').storedKWh <= 0.200001);
  conserved(capped);
});
test('missing, stale, invalid, ambiguous or off-grid sources and backup restriction yield no allocation', () => {
  for (const s of [
    null,
    { ...snapshot(), readAt: now + 1 },
    { ...snapshot(), readAt: now - 30001 },
    { ...snapshot(), readAt: now - 30000 },
    { ...snapshot(), maxAgeMs: 0 },
    { ...snapshot(), pvW: null },
    { ...snapshot(), pvW: -1 },
    { ...snapshot(), essW: Infinity },
    { ...snapshot(), gridW: NaN },
    { ...snapshot(), gridMode: 1 },
    { ...snapshot(), soc: null },
    { ...snapshot(), solarSource: 'auto' },
  ]) {
    const r = preview({ snapshot: s });
    assert.equal(r.status, 'unavailable-source');
    assert.deepEqual(r.allocations, []);
  }
  for (const advisory of [null, {}, { restricted: true, reason: 'Waiting' }]) {
    const r = preview({ advisory });
    assert.equal(r.status, 'backup-restricted');
    assert.deepEqual(r.allocations, []);
  }
  assert.throws(() => preview({ now: NaN }));
});
test('manual assumptions are finite/bounded and disconnected EV does not invent a SoC', () => {
  for (const mutate of [
    (i) => {
      i.durationMinutes = 0;
    },
    (i) => {
      i.durationMinutes = 16;
    },
    (i) => {
      i.priority = 'economic';
    },
    (i) => {
      i.home.enabled = 'true';
    },
    (i) => {
      i.home.targetSoc = 101;
    },
    (i) => {
      i.home.maxPowerKW = -1;
    },
    (i) => {
      i.home.efficiency = 0;
    },
    (i) => {
      i.ev.connected = null;
    },
    (i) => {
      i.ev.soc = '50';
    },
    (i) => {
      i.ev.targetSoc = NaN;
    },
    (i) => {
      i.ev.maxPowerKW = Infinity;
    },
    (i) => {
      i.ev.minPowerKW = 8;
    },
    (i) => {
      i.ev.currentPowerKW = -1;
    },
    (i) => {
      i.ev.observedAt = '2026-06-10T10:00';
    },
    (i) => {
      i.ev.observedAt = new Date(now + 1).toISOString();
    },
    (i) => {
      i.ev.observedAt = new Date(now - 900000).toISOString();
    },
  ]) {
    const i = input();
    mutate(i);
    assert.throws(() => preview({ input: i }));
  }
  for (const value of [null, [], {}, 1]) assert.throws(() => preview({ input: value }));
  assert.throws(() => preview({ snapshot: { ...snapshot(), capacityKWh: undefined } }));
  assert.throws(() => preview({ evConfig: { ...evConfig, usableBatteryKWh: null } }));
  const i = input();
  i.ev.observedAt = new Date(now - 899000).toISOString();
  assert.equal(Date.parse(preview({ input: i }).validUntil), now + 1000);
  i.ev.connected = false;
  i.ev.soc = NaN;
  i.ev.observedAt = null;
  assert.equal(preview({ input: i, evConfig: null }).assumptions.consumers.ev, undefined);
});
test('authenticated API reads one cached source and saved EV assumptions without writing settings or issuing commands', async () => {
  assert.deepEqual(manifest.api.previewSolar, {
    method: 'POST',
    path: '/solar/preview',
    public: false,
  });
  const devices = [{ getEnergySnapshot: () => snapshot() }];
  const homey = {
    app: { getBackupAdvisory: () => ({ restricted: false }) },
    drivers: {
      getDriver: (name) => {
        assert.equal(name, 'sigenergy');
        return { getDevices: () => devices };
      },
    },
    settings: {
      get: (key) => {
        assert.equal(key, 'chargingConfig');
        return evConfig;
      },
      set: () => assert.fail('No writes'),
    },
  };
  const result = previewSolar(homey, input(), now);
  assert.equal(result.status, 'preview');
  conserved(result);
  devices.push(devices[0]);
  assert.equal(previewSolar(homey, input(), now).status, 'unavailable-source');
  devices.pop();
  devices.length = 0;
  assert.equal(previewSolar(homey, input(), now).status, 'unavailable-source');
  const resultApi = await api.previewSolar({ homey, body: input() });
  assert.deepEqual(resultApi.allocations, []);
});
