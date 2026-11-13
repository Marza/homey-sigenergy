'use strict';
const { attachWidgetApi } = require('./widget-helper');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { tariffKey } = require('../lib/tariff-config');
const { activeAt } = require('../lib/demand-tariff');
const base = () => ({
  start: '07:00',
  end: '20:00',
  weekdays: [1, 2, 3, 4, 5],
  months: [11, 12, 1, 2, 3],
  peakCount: 3,
  rateSekPerKw: 100,
  distinctDays: true,
});
function view(file, initial = {}) {
  const elements = new Map(),
    values = { ...initial },
    writes = [],
    timers = [],
    failedReads = new Set();
  let failWrite = false;
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-11-12T12:00:00Z']));
    }
    static now() {
      return Date.parse('2026-11-12T12:00:00Z');
    }
  }
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        innerHTML: '',
        value: '',
        checked: false,
        disabled: false,
        children: [],
        replaceChildren() {
          this.children = [];
        },
        appendChild(child) {
          this.children.push(child);
        },
      });
    return elements.get(id);
  };
  const document = {
    querySelectorAll: () => [],
    getElementById: element,
    createElement: () => ({ textContent: '' }),
  };
  const Homey = {
    get(key, callback) {
      callback(failedReads.has(key) ? new Error('Read failed') : null, values[key]);
    },
    set(key, value, callback) {
      writes.push({ key, value });
      if (failWrite) callback(new Error('Write failed'));
      else {
        values[key] = JSON.parse(JSON.stringify(value));
        callback(null);
      }
    },
    ready() {},
  };
  const context = vm.createContext({
    Homey,
    document,
    Date: Clock,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (callback) => timers.push(callback),
  });
  if (file.startsWith('widgets/')) attachWidgetApi(Homey, Clock);
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g))
    if (!match[1].startsWith('/'))
      vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', path.dirname(file), match[1]), 'utf8'),
        context,
      );
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .join('\n');
  vm.runInContext(script, context);
  const run = (code) => vm.runInContext(code, context);
  return {
    values,
    writes,
    failedReads,
    element,
    run,
    failWrites() {
      failWrite = true;
    },
    refresh() {
      timers[0]();
    },
  };
}
const settings = (initial) => view('settings/index.html', initial);
test('editing an existing winter tariff preserves active months and distinction from verified rules', () => {
  const original = base(),
    v = settings({ demandTariff: original });
  v.run('bindTariffSettings(Homey)');
  assert.equal(v.element('tariffAllYear').checked, false);
  for (const month of [1, 2, 3, 11, 12])
    assert.equal(v.element('tariffMonth' + month).checked, true);
  v.element('tariffRate').value = '120';
  v.element('saveTariff').onclick();
  assert.deepEqual(v.values.demandTariff.months, [1, 2, 3, 11, 12]);
  assert.equal(v.values.demandTariff.rateSekPerKw, 120);
  assert.equal(activeAt(Date.parse('2026-06-12T09:00:00Z'), v.values.demandTariff), false);
  assert.equal(activeAt(Date.parse('2026-11-12T09:00:00Z'), v.values.demandTariff), true);
  assert.match(v.element('tariffConfigStatus').textContent, /Ej verifierad/);
  assert.deepEqual(original.months, [11, 12, 1, 2, 3]);
});
test('all-year choice is explicit and existing all-year tariffs survive round trips', () => {
  const v = settings({ demandTariff: base() });
  v.run('bindTariffSettings(Homey)');
  v.element('tariffAllYear').checked = true;
  v.element('tariffAllYear').onchange();
  assert.equal(v.element('tariffMonth11').disabled, true);
  v.element('tariffAllYear').checked = false;
  v.element('tariffAllYear').onchange();
  assert.equal(v.element('tariffMonth11').checked, true);
  assert.equal(v.element('tariffMonth11').disabled, false);
  v.element('tariffAllYear').checked = true;
  v.element('saveTariff').onclick();
  assert.equal(v.values.demandTariff.months, undefined);
  const loaded = settings({ demandTariff: v.values.demandTariff });
  loaded.run('bindTariffSettings(Homey)');
  assert.equal(loaded.element('tariffAllYear').checked, true);
  loaded.element('saveTariff').onclick();
  assert.equal(loaded.values.demandTariff.months, undefined);
});
test('empty form has no contract defaults, and invalid edits never replace a saved tariff', () => {
  const empty = settings();
  empty.run('bindTariffSettings(Homey)');
  empty.element('saveTariff').onclick();
  assert.equal(empty.writes.length, 0);
  assert.match(empty.element('tariffConfigStatus').textContent, /Ingen tariff/);
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  for (const id of ['tariffStart', 'tariffEnd', 'tariffWeekdays', 'tariffPeakCount', 'tariffRate'])
    assert.doesNotMatch(html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))[0], /\bvalue=/);
  for (const [id, value] of [
    ['tariffStart', '07:30'],
    ['tariffEnd', '06:00'],
    ['tariffWeekdays', '1,1'],
    ['tariffPeakCount', '2.5'],
    ['tariffRate', ''],
    ['tariffDistinctDays', ''],
  ]) {
    const v = settings({ demandTariff: base() });
    v.run('bindTariffSettings(Homey)');
    v.element(id).value = value;
    v.element('saveTariff').onclick();
    assert.equal(v.writes.length, 0, id);
    assert.match(v.element('tariffMessage').textContent, /.+/);
  }
});
test('load/save errors and invalid persisted tariffs remain visible', () => {
  const bad = settings({ demandTariff: { ...base(), months: [] } });
  bad.run('bindTariffSettings(Homey)');
  assert.match(bad.element('tariffConfigStatus').textContent, /Ogiltig/);
  bad.element('saveTariff').onclick();
  assert.equal(bad.writes.length, 0);
  const read = settings();
  read.failedReads.add('demandTariff');
  read.run('bindTariffSettings(Homey)');
  read.element('saveTariff').onclick();
  assert.equal(read.element('saveTariff').disabled, true);
  assert.equal(read.writes.length, 0);
  read.run('loadOverview(Homey)');
  assert.match(read.element('tariffStatus').textContent, /kunde inte läsas/);
  const write = settings({ demandTariff: base() });
  write.run('bindTariffSettings(Homey)');
  write.element('tariffRate').value = '200';
  write.failWrites();
  write.element('saveTariff').onclick();
  assert.equal(write.values.demandTariff.rateSekPerKw, 100);
  assert.equal(write.element('tariffMessage').textContent, 'Write failed');
});
function estimate(tariff, month = '2026-11') {
  return {
    status: 'provisional',
    month,
    tariffKey: tariffKey(tariff),
    averageKw: 4,
    estimatedSek: 400,
  };
}
for (const count of [3, 5])
  test(`widget labels and estimates follow ${count} configured peaks`, () => {
    const tariff = { ...base(), peakCount: count },
      result = estimate(tariff),
      v = view('widgets/energy-overview/public/index.html', {
        demandTariff: tariff,
        demandEstimate: result,
        tariffOptimization: {
          status: 'provisional',
          baseline: result,
          best: { simulatedDemandSek: 300, demandSavingSek: 100 },
        },
      });
    v.run('onHomeyReady(Homey)');
    assert.equal(v.element('demandPeakLabel').textContent, `Medel av ${count} timtoppar`);
    assert.equal(v.element('demandKw').textContent, '4 kW');
    assert.equal(v.element('simSaving').textContent, '100 kr');
    v.values.demandTariff = { ...tariff, peakCount: count === 3 ? 5 : 3 };
    v.refresh();
    assert.equal(v.element('demandKw').textContent, '–');
    assert.equal(v.element('simSaving').textContent, '–');
    assert.match(v.element('demandState').textContent, /Inväntar/);
  });
test('widget clears missing/invalid/read-error/off-season and old-month estimates', () => {
  const tariff = base(),
    result = estimate(tariff),
    v = view('widgets/energy-overview/public/index.html', {
      demandTariff: tariff,
      demandEstimate: result,
    });
  v.run('onHomeyReady(Homey)');
  assert.equal(v.element('demandKw').textContent, '4 kW');
  v.values.demandEstimate = estimate(tariff, '2026-10');
  v.refresh();
  assert.equal(v.element('demandKw').textContent, '–');
  v.values.demandTariff = { ...tariff, months: [6] };
  v.refresh();
  assert.match(v.element('demandState').textContent, /gäller inte/);
  v.values.demandTariff = { ...tariff, peakCount: 0 };
  v.refresh();
  assert.match(v.element('demandState').textContent, /Ogiltig/);
  assert.equal(v.element('demandPeakLabel').textContent, 'Medel av timtoppar');
  v.values.demandTariff = null;
  v.refresh();
  assert.match(v.element('demandState').textContent, /Konfigurera/);
  v.values.demandTariff = tariff;
  v.failedReads.add('demandTariff');
  v.refresh();
  assert.match(v.element('demandState').textContent, /kunde inte läsas/);
  assert.equal(v.element('demandPeakLabel').textContent, 'Medel av timtoppar');
});

test('Telge holiday calendar survives settings edits and invalidates old widget results', () => {
  const tariff = { ...base(), calendar: 'se-telge' };
  const v = settings({ demandTariff: tariff });
  v.run('bindTariffSettings(Homey)');
  assert.equal(v.element('tariffCalendar').value, 'se-telge');
  v.element('saveTariff').onclick();
  assert.equal(v.values.demandTariff.calendar, 'se-telge');
  assert.match(v.element('tariffConfigStatus').textContent, /Telges helgdagsundantag/);
  const result = {
    ...estimate(tariff),
    coverage: { expectedHours: 260, completeHours: 5, missingHours: 100, pendingHours: 155 },
  };
  const widget = view('widgets/energy-overview/public/index.html', {
    demandTariff: tariff,
    demandEstimate: result,
    tariffOptimization: {
      status: 'provisional',
      baseline: result,
      best: { simulatedDemandSek: 100, demandSavingSek: 20 },
    },
  });
  widget.run('onHomeyReady(Homey)');
  assert.match(
    widget.element('demandState').textContent,
    /5\/260 mättimmar.*100 saknade.*155 återstående/,
  );
  assert.match(widget.element('savingState').textContent, /observerade timmar.*100 saknade/);
  widget.values.demandTariff = base();
  widget.refresh();
  assert.equal(widget.element('demandKw').textContent, '–');
  assert.equal(widget.element('simSaving').textContent, '–');
});

test('meter-import reference remains separate and hides after binding changes', () => {
  const tariff = base(),
    r = estimate(tariff),
    v = view('widgets/energy-overview/public/index.html', {
      sourceConfig: { tibber: { revision: 'r' } },
      tibberConsumptionHistory: { configRevision: 'r' },
      meterDemandEstimate: { ...r, averageKw: 7, estimatedSek: 700 },
      demandTariff: tariff,
      demandEstimate: r,
    });
  v.run('onHomeyReady(Homey)');
  assert.equal(v.element('meterKw').textContent, '7 kW');
  assert.equal(v.element('demandKw').textContent, '4 kW');
  v.values.sourceConfig.tibber.revision = 'changed';
  v.refresh();
  assert.equal(v.element('meterKw').textContent, '–');
});

const costContract = () => ({
  schema: 1,
  currency: 'SEK',
  source: 'Synthetic contract',
  checkedOn: '2026-11-13',
  importIncludesEnergyTax: true,
  energyTaxExVatSekPerKWh: 0,
  gridImportExVatSekPerKWh: 0.2,
  gridExportBenefitSekPerKWh: 0.05,
  gridExportFeeSekPerKWh: 0,
  vatRate: 0.25,
  batteryWearSekPerKWh: 0.1,
});
test('cost form preserves explicit contract values and validates blanks/tax basis before saving', () => {
  const v = settings({ costContract: costContract() });
  v.run('bindCostSettings(Homey)');
  assert.equal(v.element('costImportIncludesEnergyTax').checked, true);
  assert.equal(v.element('costVatRate').value, 0.25);
  v.element('saveCostContract').onclick();
  assert.deepEqual(v.values.costContract, costContract());
  assert.match(v.element('costMessage').textContent, /Ingen styrning/);
  const before = v.writes.length;
  v.element('costVatRate').value = '';
  v.element('saveCostContract').onclick();
  assert.equal(v.writes.length, before);
  assert.match(v.element('costMessage').textContent, /Fyll i/);
  v.element('costVatRate').value = '0.25';
  v.element('costEnergyTax').value = '0.4';
  v.element('saveCostContract').onclick();
  assert.equal(v.writes.length, before);
  assert.match(v.element('costMessage').textContent, /ingår redan/);
});
test('cost form handles absent/invalid data and read/write failures without replacing a contract', () => {
  const empty = settings();
  empty.run('bindCostSettings(Homey)');
  empty.element('saveCostContract').onclick();
  assert.equal(empty.writes.length, 0);
  const read = settings();
  read.failedReads.add('costContract');
  read.run('bindCostSettings(Homey)');
  assert.equal(read.element('saveCostContract').disabled, true);
  read.element('saveCostContract').onclick();
  assert.equal(read.writes.length, 0);
  const invalid = settings({ costContract: {} });
  invalid.run('bindCostSettings(Homey)');
  assert.match(invalid.element('costMessage').textContent, /Ogiltigt/);
  const write = settings({ costContract: costContract() });
  write.run('bindCostSettings(Homey)');
  write.failWrites();
  write.element('costVatRate').value = '0.2';
  write.element('saveCostContract').onclick();
  assert.equal(write.values.costContract.vatRate, 0.25);
  assert.equal(write.element('costMessage').textContent, 'Write failed');
});
