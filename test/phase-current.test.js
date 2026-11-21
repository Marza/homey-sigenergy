'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { HistoryStore, SLOT_MS } = require('../lib/history');
const { bounded, MAX_STATE_BYTES } = require('../lib/history-format');
const { historySummary } = require('../lib/energy/phase-current');
const { SigenergyReader } = require('../lib/modbus');
const { phaseReaders, closePhaseReaders, pollPhaseCurrent } = require('../lib/energy/phase-reader');

const binding = 'a'.repeat(24);
const boundary = Date.parse('2026-10-01T10:00:00Z');

test('read the SDM630 register block and reject unsupported sources or invalid phase data', async () => {
  const reader = new SigenergyReader({ host: 'example.invalid' });
  reader.read = async (...args) => {
    assert.deepEqual(args, [6, 6, 1000]);
    return [0x41c4, 0, 0x4148, 0, 0x3f00, 0];
  };
  assert.deepEqual(await reader.phaseCurrents('grid'), [24.5, 12.5, 0.5]);
  reader.read = async () => [0x7fc0, 0, 0, 0, 0, 0];
  await assert.rejects(reader.phaseCurrents('grid'), /Invalid phase/);
  reader.read = async () => [0, -1];
  await assert.rejects(reader.phaseCurrents('inverter'), /Unsupported/);
});

test('read only connected gateway grid phases and measured inverter frequency', async () => {
  const reader = new SigenergyReader({ host: 'example.invalid', unitId: 247 });
  const calls = [];
  const words = (n) => [n >>> 16, n & 65535];
  reader.read = async (addr, count, timeout) => {
    calls.push([addr, count, timeout]);
    if (addr === 30004) return [1, 0, 0, 0, 0, 0];
    return (
      addr === 30286 ? [23379, 22963, 22583, 306, -196, 278] : [3, 4, -4, -644, -399, -586]
    ).flatMap(words);
  };
  assert.deepEqual(await reader.gatewayPhases(), {
    onGrid: true,
    volts: [233.79, 229.63, 225.83],
    amps: [3.06, 1.96, 2.78],
    activeKW: [0.003, 0.004, -0.004],
    reactiveKvar: [-0.644, -0.399, -0.586],
  });
  assert.deepEqual(calls, [
    [30004, 6, 1000],
    [30286, 12, 1000],
    [30052, 12, 1000],
  ]);
  reader.read = async () => [0];
  await assert.rejects(reader.gatewayPhases(), /not connected/);
  await assert.rejects(reader.gridFrequency(), /Inverter unit/);
  reader.unitId = 1;
  await assert.rejects(reader.gatewayPhases(), /unit 247/);
  reader.read = async (...args) => {
    assert.deepEqual(args, [31002, 1, 1000]);
    return [5002];
  };
  assert.equal(await reader.gridFrequency(), 50.02);
  reader.read = async () => [65535];
  assert.equal(await reader.gridFrequency(), null);
});

test('persist phase averages and peaks separately across quarter boundaries, gaps and source changes', () => {
  const data = new Map();
  const settings = { get: (key) => data.get(key), set: (key, value) => data.set(key, value) };
  const history = new HistoryStore(settings, () => boundary + 2 * SLOT_MS);
  const append = (amps, offset, meter = binding) =>
    history.observePhaseCurrent('grid', meter, amps, boundary + offset);
  append([0, 10, 20], -5000);
  append([10, 20, 24], 5000);
  history.flush();
  append([20, 22, 16], 15000);
  append(null, 25000);
  append([1, 1, 1], 35000);
  append([2, 2, 2], 96000);
  append([3, 3, 3], 106000, 'b'.repeat(24));
  append([4, 4, 4], 116000, 'b'.repeat(24));
  history.observePhaseCurrent('inverter', binding, [2, 3, 4], boundary + 5000);
  history.observePhaseCurrent('inverter', binding, [2, 3, 4], boundary + 15000);
  history.flush();

  const [prev, next] = history.getSlots();
  assert.deepEqual(prev.phaseCurrent.grid, {
    binding,
    ms: 5000,
    ampMs: [12500, 62500, 105000],
    peakA: [10, 20, 24],
  });
  assert.deepEqual(next.phaseCurrent.grid, {
    binding,
    ms: 15000,
    ampMs: [187500, 297500, 315000],
    peakA: [20, 22, 24],
  });
  assert.equal(next.phaseCurrent.inverter, undefined);
  assert.equal(next.gridWh, undefined);
  const summary = historySummary(history.getSlots(), boundary - SLOT_MS, boundary + SLOT_MS);
  assert.deepEqual(summary.grid.phases[0], { phase: 'L1', meanA: 10, peakA: 20 });
  assert.equal(summary.grid.coveredMs, 20000);
  assert.equal(summary.grid.fullQuarters, 0);
  const backup = history.export();
  assert.equal(backup.schema, 11);
  const legacy = structuredClone(backup);
  legacy.slots[0].phaseCurrent.inverter = structuredClone(legacy.slots[0].phaseCurrent.grid);
  assert.doesNotThrow(() => history.previewImport(legacy));
  assert.equal(history.previewImport(backup).conflictingSlots, 0);
  assert.throws(
    () => history.previewImport({ ...backup, schema: 10 }),
    /requires export version 11/,
  );
  backup.slots[0].phaseCurrent.grid.ms = SLOT_MS + 1;
  assert.throws(() => history.previewImport(backup), /Invalid phase current quarter/);
});

test('configure the grid phase reader and discard reads from an old connection', async () => {
  const readers = phaseReaders(
    {
      host: 'inverter.invalid',
      evdcEnabled: true,
      evdcUnitId: 2,
      addressOffset: -1,
      phaseMeterHost: 'meter.invalid',
      phaseMeterPort: 1502,
      phaseMeterUnitId: 8,
    },
    10,
  );
  assert.equal(readers.grid.reader.unitId, 8);
  assert.equal(readers.grid.reader.port, 1502);
  assert.equal(readers.grid.reader.addressOffset, 0);
  assert.equal(
    phaseReaders({ host: 'inverter.invalid', phaseInverterUnitId: 4 }, 10).inverter,
    undefined,
  );
  assert.equal(
    phaseReaders({ phaseMeterHost: 'meter.invalid', phaseMeterPort: 0 }, 10).grid.reader,
    null,
  );
  const observations = [];
  const data = new Map();
  const homey = {
    app: { history: { observePhaseCurrent: (...args) => observations.push(args) } },
    settings: { set: (key, value) => data.set(key, value) },
  };
  const entry = readers.grid;
  entry.reader.phaseCurrents = async () => [4, 8, 23];
  await pollPhaseCurrent(homey, 'grid', entry, () => true);
  assert.deepEqual(data.get('gridPhaseCurrent').amps, [4, 8, 23]);
  assert.deepEqual(observations[0].slice(0, 3), ['grid', entry.binding, [4, 8, 23]]);
  entry.reader.phaseCurrents = async () => {
    throw Error('timeout');
  };
  await pollPhaseCurrent(homey, 'grid', entry, () => true);
  assert.equal(data.get('gridPhaseCurrent').state, 'read-error');
  assert.equal(observations[1][2], null);

  let resolve;
  let current = true;
  entry.reader.phaseCurrents = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = pollPhaseCurrent(homey, 'grid', entry, () => current);
  current = false;
  closePhaseReaders(readers, homey);
  resolve([5, 8, 23]);
  await pending;
  assert.equal(data.get('gridPhaseCurrent').state, 'read-error');
  assert.equal(observations.length, 3);
});

test('selecting the Gateway uses the plant connection and creates a distinct history binding', () => {
  const settings = {
    host: 'plant.invalid',
    port: 5020,
    unitId: 247,
    addressOffset: -1,
    phaseMeterHost: 'meter.invalid',
    phaseMeterPort: 1502,
    phaseMeterUnitId: 8,
  };
  const original = phaseReaders(settings, 10).grid;
  const explicitMeter = phaseReaders({ ...settings, phaseMeterSource: 'sdm630' }, 10).grid;
  assert.equal(explicitMeter.binding, original.binding);
  const gateway = phaseReaders({ ...settings, phaseMeterSource: 'gateway' }, 10).grid;
  assert.equal(gateway.profile, 'gateway');
  assert.equal(gateway.reader.host, settings.host);
  assert.equal(gateway.reader.port, settings.port);
  assert.equal(gateway.reader.unitId, 247);
  assert.equal(gateway.reader.addressOffset, -1);
  assert.notEqual(gateway.binding, original.binding);
  assert.equal(phaseReaders({ ...settings, phaseMeterSource: 'invalid' }, 10).grid.reader, null);
});

test('trim the oldest phase observations first when the history reaches its size limit', () => {
  const phaseCurrent = { grid: { binding, ms: SLOT_MS, ampMs: [0, 0, 0], peakA: [0, 0, 0] } };
  const slots = [0, SLOT_MS].map((t) => ({ t, gridWh: 100, phaseCurrent }));
  const state = { slots, other: 'a'.repeat(MAX_STATE_BYTES - 270) };
  const trimmed = bounded(state);
  assert.deepEqual(trimmed.slots[0], { t: 0, gridWh: 100 });
  assert.equal(trimmed.slots[1], slots[1]);
  assert.equal(slots[0].phaseCurrent, phaseCurrent);
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= MAX_STATE_BYTES);
});
