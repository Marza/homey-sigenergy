'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { checkReadiness } = require('../lib/pricing/comparison-readiness');
const { prepareComparison, compareReplay } = require('../lib/pricing/replay-comparison');
const { compareSolarEv } = require('../lib/pricing/solar-ev-comparison');
const { validReport } = require('../settings/economic-readiness');
const { fixture, input, H, Q } = require('./fixtures/readiness.cjs');
const report = (f, mode = 'battery') => checkReadiness(f.homey, { hours: f.hours, mode }, f.now);
function immutable(f, fn) {
  const before = JSON.stringify({ data: f.data, rows: f.rows });
  const write = f.homey.settings.set;
  f.homey.settings.set = () => {
    throw Error('Inspection must not write settings');
  };
  let r;
  try {
    r = fn();
  } finally {
    f.homey.settings.set = write;
  }
  assert.equal(JSON.stringify({ data: f.data, rows: f.rows }), before);
  return r;
}
test('complete local data is not a validated model or financial ranking; report is allowlisted and read-only', () => {
  const f = fixture(),
    r = immutable(f, () => report(f));
  assert.equal(r.dataComplete, true);
  assert.equal(validReport(r, 4, 'battery'), true);
  assert.equal(r.modelValidated, false);
  assert.equal(r.demandEvaluated, false);
  assert.equal(r.financiallyComparable, false);
  assert.equal(r.controlApplied, false);
  assert.equal(r.from, f.from);
  assert.equal(r.to, f.to);
  assert.ok(Object.values(r.checks).every((c) => c.missingQuarters === 0));
  assert.doesNotMatch(
    JSON.stringify(r),
    /SECRET_FIXTURE|PRIVATE_FIXTURE|importWh|consumption|sourceRows|\.revision/,
  );
  assert.ok(prepareComparison(f.homey, 4, f.now).load);
  assert.equal(compareReplay(f.homey, input(), f.now).status, 'indicative');
});
test('reports simultaneous quarter gaps and price/term failures over the same window without early exit', () => {
  const f = fixture();
  f.rows.splice(1, 1);
  f.rows[3].essCoverageMs = 0;
  f.data.tibberHistoryPriceCache.rows[1].consumption = null;
  f.data.tibberHistoryPriceCache.rows[2].production = null;
  f.data.costContractTimeline = undefined;
  const r = immutable(f, () => report(f));
  assert.equal(r.dataComplete, false);
  assert.equal(r.checks.energyQuarters.missingQuarters, 1);
  assert.equal(r.checks.batteryCoverageQuarters.missingQuarters, 2);
  assert.equal(r.checks.contractQuarters.missingQuarters, 16);
  assert.equal(r.checks.purchasePriceQuarters.missingQuarters, 4);
  assert.equal(r.checks.productionPriceQuarters.missingQuarters, 4);
  assert.deepEqual(r.checks.purchasePriceQuarters.ranges, [
    { from: f.from + H, to: f.from + 2 * H },
  ]);
  assert.equal(r.checks.purchasePriceQuarters.affectedHours, 1);
  assert.equal(r.gates.find((g) => g.key === 'datedTerms').reason, 'dated-contract-required');
  assert.equal(validReport(r, 4, 'battery'), true);
});
test('partial quarters coalesce only adjacent gaps; zero energy, ESS and negative/zero prices remain valid', () => {
  const f = fixture();
  for (const i of [0, 1, 3, 4]) f.rows[i].directionalCoverageMs = Q - 1;
  const r = report(f).checks.energyQuarters;
  assert.deepEqual(r.ranges, [
    { from: f.from, to: f.from + 2 * Q },
    { from: f.from + 3 * Q, to: f.from + 5 * Q },
  ]);
  assert.equal(r.affectedHours, 2);
  for (const s of f.rows)
    Object.assign(s, { gridWh: 0, importWh: 0, exportWh: 0, essWh: 0, directionalCoverageMs: Q });
  for (const p of f.data.tibberHistoryPriceCache.rows) {
    p.consumption.price = -0.5;
    p.production.price = 0;
  }
  assert.equal(report(f).dataComplete, true);
  assert.equal(report(f, 'solar-ev').dataComplete, true);
});
test('unreadable/invalid sources are unknown, never silently reported as zero missing data', () => {
  for (const edit of [
    (f) => {
      f.homey.app.history.getSlots = () => {
        throw Error('SECRET_FIXTURE_ERROR');
      };
    },
    (f) => f.rows.push({ ...f.rows[0] }),
    (f) => {
      f.homey.app.history.getSlots = () => ({});
    },
    (f) => {
      f.rows[0].t = null;
    },
  ]) {
    const f = fixture();
    edit(f);
    const r = report(f);
    assert.equal(r.checks.energyQuarters.state, 'unavailable');
    assert.equal(r.checks.energyQuarters.missingQuarters, null);
    assert.equal(r.dataComplete, false);
    assert.equal(validReport(r, 4, 'battery'), true);
    assert.doesNotMatch(JSON.stringify(r), /SECRET_FIXTURE_ERROR/);
  }
  const f = fixture();
  f.data.costContractTimeline.entries[0].contract.source = 'tampered';
  const r = report(f);
  assert.equal(r.checks.contractQuarters.state, 'unavailable');
  assert.equal(r.gates.find((g) => g.key === 'datedTerms').reason, 'invalid-contract-timeline');
  assert.equal(compareReplay(f.homey, input(), f.now).reason, 'invalid-comparison-data');
});
test('source binding, confirmation, malformed caches and read errors are independently reported', () => {
  for (const edit of [
    (f) => (f.data.tibberHomeId = 'other'),
    (f) => {
      f.data.tibberHistoryPriceOptions.confirmed = false;
    },
    (f) => (f.data.tibberToken = ''),
    (f) => {
      f.source.session = () => {
        throw Error('private');
      };
    },
  ]) {
    const f = fixture();
    edit(f);
    const r = report(f);
    assert.equal(r.dataComplete, false);
    assert.equal(r.gates[0].state, 'unavailable');
    assert.equal(compareReplay(f.homey, input(), f.now).status, 'unavailable');
  }
  for (const edit of [
    (f) => f.data.tibberHistoryPriceCache.rows.push({ ...f.data.tibberHistoryPriceCache.rows[0] }),
    (f) => (f.data.tibberHistoryPriceCache.fetchedAt = f.now + 1),
    (f) => (f.data.tibberHistoryPriceCache.rows[0].consumption.price = Infinity),
  ]) {
    const f = fixture();
    edit(f);
    const r = report(f);
    assert.equal(r.checks.purchasePriceQuarters.state, 'unavailable');
    assert.equal(r.dataComplete, false);
  }
  const f = fixture(),
    get = f.homey.settings.get;
  f.homey.settings.get = (k) => {
    if (k === 'tibberHistoryPriceCache') throw Error('private');
    return get(k);
  };
  assert.equal(report(f).checks.productionPriceQuarters.state, 'unavailable');
});
test('absent cache/empty history/undated drafts are missing, not invented; legacy rows do not gain coverage', () => {
  const f = fixture();
  delete f.data.tibberHistoryPriceCache;
  delete f.data.costContractTimeline;
  f.rows.length = 0;
  const r = report(f);
  for (const c of Object.values(r.checks)) assert.equal(c.missingQuarters, 16);
  const g = fixture();
  for (const s of g.rows) {
    delete s.directionalCoverageMs;
    delete s.essCoverageMs;
    delete s.fieldCoverageMs;
  }
  const q = report(g, 'solar-ev');
  assert.equal(q.checks.energyQuarters.missingQuarters, 16);
  assert.equal(q.checks.batteryCoverageQuarters.missingQuarters, 16);
  assert.equal(q.checks.solarCoverageQuarters.missingQuarters, 16);
  assert.equal(q.checks.inconsistentSolarQuarters.state, 'unavailable');
});
test('solar checks share replay predicates for independent PV coverage, EV readings and inconsistent balances', () => {
  const f = fixture();
  f.rows[0].fieldCoverageMs.pvW = 0;
  f.rows[1].pvWh = -1;
  f.rows[2].evWh = 1;
  f.rows[3].max = { evW: NaN };
  f.rows[4].gridWh = -500;
  f.rows[4].importWh = 0;
  f.rows[4].exportWh = 500;
  f.rows[4].pvWh = 0;
  const r = report(f, 'solar-ev');
  assert.equal(r.checks.solarCoverageQuarters.missingQuarters, 1);
  assert.equal(r.checks.solarEnergyQuarters.missingQuarters, 1);
  assert.equal(r.checks.knownEvChargingQuarters.missingQuarters, 2);
  assert.equal(r.checks.inconsistentSolarQuarters.state, 'unavailable');
  f.rows[1].pvWh = 0;
  const q = report(f, 'solar-ev');
  assert.equal(q.checks.inconsistentSolarQuarters.missingQuarters, 1);
  const request = {
    ...input(),
    battery: { ...input().battery, solarTargetKWh: 7 },
    ev: {
      confirmHistoricalTask: true,
      confirmNoExistingEvCharging: true,
      targetSoc: 50,
      initialSoc: 40,
      minPowerKW: 1,
      maxPowerKW: 3,
      availableFromHours: 0,
      deadlineHours: 4,
    },
  };
  const run = compareSolarEv(f.homey, request, f.now);
  assert.equal(run.reason, 'incomplete-solar-ev-window');
  for (const [key, value] of Object.entries(run.missing))
    assert.equal(q.checks[key].missingQuarters, value);
  assert.equal(report(f).dataComplete, true, 'battery mode ignores solar-only blockers');
});
test('solar source and saved charging prerequisites are checked without attesting EV history', () => {
  for (const plants of [[], [{}, {}], null]) {
    const f = fixture();
    f.homey.drivers.getDriver = () => ({ getDevices: () => plants });
    assert.equal(report(f, 'solar-ev').dataComplete, false);
  }
  const f = fixture();
  f.homey.drivers.getDriver = () => {
    throw Error('private');
  };
  f.data.chargingConfig = null;
  const r = report(f, 'solar-ev');
  assert.equal(r.gates.at(-1).reason, 'charging-settings-required');
  assert.equal(r.gates.at(-2).reason, 'ambiguous-solar-plant');
});
test('reports bounded ranges with exact counts across the full 32-day window', () => {
  const f = fixture({ hours: 768 });
  for (let i = 0; i < f.rows.length; i += 2) f.rows[i].coverageMs = 0;
  const r = report(f),
    c = r.checks.energyQuarters;
  assert.equal(c.missingQuarters, 1536);
  assert.equal(c.rangeCount, 1536);
  assert.equal(c.ranges.length, 24);
  assert.equal(c.rangesTruncated, true);
  assert.equal(c.affectedHours, 768);
  assert.equal(validReport(r, 768, 'battery'), true);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) < 20000);
  f.homey.app.history.getSlots = () => Array(3073).fill(f.rows[0]);
  assert.equal(report(f).checks.energyQuarters.state, 'unavailable');
});
test('contract gaps respect local date boundaries and both repeated autumn hours stay distinct', () => {
  const f = fixture({ hours: 4, now: Date.parse('2026-01-01T02:00Z') });
  const r = report(f);
  assert.equal(r.checks.contractQuarters.missingQuarters, 4);
  assert.deepEqual(r.checks.contractQuarters.ranges, [
    { from: f.from, to: Date.parse('2025-12-31T23:00Z') },
  ]);
  for (const now of [Date.parse('2026-10-25T04:31Z'), Date.parse('2026-03-29T04:31Z')]) {
    const g = fixture({ hours: 6, now });
    g.rows.splice(4, 8);
    const q = report(g);
    assert.equal(q.to, Math.floor(now / H) * H);
    assert.equal(q.to - q.from, 6 * H);
    assert.equal(q.checks.energyQuarters.missingQuarters, 8);
    assert.equal(q.checks.energyQuarters.affectedHours, 2);
  }
});
test('invalid requests never read private settings, and the API route remains authenticated', async () => {
  const f = fixture();
  const bad = {
    settings: {
      get() {
        throw Error('must not read');
      },
    },
  };
  for (const v of [
    null,
    [],
    {},
    { hours: 0, mode: 'battery' },
    { hours: 1.5, mode: 'battery' },
    { hours: 769, mode: 'battery' },
    { hours: 169, mode: 'solar-ev' },
    { hours: '4', mode: 'battery' },
    { hours: 4, mode: 'unknown' },
    { hours: 4, mode: 'battery', confirm: true },
  ])
    assert.equal(checkReadiness(bad, v, f.now).reason, 'invalid-readiness-input');
  assert.equal(
    checkReadiness(bad, { hours: 4, mode: 'battery' }, NaN).reason,
    'invalid-readiness-input',
  );
  assert.equal(
    checkReadiness(bad, { hours: 4, mode: 'battery' }, 0).reason,
    'invalid-readiness-input',
  );
  const manifest = require('../app.json');
  assert.deepEqual(manifest.api.inspectEconomicReadiness, {
    method: 'POST',
    path: '/economics/readiness',
    public: false,
  });
  const r = await require('../api').inspectEconomicReadiness({
    homey: f.homey,
    body: { hours: 4, mode: 'battery' },
  });
  assert.equal(r.controlApplied, false);
});

test('unexpected snapshot processing failures return a safe unavailable report', () => {
  const f = fixture();
  f.rows.map = () => {
    throw Error('SECRET_FIXTURE_PROCESSING_ERROR');
  };
  const r = report(f);
  assert.equal(r.status, 'unavailable');
  assert.equal(r.reason, 'readiness-unavailable');
  assert.equal(r.dataComplete, false);
  assert.equal(r.controlApplied, false);
  assert.doesNotMatch(JSON.stringify(r), /SECRET_FIXTURE_PROCESSING_ERROR/);
});

test('missing EV measurements cannot pass the readiness check or solar replay as measured zero', () => {
  const f = fixture();
  assert.equal(report(f, 'solar-ev').checks.evCoverageQuarters.state, 'complete');
  delete f.rows[0].fieldCoverageMs.evW;
  delete f.rows[0].evWh;
  f.rows[1].fieldCoverageMs.evW /= 2;
  const r = report(f, 'solar-ev');
  assert.equal(r.dataComplete, false);
  assert.equal(r.checks.evCoverageQuarters.missingQuarters, 2);
  assert.equal(r.checks.knownEvChargingQuarters.missingQuarters, 0);
  assert.equal(report(f).dataComplete, true);
  const result = compareSolarEv(
    f.homey,
    {
      ...input(),
      ev: { confirmHistoricalTask: true, confirmNoExistingEvCharging: true },
    },
    f.now,
  );
  assert.equal(result.reason, 'incomplete-solar-ev-window');
  assert.equal(result.missing.evCoverageQuarters, 2);
});
