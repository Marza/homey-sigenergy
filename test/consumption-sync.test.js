'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { fetchConsumption, monthWindow, shouldSync } = require('../lib/pricing/consumption-sync');
const HOUR = 3600000;
const now = new Date('2026-11-13T12:30:00Z');
const opts = { token: 'secret-token', homeId: 'home', configRevision: 'revision', now };
function mock({ homes = [{ id: 'home' }], value = 2, missing = false, transform = (x) => x } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      calls.push(body);
      if (!body.variables) return { ok: true, json: async () => ({ data: { viewer: { homes } } }) };
      const { last, before, id } = body.variables;
      const end = Date.parse(Buffer.from(before, 'base64').toString());
      const nodes = Array.from({ length: last }, (_, i) => ({
        from: new Date(end - (last - i) * HOUR).toISOString(),
        to: new Date(end - (last - i - 1) * HOUR).toISOString(),
        consumption: missing && i === 0 ? null : value,
        consumptionUnit: 'kWh',
      }));
      return {
        ok: true,
        json: async () => transform({ data: { viewer: { home: { id, consumption: { nodes } } } } }),
      };
    },
  };
}
test('Stockholm month windows include DST hours and daily policy retries errors without hammering', () => {
  assert.equal(monthWindow(now).from, Date.parse('2026-10-31T23:00Z'));
  const october = new Date('2026-10-31T23:00Z'); // November has just begun locally.
  assert.equal(monthWindow(october).from, october.getTime());
  assert.equal(shouldSync({ ...opts, revision: 'revision', sync: null }), true);
  assert.equal(shouldSync({ ...opts, revision: 'revision', token: '' }), false);
  const sync = {
    configRevision: 'revision',
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
  };
  assert.equal(shouldSync({ ...opts, revision: 'revision', sync }), false);
  assert.equal(shouldSync({ ...opts, revision: 'new', sync }), true);
  assert.equal(
    shouldSync({ ...opts, revision: 'revision', sync: { ...sync, lastSuccessAt: null } }),
    false,
  );
  assert.equal(
    shouldSync({
      ...opts,
      revision: 'revision',
      now: new Date(+now + HOUR),
      sync: { ...sync, lastSuccessAt: null },
    }),
    true,
  );
  assert.equal(
    shouldSync({ ...opts, revision: 'revision', now: new Date('2026-11-13T23:01Z'), sync }),
    true,
  );
  assert.equal(
    shouldSync({
      ...opts,
      revision: 'revision',
      sync: { ...sync, lastSuccessAt: 'invalid', lastAttemptAt: 'invalid' },
    }),
    true,
  );
});
test('fetches hourly current-month snapshots with missing values and corrections, not invented quarters', async () => {
  const m = mock({ missing: true });
  const state = await fetchConsumption({ ...opts, ...m });
  assert.equal(state.hours.length, (state.to - state.from) / HOUR - 1);
  assert.equal(state.hours[0].importWh, 2000);
  assert.equal(state.configRevision, 'revision');
  assert.equal(m.calls.length, 2);
  assert.equal(
    (await fetchConsumption({ ...opts, ...mock({ value: 3 }) })).hours[0].importWh,
    3000,
  );
  assert.equal(await fetchConsumption({ ...opts, now: new Date('2026-11-01T00:05+01:00') }), null);
  const single = await fetchConsumption({ ...opts, homeId: undefined, ...mock() });
  assert.ok(single.hours.length);
});
test('October month window retains both repeated autumn hours before rollover', async () => {
  const n = new Date('2026-10-31T22:59:00Z'); // 744 completed hours before last local hour.
  const m = mock();
  const state = await fetchConsumption({ ...opts, now: n, ...m });
  assert.equal(state.hours.length, 744);
  const full = new Date('2026-10-31T23:00Z');
  // Direct window behavior at rollover is tested above; final October snapshot can contain at most 744 completed hours.
  assert.equal(monthWindow(full).to, monthWindow(full).from);
  assert.ok(state.hours.some((x) => x.t === Date.parse('2026-10-25T00:00Z')));
  assert.ok(state.hours.some((x) => x.t === Date.parse('2026-10-25T01:00Z')));
});
test('invalid homes, pages, upstream errors and credentials fail without leaking upstream text', async () => {
  await assert.rejects(fetchConsumption({ ...opts, token: '' }), /token missing/);
  await assert.rejects(fetchConsumption({ ...opts, homeId: 42 }), /home ID/);
  for (const homes of [null, [], [{ id: 'other' }], [{ id: 'home' }, { id: 'home' }]])
    await assert.rejects(fetchConsumption({ ...opts, ...mock({ homes }) }));
  await assert.rejects(
    fetchConsumption({
      ...opts,
      homeId: undefined,
      ...mock({ homes: [{ id: 'a' }, { id: 'b' }] }),
    }),
  );
  for (const transform of [
    (x) => ({ ...x, errors: [{ message: 'secret-token' }] }),
    () => ({ data: {} }),
    (x) => {
      x.data.viewer.home.id = 'other';
      return x;
    },
    (x) => {
      x.data.viewer.home.consumption.nodes[0].consumption = -1;
      return x;
    },
  ])
    await assert.rejects(
      fetchConsumption({ ...opts, ...mock({ transform }) }),
      (e) => !e.message.includes('secret-token'),
    );
  for (const fetchImpl of [
    async () => {
      throw Error('secret-token');
    },
    async () => ({ ok: false }),
    async () => ({
      ok: true,
      json: async () => {
        throw Error('secret-token');
      },
    }),
  ])
    await assert.rejects(
      fetchConsumption({ ...opts, fetchImpl }),
      (e) => !e.message.includes('secret-token'),
    );
});

test('explicit previous month fetch paginates all 745 October hours without duplicate DST intervals', async () => {
  const m = mock();
  const state = await fetchConsumption({ ...opts, ...m, month: '2026-10' });
  assert.equal(state.hours.length, 745);
  assert.equal(m.calls.length, 3);
  assert.deepEqual(
    m.calls.slice(1).map((c) => c.variables.last),
    [744, 1],
  );
  assert.equal(new Set(state.hours.map((h) => h.t)).size, 745);
  await assert.rejects(fetchConsumption({ ...opts, ...mock(), month: '2026-12' }), /Future/);
});
