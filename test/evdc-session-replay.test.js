'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareEvdcSession } = require('../lib/pricing/evdc-session-replay');
const { readImportLimits } = require('../lib/energy/import-limits');
const { fixture, H, Q } = require('./fixtures/readiness.cjs');

function sample() {
  const f = fixture();
  Object.assign(f.rows[4], { importWh: 1000, gridWh: 1000 });
  for (const row of f.rows.slice(8, 12))
    Object.assign(row, { evWh: 2500, importWh: 2750, gridWh: 2750 });
  f.data.tibberHistoryPriceCache.rows[1].consumption.price = 0.5;
  const input = {
    sessionStart: f.from + 2 * H,
    sessionEnd: f.from + 3 * H,
    minutesEarlier: 60,
    efficiency: 1,
  };
  return { ...f, input, compare: (body = input) => compareEvdcSession(f.homey, body, f.now) };
}

test('move the last DC profile earlier, keeping the same energy and finish time', () => {
  const f = sample();
  const state = JSON.stringify([f.data, f.rows]);
  const { session } = f.compare({});
  assert.deepEqual(session, {
    start: f.input.sessionStart,
    end: f.input.sessionEnd,
    energyKWh: 10,
  });
  const r = f.compare();
  assert.equal(r.status, 'indicative');
  assert.equal(r.controlApplied, false);
  assert.equal(r.shifted.energyKWh, r.session.energyKWh);
  assert.equal(r.shifted.start, r.session.start - H);
  assert.equal(r.shifted.end, r.deadline);
  assert.equal(r.deadline, f.input.sessionEnd);
  assert.equal(r.baseline.importKWh, 12.75);
  assert.equal(r.scenario.importKWh, 12.75);
  assert.equal(r.baseline.peak.kw, 11);
  assert.equal(r.scenario.peak.kw, 6.75);
  assert.equal(r.scenario.tariffPeak.kw, 6.75);
  assert.ok(Math.abs(r.scenario.energyCostSek - r.baseline.energyCostSek + 2.5) < 1e-8);
  assert.equal(JSON.stringify([f.data, f.rows]), state);
});

test('apply saved import limits to total grid load, including the other observed loads', () => {
  const f = sample();
  f.data.householdImportLimits = { importLimitKW: 8 };
  assert.equal(f.compare().baseline.importLimit.quarters, 4);
  const r = f.compare();
  assert.equal(r.scenario.importLimit.quarters, 1);
  assert.equal(r.scenario.importLimit.peak.kw, 9);
  assert.equal(
    r.scenario.peak.kw,
    6.75,
    'quarter limit and hourly peak use different denominators',
  );
  f.data.householdImportLimits = { mainFuseA: 16 };
  const fuse = f.compare();
  assert.ok(Math.abs(fuse.limits.limitKW - Math.sqrt(3) * 6.4) < 1e-8);
  assert.equal(fuse.scenario.importLimit.quarters, 0);
  f.data.householdImportLimits = { mainFuseA: 16, importLimitKW: 10 };
  assert.equal(f.compare().limits.limitKW, 10);
  f.data.householdImportLimits.importLimitKW = -1;
  assert.equal(f.compare().reason, 'invalid-household-import-limits');
  assert.throws(() => readImportLimits({ mainFuseA: '16' }), /invalid/);
});

test('a missing price leaves cost unknown without hiding energy and hourly peaks', () => {
  const f = sample();
  delete f.data.tibberHistoryPriceCache.rows[1].consumption;
  const r = f.compare();
  assert.equal(r.status, 'indicative');
  assert.equal(r.scenario.importKWh, 12.75);
  assert.equal(r.scenario.energyCostSek, null);
  assert.ok(r.priceGaps.includes('purchasePriceQuarters'));
});

test('a gap, unknown destination EVDC coverage or an unconfirmed session blocks the model', () => {
  const f = sample();
  f.rows[4].coverageMs -= 1;
  assert.deepEqual(f.compare().missing, [f.rows[4].t]);
  f.rows[4].coverageMs = Q;
  delete f.rows[4].fieldCoverageMs.evW;
  assert.deepEqual(f.compare().overlaps, [f.rows[4].t]);
  delete f.rows[12].fieldCoverageMs.evW;
  assert.equal(f.compare({}).reason, 'evdc-session-end-unconfirmed');
  f.rows[12].fieldCoverageMs.evW = Q;
  f.rows[9].min = { evW: -1 };
  assert.equal(f.compare({}).reason, 'incomplete-evdc-session');
  delete f.rows[9].min;
  assert.equal(f.compare({ ...f.input, sessionEnd: f.to }).reason, 'evdc-session-changed');
  assert.equal(f.compare({ ...f.input, minutesEarlier: -15 }).reason, 'invalid-evdc-request');
});

test('mixed flows preserve the signed energy balance when a moved load takes up export', () => {
  const f = sample();
  Object.assign(f.rows[5], { importWh: 250, exportWh: 500, gridWh: -250 });
  const r = f.compare();
  assert.equal(r.status, 'indicative');
  assert.equal(r.baseline.exportKWh, 0.5);
  assert.equal(r.scenario.exportKWh, 0);
  assert.equal(r.scenario.importKWh, r.baseline.importKWh - 0.5);
  assert.equal(r.mixedDirectionQuarters, 1);
});
