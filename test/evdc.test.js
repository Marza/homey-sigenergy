'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readEvdc, validateUnitId } = require('../lib/charging/evdc');

test('EVDC requires an explicit inverter unit ID and rejects the plant address', () => {
  for (const invalid of [undefined, true, '', 0, -1, 1.5, 247, 248, 'invalid']) {
    assert.equal(validateUnitId(invalid), null);
  }
  assert.equal(validateUnitId('1'), 1);
  assert.equal(validateUnitId(246), 246);
});

function reader(overrides = {}) {
  const blocks = {
    31502: [0, 12500],
    31504: [753, 0, 1350],
    31513: [3, 0, 0, 0, 0, 0, 1, 22, 0, 456],
    ...overrides,
  };
  return {
    async read(address, count, timeout) {
      assert.equal(timeout, 1000);
      const words = blocks[address];
      if (words instanceof Error) throw words;
      assert.equal(count, words.length);
      return words;
    },
  };
}
test('decode V2.9 signed watts, SoC and separate session and total kWh', async () => {
  const row = await readEvdc(reader());
  assert.deepEqual(row.values, {
    powerW: 12500,
    soc: 75.3,
    sessionKWh: 13.5,
    state: 3,
    totalChargedKWh: 655.58,
    totalDischargedKWh: 4.56,
  });
  assert.deepEqual(row.errors, {});
  const reverse = await readEvdc(reader({ 31502: [0xffff, 0xf63c] }));
  assert.equal(reverse.values.powerW, -2500);
});
test('invalid SoC and missing optional registers preserve a measured zero power', async () => {
  const row = await readEvdc(
    reader({ 31502: [0, 0], 31504: [0xffff, 0, 10], 31513: Error('unsupported') }),
  );
  assert.deepEqual(row.values, { powerW: 0, sessionKWh: 0.1 });
  assert.deepEqual(Object.keys(row.errors), [
    'soc',
    'state',
    'totalChargedKWh',
    'totalDischargedKWh',
  ]);
});
test('a failed or malformed power read remains unknown even with valid SoC', async () => {
  const failure = Error('timeout');
  const row = await readEvdc(reader({ 31502: failure }));
  assert.equal(row.powerFailure, failure);
  assert.ok(Number.isSafeInteger(row.powerReadAt));
  assert.equal(row.values.powerW, undefined);
  assert.equal(row.values.soc, 75.3);
  const malformed = await readEvdc(reader({ 31502: [0x8000, 0] }));
  assert.equal(malformed.values.powerW, undefined);
  assert.ok(malformed.errors.powerW);
});
