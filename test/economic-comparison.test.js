'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { compareEconomicScenarios: compare } = require('../lib/pricing/economic-comparison');
const {
  validateCostContract,
  calculateMarginalPrices,
  evaluateEnergySlots,
  totalScenarioCost,
} = require('../lib/pricing/cost-model');
const t = Date.parse('2026-10-25T00:00Z');
const contract = () => ({
  schema: 1,
  currency: 'SEK',
  source: 'Synthetic contract, not a current rate',
  checkedOn: '2026-10-25',
  importIncludesEnergyTax: false,
  energyTaxExVatSekPerKWh: 0.4,
  gridImportExVatSekPerKWh: 0.2,
  gridExportBenefitSekPerKWh: 0.1,
  gridExportFeeSekPerKWh: 0.05,
  vatRate: 0.25,
  batteryWearSekPerKWh: 0.2,
});
const slot = (time, imp, exp) => ({
  t: time,
  importWh: imp,
  exportWh: exp,
  gridWh: imp - exp,
  coverageMs: 900000,
});
function input() {
  return {
    schema: 1,
    currency: 'SEK',
    importSource: 'Synthetic import contract',
    exportSource: 'Synthetic production contract',
    importIncludesEnergyTax: false,
    prices: [
      { t, end: t + 900000, importInclVatSekPerKWh: 1, exportSekPerKWh: -0.5 },
      { t: t + 900000, end: t + 1800000, importInclVatSekPerKWh: -1, exportSekPerKWh: 0.5 },
    ],
    baseline: {
      slots: [slot(t, 1000, 500), slot(t + 900000, 1000, 0)],
      dischargeKWh: 0,
      demandChargeSek: 100,
      initialStoredKWh: 5,
      finalStoredKWh: 5,
    },
    scenario: {
      slots: [slot(t, 500, 1000), slot(t + 900000, 1000, 0)],
      dischargeKWh: 1,
      demandChargeSek: 50,
      initialStoredKWh: 5,
      finalStoredKWh: 5,
    },
  };
}
test('timestamp-matched signed exports, VAT, additional fees, wear and demand are counted separately', () => {
  const i = input(),
    c = contract(),
    result = compare(i, c);
  assert.equal(result.status, 'provisional');
  assert.equal(result.financiallyComparable, true);
  assert.equal(result.inputVerification, 'user-supplied');
  assert.equal(result.fixedChargesIncluded, false);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.baseline.importKWh, 2);
  assert.equal(result.baseline.exportKWh, 0.5);
  assert.equal(result.baseline.importCostSek, 1.5); // 1.75 + -0.25
  assert.equal(result.baseline.exportRevenueSek, -0.225);
  assert.equal(result.scenario.wearSek, 0.2);
  assert.ok(Math.abs(result.netSavingSek - 50.45) < 1e-9);
  assert.equal(result.to, t + 1800000);
  assert.equal(result.from, t);
  assert.equal(result.intervals, 2); // DST is resolved by UTC instants
  assert.deepEqual(i, input());
  assert.deepEqual(c, contract());
});
test('energy tax already included in import total is not added a second time', () => {
  const c = { ...contract(), importIncludesEnergyTax: true, energyTaxExVatSekPerKWh: 0 };
  const i = input();
  i.importIncludesEnergyTax = true;
  assert.equal(compare(i, c).baseline.importCostSek, 0.5);
  const p = calculateMarginalPrices({
    tibberImportInclVatSekPerKWh: 1,
    tibberExportSekPerKWh: -0.5,
    settings: c,
  });
  assert.equal(p.importSekPerKWh, 1.25);
  assert.equal(p.components.energyTaxInclVatSekPerKWh, 0);
  assert.throws(() => validateCostContract({ ...c, energyTaxExVatSekPerKWh: 0.4 }), /ingår redan/);
});
for (const [name, mutate, reason] of [
  [
    'missing import source',
    (i) => {
      delete i.importSource;
    },
    'provenance',
  ],
  [
    'missing export source',
    (i) => {
      i.exportSource = '';
    },
    'provenance',
  ],
  [
    'wrong currency',
    (i) => {
      i.currency = 'EUR';
    },
    'provenance',
  ],
  [
    'unknown schema',
    (i) => {
      i.schema = 3;
    },
    'provenance',
  ],
  [
    'tax basis mismatch',
    (i) => {
      i.importIncludesEnergyTax = true;
    },
    'provenance',
  ],
  [
    'missing export prices',
    (i) => {
      delete i.prices[0].exportSekPerKWh;
    },
    'price-missing',
  ],
  [
    'missing import prices',
    (i) => {
      delete i.prices[0].importInclVatSekPerKWh;
    },
    'price-missing',
  ],
  [
    'non-finite price',
    (i) => {
      i.prices[0].exportSekPerKWh = Infinity;
    },
    'price-missing',
  ],
  [
    'null price row',
    (i) => {
      i.prices[0] = null;
    },
    'price-intervals',
  ],
  [
    'duplicate prices',
    (i) => {
      i.prices[1] = { ...i.prices[0] };
    },
    'price-intervals',
  ],
  [
    'stretched price',
    (i) => {
      i.prices[0].end += 900000;
    },
    'price-intervals',
  ],
  [
    'unaligned price',
    (i) => {
      i.prices[0].t++;
    },
    'price-intervals',
  ],
  [
    'gapped prices',
    (i) => {
      i.prices[1].t += 900000;
      i.prices[1].end += 900000;
    },
    'price-intervals',
  ],
  [
    'missing scenario',
    (i) => {
      delete i.scenario;
    },
    'intervals-missing',
  ],
  [
    'empty prices',
    (i) => {
      i.prices = [];
    },
    'intervals-missing',
  ],
  [
    'oversized input',
    (i) => {
      i.prices = Array(3073).fill(i.prices[0]);
    },
    'intervals-missing',
  ],
  [
    'missing energy',
    (i) => {
      i.scenario.slots.pop();
    },
    'intervals-missing',
  ],
  [
    'wrong energy timestamp',
    (i) => {
      i.scenario.slots[0].t -= 900000;
    },
    'energy-price',
  ],
  [
    'duplicate energy',
    (i) => {
      i.scenario.slots[1] = i.scenario.slots[0];
    },
    'components-incomplete',
  ],
  [
    'null energy',
    (i) => {
      i.scenario.slots[0] = null;
    },
    'energy-price',
  ],
  [
    'partial quarter',
    (i) => {
      i.scenario.slots[0].coverageMs--;
    },
    'components-incomplete',
  ],
  [
    'missing coverage',
    (i) => {
      delete i.scenario.slots[0].coverageMs;
    },
    'components-incomplete',
  ],
  [
    'net-only energy',
    (i) => {
      delete i.scenario.slots[0].exportWh;
    },
    'components-incomplete',
  ],
  [
    'inconsistent net energy',
    (i) => {
      i.scenario.slots[0].gridWh = 0;
    },
    'components-incomplete',
  ],
  [
    'missing wear',
    (i) => {
      delete i.scenario.dischargeKWh;
    },
    'components-incomplete',
  ],
  [
    'missing demand charge',
    (i) => {
      delete i.scenario.demandChargeSek;
    },
    'components-incomplete',
  ],
  [
    'negative demand charge',
    (i) => {
      i.scenario.demandChargeSek = -1;
    },
    'components-incomplete',
  ],
  [
    'different starting battery',
    (i) => {
      i.scenario.initialStoredKWh = 6;
    },
    'battery-boundaries',
  ],
  [
    'depleted terminal battery',
    (i) => {
      i.scenario.finalStoredKWh = 4;
    },
    'battery-boundaries',
  ],
  [
    'missing battery boundary',
    (i) => {
      delete i.baseline.finalStoredKWh;
    },
    'battery-boundaries',
  ],
  [
    'cost overflow',
    (i) => {
      i.prices[0].importInclVatSekPerKWh = Number.MAX_VALUE;
      i.scenario.slots[0] = slot(t, 10000, 0);
    },
    'overflow',
  ],
])
  test(name + ' blocks a complete economic comparison', () => {
    const i = input();
    mutate(i);
    const r = compare(i, contract());
    assert.equal(r.status, 'unavailable');
    assert.match(r.reason, new RegExp(reason));
    assert.equal(r.financiallyComparable, false);
    assert.equal(r.netSavingSek, undefined);
  });
test('missing/invalid contract and inputs fail closed without throwing', () => {
  for (const c of [
    null,
    [],
    {},
    { ...contract(), vatRate: 2 },
    { ...contract(), gridExportFeeSekPerKWh: undefined },
  ])
    assert.equal(compare(input(), c).reason, 'cost-settings-missing-or-invalid');
  assert.equal(compare(null, contract()).status, 'unavailable');
  for (const patch of [
    { checkedOn: '2026-02-30' },
    { source: ' ' },
    { checkedOn: 'bad' },
    { currency: 'EUR' },
    { batteryWearSekPerKWh: -1 },
  ])
    assert.throws(() => validateCostContract({ ...contract(), ...patch }));
  assert.equal(evaluateEnergySlots([], {}, contract()).status, 'insufficient-data');
  assert.equal(evaluateEnergySlots(null, {}, contract()).status, 'insufficient-data');
  assert.equal(totalScenarioCost({ energy: null, settings: contract() }), null);
});
test('authenticated API uses only saved cost assumptions and performs no writes', async () => {
  const api = require('../api'),
    manifest = require('../app.json');
  assert.deepEqual(manifest.api.previewEconomics, {
    method: 'POST',
    path: '/economics/preview',
    public: false,
  });
  const reads = [],
    homey = {
      settings: {
        get: (key) => {
          reads.push(key);
          return contract();
        },
      },
    };
  const r = await api.previewEconomics({ homey, body: input() });
  assert.equal(r.status, 'provisional');
  assert.deepEqual(reads, ['costContract']);
});

test('packaged cost validator matches canonical Node module byte for byte', () => {
  const fs = require('node:fs'),
    path = require('node:path');
  assert.equal(
    fs.readFileSync(path.join(__dirname, '../settings/cost-model.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../lib/pricing/cost-model.js'), 'utf8'),
  );
});
test('ordering is irrelevant when baseline, scenario and price sets are identical', () => {
  const i = input(),
    expected = compare(i, contract());
  i.prices.reverse();
  i.scenario.slots.reverse();
  assert.deepEqual(compare(i, contract()), expected);
});
