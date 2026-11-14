'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const model = require('../lib/pricing/cost-model');
const { compareEconomicScenarios } = require('../lib/pricing/economic-comparison');
const legacy = () => ({
  schema: 1,
  currency: 'SEK',
  source: 'Synthetic source',
  checkedOn: '2026-06-10',
  importIncludesEnergyTax: false,
  energyTaxExVatSekPerKWh: 0.31,
  gridImportExVatSekPerKWh: 0.09,
  gridExportBenefitSekPerKWh: 0.04,
  gridExportFeeSekPerKWh: 0,
  vatRate: 0.25,
  batteryWearSekPerKWh: 0,
});
const contract = () => ({
  ...legacy(),
  schema: 2,
  importPriceBasis: 'spot-ex-vat',
  otherImportExVatSekPerKWh: 0.06,
});
function fixture(saved = null) {
  const elements = new Map(),
    writes = [],
    timers = [],
    setCallbacks = [];
  let value = saved,
    failSet = false,
    failReadback = false,
    deferred = false,
    readCount = 0;
  const el = (id) => {
    if (!elements.has(id))
      elements.set(id, { value: '', checked: false, disabled: false, textContent: '' });
    return elements.get(id);
  };
  const Homey = {
    get: (_key, callback) => {
      readCount++;
      callback(readCount > 1 && failReadback ? Error('readback failed') : null, value);
    },
    set: (key, next, callback) => {
      writes.push({ key, next });
      if (deferred) {
        setCallbacks.push(() => {
          value = next;
          callback(null);
        });
        return;
      }
      if (failSet) {
        callback(Error('Write failed'));
        return;
      }
      value = next;
      callback(null);
    },
  };
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  const start = html.indexOf('      function bindCostSettings(Homey) {'),
    end = html.indexOf('      function onHomeyReady(Homey) {', start);
  vm.runInNewContext(html.slice(start, end) + '\nbindCostSettings(Homey);', {
    document: { getElementById: el },
    Homey,
    CostModel: model,
    Date,
    setTimeout: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (t) => {
      if (t) t.cancelled = true;
    },
  });
  const fill = () => {
    const c = contract();
    el('costSource').value = c.source;
    el('costCheckedOn').value = c.checkedOn;
    el('costImportPriceBasis').value = c.importPriceBasis;
    for (const [id, val] of Object.entries({
      costEnergyTax: c.energyTaxExVatSekPerKWh,
      costGridImport: c.gridImportExVatSekPerKWh,
      costOtherImport: c.otherImportExVatSekPerKWh,
      costExportBenefit: c.gridExportBenefitSekPerKWh,
      costExportFee: c.gridExportFeeSekPerKWh,
      costVatRate: c.vatRate,
      costBatteryWear: c.batteryWearSekPerKWh,
    }))
      el(id).value = String(val).replace('.', ',');
  };
  return {
    el,
    writes,
    timers,
    setCallbacks,
    fill,
    stored: () => value,
    failSet: () => {
      failSet = true;
    },
    failReadback: () => {
      failReadback = true;
    },
    defer: () => {
      deferred = true;
    },
  };
}
test('cost form reports the actual missing metadata/amount and accepts comma decimals with read-back confirmation', () => {
  const f = fixture();
  f.fill();
  f.el('costSource').value = '';
  f.el('saveCostContract').onclick();
  assert.match(f.el('costMessage').textContent, /Avtalskälla/);
  assert.equal(f.writes.length, 0);
  f.fill();
  f.el('costCheckedOn').value = '';
  f.el('saveCostContract').onclick();
  assert.match(f.el('costMessage').textContent, /Kontrollerat datum/);
  f.fill();
  f.el('costImportPriceBasis').value = '';
  f.el('saveCostContract').onclick();
  assert.match(f.el('costMessage').textContent, /Inköpsprisunderlag/);
  f.fill();
  f.el('costOtherImport').value = '';
  f.el('saveCostContract').onclick();
  assert.match(f.el('costMessage').textContent, /Övriga inköpstillägg/);
  f.fill();
  f.el('costGridImport').value = '1,2.3';
  f.el('saveCostContract').onclick();
  assert.match(f.el('costMessage').textContent, /Rörlig importnätavgift/);
  f.fill();
  f.el('costVatRate').oninput();
  assert.match(f.el('costFormula').textContent, /1,25 × \(spotpris \+ 0,46 kr\/kWh\)/);
  assert.match(f.el('costFormula').textContent, /utan nytt momspåslag/);
  f.el('saveCostContract').onclick();
  assert.deepEqual(f.stored(), model.validateCostContract(contract()));
  assert.match(f.el('costMessage').textContent, /sparat och återläst/);
  assert.equal(f.el('saveCostContract').disabled, false);
});
test('native date fallback and legacy load retain meanings without silently writing a migration', () => {
  const f = fixture(legacy());
  assert.equal(f.writes.length, 0);
  assert.equal(f.el('costImportPriceBasis').value, 'total-incl-vat');
  assert.equal(f.el('costOtherImport').value, 0);
  assert.deepEqual(f.stored(), legacy());
  f.el('costCheckedOn').value = '';
  f.el('costCheckedOn').valueAsDate = new Date('2026-06-10T00:00:00Z');
  f.el('saveCostContract').onclick();
  assert.equal(f.stored().checkedOn, '2026-06-10');
  assert.equal(f.stored().schema, 2);
  assert.equal(f.stored().otherImportExVatSekPerKWh, 0);
  const c = fixture(contract());
  assert.equal(c.el('costImportIncludesEnergyTax').disabled, true);
  c.el('costImportPriceBasis').value = 'total-incl-vat';
  c.el('costImportPriceBasis').onchange();
  assert.equal(c.el('costImportIncludesEnergyTax').disabled, false);
});
test('write failure, unverifiable readback and lost callbacks never claim a successful save or leave the button stuck', () => {
  const f = fixture(legacy());
  f.failSet();
  f.el('saveCostContract').onclick();
  assert.equal(f.el('costMessage').textContent, 'Write failed');
  assert.deepEqual(f.stored(), legacy());
  assert.equal(f.el('saveCostContract').disabled, false);
  const r = fixture();
  r.fill();
  r.failReadback();
  r.el('saveCostContract').onclick();
  assert.match(r.el('costMessage').textContent, /kunde inte bekräftas/);
  const slow = fixture();
  slow.fill();
  slow.defer();
  slow.el('saveCostContract').onclick();
  assert.equal(slow.el('saveCostContract').disabled, true);
  slow.timers.at(-1).callback();
  assert.equal(slow.el('saveCostContract').disabled, false);
  assert.match(slow.el('costMessage').textContent, /kan ha sparats/);
  slow.setCallbacks[0]();
  assert.match(slow.el('costMessage').textContent, /kan ha sparats/);
  const edited = fixture();
  edited.fill();
  edited.defer();
  edited.el('saveCostContract').onclick();
  edited.el('costOtherImport').value = '0.07';
  edited.el('costOtherImport').oninput();
  edited.setCallbacks[0]();
  assert.match(edited.el('costMessage').textContent, /senare ändringar/);
});
test('raw spot gets VAT once, billed totals stay inclusive and signed export never gets purchase VAT', () => {
  const c = model.validateCostContract(contract());
  const r = model.calculateMarginalPrices({
    spotImportExVatSekPerKWh: 1,
    tibberExportSekPerKWh: 0.4,
    settings: c,
  });
  assert.ok(Math.abs(r.importSekPerKWh - 1.825) < 1e-9);
  assert.ok(Math.abs(r.exportSekPerKWh - 0.44) < 1e-9);
  const negative = model.calculateMarginalPrices({
    spotImportExVatSekPerKWh: -1,
    tibberExportSekPerKWh: -0.4,
    settings: c,
  });
  assert.ok(Math.abs(negative.importSekPerKWh - -0.675) < 1e-9);
  assert.ok(Math.abs(negative.exportSekPerKWh - -0.36) < 1e-9);
  const inclusive = model.calculateMarginalPrices({
    tibberImportInclVatSekPerKWh: 1.25,
    tibberExportSekPerKWh: 0.4,
    settings: { ...c, importPriceBasis: 'total-incl-vat' },
  });
  assert.equal(inclusive.importSekPerKWh, r.importSekPerKWh);
  for (const patch of [
    { importPriceBasis: 'auto' },
    { otherImportExVatSekPerKWh: -1 },
    { importIncludesEnergyTax: true },
    { otherImportExVatSekPerKWh: undefined },
  ])
    assert.throws(() => model.validateCostContract({ ...contract(), ...patch }));
});
test('economic request version and price basis prevent raw spot being misread as VAT-inclusive input', () => {
  const t = Date.parse('2026-06-10T10:00Z');
  const series = {
    slots: [{ t, gridWh: 1000, importWh: 1000, exportWh: 0, coverageMs: 900000 }],
    dischargeKWh: 0,
    demandChargeSek: 0,
    initialStoredKWh: 5,
    finalStoredKWh: 5,
  };
  const input = {
    schema: 2,
    currency: 'SEK',
    importSource: 'Synthetic raw spot',
    exportSource: 'Synthetic payout',
    importIncludesEnergyTax: false,
    importPriceBasis: 'spot-ex-vat',
    prices: [{ t, end: t + 900000, importPriceSekPerKWh: 1, exportSekPerKWh: 0.4 }],
    baseline: series,
    scenario: series,
  };
  const r = compareEconomicScenarios(input, contract());
  assert.equal(r.status, 'provisional');
  assert.ok(Math.abs(r.baseline.importCostSek - 1.825) < 1e-9);
  assert.equal(r.provenance.exportVatApplication, 'as-supplied-no-added-vat');
  assert.equal(compareEconomicScenarios({ ...input, schema: 1 }, contract()).status, 'unavailable');
  assert.equal(
    compareEconomicScenarios({ ...input, importPriceBasis: 'total-incl-vat' }, contract()).status,
    'unavailable',
  );
  const old = {
    ...input,
    schema: 1,
    prices: [{ t, end: t + 900000, importInclVatSekPerKWh: 1.25, exportSekPerKWh: 0.4 }],
  };
  assert.equal(compareEconomicScenarios(old, legacy()).status, 'provisional');
});
