'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { bind } = require('../settings/solar-preview');
const { createSolarPreview } = require('../lib/charging/solar-preview');
const time = Date.parse('2026-06-10T10:00:00Z');
function fixture() {
  let now = time;
  const elements = new Map(),
    requests = [],
    timers = [],
    intervals = [];
  const make = () => ({
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    children: [],
    replaceChildren() {
      this.children = [];
    },
    appendChild(c) {
      this.children.push(c);
    },
  });
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, make());
    return elements.get(id);
  };
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const environment = {
    document: { getElementById: el, createElement: make },
    Date: Clock,
    setTimeout: (callback, ms) => {
      const t = { callback, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cancelled = true;
    },
    setInterval: (callback) => intervals.push(callback),
  };
  const homey = {
    api: (method, url, body, callback) => requests.push({ method, url, body, callback }),
    set: () => assert.fail('No writes'),
  };
  el('solarPriority').value = 'home-first';
  el('solarMinutes').value = '5';
  bind(homey, environment);
  const fill = () => {
    el('solarHomeEnabled').checked = true;
    el('solarHomeTarget').value = '80';
    el('solarHomeMax').value = '4';
    el('solarHomeEfficiency').value = '0.9';
  };
  return {
    el,
    requests,
    timers,
    intervals,
    fill,
    advance: (ms) => {
      now += ms;
    },
  };
}
function response() {
  return createSolarPreview({
    snapshot: {
      readAt: time,
      maxAgeMs: 30000,
      gridMode: 0,
      gridW: -5000,
      pvW: 8000,
      essW: 1000,
      soc: 50,
      capacityKWh: 20,
      solarSource: 'combined',
    },
    input: {
      durationMinutes: 5,
      priority: 'home-first',
      home: { enabled: true, targetSoc: 80, maxPowerKW: 4, efficiency: 0.9 },
      ev: { connected: false },
    },
    advisory: { restricted: false },
    now: time,
  });
}
test('preview UI validates active assumptions, renders provenance and allocations, and sends no settings writes', () => {
  const v = fixture();
  v.el('solarHomeEnabled').checked = true;
  v.el('previewSolar').onclick();
  assert.equal(v.requests.length, 0);
  assert.match(v.el('solarPreviewStatus').textContent, /Fyll i/);
  v.fill();
  v.el('previewSolar').onclick();
  const r = v.requests[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/solar/preview');
  assert.equal(r.body.home.maxPowerKW, 4);
  assert.equal(r.body.ev.connected, false);
  r.callback(null, response());
  assert.equal(v.el('solarPreviewRows').children.length, 3);
  assert.match(v.el('solarPreviewContext').textContent, /Tillgängligt/);
  assert.match(v.el('solarPreviewAssumptions').textContent, /Ingen prognos/);
  v.el('solarHomeMax').oninput();
  assert.equal(v.el('solarPreviewRows').children.length, 0);
  v.el('solarEvConnected').checked = true;
  v.el('solarEvConnected').onchange();
  assert.equal(v.el('solarEvFields').disabled, false);
  v.el('solarEvStamp').onclick();
  assert.ok(v.el('solarEvObserved').value);
  v.el('previewSolar').onclick();
  assert.match(v.el('solarPreviewStatus').textContent, /Fyll i/);
});
test('expiry, API failures, timeout, restriction and late responses cannot retain a misleading allocation', () => {
  const v = fixture();
  v.fill();
  const click = () => v.el('previewSolar').onclick();
  click();
  v.el('solarMinutes').oninput();
  v.requests[0].callback(null, response());
  assert.equal(v.el('solarPreviewRows').children.length, 0);
  click();
  v.timers.at(-1).callback();
  v.requests[1].callback(null, response());
  assert.equal(v.el('solarPreviewRows').children.length, 0);
  click();
  v.requests[2].callback(new Error('Saknas'));
  assert.match(v.el('solarPreviewStatus').textContent, /Saknas/);
  click();
  v.requests[3].callback(null, { status: 'backup-restricted' });
  assert.equal(v.el('solarPreviewRows').children.length, 0);
  click();
  v.requests[4].callback(null, { status: 'unavailable-source' });
  assert.equal(v.el('solarPreviewRows').children.length, 0);
  for (const mutate of [
    (r) => {
      r.validUntil = new Date(time).toISOString();
    },
    (r) => {
      r.allocations[0].additionalKW = -1;
    },
    (r) => {
      r.allocations[0].destination = 'ev';
    },
    (r) => {
      r.allocations[0].storedKWh = null;
    },
    (r) => {
      r.allocations[0].additionalKW = 999;
    },
    (r) => {
      r.controlApplied = true;
    },
  ]) {
    click();
    const r = response();
    mutate(r);
    v.requests.at(-1).callback(null, r);
    assert.match(v.el('solarPreviewStatus').textContent, /Ogiltigt/);
    assert.equal(v.el('solarPreviewRows').children.length, 0);
  }
  click();
  v.requests.at(-1).callback(null, response());
  v.timers.at(-1).callback();
  assert.equal(v.el('solarPreviewRows').children.length, 0);
});
test('active preview refreshes via cached authenticated calculation; edits or errors stop automatic refresh', () => {
  const v = fixture();
  v.fill();
  v.el('previewSolar').onclick();
  v.requests[0].callback(null, response());
  v.intervals[0]();
  assert.equal(v.requests.length, 2);
  assert.equal(v.el('solarPreviewRows').children.length, 0);
  v.requests[1].callback(null, response());
  v.el('solarPriority').onchange();
  v.intervals[0]();
  assert.equal(v.requests.length, 2);
  v.el('previewSolar').onclick();
  v.advance(30001);
  v.requests.at(-1).callback(null, response());
  assert.match(v.el('solarPreviewStatus').textContent, /Ogiltigt/);
});
