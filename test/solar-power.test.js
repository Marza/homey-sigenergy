'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SigenergyReader } = require('../lib/modbus');
function words(watts) {
  return [(watts >>> 16) & 65535, watts & 65535];
}
function fixture({ own = 1200, third = 3400, unitId = 247, offset = 0 } = {}) {
  const reader = new SigenergyReader({ host: '192.0.2.10', unitId, addressOffset: offset });
  const calls = [];
  // Mock the actual Modbus boundary: the shared reader must still apply offset/FC04.
  reader.connected = true;
  reader.client.setTimeout = () => {};
  reader.client.close = () => {};
  reader.connect = async () => {};
  reader.client.readInputRegisters = async (address, count) => {
    calls.push({ address, count });
    const values = { 30009: 0, 30005: -500, 30014: 600, 30037: 900, 30083: 4200 };
    const logical = address - offset;
    const value = logical === 30035 ? own : logical === 30194 ? third : values[logical];
    if (value instanceof Error) throw value;
    if (Array.isArray(value)) return { data: value };
    assert.notEqual(value, undefined, `Unexpected register ${logical}`);
    return { data: count === 1 ? [value] : words(value) };
  };
  return { reader, calls };
}
test('default own PV is unchanged and does not probe third-party power', async () => {
  const { reader, calls } = fixture();
  const data = await reader.snapshot();
  assert.equal(data.pvW, 1200);
  assert.equal(data.selfPvW, 1200);
  assert.equal(data.thirdPartyPvW, null);
  assert.equal(calls.length, 6);
  assert.ok(!calls.some((c) => c.address === 30194));
});
test('explicit third-party and combined modes select distinct watts on the same plant connection', async () => {
  for (const [mode, expected] of [
    ['third-party', 3400],
    ['combined', 4600],
  ]) {
    const { reader, calls } = fixture({ offset: -1 });
    const data = await reader.snapshot(mode);
    assert.equal(data.pvW, expected);
    assert.equal(data.selfPvW, 1200);
    assert.equal(data.thirdPartyPvW, 3400);
    assert.equal(data.gridW, -500);
    assert.equal(data.essW, 900);
    assert.equal(data.soc, 60);
    assert.equal(calls.length, 7);
    assert.deepEqual(calls.at(-1), { address: 30193, count: 2 });
  }
});
test('zero is real; missing/invalid selected components never become a partial sum or retained solar', async () => {
  for (const own of [0, 1200]) {
    const { reader } = fixture({ own, third: 0 });
    assert.equal((await reader.snapshot('combined')).pvW, own);
  }
  for (const third of [
    new Error('timeout'),
    -1,
    0x7fffffff,
    10000001,
    [0],
    [0, NaN],
    [0, 1.5],
    [-1, 0],
    [0, 65536],
  ]) {
    const { reader } = fixture({ third });
    for (const mode of ['third-party', 'combined']) {
      const data = await reader.snapshot(mode);
      assert.equal(data.pvW, null);
      assert.equal(data.gridW, -500);
      assert.equal(data.soc, 60);
      assert.equal(data.essW, 900);
    }
  }
  const { reader } = fixture({ own: new Error('unsupported') });
  assert.equal((await reader.snapshot('combined')).pvW, null);
  assert.equal((await reader.snapshot('third-party')).pvW, 3400);
  assert.equal((await reader.snapshot('self')).pvW, null);
  const huge = fixture({ own: 6000000, third: 6000000 });
  assert.equal((await huge.reader.snapshot('combined')).pvW, null);
});
test('unsupported units and source selections never silently read another solar boundary', async () => {
  const { reader, calls } = fixture({ unitId: 1 });
  assert.equal((await reader.snapshot('combined')).pvW, null);
  assert.ok(!calls.some((c) => c.address === 30194));
  assert.equal((await reader.snapshot('self')).pvW, 1200);
  const count = calls.length;
  await assert.rejects(reader.snapshot('auto'), /solar energy source/);
  assert.equal(calls.length, count);
});
