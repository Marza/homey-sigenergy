'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const S = require('../lib/optimization/simulator');
const A = require('../lib/optimization/advanced-simulator');
const { recommend } = require('../lib/optimization/recommendation');
const { evaluateTariffScenarios } = require('../lib/optimization/tariff-optimizer');
const config = {
  minCapKW: 2,
  maxCapKW: 3,
  capStepKW: 0.5,
  reserveMinPercent: 20,
  reserveMaxPercent: 30,
  reserveStepPercent: 10,
  batteryCapacityKWh: 10,
  initialSocPercent: 60,
};
const rows = (n = 8) =>
  Array.from({ length: n }, (_, i) => ({
    t: Date.parse('2026-03-29T00:00Z') + i * 900000,
    gridWh: 1000,
    essWh: 0,
    coverageMs: 900000,
  }));
const plain = (x) => JSON.parse(JSON.stringify(x));
function browser(initial = {}) {
  const elements = new Map(),
    values = { optimizerConfig: S.validateOptimizer(config), autoBatteryValues: false, ...initial },
    failures = new Set(),
    writes = [];
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        value: '',
        checked: false,
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
  const Homey = {
    get(key, cb) {
      cb(failures.has(key) ? new Error('Read failed') : null, values[key]);
    },
    set(key, value, cb) {
      writes.push(key);
      values[key] = value;
      cb(null);
    },
    ready() {},
  };
  const context = vm.createContext({
    Homey,
    document: {
      querySelectorAll: () => [],
      getElementById: element,
      createElement: () => ({
        children: [],
        appendChild(c) {
          this.children.push(c);
        },
      }),
    },
    setInterval() {},
  });
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g))
    if (!match[1].startsWith('/'))
      vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../settings', match[1]), 'utf8'),
        context,
      );
  vm.runInContext(
    [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'),
    context,
  );
  // Match the DOM's string coercion when the settings loader assigns numbers.
  const run = (code) => vm.runInContext(code, context);
  return { context, run, element, values, failures, writes };
}
test('browser and Node use byte-identical core and identical replay calculations', () => {
  assert.equal(
    fs.readFileSync(path.join(__dirname, '../settings/simulator.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../lib/optimization/simulator.js'), 'utf8'),
  );
  const b = browser();
  b.context.input = rows().reverse();
  b.context.suppliedConfig = config;
  assert.deepEqual(
    plain(b.run('Simulator.simulate(input,suppliedConfig)')),
    plain(S.simulate(rows().reverse(), config)),
  );
  const noRecharge = S.simulate(rows(), config),
    advanced = A.compareScenarios(rows(), config);
  assert.deepEqual(plain(noRecharge.candidates), plain(advanced.candidates));
  assert.equal(noRecharge.assumptions.surplusSupplied, false);
  assert.equal(noRecharge.assumptions.pricesSupplied, false);
  assert.equal(noRecharge.candidates[0].simulatedSlots, undefined); // bounded summaries, not 1000 copies of history
});
test('scenario ranges are bounded in all entry points, with no silent truncation', () => {
  for (const patch of [
    { capStepKW: 1e-300 },
    { reserveStepPercent: 0.0001 },
    {
      minCapKW: 0.5,
      maxCapKW: 20,
      capStepKW: 0.1,
      reserveMinPercent: 0,
      reserveMaxPercent: 100,
      reserveStepPercent: 1,
    },
  ]) {
    for (const call of [
      (c) => S.simulate([], c),
      (c) => A.compareScenarios([], c),
      (c) => recommend([], c),
      (c) =>
        evaluateTariffScenarios(
          [],
          c,
          {
            start: '07:00',
            end: '20:00',
            weekdays: [1],
            peakCount: 1,
            distinctDays: true,
            rateSekPerKw: 1,
          },
          '2026-01',
        ),
    ])
      assert.throws(() => call({ ...config, ...patch }), /range|scenarios/);
  }
  assert.throws(() => S.simulate(Array(3073).fill({}), config), /3072/);
  assert.throws(() => S.simulate(null, config), /3072/);
  assert.throws(() => S.replay(rows(), config, NaN, 20), /scenario/);
  assert.throws(
    () => A.replayWithRecharge(rows(), config, { capKW: 2, reservePercent: 101 }),
    /scenario/,
  );
});
test('coverage counts absent quarters, rejects duplicate/unaligned/invalid records and requires eight valid slots', () => {
  const sparse = rows();
  sparse[7] = { ...sparse[7], t: sparse[7].t + 86400000 };
  const r = S.simulate(sparse, config);
  assert.equal(r.status, 'insufficient-data');
  assert.equal(r.bestIllustrative, null);
  assert.equal(r.coverage.missingSlots, 96);
  const duplicate = rows();
  duplicate.push({ ...duplicate[0] });
  assert.equal(S.prepareHistory(duplicate).coverage.validSlots, 7);
  assert.equal(
    S.prepareHistory([
      null,
      { t: 1, gridWh: 0, essWh: 0, coverageMs: 900000 },
      { ...rows()[0], coverageMs: 900001 },
    ]).coverage.validSlots,
    0,
  );
  assert.equal(S.simulate(rows(7), config).status, 'insufficient-data');
  assert.equal(S.simulate(rows(), config).status, 'illustrative');
  assert.equal(recommend(rows(7), config).status, 'insufficient-data');
  assert.equal(S.simulate(rows(), config).coverage.expectedSlots, 8); // real quarter timestamps across DST
});
test('reserve above initial SoC does not invent charge, and recharge requires explicit valid surplus', () => {
  const c = { ...config, initialSocPercent: 10 };
  const a = S.replay(rows(), c, 2, 30),
    b = A.replayWithRecharge(rows(), c, { capKW: 2, reservePercent: 30 });
  assert.equal(a.remainingSocPercent, 10);
  assert.equal(a.dischargeKWh, 0);
  assert.deepEqual(a, b);
  const input = rows();
  input.forEach((s) => (s.pvWh = 999999));
  assert.equal(A.replayWithRecharge(input, c, { capKW: 2, reservePercent: 30 }).rechargeKWh, 0);
  const recharge = A.replayWithRecharge(input, c, {
    capKW: 2,
    reservePercent: 30,
    surplusKWh: { [input[0].t]: 1 },
  });
  assert.equal(recharge.rechargeKWh, 1);
  assert.ok(recharge.remainingSocPercent > 10);
  for (const options of [
    { surplusKWh: { 0: -1 } },
    { surplusKWh: [] },
    { pricesSekPerKWh: { 1: 2 } },
    { pricesSekPerKWh: { 0: NaN } },
  ])
    assert.throws(() => A.compareScenarios(rows(), config, options), /Invalid/);
  assert.equal(
    A.replayWithRecharge([], config, { capKW: 2, reservePercent: 20, pricesSekPerKWh: {} })
      .pricedImportSek,
    null,
  );
});
test('fresh BMS constraints and stale/error fallbacks match browser and runtime', () => {
  const b = browser();
  b.context.suppliedConfig = config;
  b.context.telemetry = {
    values: {
      soc: 50,
      capacityKWh: 12,
      dischargePowerLimitKW: 1,
      chargePowerLimitKW: 2,
      dischargeCutoffSoc: 35,
    },
    errors: {},
  };
  for (const status of [{ usable: true }, { usable: false }]) {
    b.context.status = status;
    const options = { autoBatteryValues: true, status };
    const expected = S.effectiveBatteryConfig(config, b.context.telemetry, options);
    assert.deepEqual(
      plain(
        b.run(
          'Simulator.effectiveBatteryConfig(suppliedConfig,telemetry,{autoBatteryValues:true,status})',
        ),
      ),
      plain(expected),
    );
    if (status.usable) {
      assert.equal(expected.maxDischargeKW, 1);
      assert.equal(expected.maxChargeKW, 2);
      assert.equal(expected.backupReservePercent, 35);
    } else assert.equal(expected.initialSocPercent, 60);
  }
});
test('settings renders shared results and clears them on insufficient history, bad config and read errors', () => {
  const b = browser({
    historyState: { schema: 3, slots: rows(), daily: [], events: [], legacyDaily: [] },
  });
  b.run('runSimulation(Homey)');
  assert.equal(b.element('simulationRows').children.length, 6);
  assert.match(
    b.element('simulationStatus').textContent,
    /conservative-no-recharge.*Start-SoC 60.*Ingen uppladdning eller priser/,
  );
  b.values.historyState.slots = rows(2);
  b.run('runSimulation(Homey)');
  assert.equal(b.element('simulationRows').children.length, 0);
  assert.match(b.element('simulationStatus').textContent, /Otillräckligt/);
  b.values.historyState.slots = rows();
  b.values.optimizerConfig = { ...config, capStepKW: 1e-300 };
  b.run('runSimulation(Homey)');
  assert.equal(b.element('simulationRows').children.length, 0);
  assert.match(b.element('simulationStatus').textContent, /range/);
  b.values.optimizerConfig = config;
  b.failures.add('autoBatteryValues');
  b.run('runSimulation(Homey)');
  assert.match(b.element('simulationStatus').textContent, /kunde inte läsas/);
  b.failures.clear();
  b.failures.add('historyState');
  b.run('runSimulation(Homey)');
  assert.match(b.element('simulationStatus').textContent, /Read failed/);
  assert.deepEqual(b.writes, []);
});
test('settings rejects unsafe scenario ranges before saving configuration', () => {
  const b = browser();
  b.run('TibberDataSettings.bind = () => {}; onHomeyReady(Homey)');
  for (const key of Object.keys(S.DEFAULT_OPTIMIZER))
    b.element(key).value = String(b.element(key).value);
  b.element('capStepKW').value = '0.0000001';
  b.element('saveOptimizer').onclick();
  assert.match(b.element('optimizerMessage').textContent, /range/);
  assert.deepEqual(b.writes, []);
});

test('invalid config shapes and failed BMS fields cannot replace manual assumptions', () => {
  for (const input of [false, 'config', []])
    assert.throws(() => S.validateOptimizer(input), /configuration/);
  const c = S.effectiveBatteryConfig(
    config,
    { values: { soc: 80, capacityKWh: 12 } },
    { autoBatteryValues: true, status: { usable: true, fieldErrors: { soc: 'unavailable' } } },
  );
  assert.equal(c.initialSocPercent, 60);
  assert.equal(c.batteryCapacityKWh, 12);
});
