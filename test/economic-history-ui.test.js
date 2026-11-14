'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
function fixture() {
  const elements = new Map(),
    requests = [],
    timers = [];
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false });
    return elements.get(id);
  };
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  const start = html.indexOf('      function bindEconomicHistory(Homey) {'),
    end = html.indexOf('      function bindCostSettings(Homey) {', start);
  const context = {
    document: { getElementById: el },
    localTime: (v) => (v === null ? '–' : String(v)),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
    Homey: { api: (method, url, body, callback) => requests.push({ method, url, body, callback }) },
  };
  vm.runInNewContext(html.slice(start, end) + '\nbindEconomicHistory(Homey);', context);
  return { el, requests, timers };
}
const result = () => ({
  status: 'partial',
  completeQuarters: 2,
  excludedQuarters: 1,
  missingQuarters: 3,
  windowFrom: 1000,
  windowTo: 2000,
  importKWh: 0.4,
  exportKWh: 0.2,
});
test('economic history UI labels measured approximation and missing quarters without enabling financial claims', () => {
  const v = fixture();
  assert.equal(v.requests.length, 0);
  v.el('refreshEconomicHistory').onclick();
  const r = v.requests[0];
  assert.equal(r.method, 'GET');
  assert.equal(r.url, '/economics/energy-history');
  assert.equal(r.body, null);
  r.callback(null, result());
  assert.match(v.el('economicHistoryStatus').textContent, /2 kompletta/);
  assert.match(v.el('economicHistoryDetails').textContent, /Import 0,4 kWh, export 0,2 kWh/);
  assert.match(v.el('economicHistoryDetails').textContent, /ingen bakåtfyllning/);
  v.el('refreshEconomicHistory').onclick();
  v.requests[1].callback(null, {
    ...result(),
    status: 'collecting',
    completeQuarters: 0,
    importKWh: null,
    exportKWh: null,
  });
  assert.match(v.el('economicHistoryStatus').textContent, /Samlar/);
  assert.match(v.el('economicHistoryDetails').textContent, /Import – kWh/);
});
test('history read errors, timeout, malformed and out-of-order responses clear previous volumes', () => {
  const v = fixture(),
    click = () => v.el('refreshEconomicHistory').onclick();
  click();
  v.requests[0].callback(null, result());
  click();
  assert.equal(v.el('economicHistoryDetails').textContent, '');
  v.requests[1].callback(Error('failure'));
  assert.match(v.el('economicHistoryStatus').textContent, /kunde inte läsas/);
  click();
  v.timers.at(-1)();
  v.requests[2].callback(null, result());
  assert.equal(v.el('economicHistoryDetails').textContent, '');
  assert.match(v.el('economicHistoryStatus').textContent, /kunde inte hämtas/);
  click();
  click();
  v.requests[3].callback(null, result());
  assert.equal(v.el('economicHistoryDetails').textContent, '');
  v.requests[4].callback(null, { status: 'unavailable' });
  assert.equal(v.el('economicHistoryDetails').textContent, '');
});
