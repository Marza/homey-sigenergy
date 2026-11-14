'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  PROFILE,
  REGISTERS,
  CAPABILITIES,
  decodeEnergy,
  sourceKey,
  validateState,
  advance,
  projectMeters,
} = require('../lib/energy/meters');
const { SigenergyReader } = require('../lib/modbus');
const key = sourceKey({ host: 'fixture', unitId: 247 }),
  now = 1000000;
const values = (raw = '100000') => Object.fromEntries(Object.keys(REGISTERS).map((k) => [k, raw]));
function words(raw) {
  let n = BigInt(raw);
  const result = Array(4);
  for (let i = 3; i >= 0; i--) {
    result[i] = Number(n & 65535n);
    n >>= 16n;
  }
  return result;
}
test('V2.9 register profile reads exact plant U64 words without mixing old/reserved counters', async () => {
  assert.deepEqual(REGISTERS, {
    solar: 30236,
    charged: 30244,
    discharged: 30248,
    imported: 30260,
    exported: 30264,
  });
  const reader = new SigenergyReader({ host: 'fixture', unitId: 247 }),
    calls = [];
  reader.read = async (address, count) => {
    calls.push({ address, count });
    if (address === 30244) throw Object.assign(Error('unsupported'), { modbusCode: 2 });
    return words('4294967312');
  };
  const result = await reader.energyCounters(PROFILE);
  assert.equal(result.values.solar, '4294967312');
  assert.equal(result.errors.charged, 'unavailable');
  assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c.count === 4));
  await assert.rejects(reader.energyCounters('legacy'), /profile/);
  reader.unitId = 1;
  await assert.rejects(reader.energyCounters(PROFILE), /247/);
});
test('U64 decoding preserves high words and rejects sentinels, malformed and unsafe magnitudes', () => {
  for (const raw of ['0', '1', '65536', '4294967296', '100000000000000'])
    assert.equal(decodeEnergy(words(raw)), raw);
  for (const bad of [[65535, 65535, 65535, 65535], [0, 0, 0], [0, 0, 0, -1], [0, 0, 0, 1.5], null])
    assert.throws(() => decodeEnergy(bad));
});
test('persistent cumulative values survive restart/offline gaps and never add the first lifetime value twice', () => {
  const first = advance(null, { values: values(), key, now });
  assert.equal(first.values.imported, 1000);
  assert.equal(first.state.channels.imported.total, '100000');
  const restarted = advance(JSON.parse(JSON.stringify(first.state)), {
    values: values('100050'),
    key,
    now: now + 60000,
  });
  assert.equal(restarted.values.imported, 1000.5);
  const offline = advance(restarted.state, { values: values('200050'), key, now: now + 86400000 });
  assert.equal(offline.values.imported, 2000.5);
  const repeated = advance(offline.state, { values: values('200050'), key, now: now + 86400000 });
  assert.equal(repeated.values.imported, 2000.5);
  assert.equal(first.state.channels.imported.total, '100000');
});
test('decreases freeze against the high-water mark; transient low values cannot cause a subsequent double count', () => {
  const first = advance(null, { values: values(), key, now });
  const low = advance(first.state, { values: values('0'), key, now: now + 60000 });
  assert.equal(low.values.imported, undefined);
  assert.equal(low.errors.imported, 'reset-required');
  assert.deepEqual(low.state, first.state);
  const recovered = advance(low.state, { values: values('100010'), key, now: now + 120000 });
  assert.equal(recovered.values.imported, 1000.1);
  const acknowledged = advance(first.state, {
    values: values('30'),
    key,
    epoch: 1,
    now: now + 180000,
  });
  assert.equal(acknowledged.values.imported, 1000);
  const after = advance(acknowledged.state, {
    values: values('80'),
    key,
    epoch: 1,
    now: now + 240000,
  });
  assert.equal(after.values.imported, 1000.5);
  const restart = advance(JSON.parse(JSON.stringify(after.state)), {
    values: values('80'),
    key,
    epoch: 1,
    now: now + 250000,
  });
  assert.equal(restart.values.imported, 1000.5);
});
test('source binding, epoch rollback, future time, jumps and partial fields fail independently', () => {
  const first = advance(null, { values: values(), key, now });
  const other = sourceKey({ host: 'other' });
  assert.notEqual(key, other);
  assert.equal(key, sourceKey({ host: 'FIXTURE', port: '502', unitId: '247', addressOffset: '0' }));
  assert.equal(
    advance(first.state, { values: values(), key: other, now: now + 60000 }).errors.solar,
    'source-changed',
  );
  const rebound = advance(first.state, {
    values: values('5'),
    key: other,
    epoch: 1,
    now: now + 60000,
  });
  assert.equal(rebound.values.solar, 1000);
  assert.equal(
    advance(rebound.state, { values: values('6'), key: other, epoch: 0, now: now + 120000 }).errors
      .solar,
    'invalid',
  );
  assert.equal(
    advance(first.state, { values: values(), key, now: now - 1 }).errors.solar,
    'invalid',
  );
  assert.equal(
    advance(first.state, { values: values('900000000'), key, now: now + 60000 }).errors.solar,
    'invalid',
  );
  const partial = advance(first.state, {
    values: { ...values('100001'), solar: 'invalid' },
    key,
    now: now + 60000,
  });
  assert.equal(partial.values.solar, undefined);
  assert.equal(partial.values.imported, 1000.01);
  assert.throws(() => advance(first.state, { values: values(), key, epoch: -1, now }));
  assert.throws(() => advance(first.state, { values: values(), key: 'invalid', now }));
});
test('corrupt persisted state is refused rather than silently resetting the cumulative baseline', () => {
  const valid = advance(null, { values: values(), key, now }).state;
  for (const corrupt of [
    { schema: 2, channels: {} },
    { ...valid, extra: true },
    { schema: 1, channels: { unknown: {} } },
    { schema: 1, channels: { solar: {} } },
    { schema: 1, channels: [] },
    null,
  ])
    assert.throws(() => validateState(corrupt));
  for (const value of ['-1', '01', '9007199254740992', '1e5']) {
    const copy = structuredClone(valid);
    copy.channels.solar.raw = value;
    assert.throws(() => validateState(copy));
  }
  const copy = structuredClone(valid);
  copy.channels.solar.readAt = -1;
  assert.throws(() => validateState(copy));
});
test('capability projection keeps individual missing counters null and reports disabled/stale/reset state', () => {
  const meters = {
    readAt: Date.now(),
    values: { solar: 10, imported: 0, exported: 2, charged: 3, discharged: 4 },
    errors: {},
  };
  for (const role of Object.keys(CAPABILITIES)) {
    const projected = projectMeters(role, { meterProfile: PROFILE, meters });
    assert.equal(projected.status, 'ok');
    assert.deepEqual(Object.keys(projected.values), Object.values(CAPABILITIES[role]));
  }
  assert.equal(
    projectMeters('grid', { meterProfile: PROFILE, meters }).values['meter_power.imported'],
    0,
  );
  assert.equal(projectMeters('grid', null).status, 'disabled');
  assert.equal(projectMeters('grid', { meterProfile: PROFILE }).status, 'waiting');
  assert.equal(
    projectMeters('grid', {
      meterProfile: PROFILE,
      meters: { ...meters, readAt: Date.now() - 180001 },
    }).status,
    'stale',
  );
  assert.equal(
    projectMeters('grid', {
      meterProfile: PROFILE,
      meters: { ...meters, readAt: Date.now() + 10000 },
    }).status,
    'stale',
  );
  assert.equal(
    projectMeters('grid', {
      meterProfile: PROFILE,
      meters: { ...meters, values: { imported: 1 }, errors: { exported: 'reset-required' } },
    }).status,
    'reset-required',
  );
  for (const reason of ['reset-required', 'source-changed', 'invalid'])
    assert.equal(
      projectMeters('grid', {
        meterProfile: PROFILE,
        meters: { ...meters, values: {}, errors: { imported: reason, exported: reason } },
      }).status,
      reason,
    );
  assert.throws(() => projectMeters('unknown', {}));
  assert.throws(() => projectMeters('toString', {}));
});

test('an acknowledged reset is consumed independently when a previously missing channel recovers', () => {
  const initial = advance(null, { values: values(), key, now });
  const partial = advance(initial.state, {
    values: { solar: '2' },
    key,
    epoch: 1,
    now: now + 60000,
  });
  assert.equal(partial.values.solar, 1000);
  assert.equal(partial.state.channels.imported.epoch, 0);
  const recovered = advance(partial.state, {
    values: values('12'),
    key,
    epoch: 1,
    now: now + 120000,
  });
  assert.equal(recovered.values.solar, 1000.1);
  assert.equal(recovered.values.imported, 1000);
  assert.equal(recovered.state.channels.imported.epoch, 1);
});

test('optional meter transport failure stops the batch while one invalid value leaves other fields readable', async () => {
  const reader = new SigenergyReader({ host: 'fixture', unitId: 247 });
  let calls = 0;
  reader.read = async (_address, _count, timeout) => {
    calls++;
    assert.equal(timeout, 1000);
    throw Error('network');
  };
  const failed = await reader.energyCounters(PROFILE);
  assert.equal(calls, 1);
  assert.equal(Object.keys(failed.errors).length, 5);
  reader.read = async (address) =>
    address === 30236 ? [65535, 65535, 65535, 65535] : words('2000');
  const partial = await reader.energyCounters(PROFILE);
  assert.equal(partial.errors.solar, 'invalid');
  assert.equal(partial.values.imported, '2000');
});

test('third-party and combined solar modes choose distinct registers and never replace missing components with zero', async () => {
  const { sumEnergy, solarSourceKey } = require('../lib/energy/meters');
  const reader = new SigenergyReader({ host: 'fixture', unitId: 247 }),
    calls = [];
  reader.read = async (address) => {
    calls.push(address);
    return words(address === 30236 ? '0' : address === 30240 ? '7654300' : '1000');
  };
  assert.equal((await reader.energyCounters(PROFILE, 'third-party')).values.solar, '7654300');
  assert.ok(!calls.includes(30236));
  calls.length = 0;
  assert.equal((await reader.energyCounters(PROFILE, 'combined')).values.solar, '7654300');
  assert.ok(calls.includes(30236) && calls.includes(30240));
  reader.read = async (address) => {
    if (address === 30236) throw Object.assign(Error('unsupported'), { modbusCode: 2 });
    return words('2000');
  };
  const partial = await reader.energyCounters(PROFILE, 'combined');
  assert.equal(partial.values.solar, undefined);
  assert.equal(partial.errors.solar, 'unavailable');
  assert.equal(partial.values.imported, '2000');
  assert.equal(sumEnergy(['100', '200']), '300');
  assert.throws(() => sumEnergy(['100', undefined]));
  assert.throws(() => sumEnergy(['100000000000000', '1']));
  await assert.rejects(reader.energyCounters(PROFILE, 'unknown'), /solar/);
  const settings = { host: 'fixture', unitId: 247 };
  assert.equal(
    sourceKey(settings),
    'a11f600aa7d0a7a674f2c2eeeb1178c461e4eac9abd8acfd7879e68e519053ae',
  );
  assert.equal(solarSourceKey(settings), sourceKey(settings));
  assert.notEqual(
    solarSourceKey({ ...settings, energySolarSource: 'combined' }),
    sourceKey(settings),
  );
  assert.throws(() => solarSourceKey({ ...settings, energySolarSource: 'unknown' }));
});
test('changing solar scope cannot inject a lifetime total into the current Energy day', () => {
  const { solarSourceKey } = require('../lib/energy/meters');
  const settings = { host: 'fixture', unitId: 247 };
  const first = advance(null, { values: { ...values(), solar: '0' }, key, now });
  const solarKey = solarSourceKey({ ...settings, energySolarSource: 'combined' });
  const switched = advance(first.state, {
    values: { ...values('100001'), solar: '7654300' },
    key,
    solarKey,
    now: now + 60000,
  });
  assert.equal(switched.values.solar, undefined);
  assert.equal(switched.errors.solar, 'source-changed');
  assert.equal(switched.sourceValues.solar, 76543);
  assert.equal(switched.values.imported, 1000.01);
  const acknowledged = advance(switched.state, {
    values: { ...values('100002'), solar: '7654301' },
    key,
    solarKey,
    solarEpoch: 1,
    now: now + 120000,
  });
  assert.equal(acknowledged.values.solar, 0);
  assert.equal(acknowledged.values.imported, 1000.02);
  const next = advance(acknowledged.state, {
    values: { ...values('100003'), solar: '7654311' },
    key,
    solarKey,
    solarEpoch: 1,
    now: now + 180000,
  });
  assert.equal(next.values.solar, 0.1);
  assert.equal(next.sourceValues.solar, 76543.11);
  assert.throws(() => advance(first.state, { values: values(), key, solarKey: 'invalid', now }));
});
