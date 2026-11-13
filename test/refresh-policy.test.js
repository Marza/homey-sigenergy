'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasTomorrowPrices, shouldRefreshPrices } = require('../lib/pricing/refresh-policy');
test('no tomorrow prices: refresh every 15 minutes after 13 Stockholm time', () => {
  const now = new Date('2026-11-12T13:00:00Z');
  assert.equal(
    shouldRefreshPrices({ now, cache: null, lastAttemptAt: '2026-11-12T12:44:00Z' }),
    true,
  );
  assert.equal(
    shouldRefreshPrices({ now, cache: null, lastAttemptAt: '2026-11-12T12:50:00Z' }),
    false,
  );
});
test('tomorrow available: use hourly refresh', () => {
  const now = new Date('2026-11-12T13:00:00Z');
  const start = Date.parse('2026-11-13T00:00:00+01:00');
  const cache = {
    schema: 2,
    resolution: 'HOURLY',
    currency: 'SEK',
    fetchedAt: '2026-11-12T12:00:00Z',
    prices: Array.from({ length: 48 }, (_, i) => ({
      start: new Date(start + (i - 24) * 3600000).toISOString(),
      end: new Date(start + (i - 23) * 3600000).toISOString(),
      price: 1,
    })),
  };
  assert.equal(hasTomorrowPrices(cache, now), true);
  assert.equal(shouldRefreshPrices({ now, cache, lastAttemptAt: '2026-11-12T12:30:00Z' }), false);
});
test('without current prices retry every 15 minutes even before 13', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  assert.equal(
    shouldRefreshPrices({ now, cache: null, lastAttemptAt: '2026-11-12T09:30:00Z' }),
    true,
  );
});
