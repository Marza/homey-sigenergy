'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasTomorrowPrices, shouldRefreshPrices } = require('../lib/pricing/refresh-policy');
test('no tomorrow prices: refresh every 15 minutes after 13 Stockholm time', () => {
 const now = new Date('2026-11-12T13:00:00Z');
 assert.equal(shouldRefreshPrices({ now, cache: null, lastAttemptAt: '2026-11-12T12:44:00Z' }), true);
 assert.equal(shouldRefreshPrices({ now, cache: null, lastAttemptAt: '2026-11-12T12:50:00Z' }), false);
});
test('tomorrow available: use hourly refresh', () => {
 const now = new Date('2026-11-12T13:00:00Z');
 const cache = { prices: [{start:'2026-11-13T00:00:00+01:00'}] };
 assert.equal(hasTomorrowPrices(cache, now), true);
 assert.equal(shouldRefreshPrices({ now, cache, lastAttemptAt: '2026-11-12T12:30:00Z' }), false);
});
test('before 13: refresh hourly', () => {
 const now = new Date('2026-11-12T10:00:00Z');
 assert.equal(shouldRefreshPrices({ now, cache:null, lastAttemptAt:'2026-11-12T09:30:00Z' }), false);
});
