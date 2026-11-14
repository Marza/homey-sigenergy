'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { TibberData, REDIRECT, safeCache } = require('../lib/pricing/tibber-data');
const {
  decimal,
  normalizePage,
  pageUrl,
  fetchPriceWindow,
  QUARTER: Q,
  DataError,
} = require('../lib/pricing/tibber-data-prices');
const { observedCosts, contractHash } = require('../lib/pricing/observed-costs');
const NOW = Date.parse('2026-06-10T12:00:00Z'),
  T = NOW - Q;
const row = (t = T, production = true) => ({
  t,
  consumption: { price: 1.2, vat: 25 },
  ...(production ? { production: { price: -0.2, vat: 0 } } : {}),
});
const slot = (t = T) => ({
  schema: 2,
  t,
  gridWh: 500,
  importWh: 1000,
  exportWh: 500,
  coverageMs: Q,
  directionalCoverageMs: Q,
});
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
function fixture(
  fetchImpl = async () => {
    throw Error('unexpected');
  },
) {
  let now = NOW;
  const data = {
    tibberDataSession: {
      schema: 1,
      revision: 'revision-a',
      homeId: 'synthetic-home',
      clientId: 'public-client',
      token: { access: 'private-access', refresh: 'private-refresh', expiresAt: NOW + 86400000 },
    },
    costContract: contract(),
    tibberToken: 'legacy-token',
  };
  const timers = new Map();
  let next = 0;
  const callback = new EventEmitter();
  const homey = {
    app: { history: { getSlots: () => [slot()] } },
    settings: {
      get: (k) => data[k],
      set: (k, v) => {
        data[k] = v;
      },
    },
    setTimeout: (fn, ms) => {
      const id = ++next;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    cloud: {
      createOAuth2Callback: async (url) => {
        homey.authUrl = url;
        setImmediate(() =>
          callback.emit('url', 'https://callback.athom.com/oauth2/authorize?synthetic=1'),
        );
        return callback;
      },
    },
  };
  const service = new TibberData(homey, { fetchImpl, now: () => now });
  return {
    service,
    homey,
    data,
    timers,
    callback,
    setNow: (n) => {
      now = n;
    },
  };
}
const response = (body, status = 200, retry = null) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => retry },
  text: async () => JSON.stringify(body),
});
const token = () => ({
  access_token: 'rotated-access',
  refresh_token: 'rotated-refresh',
  token_type: 'Bearer',
  expires_in: 3600,
});
function page(rows = [row()], extra = {}) {
  return {
    currency: 'SEK',
    query: { effectiveStart: new Date(T).toISOString(), effectiveEnd: new Date(NOW).toISOString() },
    items: rows.map((r) => ({
      time: new Date(r.t).toISOString(),
      consumption: { price: String(r.consumption.price), vatPercent: String(r.consumption.vat) },
      ...(r.production
        ? { production: { price: r.production.price, vatPercent: r.production.vat } }
        : {}),
    })),
    ...extra,
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('strict decimal price parser preserves signed prices and rejects coercions', () => {
  assert.equal(decimal('-0.25'), -0.25);
  for (const v of ['', '1e2', ' 1', null, true, NaN, Infinity, 1000001, {}, '01', '+2'])
    assert.throws(() => decimal(v), /invalid-price/);
});
test('normalizes provider VAT and optional production/third party fields', () => {
  const p = page();
  p.items[0].consumption.thirdPartyPrice = '.2';
  assert.throws(() => normalizePage(p));
  p.items[0].consumption.thirdPartyPrice = '0.2';
  assert.deepEqual(normalizePage(p).rows[0], {
    ...row(),
    consumption: { price: 1.2, vat: 25, thirdParty: 0.2 },
  });
  assert.equal(normalizePage(page([row(T, false)])).rows[0].production, undefined);
  for (const bad of [
    null,
    { ...p, currency: 'EUR' },
    { ...p, items: Array(193).fill(p.items[0]) },
    { ...p, query: {} },
    { ...p, items: [null] },
  ])
    assert.throws(() => normalizePage(bad));
  for (const time of [
    '2026-02-30T12:00:00Z',
    '2026-06-10T11:46:00Z',
    'not-date',
    '2026-06-09T00:00:00Z',
  ])
    assert.throws(() => normalizePage({ ...p, items: [{ ...p.items[0], time }] }));
  assert.throws(() =>
    normalizePage({ ...p, items: [{ ...p.items[0], consumption: { price: 1, vatPercent: 101 } }] }),
  );
  assert.throws(() =>
    normalizePage({
      ...p,
      query: {
        effectiveStart: new Date(NOW).toISOString(),
        effectiveEnd: new Date(T).toISOString(),
      },
    }),
  );
});
test('pagination rejects redirects, cross-home URLs, credentials and cycles', async () => {
  for (const u of [
    'https://evil.test/v1/homes/synthetic-home/prices',
    '/v1/homes/other/prices',
    'https://x:y@data-api.tibber.com/v1/homes/synthetic-home/prices',
    '/v1/homes/synthetic-home/prices#x',
    '/v1/homes/synthetic-home/prices?token=x',
  ])
    assert.throws(() => pageUrl(u, 'synthetic-home'));
  assert.throws(() => pageUrl('/x', '../bad'));
  const next = '/v1/homes/synthetic-home/prices?cursor=a';
  await assert.rejects(
    fetchPriceWindow(async () => page([row()], { next }), 'synthetic-home', T, NOW),
    /invalid-pagination/,
  );
  let n = 0;
  await assert.rejects(
    fetchPriceWindow(
      async () => page([row()], { next: `/v1/homes/synthetic-home/prices?cursor=${++n}` }),
      'synthetic-home',
      T,
      NOW,
    ),
    /pagination-limit/,
  );
});
test('price pages deduplicate, follow empty historical pages and stop at unpublished future', async () => {
  let n = 0;
  const rows = await fetchPriceWindow(
    async () =>
      n++ === 0 ? page([], { next: '/v1/homes/synthetic-home/prices?cursor=a' }) : page(),
    'synthetic-home',
    T,
    NOW,
  );
  assert.equal(n, 2);
  assert.deepEqual(rows, [row()]);
  const future = page([], {
    query: {
      effectiveStart: new Date(NOW).toISOString(),
      effectiveEnd: new Date(NOW + Q).toISOString(),
    },
    next: '/v1/homes/synthetic-home/prices?cursor=x',
  });
  assert.deepEqual(await fetchPriceWindow(async () => future, 'synthetic-home', T, NOW), []);
  n = 0;
  assert.deepEqual(
    await fetchPriceWindow(
      async () =>
        n++ ? page() : page([row()], { next: '/v1/homes/synthetic-home/prices?cursor=x' }),
      'synthetic-home',
      T,
      NOW,
    ),
    [row()],
  );
  n = 0;
  await assert.rejects(
    fetchPriceWindow(
      async () => {
        const p = page();
        if (n++) p.items[0].consumption.price = '9';
        else p.next = '/v1/homes/synthetic-home/prices?cursor=x';
        return p;
      },
      'synthetic-home',
      T,
      NOW,
    ),
    /conflicting-prices/,
  );
  await assert.rejects(
    fetchPriceWindow(async () => page(), 'synthetic-home', NOW, NOW),
    /invalid-price-data/,
  );
});
test('OAuth PKCE code exchange keeps tokens backend-only; disconnect preserves GraphQL token', async () => {
  let form;
  const f = fixture(async (url, opts) => {
    assert.equal(url, 'https://thewall.tibber.com/connect/token');
    form = new URLSearchParams(opts.body);
    return response(token());
  });
  const login = await f.service.connect({ clientId: 'public-client' });
  assert.equal(login.redirectUri, REDIRECT);
  const auth = new URL(f.homey.authUrl);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.match(auth.searchParams.get('scope'), /data-api-prices-read/);
  f.callback.emit('code', 'synthetic-code');
  await tick();
  assert.equal(
    createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
    auth.searchParams.get('code_challenge'),
  );
  assert.equal(form.get('redirect_uri'), REDIRECT);
  assert.equal(form.has('client_secret'), false);
  assert.equal(f.service.status().connected, true);
  assert.equal(f.service.status().homeId, null);
  assert.doesNotMatch(JSON.stringify(f.service.status()), /rotated|private-refresh|code_verifier/);
  assert.equal(f.timers.size, 0);
  f.service.disconnect();
  assert.equal(f.service.status().connected, false);
  assert.equal(f.data.tibberToken, 'legacy-token');
});
test('OAuth validation, relay failure, cancelled and expired logins fail closed', async () => {
  await assert.rejects(fixture().service.connect({ clientId: 'bad\nclient' }), /invalid-client/);
  const fail = fixture();
  fail.homey.cloud.createOAuth2Callback = async () => {
    throw Error('private');
  };
  await assert.rejects(fail.service.connect({ clientId: 'ok' }), /authorization-failed/);
  const f = fixture();
  await f.service.connect({ clientId: 'ok' });
  f.callback.emit('code', new Error('denied'));
  assert.equal(f.service.status().authStatus, 'authorization-failed');
  const expired = fixture();
  await expired.service.connect({ clientId: 'ok' });
  [...expired.timers.values()].find((t) => t.ms === 600000).fn();
  expired.callback.emit('code', 'late');
  assert.equal(expired.service.status().authStatus, 'authorization-timeout');
  const stopped = fixture();
  await stopped.service.connect({ clientId: 'ok' });
  stopped.service.stop();
  stopped.callback.emit('code', 'late');
  assert.equal(stopped.data.tibberDataSession.token.access, 'private-access');
  const timeout = fixture();
  timeout.homey.cloud.createOAuth2Callback = async () => timeout.callback;
  const pending = timeout.service.connect({ clientId: 'ok' });
  await tick();
  [...timeout.timers.values()][0].fn();
  await assert.rejects(pending, /authorization-timeout/);
});
test('invalid login URLs and failed code exchange never install a session', async () => {
  for (const url of ['not-url', 'http://thewall.tibber.com/a', 'https://evil.test/a']) {
    const f = fixture();
    f.homey.cloud.createOAuth2Callback = async () => {
      setImmediate(() => f.callback.emit('url', url));
      return f.callback;
    };
    await assert.rejects(f.service.connect({ clientId: 'ok' }));
    assert.equal(f.data.tibberDataSession.token.access, 'private-access');
  }
  const f = fixture(async () => response({}));
  await f.service.connect({ clientId: 'ok' });
  f.callback.emit('code', 'code');
  await tick();
  assert.equal(f.service.status().authStatus, 'authorization-failed');
});
test('concurrent refresh rotates once and persists tokens before data requests', async () => {
  let calls = 0;
  const f = fixture(async (url) => {
    calls++;
    if (url.includes('/connect/token')) {
      await tick();
      return response(token());
    }
    assert.equal(f.data.tibberDataSession.token.refresh, 'rotated-refresh');
    return response({ homes: [{ id: 'synthetic-home', name: 'Synthetic meter' }] });
  });
  f.data.tibberDataSession.token.expiresAt = 0;
  const [a, b] = await Promise.all([f.service.homes(), f.service.homes()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 3);
});
test('401 refreshes once, 403/429/network/invalid JSON are sanitized', async () => {
  let calls = 0;
  const f = fixture(async (url) =>
    url.includes('/connect/token')
      ? response(token())
      : calls++
        ? response({ homes: [] })
        : response({}, 401),
  );
  assert.deepEqual(await f.service.homes(), []);
  assert.equal(calls, 2);
  for (const [status, code] of [
    [401, 'authorization-required'],
    [403, 'scope-or-prices-unavailable'],
    [429, 'rate-limited'],
    [500, 'upstream-unavailable'],
  ]) {
    const bad = fixture(async () => response({ secret: 'not echoed' }, status, '120'));
    await assert.rejects(
      bad.service.json('https://example.test'),
      (e) => e.code === code && !e.message.includes('secret'),
    );
  }
  const rate = fixture(async () => response({}, 429, '120'));
  await assert.rejects(rate.service.json('https://example.test'), (e) => e.retryMs === 120000);
  await assert.rejects(fixture().service.json('https://example.test'), /network-error/);
  await assert.rejects(
    fixture(async () => ({ ok: true, text: async () => '{' })).service.json('https://example.test'),
    /invalid-response/,
  );
  await assert.rejects(
    fixture(async () => ({
      ok: true,
      text: async () => 'x'.repeat(2 * 1024 * 1024 + 1),
    })).service.json('https://example.test'),
    /invalid-response/,
  );
});
test('home selection is explicit and invalidates source-bound data', async () => {
  const f = fixture(async () =>
    response({ homes: [{ id: 'other-home', name: 'Other synthetic meter' }] }),
  );
  await assert.rejects(f.service.selectHome({ homeId: 'other-home' }), /home-confirmation/);
  await assert.rejects(
    f.service.selectHome({ homeId: 'missing', confirmSamePlant: true }),
    /invalid-home/,
  );
  f.data.tibberDataPriceCache = { private: true };
  await f.service.selectHome({ homeId: 'other-home', confirmSamePlant: true });
  assert.equal(f.service.status().homeId, 'other-home');
  assert.equal(f.data.tibberDataPriceCache, null);
  assert.notEqual(f.data.tibberDataSession.revision, 'revision-a');
  for (const v of [
    {},
    { homes: [{ id: '../bad', name: 'bad' }] },
    { homes: [{ id: 'ok', name: 2 }] },
  ])
    await assert.rejects(fixture(async () => response(v)).service.homes(), /invalid-response/);
});
test('refresh race and in-flight prices cannot repopulate after disconnect/home change', async () => {
  let release;
  const f = fixture(async () => {
    await new Promise((r) => {
      release = r;
    });
    return response(token());
  });
  f.data.tibberDataSession.token.expiresAt = 0;
  const pending = f.service.access();
  await tick();
  f.service.disconnect();
  release();
  await assert.rejects(pending, /configuration-changed/);
  assert.equal(f.data.tibberDataSession, null);
  const g = fixture(async () => {
    await new Promise((r) => {
      release = r;
    });
    return response(page());
  });
  const sync = g.service.sync();
  await tick();
  g.service.disconnect();
  release();
  await sync;
  assert.equal(g.data.tibberDataPriceCache, null);
});
test('sync is serialized, bound to home, caches normalized rows and respects retry', async () => {
  let calls = 0;
  const f = fixture(async (url) => {
    calls++;
    assert.match(url, /homes\/synthetic-home\/prices/);
    return response(page());
  });
  await Promise.all([f.service.sync(), f.service.sync()]);
  assert.equal(calls, 1);
  assert.equal(f.service.status().priceRows, 1);
  assert.equal(f.service.status().syncStatus, 'ok');
  await f.service.sync();
  assert.equal(calls, 1);
  assert.equal(f.service.ledger().status, 'priced');
  f.setNow(NOW + 3600001);
  await f.service.sync();
  assert.equal(calls, 2);
  const bad = fixture();
  await bad.service.sync();
  assert.equal(bad.service.status().syncStatus, 'network-error');
  await bad.service.sync();
  f.service.stop();
  await f.service.sync();
  assert.throws(() => f.service.write('x', 1), /stopped/);
  const empty = fixture();
  empty.data.tibberDataSession = null;
  assert.equal((await empty.service.sync()).connected, false);
  await assert.rejects(empty.service.access(), /authorization-required/);
});
test('provider corrections and newly available production replace cached rows', async () => {
  let n = 0;
  const f = fixture(async () => response(page([row(T, !!n++)])));
  await f.service.sync();
  assert.equal(f.service.ledger().missingProductionQuarters, 1);
  f.setNow(NOW + 3600001);
  await f.service.sync();
  assert.equal(f.data.tibberDataPriceCache.rows[0].production.price, -0.2);
});
test('network options require separately billed confirmed raw-spot contract', () => {
  const f = fixture();
  assert.throws(() => f.service.options({ includeNetwork: true }), /network-confirmation/);
  assert.throws(() => f.service.options({ includeNetwork: 'yes' }), /invalid-options/);
  f.service.options({ includeNetwork: true, confirmSeparateNetworkComponents: true });
  assert.equal(f.service.status().includeNetwork, true);
  f.service.options({ includeNetwork: false });
  assert.equal(f.service.status().includeNetwork, false);
  f.data.tibberDataSession.homeId = null;
  assert.throws(() => f.service.options({ includeNetwork: false }), /select-home/);
});
test('safe cache rejects future, duplicate, malformed and cross-source data', () => {
  const c = { revision: 'r', fetchedAt: NOW, rows: [row()] };
  assert.equal(safeCache(c, 'r', NOW), c);
  for (const bad of [
    null,
    { ...c, revision: 'x' },
    { ...c, fetchedAt: NOW + 1 },
    { ...c, rows: null },
    { ...c, rows: [row(), row()] },
    { ...c, rows: [{ ...row(), t: T + 1 }] },
    { ...c, rows: [{ ...row(), production: { price: NaN, vat: 0 } }] },
  ])
    assert.equal(safeCache(bad, 'r', NOW), null);
});
test('observed ledger preserves signed export and adds manual network/VAT exactly once', () => {
  const f = fixture(),
    s = f.data.tibberDataSession,
    c = { revision: s.revision, fetchedAt: NOW, rows: [row()] };
  const trade = observedCosts(f.homey, s, c, null, NOW);
  assert.equal(trade.status, 'priced');
  assert.equal(trade.totals.importCostSek, 1.2);
  assert.equal(trade.totals.exportRevenueSek, -0.1);
  assert.equal(trade.financiallyComparable, false);
  const options = {
    includeNetwork: true,
    revision: s.revision,
    costHash: contractHash(contract()),
  };
  c.rows[0].consumption.thirdParty = 999;
  const full = observedCosts(f.homey, s, c, options, NOW);
  assert.ok(Math.abs(full.totals.importCostSek - 1.7) < 1e-9);
  assert.ok(Math.abs(full.totals.exportRevenueSek - -0.085) < 1e-9);
  assert.equal(full.componentBasis, 'tibber-plus-confirmed-manual-network');
  f.data.costContract.otherImportExVatSekPerKWh = 0.08;
  assert.equal(observedCosts(f.homey, s, c, options, NOW).status, 'network-confirmation-required');
});
test('ledger never fills missing directional energy, prices or production', () => {
  const f = fixture(),
    s = f.data.tibberDataSession,
    c = { revision: s.revision, fetchedAt: NOW, rows: [row()] };
  assert.equal(observedCosts(f.homey, s, null, null, NOW).status, 'no-prices');
  f.homey.app.history.getSlots = () => [slot(T - Q), slot()];
  let result = observedCosts(f.homey, s, c, null, NOW);
  assert.equal(result.status, 'partial');
  assert.equal(result.missingPriceQuarters, 1);
  assert.equal(result.matchedQuarters, 1);
  c.rows = [row(T, false)];
  result = observedCosts(f.homey, s, c, null, NOW);
  assert.equal(result.totals, null);
  assert.equal(result.missingProductionQuarters, 1);
  c.rows = [{ ...row(), consumption: { price: NaN, vat: 25 } }];
  assert.equal(observedCosts(f.homey, s, c, null, NOW).totals, null);
  f.homey.app.history.getSlots = () => {
    throw Error();
  };
  assert.equal(observedCosts(f.homey, s, c, null, NOW).status, 'energy-unavailable');
});
test('VAT mismatch and legacy contract cannot silently price observations', () => {
  const f = fixture(),
    s = f.data.tibberDataSession,
    c = {
      revision: s.revision,
      fetchedAt: NOW,
      rows: [{ ...row(), consumption: { price: 1, vat: 0 } }],
    };
  const options = {
    includeNetwork: true,
    revision: s.revision,
    costHash: contractHash(contract()),
  };
  assert.equal(observedCosts(f.homey, s, c, options, NOW).vatMismatchQuarters, 1);
  f.data.costContract = null;
  assert.equal(observedCosts(f.homey, s, c, options, NOW).status, 'network-confirmation-required');
});
test('new API routes are private and delegate to service', async () => {
  const api = require('../api'),
    manifest = require('../app.json'),
    f = fixture();
  f.homey.app.tibberData = f.service;
  for (const [name, path] of [
    ['getTibberDataStatus', '/tibber/data/status'],
    ['connectTibberData', '/tibber/data/connect'],
    ['getTibberDataHomes', '/tibber/data/homes'],
    ['selectTibberDataHome', '/tibber/data/home'],
    ['configureTibberDataComponents', '/tibber/data/components'],
    ['refreshTibberData', '/tibber/data/refresh'],
    ['disconnectTibberData', '/tibber/data/disconnect'],
    ['getObservedCosts', '/economics/observed'],
  ]) {
    assert.equal(manifest.api[name].public, false);
    assert.equal(manifest.api[name].path, path);
    const method = {
      getTibberDataStatus: 'status',
      connectTibberData: 'connect',
      getTibberDataHomes: 'homes',
      selectTibberDataHome: 'selectHome',
      configureTibberDataComponents: 'options',
      refreshTibberData: 'sync',
      disconnectTibberData: 'disconnect',
      getObservedCosts: 'ledger',
    }[name];
    f.service[method] = (body) => ({ called: method, body });
    const result = await api[name]({ homey: f.homey, body: { synthetic: true } });
    assert.equal(result.called, method);
  }
  assert.equal(new DataError('test').retryMs, 3600000);
});
