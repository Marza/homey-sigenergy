'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SmoS40Reader, decode16 } = require('../lib/nibe/smo-s40');
const { heatPumpPolicy } = require('../lib/backup/heat-pump-policy');
test('signed Nibe temperature decoding', () => assert.equal(decode16(65526, true), -10));
test('reads Nibe values without writing', async () => {
  const reads = [];
  const client = {
    async readInputRegisters(addr) {
      reads.push(addr);
      return { data: [200] };
    },
    close() {},
  };
  const reader = new SmoS40Reader({
    client,
    profile: { outdoorC: { address: 1, scale: 10, signed: true } },
  });
  assert.deepEqual(await reader.snapshot(), { outdoorC: 20 });
  assert.deepEqual(reads, [1]);
});
test('tariff block persists during normal grid mode', () => {
  const result = heatPumpPolicy({ gridMode: 'on-grid', tariffActive: true });
  assert.equal(result.auxiliaryHeatBlockRequested, true);
  assert.equal(result.controlApplied, false);
});
test('island and tariff reasons coexist', () => {
  const result = heatPumpPolicy({ gridMode: 'off-grid', tariffActive: true, batterySoc: 20 });
  assert.deepEqual(result.reasons, ['DEMAND_TARIFF', 'ISLAND_OR_UNKNOWN']);
  assert.equal(result.modeRequested, 'critical');
});
test('unknown status never clears island block', () => {
  assert.equal(heatPumpPolicy({ gridMode: 'unknown' }).auxiliaryHeatBlockRequested, true);
});
test('normal mode does not override existing Nibe schedule', () => {
  const result = heatPumpPolicy({ gridMode: 'on-grid' });
  assert.equal(result.auxiliaryHeatBlockRequested, false);
  assert.equal(result.controlApplied, false);
});

test('a sensor error preserves other readings and a recovered sensor returns on the next poll', async () => {
  const responses = new Map([
    [1, 0],
    [8, Object.assign(Error('Illegal address'), { modbusCode: 2 })],
    [39, 318],
    [88, 65535],
  ]);
  const reader = new SmoS40Reader({
    client: {
      readInputRegisters: async (address) => {
        const reply = responses.get(address);
        if (reply instanceof Error) throw reply;
        return { data: [reply] };
      },
    },
  });
  assert.deepEqual(await reader.snapshot(), { outdoorC: 0, supplyC: 31.8, returnC: -0.1 });
  assert.deepEqual(reader.errors, { hotWaterC: 'unsupported' });
  assert.ok(Number.isFinite(reader.outdoorReadAt));
  responses.set(8, 412);
  for (const invalid of [32768, 32769, 32767, 1001, -1, null]) {
    responses.set(1, invalid);
    assert.deepEqual(await reader.snapshot(), { hotWaterC: 41.2, supplyC: 31.8, returnC: -0.1 });
    assert.deepEqual(reader.errors, { outdoorC: 'invalid' });
    assert.equal(reader.outdoorReadAt, null);
  }
  responses.set(1, 65534);
  assert.equal((await reader.snapshot()).outdoorC, -0.2);
  assert.deepEqual(reader.errors, {});
});

test('distinguishes unreadable registers from invalid responses when all sensors fail', async () => {
  const reader = new SmoS40Reader({
    client: {
      readInputRegisters: async (address) => {
        if (address === 1) throw Error('ETIMEDOUT');
        if (address === 8) return { data: [32768] };
        return { data: [] };
      },
    },
  });
  assert.deepEqual(await reader.snapshot(), {});
  assert.deepEqual(reader.errors, {
    outdoorC: 'read-error',
    hotWaterC: 'invalid',
    supplyC: 'invalid',
    returnC: 'invalid',
  });
  assert.equal(reader.firstReadAt, null);
  assert.equal(reader.outdoorReadAt, null);
});
