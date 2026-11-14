'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { replaySolarEv } = require('../lib/optimization/coupled-solar-replay');
const { compareSolarEv } = require('../lib/pricing/solar-ev-comparison');
const { TibberHistoryPrices } = require('../lib/pricing/tibber-history-prices');
const { timelineStatus, publishContract } = require('../lib/pricing/contract-timeline');
const { DEFAULTS } = require('../lib/charging/planner');
const { HistoryStore } = require('../lib/history');
const { parseExport } = require('../lib/history-format');
const Q = 900000,
  H = 3600000,
  END = Date.parse('2026-06-11T20:00Z'),
  START = END - 12 * H;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const battery = () => ({
  capacityKWh: 10,
  initialKWh: 2,
  reserveKWh: 1,
  maxChargeKW: 2,
  maxDischargeKW: 2,
  chargeEfficiency: 0.9,
  dischargeEfficiency: 0.9,
  solarTargetKWh: 5,
});
const ev = () => ({
  capacityKWh: 10,
  initialSoc: 20,
  targetSoc: 40,
  efficiency: 0.9,
  minPowerKW: 1.4,
  maxPowerKW: 3,
  availableFromHours: 0,
  deadlineHours: 12,
});
const series = () =>
  Array.from({ length: 48 }, (_, i) => {
    const pv = i >= 16 && i < 20 ? 1 : 0;
    return { t: START + i * Q, pvKWh: pv, netLoadKWh: 0.25 - pv };
  });
function fixture() {
  const data = {
    tibberToken: 'synthetic',
    tibberHomeId: 'synthetic-home',
    sourceConfig: { tibber: { revision: 'synthetic' } },
    chargingConfig: {
      ...structuredClone(DEFAULTS),
      usableBatteryKWh: 10,
      minimumSoc: 30,
      maxChargingPowerKW: 3,
      chargingEfficiency: 0.9,
    },
    costContract: {
      schema: 2,
      currency: 'SEK',
      source: 'Synthetic terms',
      checkedOn: '2026-06-01',
      importPriceBasis: 'spot-ex-vat',
      importIncludesEnergyTax: false,
      energyTaxExVatSekPerKWh: 0.3,
      gridImportExVatSekPerKWh: 0.1,
      otherImportExVatSekPerKWh: 0,
      gridExportBenefitSekPerKWh: 0.05,
      gridExportFeeSekPerKWh: 0.01,
      vatRate: 0.25,
      batteryWearSekPerKWh: 0.2,
    },
    demandTariff: {
      start: '00:00',
      end: '23:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      peakCount: 1,
      distinctDays: false,
      rateSekPerKw: 40,
    },
  };
  const rows = series().map((s) => ({
    schema: 2,
    t: s.t,
    gridWh: s.netLoadKWh * 1000,
    importWh: Math.max(0, s.netLoadKWh) * 1000,
    exportWh: Math.max(0, -s.netLoadKWh) * 1000,
    pvWh: s.pvKWh * 1000,
    essWh: 0,
    coverageMs: Q,
    directionalCoverageMs: Q,
    essCoverageMs: Q,
    fieldCoverageMs: { gridW: Q, pvW: Q, essW: Q },
  }));
  const homey = {
    drivers: { getDriver: () => ({ getDevices: () => [{}] }) },
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
    rows: Array.from({ length: 12 }, (_, i) => ({
      t: START + i * H,
      consumption: { price: i < 6 ? 1 : 0.7 },
      production: { price: -0.1 },
    })),
  };
  const c = timelineStatus(homey);
  publishContract(
    homey,
    {
      expectedRevision: c.revision,
      draftHash: c.draftHash,
      from: '2026-06-01',
      confirmEffectiveDate: true,
      confirmTradeComponents: true,
      includeNetwork: true,
    },
    END,
  );
  return { homey, data, rows, source };
}
const input = () => ({
  hours: 12,
  capsKW: [5],
  battery: battery(),
  confirmModelAssumptions: true,
  ev: { ...ev(), confirmNoExistingEvCharging: true, confirmHistoricalTask: true },
});
test('two priorities allocate limited solar differently while meeting the same EV and home boundaries', () => {
  const h = replaySolarEv(series(), battery(), ev(), 5, 'home-first'),
    e = replaySolarEv(series(), battery(), ev(), 5, 'ev-first'),
    reference = replaySolarEv(series(), battery(), ev(), 0, 'early');
  assert.ok(h.solar.toHomeKWh > e.solar.toHomeKWh);
  assert.ok(e.solar.toEvKWh > h.solar.toEvKWh);
  assert.ok(h.solar.evNonSolarKWh > e.solar.evNonSolarKWh);
  for (const r of [h, e, reference]) {
    assert.equal(r.terminalMatched, true);
    assert.equal(r.ev.targetMet, true);
    close(r.ev.finalStoredKWh, 4);
    close(r.finalKWh, 2);
    for (const v of Object.values(r.conservation)) close(v, 0);
    close(
      r.solar.generationKWh,
      r.solar.toHouseKWh + r.solar.toEvKWh + r.solar.toHomeKWh + r.solar.exportKWh,
    );
    close(r.ev.inputKWh, r.ev.storedKWh + r.ev.lossesKWh);
  }
  assert.equal(reference.chargedKWh, 0);
  assert.equal(reference.dischargedKWh, 0);
});
test('EV minimum power is respected, including short finishes with directional subsegments', () => {
  const load = [{ t: START, netLoadKWh: -0.5, pvKWh: 1 }];
  const r = replaySolarEv(
    load,
    { ...battery(), solarTargetKWh: 2 },
    { ...ev(), initialSoc: 20, targetSoc: 21, minPowerKW: 1.4, maxPowerKW: 2, deadlineHours: 0.25 },
    5,
    'ev-first',
  );
  assert.equal(r.ev.targetMet, true);
  close(r.ev.inputKWh, 0.1 / 0.9);
  assert.equal(r.slots.length, 1);
  close(r.slots[0].gridWh, -500 + r.ev.inputKWh * 1000);
  assert.ok(r.solar.exportKWh > 0);
  const insufficient = replaySolarEv(
    [
      { t: START, netLoadKWh: -0.25, pvKWh: 0.5 },
      ...Array.from({ length: 7 }, (_, i) => ({
        t: START + (i + 1) * Q,
        netLoadKWh: 0.25,
        pvKWh: 0,
      })),
    ],
    { ...battery(), solarTargetKWh: 2 },
    { ...ev(), targetSoc: 22, deadlineHours: 2 },
    5,
    'ev-first',
  );
  assert.equal(insufficient.slots[0].evInputKWh, 0);
  assert.ok(insufficient.solar.evNonSolarKWh > 0);
});
test('arrival/departure gates the EV and an impossible deadline never gets free energy', () => {
  const load = series();
  const r = replaySolarEv(
    load,
    battery(),
    { ...ev(), availableFromHours: 5, deadlineHours: 5.25, targetSoc: 80 },
    5,
    'ev-first',
  );
  assert.equal(r.ev.targetMet, false);
  assert.ok(r.ev.unmetKWh > 0);
  assert.ok(
    r.slots.every((s) => (s.t >= START + 5 * H && s.t < START + 5.25 * H) || s.evInputKWh === 0),
  );
});
test('battery excess is not assigned an invented terminal value', () => {
  const r = replaySolarEv(
    [{ t: START, netLoadKWh: -2, pvKWh: 2.25 }],
    battery(),
    { ...ev(), targetSoc: 20, deadlineHours: 0.25 },
    5,
    'home-first',
  );
  assert.equal(r.terminalMatched, false);
  assert.ok(r.terminalExcessKWh > 0);
  assert.equal(r.terminalShortfallKWh, 0);
});
test('grid recharge, conversion losses and soft-cap misses remain explicit', () => {
  const r = replaySolarEv(
    series(),
    { ...battery(), initialKWh: 1, reserveKWh: 1 },
    ev(),
    0.1,
    'home-first',
  );
  assert.ok(r.uncoveredKWh > 0);
  assert.ok(r.ev.inputKWh > 0);
  assert.ok(r.ev.lossesKWh > 0);
  for (const v of Object.values(r.conservation)) close(v, 0);
});
test('no-solar and already-met targets preserve valid zeros without fabricating production', () => {
  const load = series().map((s) => ({ ...s, pvKWh: 0, netLoadKWh: 0.25 }));
  const r = replaySolarEv(load, battery(), { ...ev(), targetSoc: 20 }, 5, 'home-first');
  assert.equal(r.solar.generationKWh, 0);
  assert.equal(r.ev.inputKWh, 0);
  assert.equal(r.ev.targetMet, true);
  assert.equal(r.terminalMatched, true);
});
test('invalid tasks, solar boundaries, capabilities and unaligned/gapped windows fail closed', () => {
  for (const e of [
    { deadlineHours: 13 },
    { availableFromHours: 12 },
    { deadlineHours: 0.3 },
    { targetSoc: 101 },
    { initialSoc: 50 },
    { minPowerKW: 4 },
    { efficiency: 0 },
    { maxPowerKW: 0 },
  ])
    assert.throws(() => replaySolarEv(series(), battery(), { ...ev(), ...e }, 5, 'ev-first'));
  for (const load of [
    [],
    [...series(), series()[0]],
    [{ t: START, pvKWh: 0, netLoadKWh: -1 }],
    [{ t: START, pvKWh: -1, netLoadKWh: 0 }],
    [{ t: START + 1, pvKWh: 0, netLoadKWh: 0 }],
  ])
    assert.throws(() => replaySolarEv(load, battery(), ev(), 5, 'ev-first'));
  assert.throws(() =>
    replaySolarEv(series(), { ...battery(), solarTargetKWh: 11 }, ev(), 5, 'ev-first'),
  );
  assert.throws(() => replaySolarEv(series(), battery(), ev(), 5, 'unknown'));
});
test('integrated solar/EV comparison reuses prices, dated terms and tariff without ranking', () => {
  const f = fixture(),
    r = compareSolarEv(f.homey, input(), END);
  assert.equal(r.status, 'indicative');
  assert.equal(r.candidates.length, 2);
  assert.equal(r.financiallyComparable, false);
  assert.equal(r.controlApplied, false);
  assert.equal(r.rankingBasis, 'none');
  assert.deepEqual(
    r.candidates.map((c) => c.strategy),
    ['home-first', 'ev-first'],
  );
  for (const c of r.candidates) {
    assert.equal(c.ev.targetMet, true);
    assert.equal(c.terminalMatched, true);
    close(c.indicativeNetDifferenceSek, c.baseline.totalSek - c.scenario.totalSek);
    assert.ok(c.scenario.importCostSek > 0);
    assert.ok(c.scenario.exportRevenueSek <= 0);
    assert.ok(c.scenario.wearSek > 0);
  }
  assert.equal(r.evAssumptions.capacityKWh, 10);
  const above = input();
  above.ev.maxPowerKW = 100;
  assert.equal(compareSolarEv(f.homey, above, END).evAssumptions.maxPowerKW, 3);
});
test('missing independent PV coverage, recorded EV load and invalid solar balance block comparison', () => {
  for (const [change, key] of [
    [(f) => delete f.rows[0].fieldCoverageMs, 'solarCoverageQuarters'],
    [
      (f) => {
        f.rows[0].pvWh = NaN;
      },
      'solarEnergyQuarters',
    ],
    [
      (f) => {
        f.rows[0].evWh = 100;
      },
      'knownEvChargingQuarters',
    ],
    [
      (f) => {
        f.rows[16].pvWh = 0;
      },
      'inconsistentSolarQuarters',
    ],
  ]) {
    const f = fixture();
    change(f);
    const r = compareSolarEv(f.homey, input(), END);
    assert.equal(r.reason, 'incomplete-solar-ev-window');
    assert.ok(r.missing[key] > 0);
    assert.equal(r.candidates, undefined);
  }
});
test('unconfirmed baseline, incomplete existing context and invalid saved charging config cannot be priced', () => {
  const f = fixture();
  for (const changes of [{ confirmHistoricalTask: false }, { confirmNoExistingEvCharging: false }])
    assert.equal(
      compareSolarEv(f.homey, { ...input(), ev: { ...input().ev, ...changes } }, END).reason,
      'confirm-historical-ev-baseline',
    );
  for (const body of [
    null,
    { ...input(), hours: 169 },
    { ...input(), capsKW: Array.from({ length: 11 }, (_, i) => i) },
    { ...input(), capsKW: [5, 5] },
  ])
    assert.equal(compareSolarEv(f.homey, body, END).status, 'unavailable');
  const low = input();
  low.ev.targetSoc = 25;
  assert.equal(compareSolarEv(f.homey, low, END).reason, 'ev-target-below-saved-minimum');
  delete f.data.tibberHistoryPriceCache.rows[0].production;
  assert.equal(compareSolarEv(f.homey, input(), END).reason, 'incomplete-comparison-window');
  const g = fixture();
  g.data.chargingConfig = null;
  assert.equal(compareSolarEv(g.homey, input(), END).reason, 'invalid-solar-ev-assumptions');
});
test('missed EV goals or home terminal state suppress net cost differences, while component costs remain visible', () => {
  const f = fixture();
  const deadline = input();
  deadline.ev.availableFromHours = 11.75;
  deadline.ev.deadlineHours = 12;
  deadline.ev.targetSoc = 80;
  const r = compareSolarEv(f.homey, deadline, END);
  assert.equal(r.candidates[0].reason, 'ev-deadline-unmet');
  assert.equal(r.candidates[0].indicativeNetDifferenceSek, null);
  const short = fixture();
  short.rows.splice(
    0,
    short.rows.length,
    ...short.rows
      .slice(-4)
      .map((s) => ({ ...s, pvWh: 4000, gridWh: -3750, importWh: 0, exportWh: 3750 })),
  );
  const s = compareSolarEv(
    short.homey,
    { ...input(), hours: 1, ev: { ...input().ev, targetSoc: 30, deadlineHours: 1 } },
    END,
  );
  assert.equal(s.candidates[0].reason, 'terminal-energy-not-restored');
  assert.equal(s.candidates[0].indicativeNetDifferenceSek, null);
});
test('independent power coverage starts with new observations and survives export 6 and restore', () => {
  let now = START + Q;
  const map = new Map(),
    settings = { get: (k) => map.get(k), set: (k, v) => map.set(k, structuredClone(v)) },
    h = new HistoryStore(settings, () => now);
  for (let t = START; t <= START + Q; t += 30000)
    h.append({ gridW: -1000, pvW: 2000, essW: 0, evW: 0 }, t);
  h.flush();
  const row = h.getSlots()[0];
  assert.deepEqual(row.fieldCoverageMs, { gridW: Q, pvW: Q, essW: Q, evW: Q });
  const file = h.export();
  assert.equal(file.schema, 6);
  assert.doesNotThrow(() => parseExport(file, now));
  const restoredMap = new Map();
  const restored = new HistoryStore(
    { get: (k) => restoredMap.get(k), set: (k, v) => restoredMap.set(k, v) },
    () => now,
  );
  restored.import(file);
  assert.deepEqual(restored.getSlots()[0].fieldCoverageMs, row.fieldCoverageMs);
  assert.throws(() => parseExport({ ...file, schema: 5 }, now), /schema 6/);
  const old = structuredClone(file);
  old.schema = 5;
  delete old.slots[0].fieldCoverageMs;
  assert.doesNotThrow(() => parseExport(old, now));
  const bad = structuredClone(file);
  bad.slots[0].fieldCoverageMs.pvW = Q + 1;
  assert.throws(() => parseExport(bad, now));
  now += Q;
  const next = new HistoryStore(settings, () => now);
  next.append({ gridW: -1000, pvW: 2000, essW: 0 }, now - 30000);
  next.append({ gridW: -1000, pvW: 2000, essW: 0 }, now);
  next.flush();
  assert.equal(next.getSlots().find((s) => s.t === START + Q).fieldCoverageMs.pvW, 30000);
});
test('upgrade coverage never borrows older grid/ESS duration or bridges invalid PV samples', () => {
  const map = new Map(),
    settings = { get: (k) => map.get(k), set: (k, v) => map.set(k, structuredClone(v)) };
  const h = new HistoryStore(settings, () => START + Q);
  for (let t = START; t <= START + Q; t += 30000)
    h.append({ gridW: 1000, pvW: t === START + Q / 2 ? null : 2000, essW: 0 }, t);
  h.flush();
  assert.equal(h.getSlots()[0].fieldCoverageMs.pvW, Q - 60000);
  assert.equal(h.getSlots()[0].fieldCoverageMs.gridW, Q);
  const old = map.get('historyState');
  delete old.slots[0].fieldCoverageMs;
  settings.set('historyState', old);
  const fresh = new HistoryStore(settings, () => START + Q + 30000);
  fresh.append({ gridW: 1000, pvW: 2000, essW: 0 }, START + Q - 30000);
  fresh.append({ gridW: 1000, pvW: 2000, essW: 0 }, START + Q);
  fresh.flush();
  assert.equal(fresh.getSlots()[0].fieldCoverageMs.pvW, 30000);
  assert.doesNotThrow(() => fresh.export());
});
test('coupled model API is authenticated and only reads local inputs', async () => {
  const f = fixture(),
    api = require('../api'),
    manifest = require('../app.json');
  assert.deepEqual(manifest.api.compareSolarEvReplay, {
    method: 'POST',
    path: '/economics/solar-ev-replay',
    public: false,
  });
  f.homey.settings.set = () => {
    throw Error('Writes forbidden');
  };
  const r = await api.compareSolarEvReplay({ homey: f.homey, body: input() });
  assert.equal(r.controlApplied, false);
  assert.equal(r.financiallyComparable, false);
});

test('fractional deadline charging preserves both import and export within the same quarter', () => {
  const r = replaySolarEv(
    [{ t: START, netLoadKWh: -0.25, pvKWh: 0.5 }],
    { ...battery(), solarTargetKWh: 2 },
    { ...ev(), targetSoc: 21, deadlineHours: 0.25 },
    5,
    'ev-first',
  );
  assert.equal(r.ev.targetMet, true);
  assert.ok(r.slots[0].importWh > 0);
  assert.ok(r.slots[0].exportWh > 0);
  close(r.slots[0].importWh - r.slots[0].exportWh, r.slots[0].gridWh);
  close(r.slots[0].gridWh, -250 + r.ev.inputKWh * 1000);
});

test('deterministic varied solar/load/tasks preserve all storage and allocation balances', () => {
  let seed = 123456;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let n = 0; n < 60; n++) {
    const load = Array.from({ length: 32 }, (_, i) => {
      const pv = rand() * 1.5,
        house = rand();
      return { t: START + i * Q, pvKWh: pv, netLoadKWh: house - pv };
    });
    const e = {
      ...ev(),
      initialSoc: 20,
      targetSoc: 20 + rand() * 60,
      minPowerKW: rand() * 1.4,
      maxPowerKW: 3,
      availableFromHours: Math.floor(rand() * 8) * 0.25,
      deadlineHours: 8,
    };
    for (const policy of ['home-first', 'ev-first']) {
      const r = replaySolarEv(load, battery(), e, 0.5 + rand() * 5, policy);
      for (const v of Object.values(r.conservation)) close(v, 0);
      assert.ok(r.ev.finalStoredKWh <= r.ev.targetStoredKWh + 1e-7);
      for (const s of r.slots) {
        assert.ok(s.storedKWh >= 1 - 1e-7 && s.storedKWh <= 10 + 1e-7);
        close(s.importWh - s.exportWh, s.gridWh);
      }
    }
  }
});

test('a known EV power sample blocks added charging even before an EV integral exists or when net energy is zero', () => {
  const f = fixture();
  f.rows[0].evWh = 0;
  f.rows[0].max = { evW: 2000 };
  assert.equal(compareSolarEv(f.homey, input(), END).missing.knownEvChargingQuarters, 1);
});

test('missing or ambiguous paired plants block the coupled price model', () => {
  for (const devices of [[], [{}, {}]]) {
    const f = fixture();
    f.homey.drivers = { getDriver: () => ({ getDevices: () => devices }) };
    assert.equal(compareSolarEv(f.homey, input(), END).reason, 'ambiguous-solar-plant');
  }
});
