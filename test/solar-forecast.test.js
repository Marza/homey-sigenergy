'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { SolarForecast } = require('../lib/energy/solar-forecast');
const api = require('../api');
const Q = 900000,
  H = 4 * Q,
  T = Date.parse('2026-10-25T00:00Z');
const config = {
  enabled: true,
  latitude: 59,
  longitude: 18,
  loss: 10,
  roofs: [
    { name: 'East', kwp: 4, tilt: 30, bearing: 90 },
    { name: 'West', kwp: 2, tilt: 45, bearing: 270 },
  ],
};
function setup() {
  const storage = new Map([['solarMeasurementSource', { key: 'third-party', since: T - 10 * Q }]]),
    rows = [],
    calls = [];
  const settings = {
    get: (k) => storage.get(k),
    set: (k, v) => storage.set(k, structuredClone(v)),
  };
  const f = { now: T + 100, rows, storage, calls };
  const request = async (url, opts) => {
    calls.push(url);
    assert.ok(opts.signal);
    if (f.wait) await f.wait;
    if (f.fail) return { ok: false };
    const start = Math.floor(f.now / Q) * Q;
    const times = Array.from({ length: 110 }, (_, i) => (start + i * Q) / 1000);
    const values = times.map((_, i) =>
      i === 3 ? 0 : i === 4 ? null : url.searchParams.get('azimuth') === '-90' ? 800 : 400,
    );
    return {
      ok: true,
      json: async () => ({
        minutely_15_units: { global_tilted_irradiance: 'W/m²' },
        minutely_15: { time: times, global_tilted_irradiance: values },
      }),
    };
  };
  f.restart = () =>
    new SolarForecast(settings, { getSlots: () => rows }, { request, clock: () => f.now });
  f.model = f.restart();
  return f;
}
test('opt-in weather uses only site and orientation and aligns backward means with UTC quarters across DST', async () => {
  const f = setup(),
    m = f.model;
  await m.refresh();
  assert.equal(f.calls.length, 0);
  assert.equal(m.report().status, 'off');
  m.configure(config);
  assert.equal(m.report().status, 'pending');
  await m.refresh();
  const r = m.report();
  assert.equal(r.status, 'ok');
  assert.equal(r.issue.start, T + Q);
  assert.equal(r.issue.at, f.now);
  assert.equal(r.issue.roofs[0].wh.length, 96);
  assert.deepEqual(
    r.issue.roofs.map((x) => x.wh.slice(0, 3)),
    [
      [720, 0, null],
      [180, 0, null],
    ],
  );
  assert.deepEqual(
    f.calls.map((u) => u.searchParams.get('azimuth')),
    ['-90', '90'],
  );
  assert.ok(
    f.calls.every(
      (u) => !u.href.includes('West') && !u.href.includes('East') && !u.href.includes('kwp'),
    ),
  );
  await f.restart().refresh();
  assert.equal(f.calls.length, 2);
  f.rows.push(
    ...[1, 2, 3, 4].map((i) => ({
      t: T + i * Q,
      pvWh: i === 2 ? 0 : 100,
      fieldCoverageMs: { pvW: i === 3 ? 20 : Q },
    })),
  );
  f.now = T + 4 * Q;
  assert.deepEqual(f.restart().report().issue.actualWh.slice(0, 4), [100, 0, null, null]);
  f.storage.set('solarMeasurementSource', { key: 'combined', since: T + 2 * Q });
  assert.ok(m.report().issue.actualWh.every((x) => x === null));
});
test('issued forecasts survive restarts, provider failure and later revisions without hindsight', async () => {
  const f = setup(),
    m = f.model;
  m.configure(config);
  await m.refresh();
  const first = m.report().issue;
  f.now += H;
  f.fail = true;
  await m.refresh();
  assert.equal(m.report().status, 'weather-error');
  assert.deepEqual(m.report().issue, first);
  f.fail = false;
  await m.refresh();
  assert.equal(f.calls.length, 4);
  f.now += Q;
  await m.refresh();
  assert.equal(m.report().issued.length, 2);
  assert.deepEqual(f.restart().report(first.at).issue, first);
  f.now += 3 * H;
  assert.equal(m.report().status, 'stale');
  f.now += 8 * 24 * H;
  await m.refresh();
  assert.equal(m.report().issued.length, 1);
});
test('settings validation, parallel ticks, deactivation and shutdown discard in-flight forecasts', async () => {
  const f = setup(),
    m = f.model,
    homey = { app: { solarForecast: m, refreshSolarForecast: () => {} } };
  for (const invalid of [
    {},
    { ...config, longitude: 200 },
    { ...config, roofs: [] },
    { ...config, roofs: [{ ...config.roofs[0], kwp: null }] },
    { ...config, roofs: [{ name: '' }] },
  ])
    assert.throws(() => api.configureSolarForecast({ homey, body: invalid }));
  api.configureSolarForecast({ homey, body: config });
  let release;
  f.wait = new Promise((r) => (release = r));
  const p = m.refresh();
  await m.refresh();
  assert.equal(f.calls.length, 2);
  m.configure({ enabled: false });
  release();
  await p;
  assert.deepEqual(api.getSolarForecast({ homey, query: {} }).issued, []);
  assert.deepEqual(m.report().config.roofs, config.roofs);
  m.configure(config);
  const last = m.refresh();
  m.stop();
  await last;
  assert.equal(m.report().issue, null);
});

test('invalid timestamps and absent weather never publish a bogus zero-production day', async () => {
  const f = setup(),
    m = f.model;
  m.configure(config);
  for (const body of [
    {},
    {
      minutely_15_units: { global_tilted_irradiance: 'W/m²' },
      minutely_15: { time: [T / 1000, T / 1000], global_tilted_irradiance: [1, 2] },
    },
    {
      minutely_15_units: { global_tilted_irradiance: 'W/m²' },
      minutely_15: { time: [T / 1000], global_tilted_irradiance: [null] },
    },
  ]) {
    m.request = async () => ({ ok: true, json: async () => body });
    await m.refresh();
    assert.deepEqual(m.report().issued, []);
    assert.equal(m.report().status, 'weather-error');
    f.now += Q;
  }
});

test('background corrections freeze original and adjusted Wh across weather issues, gaps and restarts', async () => {
  const f = setup();
  const day = Date.parse('2026-11-27T11:00Z');
  f.now = day + 60001;
  const m = f.model;
  let irradiance = 1000;
  m.request = async () => {
    const t = Math.floor(f.now / Q) * Q;
    return {
      ok: true,
      json: async () => ({
        minutely_15_units: { global_tilted_irradiance: 'W/m²' },
        minutely_15: {
          time: Array.from({ length: 110 }, (_, i) => (t + i * Q) / 1000),
          global_tilted_irradiance: Array.from({ length: 110 }, (_, i) =>
            i === 10 ? null : irradiance,
          ),
        },
      }),
    };
  };
  m.configure(config);
  await m.refresh();
  const first = m.report().issue;
  assert.deepEqual(first.adjustments, []);
  const row = (t, pvWh, coverage = Q) => ({ t, pvWh, fieldCoverageMs: { pvW: coverage } });
  f.rows.push(...[1, 2, 3].map((i) => row(day + i * Q, 0)));
  // The later weather issue changes; its own predictions cannot be used for the earlier evidence.
  f.now += H;
  irradiance = 500;
  await m.refresh();
  const base = m.report().issue;
  const down = base.adjustments[0];
  assert.equal(down.factor, 0);
  assert.equal(down.samples, 3);
  assert.equal(down.start, day + H + Q);
  assert.equal(down.start + down.wh.length * Q, Date.parse('2026-11-27T23:00Z'));
  assert.deepEqual(down.wh.slice(0, 2), [0, 0]);
  assert.equal(down.wh[8], null);
  assert.equal(base.roofs[0].wh[0], 450);
  assert.deepEqual(m.report(first.at).issue.roofs, first.roofs);
  const resumed = f.restart();
  await resumed.refresh();
  assert.deepEqual(resumed.report().issue.adjustments, [down]);
  f.now += Q;
  f.rows.push(row(day + H, 1350));
  await resumed.refresh();
  const revisions = resumed.report().issue.adjustments;
  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions[0], down);
  assert.equal(revisions[1].factor, 0.25);
  assert.equal(revisions[1].wh[0], 169);
  // A missing/partially observed latest quarter restores the weather baseline.
  f.now += Q;
  f.rows.push(row(day + H + Q, 0, Q - 1));
  await resumed.refresh();
  assert.equal(resumed.report().issue.adjustments.at(-1).wh, null);
  assert.deepEqual(resumed.report().issue.roofs, base.roofs);
  assert.deepEqual(f.restart().report().issue.adjustments[0], down);
  f.rows.at(-1).fieldCoverageMs.pvW = Q;
  const score = f.restart().report(first.at).accuracy;
  assert.equal(score.paired, 1);
  assert.equal(score.original.maeWh, 675);
  assert.equal(score.corrected.maeWh, 0);
});
