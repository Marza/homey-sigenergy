'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const { DataDiagnostics } = require('../lib/data-diagnostics');
const { fixture } = require('./fixtures/readiness.cjs');
function view() {
  const elements = new Map(),
    requests = [],
    timers = [];
  const element = () => ({
    value: '24',
    disabled: false,
    textContent: '',
    style: {},
    setAttribute() {},
    children: [],
    appendChild(c) {
      this.children.push(c);
    },
    replaceChildren() {
      this.children = [];
    },
  });
  const field = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const context = {
    document: { getElementById: (id) => field(id.replace(/^gap-/, '')), createElement: element },
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  vm.runInNewContext(fs.readFileSync('settings/data-diagnostics.js', 'utf8'), context);
  context.DataDiagnosticsSettings.bind({
    api: (method, path, body, cb) => requests.push({ method, path, body, cb }),
  });
  return { field, requests, timers };
}
const tick = () => new Promise((r) => setImmediate(r));
function report() {
  const f = fixture();
  return new DataDiagnostics(f.homey.settings, () => f.now).report(f.homey, { hours: 4 });
}
test('diagnostic UI shows pending status and discards timed-out or superseded replies', async () => {
  const v = view();
  const p = v.field('refresh').onclick();
  assert.match(v.field('status').textContent, /Hämtar/);
  assert.equal(v.field('refresh').disabled, true);
  assert.equal(v.requests[0].path, '/diagnostics/data-gaps');
  assert.equal(v.requests[0].body.hours, 24);
  v.timers[0]();
  await p;
  assert.equal(v.field('refresh').disabled, false);
  assert.match(v.field('status').textContent, /kunde inte/);
  v.requests[0].cb(null, report());
  await tick();
  assert.equal(v.field('results').children.length, 0);
  const next = v.field('refresh').onclick();
  v.field('hours').onchange();
  v.requests[1].cb(null, report());
  await next;
  assert.equal(v.field('results').children.length, 0);
});
test('new diagnostic results replace old cards and malformed/failed reads cannot retain stale explanations', async () => {
  const v = view();
  let p = v.field('refresh').onclick();
  v.requests[0].cb(null, report());
  await p;
  assert.ok(v.field('results').children.length > 0);
  assert.match(v.field('status').textContent, /Diagnostik hämtad/);
  p = v.field('refresh').onclick();
  assert.equal(v.field('results').children.length, 0);
  v.requests[1].cb(null, { schema: 1 });
  await p;
  assert.match(v.field('status').textContent, /kunde inte/);
  p = v.field('refresh').onclick();
  v.requests[2].cb(Error('PRIVATE_TOKEN'));
  await p;
  assert.doesNotMatch(v.field('status').textContent, /PRIVATE/);
});

test('time coverage displays independent durations and rejects a contradictory fresh report', async () => {
  const v = view();
  const f = fixture({ hours: 1 });
  f.rows[0].essCoverageMs -= 60000;
  const r = new DataDiagnostics(f.homey.settings, () => f.now).report(f.homey, { hours: 1 });
  r.recovery.crossQuarterQuarters = 2;
  const text = (node) => [node.textContent, ...node.children.map(text)].join(' ');
  let p = v.field('refresh').onclick();
  v.requests[0].cb(null, r);
  await p;
  const rendered = text(v.field('results'));
  assert.match(rendered, /Observerat: 59 min/);
  assert.match(rendered, /Okänd tid: 1 min/);
  assert.match(rendered, /Timmar med räknarestimat: 0/);
  assert.match(rendered, /inte tidstäckningen/);
  assert.match(rendered, /Kvart med fördelning över kvartgräns: 2/);
  assert.match(rendered, /exakta energifördelningen.*okänd/);
  r.quality.channels.battery.observedMs++;
  p = v.field('refresh').onclick();
  v.requests[1].cb(null, r);
  await p;
  assert.equal(v.field('results').children.length, 0);
  assert.match(v.field('status').textContent, /kunde inte/);
});
