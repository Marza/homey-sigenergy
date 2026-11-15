'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { normalizeNetworkEnergy, validNetworkRows } = require('../lib/pricing/network-energy');
const { getHourlyEnergy } = require('../lib/pricing/hourly-energy');
const { fetchHistoryPrices } = require('../lib/pricing/tibber-history-fetch');
const { observedCosts } = require('../lib/pricing/observed-costs');
const { fixture } = require('./fixtures/readiness.cjs');
const H = 3600000;
function network(f) {
  return f.data.tibberHistoryPriceCache.rows.map((r) => ({
    t: r.t,
    importWh: 2000,
    exportWh: 400,
  }));
}
function setup() {
  const f = fixture();
  f.data.tibberHistoryPriceCache.networkEnergy = network(f);
  return f;
}
test('Tibber supplies independent meter volumes even before a price is available, preserving units and true zero', async () => {
  const f = setup(),
    from = f.rows[0].t,
    to = from + H;
  const home = {
    id: 'synthetic-home',
    consumption: {
      nodes: [
        {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          consumption: 0,
          consumptionUnit: 'kWh',
          unitPrice: null,
        },
      ],
    },
    production: {
      nodes: [
        {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          production: 0.4,
          productionUnit: 'kWh',
          unitPrice: null,
        },
      ],
    },
  };
  const rows = normalizeNetworkEnergy(home, 'synthetic-home', from, to);
  assert.deepEqual(rows, [{ t: from, importWh: 0, exportWh: 400 }]);
  assert.equal(validNetworkRows(rows, f.now), true);
  let energy;
  const prices = await fetchHistoryPrices({
    token: 'SYNTHETIC',
    homeId: 'synthetic-home',
    from,
    to,
    onNetworkEnergy: (r) => (energy = r),
    fetchImpl: async (_url, o) => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: JSON.parse(o.body).variables
            ? { viewer: { home } }
            : { viewer: { homes: [{ id: 'synthetic-home' }] } },
        }),
    }),
  });
  assert.deepEqual(energy, rows);
  assert.deepEqual(prices, [{ t: from }]);
  for (const edit of [
    { consumption: -1 },
    { consumptionUnit: 'Wh' },
    { consumption: Infinity },
    { from: new Date(from + 1).toISOString() },
  ]) {
    const copy = structuredClone(home);
    Object.assign(copy.consumption.nodes[0], edit);
    assert.throws(() => normalizeNetworkEnergy(copy, 'synthetic-home', from, to));
  }
  const bad = structuredClone(home);
  bad.consumption.nodes.push({ ...bad.consumption.nodes[0], consumption: 1 });
  assert.throws(() => normalizeNetworkEnergy(bad, 'synthetic-home', from, to));
});
test('hourly Tibber fallback fills incomplete grid hours with provenance and never invents quarters or battery/solar data', () => {
  const f = setup();
  f.rows[1].coverageMs = 0;
  f.rows[1].directionalCoverageMs = 0;
  const before = JSON.stringify(f.rows),
    session = f.homey.app.tibberHistoryPrices.session();
  const r = getHourlyEnergy(f.homey, f.data.tibberHistoryPriceCache, session, f.now);
  assert.equal(r.hours.length, 4);
  assert.equal(r.sigenergyHours, 3);
  assert.equal(r.tibberFilledHours, 1);
  assert.equal(r.hours[0].source, 'tibber-meter-hourly');
  assert.equal(r.hours[0].importWh, 2000);
  assert.equal(r.hours[0].exportWh, 400);
  assert.equal(r.hours[1].source, 'sigenergy-sampled');
  assert.equal(r.hours[1].importWh, 1000);
  assert.equal(JSON.stringify(f.rows), before);
  assert.equal(r.hours[0].essWh, undefined);
  const ledger = observedCosts(
    f.homey,
    session,
    f.data.tibberHistoryPriceCache,
    { confirmed: true },
    f.now,
  );
  assert.equal(ledger.tibberFilledHours, 1);
  assert.equal(ledger.matchedHours, 4);
  assert.equal(ledger.totals.importKWh, 5);
  assert.equal(ledger.financiallyComparable, false);
  assert.ok(ledger.energySources.includes('tibber-meter-hourly'));
});
test('missing export, wrong source, future/invalid meter cache and absent confirmation cannot fill a grid hour', () => {
  for (const change of [
    'export',
    'revision',
    'future',
    'duplicate',
    'unknown-field',
    'unconfirmed',
  ]) {
    const f = setup();
    f.rows.splice(0, 1);
    const cache = f.data.tibberHistoryPriceCache,
      session = f.homey.app.tibberHistoryPrices.session();
    if (change === 'export') delete cache.networkEnergy[0].exportWh;
    if (change === 'revision') cache.revision = 'OTHER';
    if (change === 'future') cache.networkEnergy[0].t = f.now;
    if (change === 'duplicate') cache.networkEnergy.push({ ...cache.networkEnergy[0] });
    if (change === 'unknown-field') cache.networkEnergy[0].PRIVATE = 'secret';
    if (change === 'unconfirmed') f.data.tibberHistoryPriceOptions.confirmed = false;
    const r = getHourlyEnergy(f.homey, cache, session, f.now);
    // A missing first quarter must not change the origin time used for the matching hour.
    assert.equal(r.tibberFilledHours, 0, change);
  }
});
test('complete Sigenergy hours take precedence; malformed storage is not hidden by the meter fallback', () => {
  const f = setup(),
    cache = f.data.tibberHistoryPriceCache,
    session = f.homey.app.tibberHistoryPrices.session();
  let r = getHourlyEnergy(f.homey, cache, session, f.now);
  assert.equal(r.tibberFilledHours, 0);
  assert.equal(r.hours[0].importWh, 1000);
  f.homey.app.history.getSlots = () => {
    throw Error('PRIVATE');
  };
  r = getHourlyEnergy(f.homey, cache, session, f.now);
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.hours, []);
  for (const rows of [
    null,
    [{ t: 1, importWh: 0 }],
    [{ t: f.now - H, importWh: -1 }],
    [{ t: f.now - H }],
    [{ t: f.now - H, exportWh: NaN }],
  ])
    assert.equal(validNetworkRows(rows, f.now), false);
});
