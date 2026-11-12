'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryStore, SLOT_MS, SLOT_RETENTION } = require('../lib/history');
function setup(now = 1800000000000) {
  const map = new Map();
  const settings = { get: key => map.get(key), set: (key, value) => map.set(key, structuredClone(value)) };
  return { history: new HistoryStore(settings, () => now), settings };
}
test('stores aggregated samples and integrates adjacent power readings', () => {
  const t = 1800000000000;
  const { history, settings } = setup(t + 10000);
  history.append({ gridW: 1000, soc: 50 }, t);
  history.append({ gridW: 2000, soc: 52 }, t + 10000);
  history.flush();
  const rows = settings.get('historySlots');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].max.gridW, 2000);
  assert.ok(Math.abs(rows[0].gridWh - (1500 * 10 / 3600)) < 0.001);
  assert.equal(settings.get('historyDaily').length, 1);
});
test('flush is idempotent', () => {
  const { history, settings } = setup();
  history.append({ gridW: 100 }, 1800000000000);
  history.flush(); history.flush();
  assert.equal(settings.get('historySlots')[0].n, 1);
});
test('retention removes old slots', () => {
  const now = 1800000000000;
  const { history, settings } = setup(now);
  history.append({ gridW: 100 }, now - (SLOT_RETENTION + 5) * SLOT_MS);
  history.append({ gridW: 200 }, now);
  history.flush();
  assert.equal(settings.get('historySlots').length, 1);
});
test('events bounded and sensitive properties excluded', () => {
  const { history, settings } = setup();
  for (let i = 0; i < 510; i++) history.event('backup-mode', { mode: 'off-grid', token: 'secret' });
  assert.equal(settings.get('historyEvents').length, 500);
  assert.equal(settings.get('historyEvents')[0].token, undefined);
});
test('export contains no configuration secrets', () => {
  const { history, settings } = setup();
  settings.set('tibberToken', 'secret');
  history.append({ gridW: 100 }, 1800000000000);
  const exported = history.export();
  assert.equal(exported.schema, 1);
  assert.equal(JSON.stringify(exported).includes('secret'), false);
});
test('invalid values are ignored', () => {
  const { history, settings } = setup();
  history.append({ gridW: NaN, pvW: Infinity }, 1800000000000);
  history.flush();
  assert.equal(settings.get('historySlots'), undefined);
});
