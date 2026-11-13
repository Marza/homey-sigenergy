'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { createRequire } = require('node:module');
const {
  DEFAULTS,
  validateConfig,
  upcomingDeadlines,
  planCharging,
} = require('../lib/charging/planner');
const { createChargingPreview } = require('../lib/charging/preview');
const api = require('../api'),
  manifest = require('../app.json');
const now = new Date('2026-11-13T20:00:00Z');
const config = () => structuredClone(DEFAULTS);
const input = () => ({
  source: 'manual',
  currentSoc: 20,
  observedAt: now.toISOString(),
  connected: true,
  availablePowerKW: 7,
});
const prices = () =>
  Array.from({ length: 192 }, (_, i) => ({
    start: new Date(+now + i * 900000).toISOString(),
    end: new Date(+now + (i + 1) * 900000).toISOString(),
    price: i === 4 ? -0.1 : 1,
  }));
const pricing = {
  usable: true,
  currency: 'SEK',
  fetchedAt: now.toISOString(),
  availableFrom: now.toISOString(),
  availableTo: new Date(+now + 48 * 3600000).toISOString(),
};
const preview = (patch = {}) =>
  createChargingPreview({
    input: input(),
    config: config(),
    prices: prices(),
    pricing,
    now,
    ...patch,
  });
test('manual preview exposes assumptions, known cost basis, deadlines, energy and no control', () => {
  const r = preview();
  assert.equal(r.status, 'planned');
  assert.equal(r.advisoryOnly, true);
  assert.equal(r.controlApplied, false);
  assert.equal(r.assumptions.powerKW, 7);
  assert.equal(r.assumptions.timezone, 'Europe/Stockholm');
  assert.equal(r.assumptions.chargingEfficiency, 0.92);
  assert.ok(r.plannedInputKWh > r.plannedBatteryKWh);
  assert.ok(Math.abs(r.plannedBatteryKWh - 7.5) < 0.001);
  assert.ok(r.slots.some((s) => s.price < 0));
  assert.equal(r.unmet.length, 0);
  assert.ok(r.priceCoverage.every((c) => c.complete));
  assert.match(r.costBasis, /inte full elkostnad/);
});
test('preview rejects absent/unverified/stale/future/invalid SoC and explicit connection/power errors', () => {
  for (const patch of [
    null,
    [],
    { ...input(), source: 'evdc' },
    { ...input(), currentSoc: null },
    { ...input(), currentSoc: 101 },
    { ...input(), observedAt: '2026-11-13T19:44:59Z' },
    { ...input(), observedAt: '2026-11-13T20:00:01Z' },
    { ...input(), observedAt: '2026-11-13T20:00' },
    { ...input(), connected: 'true' },
    { ...input(), availablePowerKW: Infinity },
    { ...input(), availablePowerKW: -1 },
  ])
    assert.throws(() => preview({ input: patch }));
  assert.equal(
    preview({ input: { ...input(), observedAt: '2026-11-13T19:45:00Z' } }).soc.ageSeconds,
    900,
  );
});
test('disconnection, no available power and missing prices never produce an actionable schedule', () => {
  for (const [patch, status] of [
    [{ input: { ...input(), connected: false } }, 'not-connected'],
    [{ input: { ...input(), availablePowerKW: 0 } }, 'no-power'],
    [{ pricing: { usable: false } }, 'no-prices'],
  ]) {
    const r = preview(patch);
    assert.equal(r.status, status);
    assert.deepEqual(r.slots, []);
    assert.equal(r.estimatedCost, undefined);
  }
  const met = preview({ input: { ...input(), currentSoc: 90 }, pricing: null });
  assert.equal(met.status, 'already-met');
  assert.deepEqual(met.slots, []);
  assert.equal(met.plannedInputKWh, 0);
  const unreachable = preview({ input: { ...input(), availablePowerKW: 0.01 } });
  assert.equal(unreachable.status, 'unreachable');
  assert.ok(unreachable.unmet.length);
  assert.ok(unreachable.unmet.every((d) => d.missingBatteryKWh > 0));
  const partial = preview({ prices: prices().slice(0, 60) });
  assert.equal(partial.status, 'partial-prices');
  assert.ok(partial.priceCoverage.some((p) => p.gaps.length));
});
test('finite bounded charging config, timezone and planning windows are validated', () => {
  for (const patch of [
    { usableBatteryKWh: Infinity },
    { usableBatteryKWh: 1001 },
    { maxChargingPowerKW: Infinity },
    { maxChargingPowerKW: 351 },
    { chargingEfficiency: NaN },
    { timezone: 'invalid/timezone' },
    { timezone: 3 },
    { dailyTargets: null },
  ])
    assert.throws(() => validateConfig({ ...config(), ...patch }));
  assert.throws(() => validateConfig(null));
  assert.throws(() => upcomingDeadlines(config(), new Date(NaN)));
  assert.throws(() => upcomingDeadlines(config(), now, 49));
  assert.throws(() =>
    planCharging({ now, currentSoc: 20, config: config(), prices: prices(), maxPowerKW: Infinity }),
  );
  assert.throws(() =>
    planCharging({ now, currentSoc: 20, config: config(), prices: Array(513).fill(prices()[0]) }),
  );
});
test('DST gaps advance to first valid minute; repeated times use the first occurrence', () => {
  const c = config();
  c.minimumDeadline = '02:30';
  const spring = upcomingDeadlines(c, new Date('2026-03-28T23:00Z'), 12)[0];
  assert.equal(spring.at.toISOString(), '2026-03-29T01:00:00.000Z');
  assert.equal(spring.adjustment, 'dst-gap-forward');
  const autumn = upcomingDeadlines(c, new Date('2026-10-24T22:00Z'), 12);
  assert.equal(autumn.length, 1);
  assert.equal(autumn[0].at.toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(autumn[0].adjustment, 'dst-first-occurrence');
  c.minimumDeadline = '00:00';
  assert.equal(
    upcomingDeadlines(c, new Date('2026-12-31T22:30Z'), 3)[0].at.toISOString(),
    '2026-12-31T23:00:00.000Z',
  );
});
test('authenticated preview API delegates computation and runtime does not write settings or return credentials', async () => {
  assert.deepEqual(manifest.api.previewCharging, {
    method: 'POST',
    path: '/charging/preview',
    public: false,
  });
  const appPath = path.join(__dirname, '../app.js'),
    requireApp = createRequire(appPath),
    module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), {
    module,
    require: (id) => (id === 'homey' ? { App: class {} } : requireApp(id)),
  });
  const app = new module.exports();
  app.homey = {
    settings: {
      get: (key) =>
        key === 'chargingConfig' ? config() : key === 'tibberToken' ? 'private-token' : null,
      set() {
        throw new Error('Writes forbidden');
      },
    },
  };
  const r = await api.previewCharging({
    homey: { app },
    body: { ...input(), observedAt: new Date().toISOString() },
  });
  assert.equal(r.status, 'no-prices');
  assert.ok(!JSON.stringify(r).includes('private-token'));
});
