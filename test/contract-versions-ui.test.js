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
    fs.readFileSync('settings/contract-versions.js', 'utf8') + '\nContractVersions.bind(Homey);',
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
test('stale saved terms require visible reload and renewed confirmation before publication', async () => {
  const v = view();
  await tick();
  v.field('from').value = '2026-06-01';
  v.field('network').checked = true;
  v.field('date-confirm').checked = true;
  v.field('components-confirm').checked = true;
  v.data.costContract.gridImportExVatSekPerKWh = 0.2;
  await v.field('publish').onclick();
  assert.equal(v.data.costContractTimeline, undefined);
  assert.match(v.field('contract-message').textContent, /Ingen ny kostnadsversion sparades/);
  assert.match(v.field('contract-message').textContent, /Läs om sparade villkor och versioner/);
  assert.equal(v.field('publish').disabled, true);
  assert.equal(v.field('date-confirm').checked, false);
  assert.equal(v.field('components-confirm').checked, false);
  await v.field('refresh').onclick();
  assert.equal(v.field('from').value, '2026-06-01');
  assert.equal(v.field('network').checked, true);
  assert.equal(v.data.costContractTimeline, undefined, 'reload must never publish');
  assert.match(v.field('refresh-message').textContent, /har lästs in/);
  assert.match(v.field('refresh-message').textContent, /publicerade kostnadsversioner: 0/);
  assert.match(v.field('refresh-message').textContent, /tryck Publicera/);
  await v.field('publish').onclick();
  assert.match(v.field('contract-message').textContent, /Bekräfta/);
  assert.equal(v.data.costContractTimeline, undefined);
  v.field('date-confirm').checked = true;
  v.field('components-confirm').checked = true;
  await v.field('publish').onclick();
  assert.equal(v.data.costContractTimeline.entries.length, 1);
  assert.match(v.field('refresh-message').textContent, /publicerade kostnadsversioner: 1/);
  const entry = v.data.costContractTimeline.entries[0];
  assert.equal(entry.from, '2026-06-01');
  assert.equal(entry.contract.gridImportExVatSekPerKWh, 0.2);
});
test('reload of changed saved terms or versions clears old attestations and results', async () => {
  for (const change of ['draft', 'timeline']) {
    const v = view();
    await tick();
    v.field('date-confirm').checked = true;
    v.field('components-confirm').checked = true;
    if (change === 'draft') v.data.demandTariff.rateSekPerKw = 45;
    else {
      const homey = { settings: { get: (k) => v.data[k], set: (k, x) => (v.data[k] = x) } };
      publishContract(homey, {
        ...timelineStatus(homey),
        expectedRevision: timelineStatus(homey).revision,
        from: '2026-06-01',
        confirmEffectiveDate: true,
        confirmTradeComponents: true,
        includeNetwork: false,
      });
    }
    await v.field('refresh').onclick();
    assert.equal(v.field('date-confirm').checked, false);
    assert.equal(v.field('components-confirm').checked, false);
    assert.equal(v.field('publish').disabled, false);
  }
});
test('failed reload disables version actions until a successful read', async () => {
  const v = view();
  await tick();
  v.field('date-confirm').checked = true;
  v.setFailure('offline');
  await v.field('refresh').onclick();
  assert.match(v.field('contract-message').textContent, /offline/);
  assert.match(v.field('refresh-message').textContent, /Omläsningen misslyckades: offline/);
  for (const id of ['publish', 'export', 'import']) assert.equal(v.field(id).disabled, true);
  assert.equal(v.field('refresh').disabled, false);
  assert.equal(v.field('date-confirm').checked, false);
  v.setFailure(null);
  await v.field('refresh').onclick();
  assert.equal(v.field('publish').disabled, false);
  assert.equal(v.data.costContractTimeline, undefined);
});
