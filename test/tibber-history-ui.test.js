'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const tick = () => new Promise((r) => setImmediate(r));
function view() {
  const elements = new Map(),
    calls = [];
  let confirmed = false,
    fail = false;
  const el = (id) => {
    if (!elements.has(id))
      elements.set(id, { textContent: '', checked: false, disabled: false, hidden: false });
    return elements.get(id);
  };
  const Homey = {
    api: (method, path, body, cb) => {
      calls.push({ method, path, body });
      if (fail) {
        cb(new Error('network'));
        return;
      }
      let result = {};
      if (path.endsWith('/status'))
        result = {
          configured: true,
          homeSelected: true,
          confirmed,
          priceHours: confirmed ? 1 : 0,
          syncStatus: 'partial',
        };
      if (path.endsWith('/confirm')) {
        if (!body.confirmSamePlant) {
          cb(new Error('home-confirmation-required'));
          return;
        }
        confirmed = true;
      }
      if (path === '/economics/observed')
        result = confirmed
          ? {
              status: 'indicative-hourly',
              matchedHours: 1,
              missingProductionHours: 2,
              unusedEnergyQuarters: 3,
              componentBasis: 'tibber-trade-only',
              totals: {
                importKWh: 1,
                exportKWh: 0.5,
                importCostSek: 1.2,
                exportRevenueSek: -0.1,
                netCostSek: 1.3,
              },
            }
          : { status: 'no-prices' };
      cb(null, result);
    },
  };
  const context = { document: { getElementById: el }, Homey };
  vm.runInNewContext(
    fs.readFileSync('settings/tibber-history-prices.js', 'utf8') +
      '\nTibberHistoryPricesSettings.bind(Homey);',
    context,
  );
  return {
    el: (id) => el('trade-' + id),
    calls,
    setFail: (v) => {
      fail = v;
    },
  };
}
test('existing-connection UI requires meter confirmation and displays honest hourly totals', async () => {
  const v = view();
  await tick();
  assert.match(v.el('status').textContent, /Bekräfta/);
  await v.el('confirm').onclick();
  assert.match(v.el('message').textContent, /Bekräfta/);
  assert.equal(v.el('confirm').disabled, false);
  v.el('same').checked = true;
  await v.el('confirm').onclick();
  assert.match(v.el('costs').textContent, /Vägledande timberäkning/);
  assert.match(v.el('costs').textContent, /ersättning −0,1 kr/);
  assert.match(v.el('coverage').textContent, /säljpris: 2 timmar/);
  assert.ok(v.calls.some((c) => c.path === '/tibber/history-prices/refresh'));
  assert.ok(v.calls.every((c) => !JSON.stringify(c).includes('token')));
  v.el('network').checked = true;
  v.el('confirm-network').checked = true;
  await v.el('save-network').onclick();
  const call = v.calls.find((c) => c.path.endsWith('/components'));
  assert.equal(call.body.includeNetwork, true);
  assert.equal(call.body.confirmSeparateNetworkComponents, true);
});
test('UI clears old costs on API failure and recovers using the same connection', async () => {
  const v = view();
  await tick();
  v.el('same').checked = true;
  await v.el('confirm').onclick();
  assert.match(v.el('costs').textContent, /1,3 kr/);
  v.setFail(true);
  await v.el('refresh').onclick();
  assert.match(v.el('costs').textContent, /kunde inte uppdateras/);
  assert.equal(v.el('coverage').textContent, '');
  assert.equal(v.el('refresh').disabled, false);
  v.setFail(false);
  await v.el('refresh').onclick();
  assert.match(v.el('costs').textContent, /Vägledande/);
});
