'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { getOverview } = require('../widgets/energy-overview/api');
const now = Date.parse('2026-11-13T20:00Z');
function snapshot(values = {}, failures = []) {
  return getOverview(
    {
      homey: {
        settings: {
          get(key) {
            if (failures.includes(key)) throw new Error('private failure');
            return values[key];
          },
          set() {
            throw new Error('Writes forbidden');
          },
        },
      },
    },
    now,
  );
}
test('widget manifest is registered without Compose and has only one read-only API', () => {
  const app = require('../app.json'),
    definition = require('../widgets/energy-overview/widget.compose.json');
  assert.equal(app.compatibility, '>=12.3.0');
  assert.deepEqual(app.widgets['energy-overview'], { id: 'energy-overview', ...definition });
  assert.deepEqual(definition.api, { getOverview: { method: 'GET', path: '/' } });
  assert.equal(definition.height, undefined);
  for (const mode of ['light', 'dark'])
    assert.deepEqual(
      [
        ...fs
          .readFileSync(path.join(__dirname, `../widgets/energy-overview/preview-${mode}.png`))
          .subarray(0, 8),
      ],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
});
test('snapshot excludes credentials, addresses, unknown fields and all but the latest quarter', () => {
  const secret = 'DO-NOT-EXPOSE';
  const r = snapshot({
    tibberToken: secret,
    tibberHomeId: secret,
    nibeHost: secret,
    sourceConfig: { sigenergy: { configured: true, enabled: true, private: secret } },
    sigenergyStatus: { readAt: new Date(now).toISOString() },
    historyState: {
      schema: 3,
      slots: [
        {
          t: now,
          counts: { gridW: 1, pvW: 1, soc: 1, secret },
          sum: { gridW: 2000, pvW: 500, soc: 70, secret },
          secret,
        },
        { t: now - 900000, secret },
      ],
    },
    nibeStatus: { readAt: new Date(now).toISOString(), readings: { outdoorC: 3, secret }, secret },
    demandTariff: {
      start: '07:00',
      end: '20:00',
      weekdays: [1],
      peakCount: 5,
      distinctDays: true,
      rateSekPerKw: 100,
      secret,
    },
    demandEstimate: {
      month: '2026-11',
      averageKw: 3,
      estimatedSek: 300,
      secret,
      coverage: { missingHours: 1, secret },
    },
    tariffOptimization: {
      status: 'provisional',
      baseline: { month: '2026-11', secret },
      best: { simulatedDemandSek: 250, demandSavingSek: 50, secret },
    },
    optimizationRecommendation: {
      updatedAt: new Date(now).toISOString(),
      status: 'illustrative',
      capKW: 3,
      reservePercent: 20,
      reason: secret,
      secret,
    },
  });
  assert.equal(r.schema, 1);
  assert.equal(r.values.historyState.slots.length, 1);
  assert.equal(r.values.historyState.slots[0].t, now);
  assert.equal(r.values.nibeStatus.readings.outdoorC, 3);
  assert.equal(r.values.demandEstimate.estimatedSek, 300);
  assert.equal(r.values.tariffOptimization.best.demandSavingSek, 50);
  assert.ok(!JSON.stringify(r).includes(secret));
  assert.ok(!JSON.stringify(r).includes('tibberToken'));
});
test('empty, legacy and invalid history and settings failures remain explicit', () => {
  assert.equal(snapshot().values.historyState.slots.length, 0);
  assert.equal(snapshot({ historySlots: [{ t: now }] }).values.historyState.slots.length, 1);
  assert.ok(snapshot({ historyState: { schema: 9, slots: [] } }).errors.includes('historyState'));
  assert.ok(snapshot({ historySlots: {} }).errors.includes('historyState'));
  assert.ok(snapshot({}, ['historySlots']).errors.includes('historyState'));
  const failed = snapshot({}, ['nibeHost', 'demandTariff']);
  assert.equal(failed.sources.sigenergy.usable, false);
  assert.equal(failed.sources.nibe.status, 'error');
  assert.ok(failed.errors.includes('demandTariff'));
  for (const [raw, expected] of [
    ['ECONNREFUSED private-host', 'ECONNREFUSED'],
    ['ETIMEDOUT private-host', 'ETIMEDOUT'],
    ['EHOSTUNREACH private-host', 'EHOSTUNREACH'],
    ['Illegal data address private-host', 'Illegal register address'],
    ['other private-host', 'Avläsningen misslyckades'],
  ]) {
    const r = snapshot({
      sourceConfig: { sigenergy: { configured: true, enabled: true } },
      sigenergyError: raw,
    });
    assert.equal(r.sources.sigenergy.error, expected);
    assert.ok(!JSON.stringify(r).includes('private-host'));
  }
});
function view() {
  const elements = new Map(),
    pending = [],
    timeouts = [],
    timers = [],
    heights = [];
  let ready = 0;
  const document = {
    body: { scrollHeight: 720 },
    getElementById(id) {
      if (!elements.has(id))
        elements.set(
          id,
          id === 'widget-content'
            ? { getBoundingClientRect: () => ({ height: 720 }) }
            : { textContent: '' },
        );
      return elements.get(id);
    },
  };
  const Homey = {
    api(method, url) {
      assert.equal(method, 'GET');
      assert.equal(url, '/');
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    ready(options) {
      ready++;
      heights.push(options.height);
    },
    setHeight(height) {
      heights.push(height);
      return Promise.resolve();
    },
  };
  const context = vm.createContext({
    Homey,
    document,
    setInterval: (fn) => timers.push(fn),
    setTimeout: (fn) => timeouts.push(fn),
    clearTimeout() {},
  });
  const directory = path.join(__dirname, '../widgets/energy-overview/public');
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g))
    if (!match[1].startsWith('/'))
      vm.runInContext(fs.readFileSync(path.join(directory, match[1]), 'utf8'), context);
  vm.runInContext(
    [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'),
    context,
  );
  vm.runInContext('onHomeyReady(Homey)', context);
  return {
    pending,
    timeouts,
    timers,
    heights,
    elements,
    get ready() {
      return ready;
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
test('actual widget bridge needs no settings API, handles network failure/recovery and resizes', async () => {
  const v = view();
  assert.equal(v.ready, 0);
  v.pending[0].reject(new Error('network'));
  await flush();
  assert.equal(v.ready, 1);
  assert.match(v.elements.get('state').textContent, /Kunde inte läsa/);
  assert.equal(v.elements.get('soc').textContent, '–');
  v.timers[0]();
  v.pending[1].resolve(snapshot());
  await flush();
  assert.equal(v.ready, 1);
  assert.equal(v.elements.get('state').textContent, 'Ingen historik');
  assert.ok(v.heights.every((h) => h === 722));
  v.timers[0]();
  v.pending[2].resolve({ schema: 9 });
  await flush();
  assert.match(v.elements.get('state').textContent, /Kunde inte läsa/);
});
test('late API responses cannot replace a newer refresh', async () => {
  const v = view();
  v.timers[0]();
  v.pending[1].resolve(snapshot());
  await flush();
  assert.equal(v.elements.get('state').textContent, 'Ingen historik');
  v.pending[0].reject(new Error('old failure'));
  await flush();
  assert.equal(v.elements.get('state').textContent, 'Ingen historik');
});

test('hung API requests time out and a late response cannot restore stale values', async () => {
  const v = view();
  v.timeouts[0]();
  assert.equal(v.ready, 1);
  assert.match(v.elements.get('state').textContent, /Kunde inte läsa/);
  v.pending[0].resolve(snapshot());
  await flush();
  assert.match(v.elements.get('state').textContent, /Kunde inte läsa/);
  v.timers[0]();
  v.pending[1].resolve(snapshot());
  await flush();
  assert.equal(v.elements.get('state').textContent, 'Ingen historik');
});
