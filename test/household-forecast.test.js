'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { HouseholdForecast } = require('../lib/energy/household-forecast');
const Q = 900000,
  DAY = 96 * Q,
  T = Date.parse('2026-11-17T10:00Z');
function fixture(rows = []) {
  const data = new Map(),
    settings = { get: (k) => data.get(k), set: (k, v) => data.set(k, structuredClone(v)) };
  const history = { getSlots: () => rows };
  return { rows, data, settings, history, model: new HouseholdForecast(settings, history) };
}
const row = (t, wh = 250) => ({ t, householdCoverageMs: Q, householdWh: wh, gridWh: 10000 });
test('a partial horizon uses only measured household energy and preserves valid zeros, issuance and gaps', () => {
  const f = fixture([
    row(T - DAY + Q, 0),
    row(T - DAY + 2 * Q, 500),
    { ...row(T - DAY + 3 * Q), householdCoverageMs: Q - 1 },
    row(T + Q, 99999),
  ]);
  const a = f.model.report(T);
  assert.equal(a.known, 2);
  assert.deepEqual(a.forecastKW.slice(0, 3), [0, 2, null]);
  assert.equal(a.peakAt, T + 2 * Q);
  assert.equal(a.totalKWh, null);
  assert.equal(a.comparable, 0);
  assert.equal(a.comparison, null);
  f.rows[0].householdWh = 12345;
  assert.deepEqual(
    new HouseholdForecast(f.settings, f.history).report(T + 1000).forecastKW,
    a.forecastKW,
  );
  assert.equal(f.data.values().next().value.issues.length, 1);
  assert.throws(() => f.model.report(T - 1), /Clock/);
  const empty = fixture().model.report(T);
  assert.equal(empty.known, 0);
  assert.equal(empty.peakKW, null);
  assert.equal(empty.peakAt, null);
});
test('three comparable days use their median and separate working days from weekends', () => {
  const f = fixture();
  for (let d = 1; d <= 12; d++)
    for (let i = 0; i < 96; i++) {
      const t = T + i * Q - d * DAY;
      const weekend = [0, 6].includes(new Date(t).getUTCDay());
      f.rows.push(row(t, weekend ? 900 : d === 1 ? 800 : 250));
    }
  const a = f.model.report(T);
  assert.equal(a.known, 96);
  assert.equal(a.forecastKW[0], 1);
  assert.equal(a.totalKWh, 24);
  assert.equal(a.comparable, 96);
  assert.equal(a.rangeKWh, null);
});
test('Stockholm spring gap and autumn duplicate use civil clock time; repeated hours carry one daily vote', () => {
  const issueTime = Date.parse('2026-03-29T23:45Z');
  const f = fixture([
    row(Date.parse('2026-03-29T00:00Z'), 250),
    row(Date.parse('2026-03-29T01:00Z'), 500),
  ]);
  assert.equal(f.model.report(issueTime).forecastKW[0], null); // Monday 02:00 had no Sunday counterpart
  assert.equal(f.model.report(issueTime).forecastKW[4], 2);
  const autumn = fixture([
    row(Date.parse('2026-10-25T00:00Z'), 100),
    row(Date.parse('2026-10-25T01:00Z'), 300),
  ]);
  assert.equal(autumn.model.report(Date.parse('2026-10-26T00:45Z')).forecastKW[0], 0.8);
});
test('daily out-of-sample errors, paired baseline and empirical interval require measured outcomes', () => {
  const f = fixture();
  for (let t = T - 14 * DAY; t < T + 20 * DAY; t += Q) f.rows.push(row(t, 250));
  let r;
  for (let d = 0; d <= 15; d++) r = f.model.report(T + d * DAY);
  assert.equal(r.score.days, 14);
  assert.equal(r.score.lastErrorKWh, 0);
  assert.deepEqual(r.rangeKWh, [24, 24]);
  assert.equal(r.score.maeKW, 0);
  assert.equal(r.score.yesterdayMaeKW, 0);
  assert.ok(r.score.pairs >= 14 * 95);
  f.rows.find((v) => v.t === T + Q).householdCoverageMs = 1;
  r = f.model.report(T + 15 * DAY);
  assert.equal(r.score.days, 13);
  assert.equal(r.rangeKWh, null);
  assert.ok(r.comparison.actualKW.includes(1));
  assert.equal(r.comparison.actualKW.length, 96);
});
test('private API serves the forecast and exposes no retired simulation routes', async () => {
  const m = require('../app.json'),
    api = require('../api');
  assert.deepEqual(m.api.getHouseholdForecast, {
    method: 'GET',
    path: '/forecast/household',
    public: false,
  });
  assert.equal(
    await api.getHouseholdForecast({ homey: { app: { forecast: { report: () => 123 } } } }),
    123,
  );
  for (const k of Object.keys(m.api))
    assert.doesNotMatch(
      k,
      /Replay|previewCharging|previewSolar|OptimizationPreview|previewEconomics/,
    );
});
test('ambiguous, unaligned and invalid household observations cannot create a prediction', () => {
  const t = T - DAY + Q;
  const f = fixture([
    row(t, 10),
    row(t, 20),
    row(t + Q, -1),
    row(t + 2 * Q, NaN),
    row(t + 3 * Q + 1),
    null,
  ]);
  assert.equal(f.model.report(T).known, 0);
});
test('rolling forecasts score the same actual quarters as the yesterday baseline, including nonzero errors', () => {
  const rows = [];
  for (let t = T - 8 * DAY; t < T + DAY + Q; t += Q)
    rows.push(row(t, t >= T ? 500 : t >= T - DAY ? 350 : 250));
  const f = fixture(rows);
  f.model.refresh(T);
  const r = f.model.report(T + DAY + Q);
  assert.equal(r.completedRuns, 1);
  assert.equal(r.fullyScoredRuns, 1);
  assert.equal(r.recentErrorKWh, 24);
  assert.equal(r.score.pairs, 95);
  assert.equal(r.score.maeKW, 1);
  assert.equal(r.score.yesterdayMaeKW, 0.6);
});
