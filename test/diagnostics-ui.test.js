'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { nibeKey } = require('../lib/source-status');
function view(file) {
  const elements = new Map(),
    timers = [],
    failures = new Set();
  let now = Date.now();
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const readAt = new Date(now - 1000).toISOString();
  const values = {
    sourceConfig: {
      sigenergy: { configured: true, enabled: true },
      evdc: { configured: true, enabled: false },
    },
    sigenergyStatus: { readAt },
    nibeHost: '192.0.2.30',
    nibeStatus: { readAt, readings: { outdoorC: -2 } },
    historyState: {
      schema: 3,
      slots: [
        {
          t: now - 1000,
          counts: { gridW: 1, pvW: 1, soc: 1 },
          sum: { gridW: 2000, pvW: 1000, soc: 60 },
        },
      ],
      daily: [],
      events: [],
      legacyDaily: [],
    },
  };
  values.sourceConfig.nibe = { connectionKey: nibeKey(values) };
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        innerHTML: '',
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
      callback(failures.has(key) ? new Error('Read failed') : null, values[key]);
    },
    ready() {},
  };
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const browserCopy = path.join(path.dirname(file), 'source-status.js');
  assert.match(html, /<script src="source-status.js"><\/script>/);
  const script =
    fs.readFileSync(path.join(__dirname, '..', browserCopy), 'utf8') +
    '\n' +
    [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const context = vm.createContext({
    document,
    Homey,
    Date: Clock,
    setInterval: (callback) => timers.push(callback),
  });
  vm.runInContext(script, context);
  const widget = file.startsWith('widgets/');
  const refresh = widget
    ? () => timers[0]()
    : () => vm.runInContext('loadOverview(Homey);refreshDiagnostics(Homey)', context);
  if (widget) vm.runInContext('onHomeyReady(Homey)', context);
  else refresh();
  return {
    values,
    failures,
    refresh,
    text: (id) => element(id).textContent,
    element,
    advance: (ms) => {
      now += ms;
    },
  };
}
for (const [file, grid, outdoor] of [
  ['settings/index.html', 'gridPower', 'outdoorTemp'],
  ['widgets/energy-overview/public/index.html', 'grid', 'outdoor'],
]) {
  test(`${file}: success → failure → recovery → disabled clears cached readings`, () => {
    const v = view(file);
    assert.notEqual(v.text(grid), '–');
    assert.match(v.text(outdoor), /[−-]2/);
    v.values.sigenergyError = 'timeout';
    v.values.nibeError = 'ECONNREFUSED';
    v.refresh();
    assert.equal(v.text(grid), '–');
    assert.equal(v.text(outdoor), '–');
    assert.match(v.text(file.startsWith('widgets/') ? 'outdoorState' : 'nibeUpdated'), /nekades/);
    v.values.sigenergyError = null;
    v.values.nibeError = null;
    v.refresh();
    assert.notEqual(v.text(grid), '–');
    assert.match(v.text(outdoor), /[−-]2/);
    v.values.sourceConfig.sigenergy.enabled = false;
    v.values.nibeHost = '';
    v.refresh();
    assert.equal(v.text(grid), '–');
    assert.equal(v.text(outdoor), '–');
  });
  test(`${file}: stale, future, empty and failed history never retain previous figures`, () => {
    const v = view(file);
    v.advance(120000);
    v.refresh();
    assert.equal(v.text(grid), '–');
    assert.equal(v.text(outdoor), '–');
    v.advance(-120000);
    v.values.sigenergyStatus.readAt = new Date(Date.now() + 600000).toISOString();
    v.refresh();
    assert.equal(v.text(grid), '–');
    v.values.sigenergyStatus.readAt = new Date(Date.now() - 1000).toISOString();
    v.refresh();
    assert.notEqual(v.text(grid), '–');
    v.failures.add('historyState');
    v.refresh();
    assert.equal(v.text(grid), '–');
    v.failures.clear();
    v.refresh();
    assert.notEqual(v.text(grid), '–');
    v.values.historyState.slots = [];
    v.refresh();
    assert.equal(v.text(grid), '–');
  });
  test(`${file}: failed settings reads and changed Nibe configuration hide cached values`, () => {
    const v = view(file);
    v.failures.add('sourceConfig');
    v.refresh();
    assert.equal(v.text(grid), '–');
    assert.equal(v.text(outdoor), '–');
    v.failures.clear();
    v.values.nibePort = 503;
    v.refresh();
    assert.equal(v.text(outdoor), '–');
  });
}
test('widget rejects future recommendations', () => {
  const v = view('widgets/energy-overview/public/index.html');
  v.values.optimizationRecommendation = {
    status: 'illustrative',
    capKW: 4,
    reservePercent: 20,
    updatedAt: new Date(Date.now() + 600000).toISOString(),
  };
  v.refresh();
  assert.equal(v.text('cap'), '–');
  assert.equal(v.text('reserve'), '–');
});

test('settings exposes partial battery errors and omits failed limits from temperature context', () => {
  const v = view('settings/index.html');
  v.values.batteryTelemetry = {
    readAt: new Date(Date.now() - 1000).toISOString(),
    values: { chargePowerLimitKW: 2, dischargePowerLimitKW: 3 },
    errors: { dischargePowerLimitKW: 'Unsupported register' },
  };
  v.refresh();
  assert.match(v.text('temperatureStatus'), /BMS laddgräns: 2 kW/);
  assert.match(v.text('temperatureStatus'), /BMS urladdningsgräns: saknas/);
  const rows = v
    .element('diagnosticRows')
    .children.map((p) => p.textContent)
    .join('\n');
  assert.match(rows, /Batteri: Delvis tillgänglig/);
  assert.match(rows, /dischargePowerLimitKW: Unsupported register/);
});
