'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../api');
const manifest = require('../app.json');
const { HistoryStore } = require('../lib/history');

test('all history routes are authenticated and delegate to the same validated store', async () => {
  const now = Date.parse('2026-01-01T00:00:10Z');
  const values = new Map([['tibberToken', 'must-not-export']]);
  const settings = {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, structuredClone(value)),
  };
  const history = new HistoryStore(settings, () => now);
  history.append({ gridW: 3600 }, now - 10000);
  history.append({ gridW: 3600 }, now);
  const homey = { settings, app: { history } };
  const file = await api.exportHistory({ homey });
  assert.deepEqual(file.history, history.export());
  assert.equal(file.schema, 1);
  assert.equal(file.meter, null);
  assert.equal(JSON.stringify(file).includes('must-not-export'), false);
  for (const name of Object.keys(api)) assert.equal(manifest.api[name].public, false);
  const preview = await api.previewHistoryImport({ homey, body: file });
  assert.equal(preview.slots, 1);
  const before = structuredClone(values.get('historyState'));
  await assert.rejects(
    api.importHistory({ homey, body: { ...file, tibberToken: 'secret' } }),
    /Invalid backup/,
  );
  assert.deepEqual(values.get('historyState'), before);
  const result = await api.importHistory({ homey, body: file });
  assert.equal(result.restored, true);
  assert.equal(values.get('historyState').slots[0].gridWh, 10);
});
