'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePrices, fetchTibberPrices } = require('../lib/pricing/tibber');
const { validateEvdc, readEvdc } = require('../lib/charging/evdc');
const rows = [
  { startsAt: '2026-11-12T00:00:00Z', total: 0.3 },
  { startsAt: '2026-11-12T00:15:00Z', total: 0.2 },
  { startsAt: '2026-11-12T00:30:00Z', total: 0.4 },
];
test('normalize Tibber prices into 15-min slots', () => {
  const slots = normalizePrices(
    { currentSubscription: { priceInfo: { today: rows, tomorrow: [] } } },
    new Date('2026-11-11'),
  );
  assert.equal(slots.length, 3);
  assert.equal(Date.parse(slots[0].end) - Date.parse(slots[0].start), 900000);
});
test('reject insufficient price data', () =>
  assert.throws(
    () => normalizePrices({ currentSubscription: { priceInfo: { today: rows.slice(0, 1) } } }),
    /interval/,
  ));
test('fetch prices and select home', async () => {
  const result = await fetchTibberPrices({
    token: 'test',
    homeId: 'abc',
    now: new Date('2026-11-11'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            homes: [
              { id: 'abc', currentSubscription: { priceInfo: { today: rows, tomorrow: [] } } },
            ],
          },
        },
      }),
    }),
  });
  assert.equal(result.homeId, 'abc');
  assert.equal(result.prices.length, 3);
});
test('reject invalid EVDC SoC', () =>
  assert.throws(() => validateEvdc({ soc: 120, powerW: 1000 }), /SoC/));
test('read EVDC with explicit scales', async () => {
  const data = await readEvdc({ read: async (addr) => (addr === 31502 ? [0, 2500] : [75]) });
  assert.deepEqual(data, { soc: 75, powerW: 2500 });
});
