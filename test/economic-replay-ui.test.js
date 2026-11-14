'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs');
const {
  timelineStatus,
  publishContract,
  restoreTimeline,
} = require('../lib/pricing/contract-timeline');
const tick = () => new Promise((r) => setImmediate(r));
function view() {
  const elements = new Map(),
    timers = [],
    requests = [];
  const el = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: false,
        disabled: false,
        textContent: '',
        children: [],
        files: [],
        replaceChildren() {
          this.children = [];
        },
        appendChild(c) {
          this.children.push(c);
        },
        click() {},
      });
    return elements.get(id);
  };
  const data = {
    costContract: {
      schema: 2,
      currency: 'SEK',
      source: 'Synthetic <script> text',
      checkedOn: '2026-06-01',
      importPriceBasis: 'spot-ex-vat',
      importIncludesEnergyTax: false,
      energyTaxExVatSekPerKWh: 0.3,
      gridImportExVatSekPerKWh: 0.1,
      otherImportExVatSekPerKWh: 0,
      gridExportBenefitSekPerKWh: 0.05,
      gridExportFeeSekPerKWh: 0,
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
  const homey = {
    settings: {
      get: (k) => data[k],
      set: (k, v) => {
        data[k] = v;
      },
    },
  };
  let failure = null;
  const Homey = {
    get: (key, cb) =>
      key === 'chargingConfig'
        ? cb(null, {
            usableBatteryKWh: 10,
            chargingEfficiency: 0.9,
            maxChargingPowerKW: 3,
            minimumSoc: 30,
          })
        : cb(null, {
            batteryCapacityKWh: 10,
            initialSocPercent: 50,
            reserveMinPercent: 10,
            backupReservePercent: 15,
            maxChargeKW: 4,
            maxDischargeKW: 4,
            roundTripEfficiency: 0.81,
          }),
    api: (method, path, body, cb) => {
      if (failure) {
        cb(Error(failure));
        return;
      }
      try {
        if (path === '/economics/contracts/restore') cb(null, restoreTimeline(homey, body));
        else if (path === '/economics/contracts')
          cb(null, method === 'GET' ? timelineStatus(homey) : publishContract(homey, body));
        else requests.push({ body, cb, path });
      } catch (e) {
        cb(e);
      }
    },
  };
  const context = {
    Homey,
    document: {
      getElementById: (id) => el(id),
      createElement: () => ({
        textContent: '',
        children: [],
        appendChild(c) {
          this.children.push(c);
        },
        click() {},
      }),
    },
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    Blob,
  };
  vm.runInNewContext(
    fs.readFileSync('settings/economic-replay.js', 'utf8') +
      '\nEconomicReplaySettings.bind(Homey);',
    context,
  );
  const field = (id) => el('econ-' + id);
  field('hours').value = '4';
  field('caps').value = '2;3';
  return {
    field,
    requests,
    timers,
    data,
    setFailure: (v) => {
      failure = v;
    },
  };
}
function result() {
  const money = {
    importKWh: 1,
    exportKWh: 0,
    importCostSek: 1.5,
    exportRevenueSek: 0,
    energySek: 1.5,
    wearSek: 0.1,
    demand: {
      status: 'provisional',
      totalSek: 40,
      months: [
        { month: '2026-06', coverage: { completeHours: 4, missingHours: 8, pendingHours: 10 } },
      ],
    },
  };
  return {
    status: 'indicative',
    from: 0,
    to: 14400000,
    contractVersions: ['synthetic'],
    candidates: [
      {
        capKW: 2,
        chargedKWh: 1,
        dischargedKWh: 0.8,
        lossesKWh: 0.2,
        initialStoredKWh: 5,
        finalStoredKWh: 5,
        uncoveredKWh: 0,
        baseline: money,
        scenario: money,
        indicativeNetDifferenceSek: 2,
      },
    ],
  };
}
test('dated UI publishes only explicit dates and saved snapshots, safely renders source text and supports export/restore', async () => {
  const v = view();
  await tick();
  assert.equal(v.field('publish').disabled, false);
  assert.equal(v.field('from').value, '');
  await v.field('publish').onclick();
  assert.match(v.field('contract-message').textContent, /Bekräfta/);
  v.field('from').value = '2026-06-01';
  v.field('date-confirm').checked = true;
  v.field('components-confirm').checked = true;
  v.field('network').checked = true;
  await v.field('publish').onclick();
  assert.equal(v.data.costContractTimeline.entries.length, 1);
  assert.match(v.field('contracts').children[0].textContent, /<script>/);
  await v.field('export').onclick();
  v.field('import-confirm').checked = true;
  v.field('import-file').files = [
    { size: 1024, text: async () => JSON.stringify(v.data.costContractTimeline) },
  ];
  await v.field('import').onclick();
  assert.equal(v.data.costContractTimeline.entries.length, 1);
  v.field('import-file').files = [{ size: 300000 }];
  await v.field('import').onclick();
  assert.match(v.field('contract-message').textContent, /256 KiB/);
});
test('comparison UI prefills only saved assumptions, handles comma decimals and shows component costs', async () => {
  const v = view();
  await tick();
  assert.equal(v.field('capacity').value, '10');
  assert.equal(v.field('reserve').value, '1.5');
  v.field('charge-eta').value = '0,9';
  v.field('model-confirm').checked = true;
  const pending = v.field('run').onclick();
  assert.equal(v.requests[0].body.battery.chargeEfficiency, 0.9);
  assert.deepEqual(Array.from(v.requests[0].body.capsKW), [2, 3]);
  v.requests[0].cb(null, result());
  await pending;
  assert.match(v.field('result').textContent, /ingen ekonomisk rangordning/);
  assert.equal(v.field('results').children.length, 1);
  assert.ok(
    v
      .field('results')
      .children[0].children.some((c) => c.textContent.includes('Indikativ kostnadsskillnad')),
  );
});
test('edits invalidate pending results and gaps/unrestored energy never leave an old saving', async () => {
  const v = view();
  await tick();
  let p = v.field('run').onclick();
  v.field('initial').oninput();
  v.requests[0].cb(null, result());
  await p;
  assert.equal(v.field('results').children.length, 0);
  p = v.field('run').onclick();
  v.requests[1].cb(null, {
    status: 'unavailable',
    reason: 'incomplete-comparison-window',
    missing: {
      energyQuarters: 1,
      batteryCoverageQuarters: 4,
      contractQuarters: 0,
      purchasePriceQuarters: 0,
      productionPriceQuarters: 0,
    },
  });
  await p;
  assert.match(v.field('result').textContent, /batteritäckning 4/);
  p = v.field('run').onclick();
  const r = result();
  r.candidates[0].indicativeNetDifferenceSek = null;
  r.candidates[0].reason = 'terminal-energy-not-restored';
  v.requests[2].cb(null, r);
  await p;
  assert.ok(
    v
      .field('results')
      .children[0].children.some((c) => c.textContent.includes('slutenergi matchar inte')),
  );
});
test('failed API, malformed inputs and missing callbacks cannot leave controls stuck or stale money visible', async () => {
  const v = view();
  await tick();
  v.field('caps').value = '2;';
  await v.field('run').onclick();
  assert.equal(v.requests.length, 0);
  assert.equal(v.field('run').disabled, false);
  v.field('caps').value = '2';
  v.setFailure('offline');
  await v.field('run').onclick();
  assert.equal(v.field('results').children.length, 0);
  assert.equal(v.field('run').disabled, false);
  v.setFailure(null);
  const p = v.field('run').onclick();
  v.timers.at(-1)();
  await p;
  assert.match(v.field('result').textContent, /Svar saknas/);
  assert.equal(v.field('run').disabled, false);
});

test('malformed comparison response cannot render NaN or stale cost cards', async () => {
  const v = view();
  await tick();
  const p = v.field('run').onclick();
  v.requests[0].cb(null, { from: 0, to: 1, contractVersions: [], candidates: [{ capKW: 2 }] });
  await p;
  assert.match(v.field('result').textContent, /Ogiltigt beräkningssvar/);
  assert.equal(v.field('results').children.length, 0);
});

function enableSolar(v) {
  v.field('solar-enabled').checked = true;
  v.field('solar-enabled').onchange();
  for (const [id, value] of Object.entries({
    hours: '12',
    caps: '5',
    'solar-target': '10',
    'ev-initial': '20',
    'ev-target': '40',
    'ev-min': '1,4',
    'ev-max': '3',
    'ev-arrival': '0',
    'ev-departure': '12',
  }))
    v.field(id).value = value;
  v.field('ev-history-confirm').checked = true;
  v.field('ev-absent-confirm').checked = true;
}
function coupledResult() {
  const r = result();
  r.mode = 'coupled-solar-ev';
  r.evAssumptions = { capacityKWh: 10, efficiency: 0.9, minPowerKW: 1.4, maxPowerKW: 3 };
  r.candidates = Array.from({ length: 2 }, (_, i) => ({
    ...structuredClone(r.candidates[0]),
    capKW: 5,
    strategy: i ? 'ev-first' : 'home-first',
    ev: {
      targetStoredKWh: 4,
      finalStoredKWh: 4,
      inputKWh: 2.22,
      lossesKWh: 0.22,
      unmetKWh: 0,
      deadlineHours: 12,
    },
    solar: {
      generationKWh: 4,
      toHouseKWh: 1,
      toEvKWh: 1,
      toHomeKWh: 1,
      exportKWh: 1,
      evNonSolarKWh: 1.22,
    },
  }));
  return r;
}
test('coupled UI posts explicit historical EV assumptions and displays both strategies and solar allocation', async () => {
  const v = view();
  await tick();
  enableSolar(v);
  assert.equal(v.field('solar-fields').disabled, false);
  assert.match(v.field('ev-config').textContent, /10 kWh/);
  const p = v.field('run').onclick();
  assert.equal(v.requests[0].path, '/economics/solar-ev-replay');
  assert.equal(v.requests[0].body.ev.minPowerKW, 1.4);
  assert.equal(v.requests[0].body.ev.confirmNoExistingEvCharging, true);
  v.requests[0].cb(null, coupledResult());
  await p;
  assert.equal(v.field('results').children.length, 2);
  assert.match(v.field('results').children[0].children[0].textContent, /Batteri först/);
  assert.match(v.field('results').children[1].children[0].textContent, /Bil först/);
  assert.ok(
    v
      .field('results')
      .children[0].children.some((c) => c.textContent.includes('Vald solproduktion')),
  );
  v.field('solar-enabled').checked = false;
  v.field('solar-enabled').onchange();
  assert.equal(v.field('solar-fields').disabled, true);
  assert.equal(v.field('results').children.length, 0);
});
test('coupled UI withholds truncated strategies, missing solar values and unachieved EV goals', async () => {
  const v = view();
  await tick();
  enableSolar(v);
  let p = v.field('run').onclick();
  let r = coupledResult();
  r.candidates.pop();
  v.requests[0].cb(null, r);
  await p;
  assert.match(v.field('result').textContent, /Ogiltigt sol\/bil/);
  assert.equal(v.field('results').children.length, 0);
  p = v.field('run').onclick();
  r = coupledResult();
  delete r.candidates[0].solar.generationKWh;
  v.requests[1].cb(null, r);
  await p;
  assert.match(v.field('result').textContent, /Ogiltigt sol\/bil/);
  p = v.field('run').onclick();
  r = coupledResult();
  for (const c of r.candidates) {
    c.indicativeNetDifferenceSek = null;
    c.reason = 'ev-deadline-unmet';
    c.ev.unmetKWh = 2;
  }
  v.requests[2].cb(null, r);
  await p;
  assert.ok(
    v
      .field('results')
      .children[0].children.some((c) => c.textContent.includes('laddmål kunde inte nås')),
  );
});
test('coupled missing-data details show independent solar and existing EV-load exclusions', async () => {
  const v = view();
  await tick();
  enableSolar(v);
  const p = v.field('run').onclick();
  v.requests[0].cb(null, {
    status: 'unavailable',
    reason: 'incomplete-solar-ev-window',
    missing: { solarCoverageQuarters: 4, knownEvChargingQuarters: 2 },
  });
  await p;
  assert.match(v.field('result').textContent, /soltäckning 4/);
  assert.match(v.field('result').textContent, /befintlig billaddning 2/);
});
