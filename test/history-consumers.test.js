'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { HistoryStore } = require('../lib/history');

test('runtime calculations read canonical history instead of frozen migration keys', () => {
  const appPath = path.join(__dirname, '../app.js'), requireApp = createRequire(appPath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), {
    module, require: id => id === 'homey' ? { App: class {} } : requireApp(id),
  });
  const t = Date.parse('2026-01-12T09:00:00Z');
  const slots = [0, 1, 2, 3].map(i => ({ t: t + i * 900000, gridWh: 1000, essWh: 0, coverageMs: 900000 }));
  const map = new Map([
    ['historyState', { schema: 3, timezone: 'Europe/Stockholm', slots, daily: [], events: [], legacyDaily: [] }],
    ['demandTariff', { start: '07:00', end: '20:00', weekdays: [1], peakCount: 1, distinctDays: true, rateSekPerKw: 100 }],
  ]);
  const settings = { get(key) { assert.notEqual(key, 'historySlots'); return map.get(key); }, set: (key, value) => map.set(key, value) };
  const app = new module.exports(); app.homey = { settings }; app.history = new HistoryStore(settings);
  assert.equal(app.getDemandCharge('2026-01').averageKw, 4);
  assert.equal(app.getOptimizationPreview().status, 'illustrative');
  assert.ok(app.getAdvancedOptimizationPreview().candidates.length > 0);
});
