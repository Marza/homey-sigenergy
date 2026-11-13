'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calendar,
  coverageFor,
  inspectCache,
  priceStatus,
  refreshPolicy,
  usablePrices,
} = require('../lib/pricing/coverage');
const { normalizePrices, fetchTibberPrices } = require('../lib/pricing/tibber');
const { hasTomorrowPrices } = require('../lib/pricing/refresh-policy');
const fixture = require('./fixtures/tibber-quarter-hourly.json');
const now = new Date('2026-11-13T12:00:00Z');
const home = () => structuredClone(fixture.data.viewer.homes[0]);
function cache() {
  return {
    schema: 2,
    homeId: 'fixture-home',
    selectedHomeId: 'fixture-home',
    resolution: 'QUARTER_HOURLY',
    currency: 'SEK',
    fetchedAt: now.toISOString(),
    prices: normalizePrices(home(), now),
  };
}
const values = (c) => ({
  tibberToken: 'test-not-a-secret',
  tibberHomeId: 'fixture-home',
  priceCache: c,
});
const response = (data) => async () => ({ ok: true, json: async () => data });

test('sanitized real response preserves explicit resolution, negative prices and final interval', async () => {
  const result = await fetchTibberPrices({
    token: 'test',
    homeId: 'fixture-home',
    now,
    fetchImpl: async (_url, request) => {
      assert.match(JSON.parse(request.body).query, /priceInfo\(resolution: QUARTER_HOURLY\)/);
      assert.match(request.body, /currency/);
      return response(fixture)();
    },
  });
  assert.equal(result.prices.length, 192);
  assert.equal(result.schema, 2);
  assert.equal(result.currency, 'SEK');
  assert.equal(result.prices[0].price, -0.25);
  assert.equal(result.prices.at(-1).end, '2026-11-14T23:00:00.000Z');
  const status = priceStatus(values(result), now.getTime());
  assert.equal(status.status, 'ok');
  assert.equal(status.coverage.tomorrow.expectedMs, 86400000);
  assert.equal(status.coverage.tomorrow.complete, true);
  assert.equal(hasTomorrowPrices(result, now), true);
  assert.ok(
    usablePrices(values(result), now.getTime()).every((p) => Date.parse(p.end) > now.getTime()),
  );
});

test('three missing quarters are gaps, never a longer valid price', () => {
  const h = home();
  h.currentSubscription.priceInfo.tomorrow.splice(1, 3);
  const c = { ...cache(), prices: normalizePrices(h, now) };
  assert.equal(Date.parse(c.prices[96].end) - Date.parse(c.prices[96].start), 900000);
  const status = priceStatus(values(c), now.getTime());
  assert.equal(status.status, 'partial');
  assert.equal(status.coverage.tomorrow.coveredMs, 23.25 * 3600000);
  assert.deepEqual(status.coverage.tomorrow.gaps, [
    { start: '2026-11-13T23:15:00.000Z', end: '2026-11-14T00:00:00.000Z' },
  ]);
  assert.equal(hasTomorrowPrices(c, now), false);
  const policy = refreshPolicy({ cache: c, now, lastAttemptAt: '2026-11-13T11:50:00Z' });
  assert.equal(policy.intervalMinutes, 15);
  assert.equal(policy.eligible, false);
  assert.equal(policy.nextAttemptAt, '2026-11-13T12:05:00.000Z');
});

test('identical duplicate rows are counted once; conflicting duplicates fail', async () => {
  const h = home();
  h.currentSubscription.priceInfo.today.push({ ...h.currentSubscription.priceInfo.today[0] });
  const r = await fetchTibberPrices({
    token: 'test',
    now,
    fetchImpl: response({ data: { viewer: { homes: [h] } } }),
  });
  assert.equal(r.duplicateRows, 1);
  assert.equal(r.prices.length, 192);
  h.currentSubscription.priceInfo.today.at(-1).total = 99;
  assert.throws(() => normalizePrices(h, now), /Conflicting duplicate/);
});

for (const [date, hours] of [
  ['2026-03-29', 23],
  ['2026-10-25', 25],
]) {
  test(`Stockholm ${date} has exactly ${hours} covered hours without local-time collisions`, () => {
    const time = new Date(date + 'T12:00:00Z'),
      day = calendar(time).today;
    assert.equal(day.end - day.start, hours * 3600000);
    const today = Array.from({ length: hours * 4 }, (_, i) => ({
      startsAt: new Date(day.start + i * 900000).toISOString(),
      total: -0.2,
      currency: 'SEK',
    }));
    const prices = normalizePrices(
      { currentSubscription: { priceInfo: { today, tomorrow: [] } } },
      time,
    );
    assert.equal(prices.length, hours * 4);
    assert.equal(coverageFor(prices, day.start, day.end).complete, true);
    assert.equal(prices.at(-1).end, new Date(day.end).toISOString());
    const preceding = new Date(day.start - 3600000);
    const c = { ...cache(), fetchedAt: preceding.toISOString(), prices };
    assert.equal(
      priceStatus(values(c), preceding.getTime()).coverage.tomorrow.expectedMs,
      hours * 3600000,
    );
    assert.equal(hasTomorrowPrices(c, preceding), true);
  });
}

test('hourly contract is explicit and an hourly gap never changes the final duration', () => {
  const h = structuredClone(require('./fixtures/tibber-hourly.json').data.viewer.homes[0]);
  h.currentSubscription.priceInfo.tomorrow.splice(3, 1);
  const prices = normalizePrices(h, now, { resolution: 'HOURLY' });
  assert.equal(prices.length, 47);
  assert.ok(prices.every((p) => Date.parse(p.end) - Date.parse(p.start) === 3600000));
  assert.equal(prices.at(-1).end, '2026-11-14T23:00:00.000Z');
  assert.throws(() => normalizePrices(home(), now, { resolution: 'HOURLY' }), /ambiguous/);
});

test('malformed, ambiguous, wrong-currency and wrong-day data fail closed', () => {
  for (const mutate of [
    (h) => {
      h.currentSubscription.priceInfo.today = null;
    },
    (h) => {
      h.currentSubscription.priceInfo.today[0] = null;
    },
    (h) => {
      h.currentSubscription.priceInfo.today[0].total = null;
    },
    (h) => {
      h.currentSubscription.priceInfo.today[0].currency = 'EUR';
    },
    (h) => {
      h.currentSubscription.priceInfo.today[0].startsAt = '2026-11-13T00:00:00';
    },
    (h) => {
      h.currentSubscription.priceInfo.today[0].startsAt = '2026-11-13T00:01:00+01:00';
    },
    (h) => {
      h.currentSubscription.priceInfo.today[0].startsAt = '2026-11-14T00:00:00+01:00';
    },
    (h) => {
      h.currentSubscription.priceInfo.today[0].startsAt = '2026-11-13T24:00:00+01:00';
    },
    (h) => {
      h.currentSubscription.priceInfo = null;
    },
  ]) {
    const h = home();
    mutate(h);
    assert.throws(() => normalizePrices(h, now));
  }
  assert.throws(() => normalizePrices(home(), now, { resolution: 'DAILY' }), /Unsupported/);
});

test('legacy, corrupt, expired, future-dated and changed-home caches are never trusted', () => {
  const base = cache();
  for (const c of [
    { ...base, schema: 1 },
    { ...base, currency: 'EUR' },
    { ...base, prices: null },
    { ...base, prices: [...base.prices, base.prices[0]] },
    { ...base, prices: [{ ...base.prices[0], price: null }] },
    { ...base, prices: [{ ...base.prices[0], end: base.prices[0].start }] },
  ]) {
    assert.equal(inspectCache(c).prices.length, 0);
    assert.equal(priceStatus(values(c), now.getTime()).usable, false);
  }
  assert.equal(priceStatus(values({ ...base, fetchedAt: 'bad' }), now.getTime()).usable, false);
  assert.equal(
    priceStatus(
      values({ ...base, fetchedAt: new Date(now.getTime() + 1000).toISOString() }),
      now.getTime(),
    ).usable,
    false,
  );
  assert.equal(
    priceStatus({ ...values(base), tibberHomeId: 'other-home' }, now.getTime()).reason,
    'configuration-changed',
  );
  assert.equal(
    priceStatus({ ...values(base), sourceConfig: { tibber: { revision: 'new' } } }, now.getTime())
      .usable,
    false,
  );
  assert.equal(
    priceStatus(values(base), Date.parse('2026-11-15T00:00:00Z')).reason,
    'expired-prices',
  );
  assert.equal(priceStatus({ ...values(base), tibberToken: '' }, now.getTime()).status, 'disabled');
  assert.equal(priceStatus(values(null), now.getTime()).status, 'no-data');
});

test('API failure retains usable known coverage and reports the failure separately', () => {
  const v = {
    ...values(cache()),
    priceError: 'Tibber HTTP 503',
    priceLastAttemptAt: now.toISOString(),
  };
  const status = priceStatus(v, now.getTime());
  assert.equal(status.status, 'error');
  assert.equal(status.usable, true);
  assert.equal(status.coverage.tomorrow.complete, true);
  assert.equal(status.refresh.intervalMinutes, 60);
  assert.equal(status.lastAttemptAt, now.toISOString());
});

test('clock skew and invalid attempt timestamps cannot suppress refresh forever', () => {
  for (const lastAttemptAt of ['invalid', new Date(now.getTime() + 10000).toISOString(), null])
    assert.equal(refreshPolicy({ cache: cache(), now, lastAttemptAt }).eligible, true);
  assert.equal(
    refreshPolicy({ cache: {}, now, lastAttemptAt: now.toISOString() }).intervalMinutes,
    15,
  );
  assert.throws(() => coverageFor([], 1, 0), /Invalid/);
  assert.equal(coverageFor([], 0, 0).complete, true);
  const morning = new Date('2026-11-13T08:00:00Z');
  const morningCache = { ...cache(), fetchedAt: '2026-11-13T07:00:00Z' };
  assert.equal(
    refreshPolicy({ cache: morningCache, now: morning, lastAttemptAt: '2026-11-13T07:30:00Z' })
      .intervalMinutes,
    60,
  );
});

test('multiple homes require exact selection and failures never echo credentials', async () => {
  const two = structuredClone(fixture);
  two.data.viewer.homes.push({ ...home(), id: 'other-home' });
  await assert.rejects(
    fetchTibberPrices({ token: 'test', now, fetchImpl: response(two) }),
    /home ID/,
  );
  await assert.rejects(
    fetchTibberPrices({ token: 'test', homeId: 'missing', now, fetchImpl: response(two) }),
    /home ID/,
  );
  assert.equal(
    (
      await fetchTibberPrices({
        token: 'test',
        homeId: 'other-home',
        now,
        fetchImpl: response(two),
      })
    ).homeId,
    'other-home',
  );
  for (const fetchImpl of [
    async () => {
      throw new Error('do-not-leak-token');
    },
    async () => {
      throw Object.assign(new Error('do-not-leak-token'), { name: 'TimeoutError' });
    },
    response({ errors: [{ message: 'do-not-leak-token' }] }),
    async () => ({
      ok: true,
      json: async () => {
        throw new Error('do-not-leak-token');
      },
    }),
    async () => ({ ok: false, status: 429 }),
  ]) {
    await assert.rejects(
      fetchTibberPrices({ token: 'do-not-leak-token', now, fetchImpl }),
      (error) => !error.message.includes('do-not-leak-token'),
    );
  }
  await assert.rejects(fetchTibberPrices({ token: ' ', fetchImpl: response(fixture) }), /missing/);
  await assert.rejects(
    fetchTibberPrices({ token: 'test', homeId: 4, fetchImpl: response(fixture) }),
    /home ID/,
  );
  await assert.rejects(
    fetchTibberPrices({ token: 'test', resolution: 'DAILY', fetchImpl: response(fixture) }),
    /Unsupported/,
  );
  await assert.rejects(
    fetchTibberPrices({
      token: 'test',
      now,
      fetchImpl: response({ data: { viewer: { homes: [] } } }),
    }),
    /home ID/,
  );
  await assert.rejects(
    fetchTibberPrices({ token: 'test', now, fetchImpl: response({}) }),
    /homes response/,
  );
  await assert.rejects(
    fetchTibberPrices({
      token: 'test',
      now,
      fetchImpl: response({
        data: {
          viewer: {
            homes: [{ id: 'x', currentSubscription: { priceInfo: { today: [], tomorrow: [] } } }],
          },
        },
      }),
    }),
    /No usable/,
  );
});
