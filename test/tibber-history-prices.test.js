'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  fetchHistoryPrices,
  normalizeHours,
  HOUR: H,
  PriceError,
} = require('../lib/pricing/tibber-history-fetch');
const { TibberHistoryPrices, safeCache } = require('../lib/pricing/tibber-history-prices');
const { observedCosts, contractHash } = require('../lib/pricing/observed-costs');
const NOW = Date.parse('2026-06-10T12:00:00Z'),
  T = NOW - H,
  Q = H / 4;
const contract = () => ({
  schema: 2,
  currency: 'SEK',
  source: 'Synthetic contract',
  checkedOn: '2026-06-01',
  importPriceBasis: 'spot-ex-vat',
  importIncludesEnergyTax: false,
  energyTaxExVatSekPerKWh: 0.31,
  gridImportExVatSekPerKWh: 0.09,
  otherImportExVatSekPerKWh: 0.06,
  gridExportBenefitSekPerKWh: 0.04,
  gridExportFeeSekPerKWh: 0.01,
  vatRate: 0.25,
  batteryWearSekPerKWh: 0.12,
});
const slots = () =>
  Array.from({ length: 4 }, (_, i) => ({
    schema: 2,
    t: T + i * Q,
    coverageMs: Q,
    directionalCoverageMs: Q,
    importWh: 250,
    exportWh: 125,
    gridWh: 125,
  }));
function node(t = T, direction = 'consumption', price = direction === 'consumption' ? 1.2 : -0.2) {
  return {
    from: new Date(t).toISOString(),
    to: new Date(t + H).toISOString(),
    unitPrice: price,
    unitPriceVAT: direction === 'consumption' ? 0.24 : 0,
    currency: 'SEK',
    ...(direction === 'consumption'
      ? { consumption: 1, consumptionUnit: 'kWh', cost: price }
      : { production: 0.5, productionUnit: 'kWh', profit: price * 0.5 }),
  };
}
const home = (c = [node()], p = [node(T, 'production')]) => ({
  id: 'synthetic-home',
  consumption: { nodes: c },
  production: p === null ? null : { nodes: p },
});
const response = (data, status = 200, retry) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => retry },
  text: async () => JSON.stringify(data),
});
function fixture(fetchImpl) {
  let now = NOW;
  const data = {
    tibberToken: 'synthetic-token',
    tibberHomeId: 'synthetic-home',
    sourceConfig: { tibber: { revision: 'revision-a' } },
    costContract: contract(),
  };
  const homey = {
    settings: {
      get: (k) => data[k],
      set: (k, v) => {
        data[k] = v;
      },
    },
    app: { history: { getSlots: slots } },
  };
  const service = new TibberHistoryPrices(homey, {
    now: () => now,
    fetchImpl:
      fetchImpl ||
      (async (_url, opts) => {
        const { query } = JSON.parse(opts.body);
        return response({
          data: query.includes('homes {')
            ? { viewer: { homes: [{ id: 'synthetic-home' }] } }
            : { viewer: { home: home() } },
        });
      }),
  });
  return {
    homey,
    data,
    service,
    setNow: (n) => {
      now = n;
    },
  };
}
const fetchOptions = () => ({
  token: 'synthetic-token',
  homeId: 'synthetic-home',
  from: T,
  to: NOW,
});
const tick = () => new Promise((r) => setImmediate(r));
test('fetch uses existing PAT and selected home with bounded GraphQL variables only', async () => {
  const calls = [];
  const rows = await fetchHistoryPrices({
    ...fetchOptions(),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      const { query, variables } = JSON.parse(opts.body);
      if (!variables) return response({ data: { viewer: { homes: [{ id: 'synthetic-home' }] } } });
      assert.equal(variables.last, 1);
      assert.equal(Buffer.from(variables.before, 'base64').toString(), new Date(NOW).toISOString());
      assert.match(query, /production\(resolution: HOURLY/);
      return response({ data: { viewer: { home: home() } } });
    },
  });
  assert.equal(rows[0].production.price, -0.2);
  assert.equal(rows[0].consumption.price, 1.2);
  assert.equal(rows[0].consumption.vatAmount, 0.24);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.url, 'https://api.tibber.com/v1-beta/gql');
    assert.equal(c.opts.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(c.opts.redirect, 'error');
  }
});
test('32-day window pages into at most 744-hour queries without inventing missing hours', async () => {
  const counts = [];
  const result = await fetchHistoryPrices({
    ...fetchOptions(),
    from: NOW - 32 * 24 * H,
    fetchImpl: async (_url, o) => {
      const v = JSON.parse(o.body).variables;
      if (!v) return response({ data: { viewer: { homes: [{ id: 'synthetic-home' }] } } });
      counts.push(v.last);
      return response({ data: { viewer: { home: home([], []) } } });
    },
  });
  assert.deepEqual(counts, [744, 24]);
  assert.deepEqual(result, []);
});
test('normalizer preserves signed unit prices; VAT and missing production are not guessed', () => {
  assert.equal(normalizeHours(home(), 'synthetic-home', T, NOW)[0].production.price, -0.2);
  assert.equal(
    normalizeHours(home([node()], null), 'synthetic-home', T, NOW)[0].production,
    undefined,
  );
  assert.equal(
    normalizeHours(
      home([{ ...node(), unitPrice: null, currency: null }], []),
      'synthetic-home',
      T,
      NOW,
    )[0].consumption,
    undefined,
  );
  assert.equal(
    normalizeHours(home([node(T, 'consumption', -0.1)], []), 'synthetic-home', T, NOW)[0]
      .consumption.price,
    -0.1,
  );
  for (const change of [
    { unitPrice: '1.2' },
    { unitPrice: NaN },
    { unitPriceVAT: Infinity },
    { currency: 'EUR' },
    { consumption: -1 },
    { consumptionUnit: 'Wh' },
    { cost: Infinity },
    { cost: 99 },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-06-10T11:15:00Z' },
    { to: new Date(NOW + H).toISOString() },
  ])
    assert.throws(() => normalizeHours(home([{ ...node(), ...change }]), 'synthetic-home', T, NOW));
  assert.throws(() => normalizeHours(home(), 'different-home', T, NOW), /invalid-home/);
  assert.throws(
    () => normalizeHours({ ...home(), consumption: null }, 'synthetic-home', T, NOW),
    /invalid-history/,
  );
  const duplicateHome = home([node(), node(T, 'consumption', 2)], []);
  assert.throws(
    () => normalizeHours(duplicateHome, 'synthetic-home', T - H, NOW),
    /conflicting-history/,
  );
  assert.equal(normalizeHours(home([node(), node()], []), 'synthetic-home', T - H, NOW).length, 1);
});
test('HTTP, GraphQL, JSON and network errors never echo private upstream messages', async () => {
  for (const [status, code] of [
    [401, 'authorization-required'],
    [429, 'rate-limited'],
    [500, 'upstream-unavailable'],
  ])
    await assert.rejects(
      fetchHistoryPrices({
        ...fetchOptions(),
        fetchImpl: async () => response({ private: 'secret' }, status, '120'),
      }),
      (e) => e.code === code && !e.message.includes('secret'),
    );
  await assert.rejects(
    fetchHistoryPrices({
      ...fetchOptions(),
      fetchImpl: async () => {
        throw Error('private-token');
      },
    }),
    /network-error/,
  );
  for (const body of [
    '{',
    'x'.repeat(2 * 1024 * 1024 + 1),
    JSON.stringify({ errors: [{ message: 'private-token' }] }),
  ])
    await assert.rejects(
      fetchHistoryPrices({
        ...fetchOptions(),
        fetchImpl: async () => ({ ok: true, text: async () => body }),
      }),
      (e) => !e.message.includes('private-token'),
    );
  await assert.rejects(
    fetchHistoryPrices({
      ...fetchOptions(),
      fetchImpl: async () => response({ data: { viewer: { homes: [] } } }),
    }),
    /invalid-home/,
  );
  for (const change of [
    { token: '' },
    { homeId: '../bad' },
    { from: T + 1 },
    { to: T },
    { from: NOW - 33 * 24 * H },
  ])
    await assert.rejects(fetchHistoryPrices({ ...fetchOptions(), ...change }));
});
test('service reuses configured credentials and bound single-home price cache; confirmation required', async () => {
  const f = fixture();
  assert.equal(f.service.status().configured, true);
  await f.service.sync();
  assert.equal(f.data.tibberHistoryPriceCache, undefined);
  assert.throws(() => f.service.confirm({}), /home-confirmation/);
  f.service.confirm({ confirmSamePlant: true });
  await f.service.sync();
  assert.equal(f.service.status().priceHours, 1);
  assert.equal(f.data.tibberToken, 'synthetic-token');
  assert.doesNotMatch(
    JSON.stringify(f.service.status()),
    /synthetic-token|synthetic-home|revision-a/,
  );
  f.data.tibberHomeId = '';
  assert.equal(f.service.status().homeSelected, false);
  f.data.priceCache = {
    homeId: 'synthetic-home',
    selectedHomeId: null,
    configRevision: 'revision-a',
  };
  assert.equal(f.service.status().homeSelected, true);
  f.data.priceCache.configRevision = 'other';
  assert.equal(f.service.status().homeSelected, false);
  assert.throws(() => f.service.confirm({ confirmSamePlant: true }), /select-home/);
  f.data.tibberToken = '';
  assert.equal(f.service.status().configured, false);
});
test('sync serializes, preserves good cache on error and respects hourly/daily backoff', async () => {
  const f = fixture();
  f.service.confirm({ confirmSamePlant: true });
  await Promise.all([f.service.sync(), f.service.sync()]);
  const c = f.data.tibberHistoryPriceCache;
  assert.equal(f.service.status().syncStatus, 'ok');
  await f.service.sync();
  assert.equal(f.data.tibberHistoryPriceCache, c);
  f.setNow(NOW + 24 * H);
  f.service.fetch = async () => {
    throw Error('private');
  };
  await f.service.sync();
  assert.equal(f.service.status().syncStatus, 'network-error');
  assert.equal(f.data.tibberHistoryPriceCache, c);
  f.homey.app.history.getSlots = () => [];
  f.setNow(NOW + 25 * H);
  await f.service.sync();
  assert.equal(f.service.status().syncStatus, 'waiting-for-energy');
});
test('missing production retries hourly and never replaces it with a consumption price', async () => {
  const f = fixture(async (_u, o) =>
    response({
      data: JSON.parse(o.body).variables
        ? { viewer: { home: home([node()], null) } }
        : { viewer: { homes: [{ id: 'synthetic-home' }] } },
    }),
  );
  f.service.confirm({ confirmSamePlant: true });
  await f.service.sync();
  assert.equal(f.service.status().syncStatus, 'partial');
  assert.equal(f.service.status().nextAttemptAt, NOW + H);
  assert.equal(f.service.ledger().totals, null);
  assert.equal(f.service.ledger().missingProductionHours, 1);
});
test('token/home changes and shutdown reject pending results and existing cache', async () => {
  let release;
  const f = fixture(async () => {
    await new Promise((r) => {
      release = r;
    });
    return response({ data: { viewer: { homes: [{ id: 'synthetic-home' }] } } });
  });
  f.service.confirm({ confirmSamePlant: true });
  const pending = f.service.sync();
  await tick();
  f.data.tibberToken = 'changed';
  release();
  await pending;
  assert.equal(f.data.tibberHistoryPriceCache, undefined);
  assert.equal(f.service.status().confirmed, false);
  const g = fixture();
  g.service.confirm({ confirmSamePlant: true });
  await g.service.sync();
  g.data.tibberHomeId = 'other-home';
  assert.equal(g.service.status().priceHours, 0);
  assert.equal(g.service.ledger().status, 'no-prices');
  g.service.stop();
  await g.service.sync();
  assert.throws(() => g.service.write('x', 1), /stopped/);
});
test('ledger groups only complete closed four-quarter hours and is always indicative', async () => {
  const f = fixture();
  f.service.confirm({ confirmSamePlant: true });
  await f.service.sync();
  const r = f.service.ledger();
  assert.equal(r.status, 'indicative-hourly');
  assert.equal(r.matchedHours, 1);
  assert.equal(r.totals.importCostSek, 1.2);
  assert.equal(r.totals.exportRevenueSek, -0.1);
  assert.equal(r.financiallyComparable, false);
  assert.equal(r.priceResolution, 'HOURLY');
  f.homey.app.history.getSlots = () => slots().slice(1);
  assert.equal(f.service.ledger().totals, null);
  assert.equal(f.service.ledger().unusedEnergyQuarters, 3);
  f.homey.app.history.getSlots = () => [...slots(), { ...slots()[0], t: NOW }];
  assert.equal(f.service.ledger().matchedHours, 1);
  f.homey.app.history.getSlots = () => {
    throw Error();
  };
  assert.equal(f.service.ledger().status, 'energy-unavailable');
});
test('network additions apply purchase VAT only; supplier fees are never duplicated', async () => {
  const f = fixture();
  f.service.confirm({ confirmSamePlant: true });
  await f.service.sync();
  assert.throws(() => f.service.options({ includeNetwork: true }), /network-confirmation/);
  assert.throws(() => f.service.options({ includeNetwork: 'yes' }), /invalid-options/);
  f.service.options({ includeNetwork: true, confirmSeparateNetworkComponents: true });
  assert.equal(f.service.ledger().status, 'dated-contract-required');
  f.data.demandTariff = {
    start: '00:00',
    end: '23:00',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    peakCount: 1,
    distinctDays: false,
    rateSekPerKw: 50,
  };
  const { publishContract, timelineStatus } = require('../lib/pricing/contract-timeline');
  const state = timelineStatus(f.homey);
  publishContract(
    f.homey,
    {
      expectedRevision: state.revision,
      draftHash: state.draftHash,
      from: '2026-06-01',
      confirmEffectiveDate: true,
      confirmTradeComponents: true,
      includeNetwork: true,
    },
    NOW,
  );
  const full = f.service.ledger();
  assert.ok(Math.abs(full.totals.importCostSek - 1.7) < 1e-9);
  assert.ok(Math.abs(full.totals.exportRevenueSek + 0.085) < 1e-9);
  f.data.costContract.otherImportExVatSekPerKWh = 0.1;
  assert.equal(f.service.ledger().componentBasis, 'dated-contract-components');
  f.data.costContract = null;
  assert.equal(f.service.ledger().componentBasis, 'dated-contract-components');
  f.service.options({ includeNetwork: false });
  assert.equal(f.service.ledger().totals.importCostSek, 1.7);
  f.data.tibberHomeId = 'changed';
  assert.throws(() => f.service.options({ includeNetwork: false }), /home-confirmation/);
});
test('safe hourly cache rejects duplicates, malformed, future and cross-source values', () => {
  const c = {
    schema: 1,
    revision: 'r',
    fetchedAt: NOW,
    rows: [{ t: T, consumption: { price: 1 } }],
  };
  assert.equal(safeCache(c, 'r', NOW), c);
  for (const bad of [
    null,
    { ...c, schema: 2 },
    { ...c, revision: 'x' },
    { ...c, fetchedAt: NOW + 1 },
    { ...c, rows: [null] },
    { ...c, rows: [...c.rows, ...c.rows] },
    { ...c, rows: [{ t: T + 1 }] },
    { ...c, rows: [{ t: T, production: { price: NaN } }] },
  ])
    assert.equal(safeCache(bad, 'r', NOW), null);
  assert.ok(contractHash(contract()));
  assert.equal(new PriceError('x').retryMs, H);
});
test('missing hourly prices do not produce totals and private routes delegate to existing-connection service', async () => {
  const f = fixture(),
    s = f.service.session();
  const c = { revision: s.revision, fetchedAt: NOW, rows: [] };
  assert.equal(observedCosts(f.homey, s, c, null, NOW).missingPriceHours, 1);
  c.rows = [{ t: T, consumption: { price: NaN }, production: { price: 1 } }];
  assert.equal(observedCosts(f.homey, s, c, null, NOW).totals, null);
  const api = require('../api'),
    manifest = require('../app.json');
  f.homey.app.tibberHistoryPrices = f.service;
  for (const [name, method] of [
    ['getTibberHistoryPriceStatus', 'status'],
    ['confirmTibberHistoryHome', 'confirm'],
    ['configureTibberHistoryComponents', 'options'],
    ['refreshTibberHistoryPrices', 'sync'],
    ['getObservedCosts', 'ledger'],
  ]) {
    assert.equal(manifest.api[name].public, false);
    f.service[method] = (body) => ({ method, body });
    assert.equal((await api[name]({ homey: f.homey, body: { synthetic: true } })).method, method);
  }
  assert.equal(
    Object.keys(manifest.api).some((k) => /connectTibberData|disconnectTibberData/.test(k)),
    false,
  );
});
