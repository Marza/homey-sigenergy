'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { optimize, Q } = require('../lib/energy/battery-plan');
const { getBatteryPlan } = require('../lib/energy/battery-plan-report');
const { normalizePrices } = require('../lib/pricing/tibber');
const { timelineStatus, publishContract } = require('../lib/pricing/contract-timeline');
const b = { soc: 45.4, low: 15, high: 80, capacity: 10, chargeKW: 4, dischargeKW: 4, importKW: 5 };
const slot = (buy, sell, netKWh = 0) => ({
  t: 0,
  buy,
  sell,
  netKWh,
  wear: 0.03,
  peakWindow: false,
});
test('buys low, sells high, retains exact opening energy; AC losses, wear and household load count', () => {
  const plan = optimize([slot(0.1, 0), slot(4, 3)], b);
  assert.deepEqual(
    plan.map((q) => q.action),
    ['buy', 'sell'],
  );
  assert.equal(plan.at(-1).endSoc, b.soc);
  assert.ok(Math.abs(plan[1].sellKWh / plan[0].buyKWh - 0.95 ** 2) < 1e-8);
  assert.deepEqual(
    optimize([slot(1, 0.9), slot(1, 0.9)], b).map((q) => q.action),
    ['hold', 'hold'],
  );
  assert.equal(optimize([slot(0.1, 0), slot(4, 0.1, 1)], b)[1].action, 'house');
  assert.equal(optimize([slot(0.1, 0, -1), slot(4, 0.1, 1)], b)[0].action, 'solar');
});
test('bounds and peak windows apply to grid charging, including negative prices', () => {
  const cap = optimize([slot(-2, -3, 1.1), slot(3, 2)], b);
  assert.ok(cap[0].buyKWh <= 0.15 + 1e-9);
  assert.ok(cap[0].buyKWh > 0);
  assert.equal(optimize([{ ...slot(-2, -3), peakWindow: true }, slot(3, 2)], b)[0].action, 'hold');
  assert.equal(optimize([slot(1, 0, 4)], b), null);
  assert.equal(optimize([slot(1, 0)], { ...b, low: 80 }), null);
});
function fixture(now = Date.parse('2026-11-22T10:01:00Z')) {
  const first = Math.ceil(now / Q) * Q;
  const stamped = new Date(now).toISOString();
  const slots = [
    { t: first - 96 * Q, fieldCoverageMs: { pvW: Q }, pvWh: 0 },
    { t: first - 95 * Q, fieldCoverageMs: { pvW: Q }, pvWh: 0 },
    { t: first - Q, minuteMeans: { soc: [{ mean: 42 }, null, null] } },
  ];
  const contract = {
    schema: 2,
    source: 'fixture',
    currency: 'SEK',
    checkedOn: '2026-01-01',
    importPriceBasis: 'spot-ex-vat',
    importIncludesEnergyTax: false,
    energyTaxExVatSekPerKWh: 0.36,
    gridImportExVatSekPerKWh: 0.056,
    otherImportExVatSekPerKWh: 0.0928,
    vatRate: 0.25,
    gridExportBenefitSekPerKWh: 0.056,
    gridExportFeeSekPerKWh: 0,
    batteryWearSekPerKWh: 0,
  };
  const entry = {
    contract,
    from: '2026-01-01',
    tariff: {
      start: '07:00',
      end: '20:00',
      weekdays: [1],
      peakCount: 5,
      rateSekPerKw: 100,
      distinctDays: true,
    },
    includeNetwork: true,
    tradeComponentsConfirmed: true,
    savedAt: stamped,
  };

  const data = {
    costContract: contract,
    demandTariff: entry.tariff,
    sourceConfig: { sigenergy: { configured: true, enabled: true }, tibber: { revision: 'one' } },
    sigenergyStatus: { readAt: stamped },
    backupStatus: {
      mode: 'on-grid',
      soc: b.soc,
      suspendEconomicOptimization: false,
      observedAt: stamped,
    },
    batteryTelemetry: {
      readAt: stamped,
      values: {
        capacityKWh: 10,
        dischargeCutoffSoc: 15,
        chargeCutoffSoc: 80,
        chargePowerLimitKW: 4,
        dischargePowerLimitKW: 4,
      },
    },
    householdForecastV1: { issues: [{ at: now, start: first, wh: Array(96).fill(0) }] },
    householdImportLimits: { importLimitKW: 5 },
    tibberToken: 'secret',
    priceCache: {
      schema: 2,
      resolution: 'QUARTER_HOURLY',
      currency: 'SEK',
      selectedHomeId: null,
      configRevision: 'one',
      fetchedAt: stamped,
      prices: [0, 1].map((i) => ({
        start: new Date(first + i * Q).toISOString(),
        end: new Date(first + (i + 1) * Q).toISOString(),
        price: 9,
        spot: i ? 3 : -1,
      })),
    },
  };
  const settings = {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
  };
  const { draftHash, revision } = timelineStatus({ settings });
  publishContract(
    { settings },
    {
      draftHash,
      expectedRevision: revision,
      from: entry.from,
      confirmEffectiveDate: true,
      confirmTradeComponents: true,
      includeNetwork: true,
    },
    now,
  );
  return {
    data,
    now,
    first,
    report: () =>
      getBatteryPlan(
        { settings: { get: (k) => data[k] }, app: { history: { getSlots: () => slots } } },
        now,
      ),
  };
}
test('report uses dated prices in both directions, covers available quarters and stops at first gap', () => {
  const { report, first, data } = fixture();
  const result = report();
  const price = result.quarters.find((q) => q.t === first);
  assert.ok(Math.abs(price.buy - 1.25 * (-1 + 0.5088)) < 1e-9);
  assert.equal(price.sell, -0.944);
  assert.deepEqual(
    result.plan.map((q) => q.action),
    ['buy', 'sell'],
  );
  assert.equal(result.reason, 'prices');
  assert.equal(result.measured[0].soc, 42);
  assert.ok(!JSON.stringify(result).includes('secret'));
  data.priceCache.configRevision = 'wrong';
  assert.equal(report().plan.length, 0);
  data.priceCache.configRevision = 'one';
  delete data.priceCache.prices[0].spot;
  assert.equal(report().quarters.find((q) => q.t === first).sell, null);
  data.backupStatus.mode = 'off-grid';
  assert.equal(report().reason, 'grid');
});
test('absent load, contract or battery data leaves prices and measured history independent of advice', () => {
  const { data, report } = fixture();
  data.householdForecastV1.issues = [];
  assert.equal(report().reason, 'load');
  delete data.costContractTimeline;
  assert.equal(report().reason, 'contract');
  assert.equal(report().measured.length, 1);
});
test('Tibber optional energy field preserves zero and negatives without changing cached purchase total', () => {
  const now = new Date('2026-11-22T12:00:00Z'),
    home = {
      currentSubscription: {
        priceInfo: {
          today: [{ startsAt: now.toISOString(), total: 0.15, energy: -0.1, currency: 'SEK' }],
          tomorrow: [],
        },
      },
    };
  assert.equal(normalizePrices(home, now)[0].spot, -0.1);
  home.currentSubscription.priceInfo.today[0].energy = 0;
  assert.equal(normalizePrices(home, now)[0].spot, 0);
  home.currentSubscription.priceInfo.today.push({
    ...home.currentSubscription.priceInfo.today[0],
    energy: 0.02,
  });
  assert.throws(() => normalizePrices(home, now), /Conflicting/);
});

test('binding the plan to a main fuse suppresses extra network trades without phase evidence', () => {
  const { data, report } = fixture();
  data.householdImportLimits.mainFuseA = 25;
  const result = report();
  assert.equal(result.missingPhase, true);
  assert.ok(result.plan.length > 0 && result.plan.every((q) => q.buyKWh === 0 && q.sellKWh === 0));
  const quarters = [
    { ...slot(0, 0), phaseRoomKWh: 0.25 },
    { ...slot(4, 3), phaseRoomKWh: 0.2 },
  ];
  const plan = optimize(quarters, b);
  assert.ok(plan[0].buyKWh > 0 && plan[0].buyKWh <= 0.25);
  assert.ok(plan[1].sellKWh > 0 && plan[1].sellKWh <= 0.2);
});

test('the report applies the household target only inside the effective Stockholm tariff window', () => {
  const sunday = fixture();
  assert.equal(sunday.report().tariffTargetKW, 3);
  assert.ok(sunday.report().plan.every((q) => !q.peakWindow));
  const monday = fixture(Date.parse('2026-11-23T10:01:00Z'));
  monday.data.householdImportLimits.tariffTargetKW = 1.2;
  monday.data.householdForecastV1.issues[0].wh.fill(750);
  const result = monday.report();
  assert.equal(result.tariffTargetKW, 1.2);
  assert.equal(result.plan.length, 2);
  assert.ok(
    result.plan.every((q) => q.peakWindow && q.gridImportKW <= 1.2 + 1e-9 && q.buyKWh === 0),
  );
});

test('precharges for an expensive peak even when the energy price alone favors waiting', () => {
  const s = { ...b, low: 20, soc: 20, importKW: 7, tariffTargetKW: 3 };
  const plan = optimize([slot(5, 0, 0.25), { ...slot(1, 0, 1.5), peakWindow: true }], s);
  assert.ok(plan[0].chargeKW > 0);
  assert.ok(plan[1].gridImportKW <= 3 + 1e-9);
  assert.equal(plan[1].action, 'house');
  const limited = optimize(
    [
      { ...slot(5, 0), phaseRoomKWh: 0 },
      { ...slot(1, 0, 1.5), peakWindow: true },
    ],
    s,
  );
  assert.equal(limited[0].buyKWh, 0);
  assert.equal(limited[1].gridImportKW, 6);
  // The battery cutoff and the household connection remain hard limits.
  assert.equal(limited[1].endSoc, s.low);
  assert.equal(optimize([{ ...slot(1, 0, 2), peakWindow: true }], s), null);
});

test('can draw opening energy to protect the target without a grid refill in the horizon', () => {
  const s = { ...b, tariffTargetKW: 3 };
  const [q] = optimize([{ ...slot(1, 0, 1), peakWindow: true }], s);
  assert.ok(q.gridImportKW <= 3 + 1e-9 && q.endSoc < s.soc && q.endSoc >= s.low);
});

test('concentrates equal-price grid charging within remaining import and BMS capacity', () => {
  const s = {
    ...b,
    soc: 20,
    low: 20,
    high: 90,
    capacity: 19,
    importKW: 17.3,
    chargeKW: 14.3,
    dischargeKW: 17,
  };
  const plan = optimize([slot(1, 0, 0.75), slot(1, 0, 0.75), slot(5, 0, 3.1)], s);
  assert.equal(plan.filter((q) => q.buyKWh > 0).length, 1);
  const q = plan.find((q) => q.buyKWh > 0);
  assert.ok(q.chargeKW > 12 && q.chargeKW <= 14.3 + 1e-9 && q.gridImportKW <= 17.3 + 1e-9);
  const netLimited = optimize([slot(1, 0, 2), slot(4, 0, 3)], s);
  assert.ok(netLimited[0].chargeKW > 8 && netLimited[0].chargeKW <= 9.3 + 1e-9);
});
