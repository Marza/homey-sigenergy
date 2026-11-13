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
