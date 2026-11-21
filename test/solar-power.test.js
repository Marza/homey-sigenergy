'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SigenergyReader } = require('../lib/modbus');
function words(watts) {
  return [(watts >>> 16) & 65535, watts & 65535];
}
function fixture({ own = 1200, third = 3400, unitId = 247, offset = 0, rejectBlock } = {}) {
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
    if (count > 2) {
      if (rejectBlock || (logical === 30035 && own instanceof Error))
        throw Object.assign(new Error('Illegal address'), { modbusCode: 2 });
      if (logical === 30005 && count === 5) return { data: [...words(-500), 0, 0, 0] };
      if (logical === 30035 && count === 4) return { data: [...words(own), ...words(900)] };
      throw Error('Unexpected block');
    }
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
  assert.equal(calls.length, 4);
  assert.ok(!calls.some((c) => c.address === 30194));
});
test('intermediate plant poll reads power without reading the SoC register', async () => {
  const { reader, calls } = fixture();
  const data = await reader.snapshot('self', false);
  assert.ok(!calls.some((c) => c.address === 30014));
  assert.equal(data.soc, undefined);
  assert.equal(data.essW, 900);
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
    assert.equal(calls.length, 5);
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

test('one minute keeps six power polls, reads capacity and SoC once and uses 14 own-PV requests', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 60000 });
  const { reader, calls } = fixture();
  for (let i = 0; i < 6; i++) {
    const sample = await reader.snapshot('self', i === 0);
    assert.equal(sample.capacityKWh, 42);
    assert.equal(sample.essW, 900);
    t.mock.timers.tick(10000);
  }
  assert.equal(calls.length, 14);
  const orig = reader.client.readInputRegisters;
  reader.client.readInputRegisters = (address, count) => {
    if (address === 30083) throw Error('unavailable');
    return orig(address, count);
  };
  const next = await reader.snapshot();
  assert.equal(next.capacityKWh, null);
  assert.equal(next.gridW, -500);
  reader.client.readInputRegisters = orig;
  assert.equal((await reader.snapshot('self', false)).capacityKWh, null);
  t.mock.timers.tick(60000);
  assert.equal((await reader.snapshot()).capacityKWh, 42);
});

test('firmware rejecting block reads uses the original inputs on every later poll', async () => {
  const { reader, calls } = fixture({ rejectBlock: true });
  for (let i = 0; i < 2; i++) {
    const sample = await reader.snapshot('combined');
    assert.equal(sample.gridW, -500);
    assert.equal(sample.gridMode, 0);
    assert.equal(sample.pvW, 4600);
    assert.equal(sample.essW, 900);
  }
  assert.equal(calls.filter((c) => c.count > 2).length, 2);
});

test('short and timed-out blocks never manufacture readings or disable the next block attempt', async () => {
  const { reader } = fixture();
  const read = reader.read.bind(reader);
  reader.read = async () => [0];
  await assert.rejects(reader.snapshot(), /Incomplete/);
  reader.read = async () => {
    throw Error('timeout');
  };
  await assert.rejects(reader.snapshot(), /timeout/);
  reader.read = read;
  assert.equal((await reader.snapshot()).gridW, -500);
});
