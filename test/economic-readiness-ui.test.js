'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const { validReport } = require('../settings/economic-readiness');
const { checkReadiness } = require('../lib/pricing/comparison-readiness');
const { fixture, END, H, Q } = require('./fixtures/readiness.cjs');
function view() {
  const elements = new Map(),
    requests = [],
    timers = new Map();
  let serial = 0,
    fail = false;
  function element(id = '') {
    return {
      id,
      disabled: false,
      checked: false,
      value: '',
      textContent: '',
      children: [],
      listeners: {},
      querySelectorAll: () => [],
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      appendChild(n) {
        this.children.push(n);
      },
      replaceChildren() {
        this.children = [];
      },
    };
  }
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const doc = { getElementById: el, createElement: () => element() };
  class Clock extends Date {
    static now() {
      return END;
    }
  }
  const context = {
    document: doc,
    Date: Clock,
    Intl,
    Error,
    Homey: {
      api(method, path, body, callback) {
        if (fail) throw Error('synchronous transport error');
        requests.push({ method, path, body, callback });
      },
    },
    setTimeout(fn, ms) {
      timers.set(++serial, { fn, ms });
      return serial;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  vm.runInNewContext(
    fs.readFileSync('settings/economic-readiness.js', 'utf8') +
      '\nEconomicReadinessSettings.bind(Homey);',
    context,
  );
  el('econ-hours').value = '4';
  const fire = (id, type = 'click') => el(id).listeners[type]();
  return {
    el,
    requests,
    timers,
    fire,
    setFailure(v) {
      fail = v;
    },
    text: () => el('econ-data-status').textContent,
    list: () => el('econ-data-checks').children,
  };
}
const good = () => checkReadiness(fixture().homey, { hours: 4, mode: 'battery' }, END);
test('inspection is explicit, accepts complete data without financial claims and renders only text', () => {
  const v = view();
  assert.equal(v.requests.length, 0);
  v.fire('econ-check-data');
  assert.equal(v.el('econ-check-data').disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(v.requests[0].body)), { hours: 4, mode: 'battery' });
  assert.equal(v.requests[0].path, '/economics/readiness');
  v.requests[0].callback(null, good());
  assert.match(v.text(), /Data för grundkontrollen är täckta/);
  assert.equal(v.list().length, 9);
  assert.equal(v.el('econ-check-data').disabled, false);
  v.requests[0].callback(null, good());
  assert.equal(v.list().length, 9, 'duplicate callbacks do not append a second result');
  assert.ok([...v.timers.values()].some((t) => t.ms === H));
});
test('missing and unknown data show independent counts, clock hours, gap periods and next steps', () => {
  const f = fixture();
  f.rows.splice(1, 2);
  delete f.data.costContractTimeline;
  f.data.tibberHistoryPriceCache.rows[1].production = null;
  const v = view();
  v.fire('econ-check-data');
  v.requests[0].callback(null, checkReadiness(f.homey, { hours: 4, mode: 'battery' }, END));
  const text = (n) => [n.textContent, ...n.children.map(text)].join(' ');
  const all = v.list().map(text).join(' ');
  assert.match(v.text(), /ofullständigt/);
  assert.match(all, /2 kvart/);
  assert.match(all, /berörda klocktimmar/);
  assert.match(all, /GMT\+2/);
  assert.match(all, /slut exkluderat/);
  assert.match(all, /giltighetsdatum/);
});
test('edits, source actions, timeouts, errors and hour expiry clear old reports; late replies cannot restore them', () => {
  const v = view();
  v.fire('econ-check-data');
  const old = v.requests[0];
  v.el('econ-hours').value = '5';
  v.fire('econ-hours', 'input');
  old.callback(null, good());
  assert.equal(v.list().length, 0);
  v.el('econ-hours').value = '4';
  v.fire('econ-check-data');
  const pending = v.requests.at(-1),
    timeout = [...v.timers.values()].find((t) => t.ms === 15000);
  timeout.fn();
  pending.callback(null, good());
  assert.equal(v.list().length, 0);
  assert.match(v.text(), /inget svar/);
  v.fire('econ-check-data');
  v.requests.at(-1).callback(null, good());
  v.fire('saveCostContract');
  assert.equal(v.list().length, 0);
  v.fire('econ-check-data');
  v.requests.at(-1).callback(Error('private error'));
  assert.equal(v.list().length, 0);
  assert.match(v.text(), /kunde inte bedömas/);
  assert.doesNotMatch(v.text(), /private error/);
  v.fire('econ-check-data');
  v.requests.at(-1).callback(null, good());
  const expire = [...v.timers.values()].find((t) => t.ms === H);
  expire.fn();
  assert.equal(v.list().length, 0);
  assert.match(v.text(), /ny hel timme/);
  v.setFailure(true);
  v.fire('econ-check-data');
  assert.equal(v.el('econ-check-data').disabled, false);
  assert.match(v.text(), /kunde inte bedömas/);
});
test('invalid hour selections make no request; mode changes discard the old report', () => {
  const v = view();
  for (const value of ['', '0', '1.5', '769', 'word']) {
    v.el('econ-hours').value = value;
    v.fire('econ-check-data');
  }
  assert.equal(v.requests.length, 0);
  v.el('econ-solar-enabled').checked = true;
  v.el('econ-hours').value = '169';
  v.fire('econ-check-data');
  assert.equal(v.requests.length, 0);
  assert.match(v.text(), /168/);
  v.el('econ-hours').value = '4';
  v.fire('econ-check-data');
  assert.equal(v.requests[0].body.mode, 'solar-ev');
  v.fire('econ-solar-enabled', 'change');
  v.requests[0].callback(null, good());
  assert.equal(v.list().length, 0);
});
test('malformed or misleading backend reports are never shown as complete', () => {
  const base = good();
  const edits = [
    (r) => (r.financiallyComparable = true),
    (r) => (r.controlApplied = true),
    (r) => (r.modelValidated = true),
    (r) => (r.demandEvaluated = true),
    (r) => (r.mode = 'solar-ev'),
    (r) => r.to++,
    (r) => (r.checkedAt -= H),
    (r) => r.gates.push(r.gates[0]),
    (r) => (r.gates[0].key = 'unexpected'),
    (r) => delete r.checks.energyQuarters,
    (r) => r.checks.energyQuarters.expectedQuarters++,
    (r) => (r.checks.energyQuarters.state = 'unexpected'),
    (r) => (r.checks.energyQuarters.affectedHours = 1),
    (r) => (r.checks.energyQuarters.ranges = [{ from: r.from, to: r.from + Q }]),
    (r) => (r.status = 'incomplete'),
    (r) => (r.dataComplete = false),
  ];
  for (const edit of edits) {
    const r = structuredClone(base);
    edit(r);
    assert.equal(validReport(r, 4, 'battery'), false);
    const v = view();
    v.fire('econ-check-data');
    v.requests[0].callback(null, r);
    assert.equal(v.list().length, 0);
    assert.match(v.text(), /kunde inte bedömas/);
  }
  const f = fixture();
  f.rows.length = 0;
  const missing = checkReadiness(f.homey, { hours: 4, mode: 'battery' }, END);
  for (const edit of [
    (r) => r.checks.energyQuarters.ranges[0].from--,
    (r) => (r.checks.energyQuarters.ranges[0].to = r.to + Q),
    (r) => (r.checks.energyQuarters.affectedHours = 1),
    (r) => (r.checks.energyQuarters.ranges = []),
    (r) => (r.checks.energyQuarters.rangeCount = 0),
    (r) => (r.checks.energyQuarters.missingQuarters = 1),
  ]) {
    const r = structuredClone(missing);
    edit(r);
    assert.equal(validReport(r, 4, 'battery'), false);
  }
  const v = view();
  v.fire('econ-check-data');
  const future = structuredClone(base);
  future.checkedAt += 6 * 60000;
  v.requests[0].callback(null, future);
  assert.equal(v.list().length, 0);
  const expired = structuredClone(base);
  expired.from -= H;
  expired.to -= H;
  expired.checkedAt -= H;
  v.fire('econ-check-data');
  v.requests.at(-1).callback(null, expired);
  assert.equal(v.list().length, 0);
});
