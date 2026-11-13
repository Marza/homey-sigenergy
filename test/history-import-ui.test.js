'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function view(api) {
  const elements = new Map(), downloaded = [];
  const document = {
    querySelectorAll: () => [],
    getElementById(id) { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false }); return elements.get(id); },
    createElement() { return { click() {} }; },
  };
  const Homey = { api, get(key, callback) { callback(null, undefined); } };
  class Blob { constructor(parts) { downloaded.push(JSON.parse(parts[0])); } }
  const URL = { createObjectURL: () => 'test:blob', revokeObjectURL() {} };
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../lib/source-status.js'), 'utf8') + '\n' + [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const context = vm.createContext({ document, Homey, Blob, URL, setTimeout() {} });
  vm.runInContext(script, context);
  return { element: id => document.getElementById(id), run: code => vm.runInContext(code, context), downloaded };
}

test('settings exports the server snapshot verbatim instead of reading independent keys', () => {
  const file = { format: 'com.local.sigenergy.history', schema: 3, slots: [], daily: [], events: [], legacyDaily: [] };
  const v = view((method, route, body, callback) => {
    assert.equal(method, 'GET'); assert.equal(route, '/history/export'); callback(null, file);
  });
  v.run('exportHistory(Homey)');
  assert.deepEqual(v.downloaded, [file]);
});

test('restore is enabled only after preview and preserves the selected payload', async () => {
  const calls = [], file = { schema: 2, slots: [], daily: [], events: [] };
  const v = view((method, route, body, callback) => {
    calls.push({ method, route, body });
    if (route.endsWith('/preview')) callback(null, { slots: 2, daily: 1, conflictingSlots: 1 });
    else callback(null, { restored: true });
  });
  v.run('bindHistoryImport(Homey)');
  const input = v.element('importHistoryFile'), button = v.element('restoreHistory');
  assert.equal(button.disabled, true);
  input.files = [{ size: 100, text: async () => JSON.stringify(file) }];
  await input.onchange();
  assert.equal(calls.length, 1); assert.equal(button.disabled, false);
  assert.match(v.element('importHistoryPreview').textContent, /överlappande/);
  button.onclick();
  assert.equal(calls[1].route, '/history/import');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), file);
  assert.equal(button.disabled, true); assert.equal(input.disabled, false);
});

test('invalid JSON, large files and failed previews never enable restore', async () => {
  let calls = 0;
  const v = view((method, route, body, callback) => { calls++; callback(new Error('Invalid export')); });
  v.run('bindHistoryImport(Homey)');
  const input = v.element('importHistoryFile'), button = v.element('restoreHistory');
  input.files = [{ size: 100, text: async () => '{invalid' }]; await input.onchange();
  assert.equal(button.disabled, true); assert.equal(calls, 0);
  input.files = [{ size: 9 * 1024 * 1024, text: async () => '{}' }]; await input.onchange();
  assert.equal(button.disabled, true); assert.equal(calls, 0);
  input.files = [{ size: 100, text: async () => '{}' }]; await input.onchange();
  assert.equal(button.disabled, true); assert.equal(calls, 1);
  button.onclick(); assert.equal(calls, 1);
});

test('a late preview for an older file cannot authorize a different selected file', async () => {
  const callbacks = [];
  const v = view((method, route, body, callback) => callbacks.push(callback));
  v.run('bindHistoryImport(Homey)');
  const input = v.element('importHistoryFile');
  input.files = [{ size: 100, text: async () => '{"file":1}' }]; await input.onchange();
  input.files = [{ size: 100, text: async () => '{"file":2}' }]; await input.onchange();
  callbacks[0](null, { slots: 1, daily: 1, conflictingSlots: 0 });
  assert.equal(v.element('restoreHistory').disabled, true);
  callbacks[1](new Error('Bad second file'));
  assert.equal(v.element('restoreHistory').disabled, true);
});
