'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { qualityReport, validSnapshot } = require('../lib/data-quality');
const { DataDiagnostics } = require('../lib/data-diagnostics');
const { validQuality, duration, percent } = require('../settings/data-diagnostics');
const { fixture, H, Q, END } = require('./fixtures/readiness.cjs');
const recovery = (t, ms, correctionWh) => ({
  from: t,
  to: t + ms,
  coverageMs: ms,
  correctionWh,
  maxCollectionSkewMs: 2000,
});
function inspect(f, hours = f.hours) {
  return new DataDiagnostics(f.homey.settings, () => f.now).report(f.homey, { hours });
}
function partition(q) {
  for (const c of Object.values(q.channels)) {
    assert.equal(c.observedMs + c.counterEstimatedMs + c.unknownMs, q.totalMs);
    assert.ok(c.observedMs >= 0 && c.counterEstimatedMs >= 0 && c.unknownMs >= 0);
  }
}
test('partial integration counts time independently per channel, including zero solar/battery energy', () => {
  const f = fixture({ hours: 1 });
  Object.assign(f.rows[0], { coverageMs: Q - 1000, directionalCoverageMs: Q - 1000 });
  f.rows[1].essCoverageMs = Q - 60000;
  f.rows[2].fieldCoverageMs.pvW = Q - 1;
  const before = JSON.stringify(f.data),
    rows = structuredClone(f.rows);
  const r = inspect(f),
    q = r.quality;
  assert.deepEqual(q.channels.grid, {
    available: true,
    observedMs: H - 1000,
    counterEstimatedMs: 0,
    unknownMs: 1000,
  });
  assert.equal(q.channels.battery.observedMs, H - 60000);
  assert.equal(q.channels.solar.unknownMs, 1);
  assert.equal(r.gaps.grid.missing, 1);
  assert.equal(q.hourlyGrid.unknownHours, 1);
  partition(q);
  assert.equal(JSON.stringify(f.data), before);
  assert.deepEqual(f.rows, rows);
  assert.ok(validQuality(q, r.from, r.to));
});
test('validated counter duration adds to sampled time once, separately for grid, battery and solar', () => {
  const f = fixture({ hours: 1 }),
    row = f.rows[0];
  Object.assign(row, {
    coverageMs: Q - 60000,
    directionalCoverageMs: Q - 60000,
    essCoverageMs: Q - 120000,
  });
  row.fieldCoverageMs.pvW = Q - 180000;
  row.counterRecovery = {
    grid: recovery(row.t, 60000, { importWh: 5, exportWh: 0, gridWh: 5 }),
    battery: recovery(row.t, 120000, { essWh: -10 }),
    solar: recovery(row.t, 180000, { pvWh: 20 }),
  };
  const r = inspect(f),
    q = r.quality;
  for (const [key, ms] of [
    ['grid', 60000],
    ['battery', 120000],
    ['solar', 180000],
  ]) {
    assert.equal(q.channels[key].counterEstimatedMs, ms);
    assert.equal(q.channels[key].observedMs, H - ms);
    assert.equal(q.channels[key].unknownMs, 0);
  }
  assert.equal(q.hourlyGrid.withCounterEstimateHours, 1);
  assert.equal(q.hourlyGrid.sampledHours, 0);
  assert.equal(r.gaps.grid.missing, 1, 'raw gaps remain visible');
  partition(q);
});
test('whole-hour sources are exclusive and Tibber never fills quarter durations', () => {
  const f = fixture({ hours: 4 });
  // Hour 0 sampled; hour 1 contains a complete counter-assisted quarter.
  Object.assign(f.rows[4], { coverageMs: Q - 60000, directionalCoverageMs: Q - 60000 });
  f.rows[4].counterRecovery = {
    grid: recovery(f.rows[4].t, 60000, { importWh: 0, exportWh: 0, gridWh: 0 }),
  };
  // Hours 2 and 3 each lack a grid quarter; only hour 2 has both Tibber directions.
  f.rows.splice(12, 1);
  f.rows.splice(8, 1);
  f.data.tibberHistoryPriceCache.networkEnergy = [
    { t: f.from + 2 * H, importWh: 1000, exportWh: 0 },
    { t: f.from + 3 * H, importWh: 500 },
  ];
  const r = inspect(f),
    q = r.quality;
  assert.deepEqual(q.hourlyGrid, {
    available: true,
    from: f.from,
    to: f.to,
    totalHours: 4,
    sampledHours: 1,
    withCounterEstimateHours: 1,
    tibberHours: 1,
    unknownHours: 1,
  });
  assert.equal(q.channels.grid.unknownMs, 2 * Q);
  assert.equal(q.channels.battery.unknownMs, 2 * Q);
  assert.equal(q.channels.solar.unknownMs, 2 * Q);
  partition(q);
  f.homey.app.tibberHistoryPrices.status = () => ({ confirmed: false });
  assert.equal(inspect(f).quality.hourlyGrid.tibberHours, 0);
});
test('legacy, absent, inconsistent and invalid per-channel evidence stays unknown', () => {
  const cases = [
    (r) => {
      r.schema = 1;
    },
    (r) => {
      delete r.directionalCoverageMs;
      delete r.essCoverageMs;
      delete r.fieldCoverageMs;
    },
    (r) => {
      r.directionalCoverageMs = Q + 1;
      r.essCoverageMs = -1;
      r.fieldCoverageMs.pvW = 0.5;
    },
    (r) => {
      r.importWh = -1;
      r.essWh = NaN;
      r.pvWh = -1;
    },
    (r) => {
      r.gridWh = 999;
      r.essWh = Infinity;
      delete r.pvWh;
    },
  ];
  for (const change of cases) {
    const f = fixture({ hours: 1 });
    change(f.rows[0]);
    const q = inspect(f).quality;
    for (const c of Object.values(q.channels)) assert.equal(c.unknownMs, Q);
    partition(q);
  }
  const f = fixture({ hours: 1 });
  f.rows[0].directionalCoverageMs = Q / 2;
  f.rows[0].gridWh = 1000; // Additional net-only time is not directional evidence.
  assert.equal(inspect(f).quality.channels.grid.unknownMs, Q / 2);
});
test('invalid or overlapping recovery never credits estimates or overwrites observed time', () => {
  for (const change of [
    (r) => {
      r.counterRecovery.grid.coverageMs = Q;
    },
    (r) => {
      r.counterRecovery.grid.correctionWh.gridWh = 9;
    },
    (r) => {
      r.counterRecovery.grid.to = r.t + Q;
    },
    (r) => {
      r.counterRecovery.grid.correctionWh.importWh = -1000;
      r.counterRecovery.grid.correctionWh.gridWh = -1000;
    },
    (r) => {
      r.coverageMs = -1;
    },
  ]) {
    const f = fixture({ hours: 1 }),
      row = f.rows[0];
    Object.assign(row, { coverageMs: Q - 60000, directionalCoverageMs: Q - 60000 });
    row.counterRecovery = { grid: recovery(row.t, 60000, { importWh: 0, exportWh: 0, gridWh: 0 }) };
    change(row);
    const q = inspect(f).quality;
    assert.equal(q.channels.grid.counterEstimatedMs, 0);
    assert.ok(q.channels.grid.unknownMs >= 60000);
    partition(q);
  }
});
test('anchor-only rows can have zero observed duration and valid estimated duration', () => {
  const f = fixture({ hours: 1 }),
    r = f.rows[0];
  Object.assign(r, {
    coverageMs: 0,
    directionalCoverageMs: 0,
    essCoverageMs: 0,
    fieldCoverageMs: { pvW: 0 },
  });
  delete r.importWh;
  delete r.exportWh;
  delete r.gridWh;
  delete r.essWh;
  delete r.pvWh;
  r.counterRecovery = {
    grid: recovery(r.t, 60000, { importWh: 5, exportWh: 0, gridWh: 5 }),
    battery: recovery(r.t, 60000, { essWh: 0 }),
    solar: recovery(r.t, 60000, { pvWh: 0 }),
  };
  const q = inspect(f).quality;
  for (const c of Object.values(q.channels)) {
    assert.equal(c.observedMs, H - Q);
    assert.equal(c.counterEstimatedMs, 60000);
    assert.equal(c.unknownMs, Q - 60000);
  }
  partition(q);
});
test('empty readable history is unknown, ambiguous/unreadable snapshots are unavailable', () => {
  const f = fixture({ hours: 1 });
  f.rows.length = 0;
  assert.equal(inspect(f).quality.channels.grid.unknownMs, H);
  for (const rows of [
    null,
    {},
    [null],
    [{ t: -Q }],
    [{ t: END + Q }],
    [{ t: END - 1 }],
    [{ t: END }, { t: END }],
    Array(3073).fill({ t: END }),
  ]) {
    assert.equal(validSnapshot(rows, END), false);
    f.homey.app.history.getSlots = () => rows;
    const r = inspect(f);
    assert.equal(r.storage.readable, false);
    assert.equal(r.quality.channels.grid.observedMs, null);
    assert.equal(r.quality.hourlyGrid.unknownHours, null);
    assert.ok(validQuality(r.quality, r.from, r.to));
  }
});
test('rolling windows include missing history, exclude open/outside quarters, and cross DST in elapsed time', () => {
  for (const now of [Date.parse('2026-03-29T05:37Z'), Date.parse('2026-10-25T05:37Z')]) {
    const f = fixture({ hours: 24, now });
    f.rows.push({ ...f.rows[0], t: Math.floor(now / Q) * Q });
    const r = inspect(f, 168),
      q = r.quality;
    assert.equal(q.totalMs, 168 * H);
    assert.equal(q.channels.grid.observedMs, 24 * H);
    assert.equal(q.channels.grid.unknownMs, 144 * H);
    assert.equal(q.hourlyGrid.totalHours, 168);
    assert.equal(q.hourlyGrid.sampledHours, 24);
    assert.equal(q.hourlyGrid.from, Math.floor(r.from / H) * H);
    partition(q);
  }
});
test('source buckets reject duplicate/invalid/outside hours and do not trust scalar source counts', () => {
  const f = fixture({ hours: 4 });
  const hourly = {
    status: 'partial',
    tibberFilledHours: 999,
    hours: [
      { t: f.from, source: 'sigenergy-sampled', importWh: 0, exportWh: 0 },
      { t: f.from, source: 'tibber-meter-hourly', importWh: 0, exportWh: 0 },
      { t: f.from + H, source: 'constructor', importWh: 0, exportWh: 0 },
      { t: f.from + 2 * H, source: 'sigenergy-sampled', importWh: -1, exportWh: 0 },
      { t: f.from + 3 * H, source: 'sigenergy-sampled', importWh: 0, exportWh: 0 },
      { t: f.from - H, source: 'tibber-meter-hourly', importWh: 1, exportWh: 0 },
      { t: f.from + 1, source: 'tibber-meter-hourly', importWh: 1, exportWh: 0 },
      null,
    ],
  };
  const q = qualityReport(f.rows, f.from, f.to, hourly);
  assert.equal(q.hourlyGrid.sampledHours, 1);
  assert.equal(q.hourlyGrid.tibberHours, 0);
  assert.equal(q.hourlyGrid.unknownHours, 3);
  const unavailable = qualityReport(f.rows, f.from, f.to, { status: 'unavailable' });
  assert.ok(validQuality(unavailable, f.from, f.to));
});
test('display does not round small unknown durations away or accept contradictory quality reports', () => {
  const r = inspect(fixture()),
    q = r.quality;
  assert.equal(duration(1), '<1 s');
  assert.equal(duration(0), '0 s');
  assert.equal(duration(H + 61000), '1 h 1 min 1 s');
  assert.equal(percent(H - 1, H), '99,99 %');
  assert.equal(percent(H, H), '100 %');
  for (const change of [
    (x) => {
      x.totalMs++;
    },
    (x) => {
      x.channels.grid.observedMs++;
    },
    (x) => {
      x.channels.battery.available = false;
    },
    (x) => {
      x.channels.solar.unknownMs = -1;
    },
    (x) => {
      x.hourlyGrid.tibberHours++;
    },
    (x) => {
      x.hourlyGrid.from++;
    },
    (x) => {
      x.channels = {};
    },
  ]) {
    const bad = structuredClone(q);
    change(bad);
    assert.equal(validQuality(bad, r.from, r.to), false);
  }
  assert.equal(validQuality(null, r.from, r.to), false);
});
