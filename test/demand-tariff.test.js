'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activeAt, calculateDemandCharge, localParts } = require('../lib/demand-tariff');
const tariff = {
  start: '07:00',
  end: '20:00',
  weekdays: [1, 2, 3, 4, 5],
  months: [11, 12, 1, 2, 3],
  rateSekPerKw: 100,
  peakCount: 5,
  distinctDays: true,
};
function hour(iso, kw) {
  const start = Date.parse(iso);
  return [0, 1, 2, 3].map((i) => ({ t: start + i * 900000, gridWh: kw * 250, coverageMs: 900000 }));
}
test('five highest complete hourly averages on distinct days', () => {
  const rows = [12, 8, 6, 4, 2].flatMap((kw, i) =>
    hour(`2026-01-${String(12 + i).padStart(2, '0')}T09:00:00Z`, kw),
  );
  rows.push(...hour('2026-01-12T10:00:00Z', 20));
  const r = calculateDemandCharge(rows, tariff, '2026-01');
  assert.equal(r.averageKw, 8);
  assert.equal(r.estimatedSek, 800);
  assert.deepEqual(
    r.selectedPeaks.map((p) => p.kw),
    [20, 8, 6, 4, 2],
  );
});
test('missing quarter never becomes a complete hourly peak', () => {
  const rows = hour('2026-01-12T09:00:00Z', 12).slice(0, 3);
  const r = calculateDemandCharge(rows, { ...tariff, peakCount: 1 }, '2026-01');
  assert.equal(r.averageKw, null);
  assert.equal(r.eligibleHours, 0);
});
test('weekday, season and time window in Stockholm', () => {
  assert.equal(activeAt(Date.parse('2026-01-12T06:00:00Z'), tariff), true);
  assert.equal(activeAt(Date.parse('2026-01-12T19:00:00Z'), tariff), false);
  assert.equal(activeAt(Date.parse('2026-06-12T09:00:00Z'), tariff), false);
  assert.equal(localParts(Date.parse('2026-03-29T01:30:00Z')).minute, 210);
});
test('reject malformed tariff', () =>
  assert.throws(() => activeAt(Date.now(), { ...tariff, peakCount: 0 })));
