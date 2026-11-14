'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  timelineStatus,
  publishContract,
  restoreTimeline,
  readTimeline,
  validateTimeline,
  contractAt,
  hash,
} = require('../lib/pricing/contract-timeline');
const { replayBattery } = require('../lib/optimization/balanced-replay');
const { compareReplay } = require('../lib/pricing/replay-comparison');
const { TibberHistoryPrices } = require('../lib/pricing/tibber-history-prices');
const { HistoryStore } = require('../lib/history');
const { parseExport } = require('../lib/history-format');
const Q = 900000,
  H = 3600000;
const END = Date.parse('2026-06-11T12:00:00Z'),
  START = END - 4 * H;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const cost = () => ({
  schema: 2,
  currency: 'SEK',
  source: 'Synthetic dated terms',
  checkedOn: '2026-06-01',
  importPriceBasis: 'spot-ex-vat',
  importIncludesEnergyTax: false,
  energyTaxExVatSekPerKWh: 0.3,
  gridImportExVatSekPerKWh: 0.1,
  otherImportExVatSekPerKWh: 0.9,
  gridExportBenefitSekPerKWh: 0.05,
  gridExportFeeSekPerKWh: 0.01,
  vatRate: 0.25,
  batteryWearSekPerKWh: 0.2,
});
const tariff = () => ({
  start: '00:00',
  end: '23:00',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  peakCount: 1,
  distinctDays: false,
  rateSekPerKw: 40,
});
const battery = () => ({
  capacityKWh: 10,
  initialKWh: 5,
  reserveKWh: 1,
  maxChargeKW: 4,
  maxDischargeKW: 4,
  chargeEfficiency: 0.9,
  dischargeEfficiency: 0.9,
});
function fixture() {
  const data = {
    costContract: cost(),
    demandTariff: tariff(),
    tibberToken: 'synthetic-token',
    tibberHomeId: 'synthetic-home',
    sourceConfig: { tibber: { revision: 'r' } },
  };
  const rows = Array.from({ length: 16 }, (_, i) => {
    const grid = i < 4 ? 1000 : 250;
    return {
      schema: 2,
      t: START + i * Q,
      gridWh: grid,
      importWh: grid,
      exportWh: 0,
      coverageMs: Q,
      directionalCoverageMs: Q,
      essWh: 0,
      essCoverageMs: Q,
    };
  });
  const homey = {
    settings: {
      get: (k) => data[k],
      set: (k, v) => {
        data[k] = structuredClone(v);
      },
    },
    app: { history: { getSlots: () => rows } },
  };
  const source = new TibberHistoryPrices(homey, { now: () => END });
  homey.app.tibberHistoryPrices = source;
  source.confirm({ confirmSamePlant: true });
  data.tibberHistoryPriceCache = {
    schema: 1,
    revision: source.session().revision,
    fetchedAt: END,
    rows: Array.from({ length: 4 }, (_, i) => ({
      t: START + i * H,
      consumption: { price: 1 },
      production: { price: -0.1 },
    })),
  };
  return { data, homey, rows, source };
}
function publish(f, from = '2026-06-01', includeNetwork = true) {
  const state = timelineStatus(f.homey);
  return publishContract(
    f.homey,
    {
      from,
      includeNetwork,
      confirmEffectiveDate: true,
      confirmTradeComponents: true,
      expectedRevision: state.revision,
      draftHash: state.draftHash,
    },
    END,
  );
}
function input() {
  return { hours: 4, capsKW: [2, 3, 4], battery: battery(), confirmModelAssumptions: true };
}
test('dated snapshots freeze tax, network, wear and tariff; checkedOn never supplies a start', () => {
  const f = fixture();
  assert.equal(readTimeline(f.homey).entries.length, 0);
  const a = publish(f);
  const old = structuredClone(a.timeline.entries[0]);
  f.data.costContract.energyTaxExVatSekPerKWh = 9;
  f.data.demandTariff.rateSekPerKw = 999;
  assert.deepEqual(readTimeline(f.homey).entries[0], old);
  assert.equal(contractAt(a.timeline, Date.parse('2026-05-31T21:00Z')), null);
  assert.equal(contractAt(a.timeline, Date.parse('2026-05-31T22:00Z')).id, old.id);
  const b = publish(f, '2026-06-12');
  assert.equal(contractAt(b.timeline, END).id, old.id);
  assert.equal(
    contractAt(b.timeline, Date.parse('2026-06-11T22:00Z')).contract.energyTaxExVatSekPerKWh,
    9,
  );
});
test('publication rejects stale drafts/revisions, backdating, missing confirmation and invalid terms', () => {
  const f = fixture(),
    s = timelineStatus(f.homey);
  const p = {
    from: '2026-06-01',
    includeNetwork: true,
    confirmEffectiveDate: true,
    confirmTradeComponents: true,
    expectedRevision: s.revision,
    draftHash: s.draftHash,
  };
  for (const change of [
    { expectedRevision: 'old' },
    { draftHash: 'old' },
    { confirmEffectiveDate: false },
    { confirmTradeComponents: false },
    { from: '2026-02-30' },
    { includeNetwork: 'yes' },
  ])
    assert.throws(() => publishContract(f.homey, { ...p, ...change }, END));
  publishContract(f.homey, p, END);
  assert.throws(() => publish(f, '2026-06-01'), /increase/);
  assert.throws(() => publish(f, '2026-05-01'), /increase/);
  f.data.costContract.importPriceBasis = 'total-incl-vat';
  assert.throws(() => publish(f, '2026-07-01'), /incompatible/);
});
test('timeline restore is bounded, idempotent and cannot rewrite published intervals', () => {
  const f = fixture(),
    first = publish(f).timeline;
  const fresh = fixture(),
    state = timelineStatus(fresh.homey);
  restoreTimeline(fresh.homey, {
    timeline: first,
    expectedRevision: state.revision,
    confirmSamePlant: true,
  });
  assert.deepEqual(readTimeline(fresh.homey), first);
  restoreTimeline(fresh.homey, {
    timeline: first,
    expectedRevision: timelineStatus(fresh.homey).revision,
    confirmSamePlant: true,
  });
  assert.throws(
    () =>
      restoreTimeline(fresh.homey, {
        timeline: first,
        expectedRevision: 'wrong',
        confirmSamePlant: true,
      }),
    /confirm/,
  );
  const other = fixture();
  other.data.costContract.gridImportExVatSekPerKWh = 0.5;
  const conflicting = publish(other).timeline;
  assert.throws(
    () =>
      restoreTimeline(fresh.homey, {
        timeline: conflicting,
        expectedRevision: timelineStatus(fresh.homey).revision,
        confirmSamePlant: true,
      }),
    /conflict/,
  );
  const old = fixture();
  const past = publish(old, '2026-05-01').timeline;
  assert.throws(
    () =>
      restoreTimeline(fresh.homey, {
        timeline: past,
        expectedRevision: timelineStatus(fresh.homey).revision,
        confirmSamePlant: true,
      }),
    /rewrite/,
  );
  for (const bad of [
    null,
    { schema: 2, entries: [] },
    { schema: 1, entries: Array(101).fill({}) },
    { ...first, token: 'secret' },
    { ...first, entries: [{ ...first.entries[0], id: 'modified' }] },
  ])
    assert.throws(() => validateTimeline(bad));
  assert.equal(hash(first), hash(readTimeline(f.homey)));
});
test('unverified persistence never reports contract success', () => {
  const f = fixture();
  f.homey.settings.set = () => {};
  assert.throws(() => publish(f), /unverified/);
});
test('balanced replay preserves conservation, signs, constraints and terminal energy', () => {
  const load = Array.from({ length: 16 }, (_, i) => ({
    t: START + i * Q,
    netLoadKWh: i < 4 ? 1 : 0.25,
  }));
  const r = replayBattery(load, battery(), 2);
  assert.equal(r.terminalMatched, true);
  close(r.initialKWh, r.finalKWh);
  close(r.balanceResidualKWh, 0);
  assert.ok(r.lossesKWh > 0);
  assert.ok(r.chargedKWh > r.dischargedKWh);
  close(r.chargedKWh - r.dischargedKWh, r.lossesKWh);
  for (const s of r.scenario) {
    assert.ok(s.storedKWh >= 1 - 1e-8 && s.storedKWh <= 5 + 1e-8);
    assert.ok(!(s.chargeKWh > 0 && s.dischargeKWh > 0));
    assert.ok(s.chargeKWh <= 1 && s.dischargeKWh <= 1);
    close(s.importWh - s.exportWh, s.gridWh);
  }
});
test('solar recharge reduces export and is not free; terminal depletion remains explicit', () => {
  const r = replayBattery(
    [
      { t: START, netLoadKWh: 1 },
      { t: START + Q, netLoadKWh: -1 },
    ],
    { ...battery(), chargeEfficiency: 1, dischargeEfficiency: 1 },
    2,
  );
  assert.equal(r.terminalMatched, true);
  close(r.scenario[1].exportWh, 500);
  close(r.scenario[1].chargeKWh, 0.5);
  const empty = replayBattery([{ t: START, netLoadKWh: 1 }], battery(), 2);
  assert.equal(empty.terminalMatched, false);
  assert.ok(empty.terminalShortfallKWh > 0);
  const floor = replayBattery([{ t: START, netLoadKWh: 1 }], { ...battery(), initialKWh: 1 }, 2);
  assert.equal(floor.dischargedKWh, 0);
  assert.ok(floor.uncoveredKWh > 0);
});
test('battery model rejects invalid capabilities, gaps, duplicate intervals and oversized windows', () => {
  const load = [{ t: START, netLoadKWh: 1 }];
  for (const change of [
    { capacityKWh: 0 },
    { initialKWh: 11 },
    { reserveKWh: 6 },
    { maxChargeKW: 0 },
    { maxDischargeKW: -1 },
    { chargeEfficiency: 0 },
    { dischargeEfficiency: 2 },
    { initialKWh: NaN },
  ])
    assert.throws(() => replayBattery(load, { ...battery(), ...change }, 2));
  for (const bad of [
    [],
    Array(3073).fill(load[0]),
    [...load, ...load],
    [{ t: START + 1, netLoadKWh: 1 }],
    [{ t: START, netLoadKWh: Infinity }],
  ])
    assert.throws(() => replayBattery(bad, battery(), 2));
  assert.throws(() => replayBattery(load, battery(), -1));
});
test('integrated comparison prices the same period with dated fees, wear and demand', () => {
  const f = fixture();
  publish(f);
  const r = compareReplay(f.homey, input(), END);
  assert.equal(r.status, 'indicative');
  assert.equal(r.financiallyComparable, false);
  assert.equal(r.rankingBasis, 'none');
  assert.equal(r.contractVersions.length, 1);
  assert.equal(r.candidates.length, 3);
  const c = r.candidates[0];
  assert.equal(c.terminalMatched, true);
  assert.ok(c.scenario.wearSek > 0);
  assert.equal(c.baseline.wearSek, 0);
  assert.ok(c.scenario.demand.totalSek < c.baseline.demand.totalSek);
  close(c.indicativeNetDifferenceSek, c.baseline.totalSek - c.scenario.totalSek);
  close(c.scenario.energySek, c.scenario.importCostSek - c.scenario.exportRevenueSek);
  f.data.costContract.energyTaxExVatSekPerKWh = 99;
  f.data.demandTariff.rateSekPerKw = 99999;
  assert.deepEqual(compareReplay(f.homey, input(), END), r);
});
test('original battery charge is subtracted from grid energy exactly once', () => {
  const f = fixture();
  publish(f);
  for (const s of f.rows) {
    s.essWh = 100;
    s.gridWh += 100;
    s.importWh += 100;
  }
  const r = compareReplay(f.homey, input(), END);
  close(r.candidates[0].baseline.importKWh, 7);
});
test('unrestored energy and insufficient tariff peaks block net-cost difference', () => {
  const f = fixture();
  publish(f);
  const high = compareReplay(f.homey, { ...input(), hours: 1, capsKW: [0.1] }, END);
  assert.equal(high.candidates[0].reason, 'terminal-energy-not-restored');
  assert.equal(high.candidates[0].indicativeNetDifferenceSek, null);
  const g = fixture();
  g.data.demandTariff.peakCount = 5;
  g.data.demandTariff.distinctDays = true;
  publish(g);
  const r = compareReplay(g.homey, input(), END);
  assert.equal(r.candidates[0].reason, 'insufficient-demand-peaks');
  assert.equal(r.candidates[0].baseline.totalSek, null);
});
test('missing coverage, terms or prices cannot silently shrink a comparison period', () => {
  for (const [change, key] of [
    [(f) => f.rows.pop(), 'energyQuarters'],
    [(f) => delete f.rows[0].essCoverageMs, 'batteryCoverageQuarters'],
    [(f) => delete f.data.tibberHistoryPriceCache.rows[0].production, 'productionPriceQuarters'],
    [(f) => delete f.data.tibberHistoryPriceCache.rows[0].consumption, 'purchasePriceQuarters'],
  ]) {
    const f = fixture();
    publish(f);
    change(f);
    const r = compareReplay(f.homey, input(), END);
    assert.equal(r.reason, 'incomplete-comparison-window');
    assert.ok(r.missing[key] > 0);
    assert.equal(r.candidates, undefined);
  }
  const f = fixture();
  publish(f, '2026-06-12');
  assert.equal(compareReplay(f.homey, input(), END).missing.contractQuarters, 16);
});
test('source changes, bad input, invalid archives and corrupted history fail closed', () => {
  for (const body of [
    null,
    { ...input(), confirmModelAssumptions: false },
    { ...input(), hours: 769 },
    { ...input(), capsKW: [2, 2] },
    { ...input(), capsKW: Array.from({ length: 21 }, (_, i) => i) },
  ])
    assert.equal(compareReplay(fixture().homey, body, END).status, 'unavailable');
  const f = fixture();
  assert.equal(compareReplay(f.homey, input(), END).reason, 'dated-contract-required');
  publish(f);
  f.data.tibberToken = 'changed';
  assert.equal(compareReplay(f.homey, input(), END).reason, 'tibber-home-not-confirmed');
  const g = fixture();
  publish(g);
  g.data.tibberHistoryPriceCache = null;
  assert.equal(compareReplay(g.homey, input(), END).reason, 'historical-prices-unavailable');
  const bad = fixture();
  publish(bad);
  bad.rows.push(bad.rows[0]);
  assert.equal(compareReplay(bad.homey, input(), END).reason, 'invalid-history');
  bad.data.costContractTimeline.entries[0].id = 'tampered';
  assert.equal(compareReplay(bad.homey, input(), END).status, 'unavailable');
});
test('dated observed ledger does not reprice history when the draft changes', () => {
  const f = fixture();
  publish(f);
  const a = f.source.ledger();
  assert.equal(a.componentBasis, 'dated-contract-components');
  assert.equal(a.matchedHours, 4);
  f.data.costContract.energyTaxExVatSekPerKWh = 80;
  assert.deepEqual(f.source.ledger(), a);
  const g = fixture();
  publish(g, '2026-06-12');
  assert.equal(g.source.ledger().missingContractHours, 4);
  assert.equal(g.source.ledger().totals, null);
});
test('new battery coverage is independently integrated and survives export 5, restore and restart', () => {
  let now = START + Q;
  const map = new Map(),
    settings = { get: (k) => map.get(k), set: (k, v) => map.set(k, structuredClone(v)) };
  const h = new HistoryStore(settings, () => now);
  for (let t = START; t <= START + Q; t += 30000) h.append({ gridW: 2000, essW: 1000 }, t);
  h.flush();
  const row = h.getSlots()[0];
  assert.equal(row.essCoverageMs, Q);
  close(row.essWh, 250);
  const exported = h.export();
  assert.equal(exported.schema, 5);
  const freshMap = new Map(),
    fresh = new HistoryStore(
      { get: (k) => freshMap.get(k), set: (k, v) => freshMap.set(k, v) },
      () => now,
    );
  fresh.import(exported);
  assert.equal(fresh.getSlots()[0].essCoverageMs, Q);
  assert.throws(() => parseExport({ ...exported, schema: 4 }, now), /schema 5/);
  const legacy = structuredClone(exported);
  legacy.schema = 4;
  for (const s of legacy.slots) delete s.essCoverageMs;
  assert.doesNotThrow(() => parseExport(legacy, now));
  const invalid = structuredClone(exported);
  invalid.slots[0].essCoverageMs = Q + 1;
  assert.throws(() => parseExport(invalid, now));
  now += Q;
  const restarted = new HistoryStore(settings, () => now);
  restarted.append({ gridW: 2000, essW: 1000 }, now - 30000);
  restarted.append({ gridW: 2000, essW: 1000 }, now);
  restarted.flush();
  assert.equal(restarted.getSlots().find((s) => s.t === START + Q).essCoverageMs, 30000);
});
test('battery outages and net-only legacy coverage cannot qualify as complete battery energy', () => {
  const map = new Map(),
    settings = { get: (k) => map.get(k), set: (k, v) => map.set(k, v) },
    h = new HistoryStore(settings, () => START + Q);
  for (let t = START; t <= START + Q; t += 30000)
    h.append({ gridW: 2000, essW: t === START + Q / 2 ? null : 1000 }, t);
  h.flush();
  assert.equal(h.getSlots()[0].coverageMs, Q);
  assert.equal(h.getSlots()[0].essCoverageMs, Q - 60000);
});
test('new economic API routes are authenticated and do not add device control', async () => {
  const api = require('../api'),
    manifest = require('../app.json'),
    f = fixture();
  for (const name of [
    'getContractTimeline',
    'publishCostContract',
    'restoreCostContracts',
    'compareBatteryReplay',
  ])
    assert.equal(manifest.api[name].public, false);
  const s = await api.getContractTimeline({ homey: f.homey });
  assert.equal(s.timeline.entries.length, 0);
  await api.publishCostContract({
    homey: f.homey,
    body: {
      expectedRevision: s.revision,
      draftHash: s.draftHash,
      from: '2026-06-01',
      confirmEffectiveDate: true,
      confirmTradeComponents: true,
      includeNetwork: true,
    },
  });
  const fresh = timelineStatus(f.homey);
  await api.restoreCostContracts({
    homey: f.homey,
    body: { timeline: fresh.timeline, expectedRevision: fresh.revision, confirmSamePlant: true },
  });
  assert.equal(
    (await api.compareBatteryReplay({ homey: f.homey, body: input() })).controlApplied,
    false,
  );
});

function dayFixture() {
  const f = fixture();
  f.rows.splice(
    0,
    f.rows.length,
    ...Array.from({ length: 96 }, (_, i) => ({
      schema: 2,
      t: END - 24 * H + i * Q,
      gridWh: 250,
      importWh: 250,
      exportWh: 0,
      coverageMs: Q,
      directionalCoverageMs: Q,
      essWh: 0,
      essCoverageMs: Q,
    })),
  );
  f.data.tibberHistoryPriceCache.rows = Array.from({ length: 24 }, (_, i) => ({
    t: END - 24 * H + i * H,
    consumption: { price: 1 },
    production: { price: -0.1 },
  }));
  return f;
}
test('different dated energy fees are applied per Stockholm date without repricing earlier hours', () => {
  const f = dayFixture();
  publish(f);
  f.data.costContract.energyTaxExVatSekPerKWh = 0.7;
  publish(f, '2026-06-11');
  const r = compareReplay(f.homey, { ...input(), hours: 24 }, END);
  assert.equal(r.contractVersions.length, 2);
  close(r.candidates[0].baseline.importCostSek, 43);
});
test('mid-month demand-rate changes are blocked instead of guessing a prorated bill', () => {
  const f = dayFixture();
  publish(f);
  f.data.demandTariff.rateSekPerKw = 80;
  publish(f, '2026-06-11');
  const r = compareReplay(f.homey, { ...input(), hours: 24 }, END);
  assert.equal(r.candidates[0].reason, 'tariff-changed-within-month');
  assert.equal(r.candidates[0].indicativeNetDifferenceSek, null);
});
test('contract effective dates follow Stockholm midnights across both DST transitions', () => {
  const f = fixture();
  publish(f, '2026-03-29');
  const t = readTimeline(f.homey);
  assert.equal(contractAt(t, Date.parse('2026-03-28T22:59:59Z')), null);
  assert.ok(contractAt(t, Date.parse('2026-03-28T23:00:00Z')));
  publish(f, '2026-10-25');
  const u = readTimeline(f.homey);
  assert.equal(contractAt(u, Date.parse('2026-10-24T21:59:59Z')).from, '2026-03-29');
  assert.equal(contractAt(u, Date.parse('2026-10-24T22:00:00Z')).from, '2026-10-25');
});

test('inactive tariff seasons and explicit zero demand price contribute zero without requiring peaks', () => {
  for (const change of [{ months: [1, 2, 3] }, { rateSekPerKw: 0 }]) {
    const f = fixture();
    Object.assign(f.data.demandTariff, change, { peakCount: 5, distinctDays: true });
    publish(f);
    const r = compareReplay(f.homey, input(), END);
    assert.equal(r.candidates[0].status, 'indicative');
    assert.equal(r.candidates[0].scenario.demand.totalSek, 0);
  }
});
