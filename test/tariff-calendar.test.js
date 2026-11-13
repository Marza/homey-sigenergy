'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { excludedDate } = require('../lib/tariff-calendar');
const { activeAt, calculateDemandCharge } = require('../lib/demand-tariff');
const { tariffKey, validateTariff, parseTariffForm } = require('../lib/tariff-config');
const { evaluateTariffScenarios } = require('../lib/optimization/tariff-optimizer');
const tariff = {
  start: '07:00',
  end: '20:00',
  weekdays: [1, 2, 3, 4, 5],
  months: [1, 2, 3, 11, 12],
  peakCount: 2,
  distinctDays: true,
  rateSekPerKw: 125.1,
  calendar: 'se-telge',
};
const past = { nowMs: Date.parse('2027-01-01T00:00:00Z') };
function hour(iso, kw = 1) {
  const t = Date.parse(iso);
  return [0, 1, 2, 3].map((i) => ({
    t: t + i * 900000,
    gridWh: kw * 250,
    coverageMs: 900000,
    essWh: 0,
  }));
}
test('Swedish holidays and Telge eves use calendar dates, including movable holidays', () => {
  for (const date of [
    '2026-01-01',
    '2026-01-06',
    '2026-04-03',
    '2026-04-06',
    '2026-05-01',
    '2026-05-14',
    '2026-06-06',
    '2026-06-20',
    '2026-10-31',
    '2026-12-24',
    '2026-12-25',
    '2026-12-26',
    '2026-12-31',
    '2027-03-26',
    '2027-03-29',
    '2027-06-26',
    '2027-11-06',
    '2026-11-01',
  ])
    assert.equal(excludedDate(date), true, date);
  for (const date of [
    '2026-04-02',
    '2026-04-07',
    '2026-06-19',
    '2026-12-23',
    '2027-03-25',
    '2027-03-30',
    '2027-11-05',
  ])
    assert.equal(excludedDate(date), false, date);
});
test('holiday calendar is opt-in, validated, and included in cached result identity', () => {
  for (const iso of [
    '2026-01-01T09:00Z',
    '2026-01-06T09:00Z',
    '2026-12-24T09:00Z',
    '2026-12-31T09:00Z',
    '2027-03-26T09:00Z',
    '2027-03-29T09:00Z',
  ]) {
    assert.equal(activeAt(Date.parse(iso), tariff), false, iso);
    assert.equal(activeAt(Date.parse(iso), { ...tariff, calendar: undefined }), true, iso);
  }
  assert.equal(activeAt(Date.parse('2026-01-07T06:00Z'), tariff), true);
  assert.notEqual(tariffKey(tariff), tariffKey({ ...tariff, calendar: 'none' }));
  assert.throws(() => validateTariff({ ...tariff, calendar: 'unknown' }));
  const raw = {
    ...tariff,
    weekdays: '1,2,3,4,5',
    peakCount: '2',
    rateSekPerKw: '125.1',
    distinctDays: 'true',
    allYear: false,
  };
  assert.deepEqual(parseTariffForm(raw), tariff);
  assert.throws(() => parseTariffForm({ ...raw, calendar: 'unknown' }));
});
test('hand-calculated synthetic reference: exclusions, daily maxima, mean and fee', () => {
  // Synthetic observations, not customer billing evidence. Jan 1 is ineligible.
  const rows = [
    ...hour('2026-01-01T09:00Z', 99),
    ...hour('2026-01-07T09:00Z', 4),
    ...hour('2026-01-07T10:00Z', 8),
    ...hour('2026-01-08T09:00Z', 6),
  ];
  const r = calculateDemandCharge(rows, tariff, '2026-01', past);
  assert.deepEqual(
    r.selectedPeaks.map((p) => [p.date, p.kw]),
    [
      ['2026-01-07', 8],
      ['2026-01-08', 6],
    ],
  );
  assert.equal(r.averageKw, 7);
  assert.ok(Math.abs(r.estimatedSek - 875.7) < 1e-9);
  assert.equal(r.eligibleHours, 3);
  assert.equal(r.coverage.expectedHours, 20 * 13); // 22 weekdays minus Jan 1 and Jan 6
});
test('coverage counts completely absent hours and separates future hours', () => {
  const c = { ...tariff, peakCount: 1 };
  const r = calculateDemandCharge(hour('2026-01-02T06:00Z', 2), c, '2026-01', {
    nowMs: Date.parse('2026-01-02T08:30Z'),
  });
  assert.equal(r.coverage.elapsedHours, 2);
  assert.equal(r.coverage.completeHours, 1);
  assert.equal(r.coverage.missingHours, 1);
  assert.equal(r.coverage.pendingHours, r.coverage.expectedHours - 2);
  assert.equal(r.coverage.status, 'partial');
  const future = calculateDemandCharge(hour('2026-01-02T09:00Z', 99), c, '2026-01', {
    nowMs: Date.parse('2026-01-02T08:30Z'),
  });
  assert.equal(future.status, 'insufficient-data');
  assert.throws(() => calculateDemandCharge([], c, '2026-13', past));
  assert.throws(() => calculateDemandCharge([], c, '2026-01', { nowMs: NaN }));
});
test('duplicate quarters invalidate an hour rather than replace an observation', () => {
  const rows = hour('2026-01-07T09:00Z', 5);
  rows.push({ ...rows[0], gridWh: 99999 });
  const r = calculateDemandCharge(rows, { ...tariff, peakCount: 1 }, '2026-01', past);
  assert.equal(r.eligibleHours, 0);
  assert.equal(r.status, 'insufficient-data');
});
test('DST real hours and Stockholm month boundaries preserve coverage', () => {
  for (const [month, expected] of [
    ['2026-03', 14],
    ['2026-10', 13],
  ]) {
    const config = {
      ...tariff,
      calendar: 'none',
      months: undefined,
      weekdays: [0],
      start: '01:00',
      end: '04:00',
      peakCount: 1,
    };
    const rows = [];
    const first = Date.parse(month + '-01T00:00Z') - 86400000;
    for (let t = first; t < first + 33 * 86400000; t += 3600000)
      if (activeAt(t, config)) rows.push(...hour(new Date(t).toISOString()));
    const r = calculateDemandCharge(rows, config, month, past);
    assert.equal(r.coverage.expectedHours, expected);
    assert.equal(r.coverage.completeHours, expected);
    assert.equal(r.coverage.missingHours, 0);
    assert.equal(r.coverage.status, 'complete');
  }
  const config = {
    ...tariff,
    calendar: 'none',
    months: undefined,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '01:00',
    peakCount: 1,
  };
  const r = calculateDemandCharge(hour('2026-03-31T22:00Z', 4), config, '2026-04', past);
  assert.equal(r.selectedPeaks[0].date, '2026-04-01');
  assert.equal(
    calculateDemandCharge(hour('2026-03-31T22:00Z', 4), config, '2026-03', past).eligibleHours,
    0,
  );
});
test('baseline and replay carry identical observed-hour coverage', () => {
  const rows = [...hour('2026-01-07T09:00Z', 8), ...hour('2026-01-08T09:00Z', 6)];
  const result = evaluateTariffScenarios(
    rows,
    {
      minCapKW: 3,
      maxCapKW: 3,
      reserveMinPercent: 20,
      reserveMaxPercent: 20,
      initialSocPercent: 90,
      batteryCapacityKWh: 42,
    },
    tariff,
    '2026-01',
    past,
  );
  assert.equal(result.status, 'provisional');
  assert.equal(result.scope, 'observed-hours');
  assert.deepEqual(result.coverage, result.baseline.coverage);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.best.eligibleHours, result.coverage.completeHours);
});

test('an invalid duplicate also invalidates its otherwise complete hour', () => {
  const rows = hour('2026-01-07T09:00Z', 5);
  rows.unshift({ ...rows[0], coverageMs: 900001 });
  const r = calculateDemandCharge(rows, { ...tariff, peakCount: 1 }, '2026-01', past);
  assert.equal(r.eligibleHours, 0);
});
