'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { DEFAULTS } = require('../lib/charging/planner');
const { createChargingPreview } = require('../lib/charging/preview');
const time = Date.parse('2026-11-13T20:00Z');
function view() {
  const elements = new Map(),
    requests = [],
    timeouts = [],
    writes = [];
  const make = () => ({
    textContent: '',
    children: [],
    checked: false,
    disabled: false,
    _value: '',
    get value() {
      return this._value;
    },
    set value(v) {
      this._value = String(v);
    },
    replaceChildren() {
      this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
    },
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, make());
    return elements.get(id);
  };
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [time]));
    }
    static now() {
      return time;
    }
  }
  const Homey = {
    get(key, cb) {
      cb(null, key === 'chargingConfig' ? structuredClone(DEFAULTS) : null);
    },
    set(key, value, cb) {
      writes.push(key);
      cb(null);
    },
    api(method, url, body, callback) {
      requests.push({ method, url, body, callback });
    },
    ready() {},
  };
  const context = vm.createContext({
    Homey,
    Date: Clock,
    document: { querySelectorAll: () => [], getElementById: element, createElement: make },
    setInterval() {},
    setTimeout: (callback) => timeouts.push(callback),
    clearTimeout() {},
  });
  const directory = path.join(__dirname, '../settings'),
    html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  assert.equal(
    fs.readFileSync(path.join(directory, 'charging-planner.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../lib/charging/planner.js'), 'utf8'),
  );
  for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g))
    if (!match[1].startsWith('/'))
      vm.runInContext(fs.readFileSync(path.join(directory, match[1]), 'utf8'), context);
  vm.runInContext(
    [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'),
    context,
  );
  const run = (script) => vm.runInContext(script, context);
  run('bindChargingPreview(Homey)');
  const fill = () => {
    element('planSoc').value = '20';
    element('planObservedAt').value = new Date(time).toISOString();
    element('planPower').value = '7';
    element('planConnected').checked = true;
  };
  return { element, requests, timeouts, writes, run, fill };
}
function result() {
  const now = new Date(time),
    prices = Array.from({ length: 192 }, (_, i) => ({
      start: new Date(time + i * 900000).toISOString(),
      end: new Date(time + (i + 1) * 900000).toISOString(),
      price: 1,
    }));
  return createChargingPreview({
    input: {
      source: 'manual',
      currentSoc: 20,
      observedAt: now.toISOString(),
      connected: true,
      availablePowerKW: 7,
    },
    now,
    config: structuredClone(DEFAULTS),
    prices,
    pricing: {
      usable: true,
      currency: 'SEK',
      availableFrom: prices[0].start,
      availableTo: prices.at(-1).end,
      fetchedAt: now.toISOString(),
    },
  });
}
test('preview UI requires explicit inputs, calls only authenticated computation and renders assumptions/coverage', () => {
  const v = view();
  v.element('previewCharging').onclick();
  assert.equal(v.requests.length, 0);
  assert.match(v.element('chargingPreviewStatus').textContent, /Fyll i/);
  v.fill();
  v.element('previewCharging').onclick();
  const req = v.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/charging/preview');
  assert.equal(req.body.source, 'manual');
  req.callback(null, result());
  assert.ok(v.element('chargingSlots').children.length > 0);
  assert.equal(v.element('chargingDeadlines').children.length, 2);
  assert.match(
    v.element('chargingPreviewContext').textContent,
    /Manuell SoC 20.*92 %.*7 kW.*Europe\/Stockholm/,
  );
  assert.match(v.element('chargingPreviewSummary').textContent, /inte full elkostnad/);
  assert.deepEqual(v.writes, []);
  v.element('planSoc').oninput();
  assert.equal(v.element('chargingSlots').children.length, 0);
  assert.equal(v.element('chargingPreviewSummary').textContent, '');
});
test('input edits, timeouts, expiry, invalid responses and server failures clear results', () => {
  const v = view();
  v.fill();
  v.element('previewCharging').onclick();
  v.element('days').oninput();
  v.requests[0].callback(null, result());
  assert.equal(v.element('chargingSlots').children.length, 0);
  v.element('previewCharging').onclick();
  v.timeouts.at(-1)();
  assert.match(v.element('chargingPreviewStatus').textContent, /kunde inte hämtas/);
  v.requests[1].callback(null, result());
  assert.equal(v.element('chargingSlots').children.length, 0);
  v.element('previewCharging').onclick();
  v.requests[2].callback(new Error('SoC är inaktuell'));
  assert.match(v.element('chargingPreviewStatus').textContent, /inaktuell/);
  v.element('previewCharging').onclick();
  v.requests[3].callback(null, {});
  assert.match(v.element('chargingPreviewStatus').textContent, /Ogiltigt svar/);
  v.element('previewCharging').onclick();
  v.requests[4].callback(null, result());
  v.timeouts.at(-1)();
  assert.match(v.element('chargingPreviewStatus').textContent, /blivit inaktuell/);
  assert.equal(v.element('chargingSlots').children.length, 0);
});
test('stamp action is explicit and schedule saving shares backend validation', () => {
  const v = view();
  v.element('planStamp').onclick();
  assert.match(v.element('planObservedAt').value, /2026-11-13T/);
  assert.equal(v.requests.length, 0);
  v.run(
    'TibberHistoryPricesSettings.bind = () => {}; EconomicReplaySettings.bind = () => {}; onHomeyReady(Homey)',
  );
  assert.equal(v.element('chargingEfficiency').value, '0.92');
  v.element('chargingEfficiency').value = '';
  v.element('save').onclick();
  assert.match(v.element('message').textContent, /Fyll i/);
  assert.deepEqual(v.writes, []);
});

test('blocked preview leaves coverage and unmet energy unknown rather than showing zero', () => {
  const v = view();
  v.fill();
  v.element('previewCharging').onclick();
  v.requests[0].callback(null, {
    ...result(),
    status: 'no-prices',
    priceCoverage: undefined,
    unmet: undefined,
    slots: [],
    estimatedCost: undefined,
  });
  const cells = v.element('chargingDeadlines').children[0].children;
  assert.equal(cells[2].textContent, 'Ej beräknad');
  assert.equal(cells[3].textContent, 'Ej beräknad');
});

test('backup restriction clears previously rendered charging instructions and explains why', () => {
  const v = view();
  v.fill();
  v.element('previewCharging').onclick();
  v.requests[0].callback(null, result());
  assert.ok(v.element('chargingSlots').children.length);
  v.element('previewCharging').onclick();
  v.requests[1].callback(null, {
    status: 'backup-restricted',
    reason: 'Ekonomiska råd pausade. Ingen styrning utförs.',
    slots: [],
  });
  assert.equal(v.element('chargingSlots').children.length, 0);
  assert.equal(v.element('chargingDeadlines').children.length, 0);
  assert.match(v.element('chargingPreviewStatus').textContent, /pausade/);
  assert.equal(v.element('chargingPreviewSummary').textContent, '');
});
