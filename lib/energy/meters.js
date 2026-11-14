'use strict';
const { createHash } = require('node:crypto');
const PROFILE = 'sigenergy-v29-statistics';
// Manufacturer V2.9, table 5-1, pp.13-14. Plant address 247, input registers, U64 /100 kWh.
const REGISTERS = Object.freeze({
  solar: 30236,
  charged: 30244,
  discharged: 30248,
  imported: 30260,
  exported: 30264,
});
const CAPABILITIES = Object.freeze({
  grid: { imported: 'meter_power.imported', exported: 'meter_power.exported' },
  solar: { solar: 'meter_power' },
  battery: { charged: 'meter_power.charged', discharged: 'meter_power.discharged' },
});
const MAX_CENTI = 100000000000000n;
function centi(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,14})$/.test(value) || BigInt(value) > MAX_CENTI)
    throw Error('Invalid cumulative energy');
  return BigInt(value);
}
function decodeEnergy(words) {
  if (
    !Array.isArray(words) ||
    words.length !== 4 ||
    words.some((w) => !Number.isInteger(w) || w < 0 || w > 65535)
  )
    throw Error('Invalid U64 energy registers');
  const raw = words.reduce((n, w) => (n << 16n) | BigInt(w), 0n);
  if (raw > MAX_CENTI) throw Error('Energy register outside supported range');
  return raw.toString();
}
function sourceKey(settings) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        String(settings.host || '')
          .trim()
          .toLowerCase(),
        Number(settings.port ?? 502),
        Number(settings.unitId ?? 247),
        Number(settings.addressOffset ?? 0),
        PROFILE,
      ]),
    )
    .digest('hex');
}
function validateState(state) {
  if (
    !state ||
    state.schema !== 1 ||
    Object.keys(state).some((k) => !['schema', 'channels'].includes(k)) ||
    !state.channels ||
    typeof state.channels !== 'object' ||
    Array.isArray(state.channels)
  )
    throw Error('Invalid cumulative energy state');
  for (const [key, e] of Object.entries(state.channels)) {
    if (
      !Object.hasOwn(REGISTERS, key) ||
      !e ||
      Object.keys(e).some((k) => !['raw', 'total', 'readAt', 'sourceKey', 'epoch'].includes(k)) ||
      !Number.isSafeInteger(e.readAt) ||
      e.readAt < 0 ||
      !Number.isSafeInteger(e.epoch) ||
      e.epoch < 0 ||
      typeof e.sourceKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(e.sourceKey)
    )
      throw Error('Invalid cumulative energy channel');
    centi(e.raw);
    centi(e.total);
  }
  return state;
}
function advance(previous, { values, key, epoch = 0, now = Date.now() }) {
  if (previous) validateState(previous);
  if (
    typeof key !== 'string' ||
    !/^[0-9a-f]{64}$/.test(key) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw Error('Invalid cumulative energy context');
  const state = structuredClone(previous || { schema: 1, channels: {} }),
    accepted = {},
    errors = {};
  for (const name of Object.keys(REGISTERS)) {
    let raw;
    try {
      raw = centi(values?.[name]);
    } catch {
      errors[name] = 'invalid';
      continue;
    }
    const old = state.channels[name];
    let total = raw;
    if (old) {
      if (now < old.readAt || epoch < old.epoch) {
        errors[name] = 'invalid';
        continue;
      }
      if (epoch > old.epoch) {
        // Explicit operator acknowledgement starts a new segment without inventing energy across the gap.
        total = centi(old.total);
      } else {
        if (old.sourceKey !== key) {
          errors[name] = 'source-changed';
          continue;
        }
        const delta = raw - centi(old.raw);
        if (delta < 0n) {
          errors[name] = 'reset-required';
          continue;
        }
        // Broad 10 MW software guard, not a hardware rating. True cumulative counters can cover an offline gap.
        const maximum = BigInt(Math.ceil((1000000 * (now - old.readAt)) / 3600000) + 100);
        if (delta > maximum) {
          errors[name] = 'invalid';
          continue;
        }
        total = centi(old.total) + delta;
      }
    }
    if (total > MAX_CENTI) {
      errors[name] = 'invalid';
      continue;
    }
    state.channels[name] = {
      raw: raw.toString(),
      total: total.toString(),
      readAt: now,
      sourceKey: key,
      epoch,
    };
    accepted[name] = Number(total) / 100;
  }
  return { state, values: accepted, errors, readAt: now };
}
function projectMeters(role, snapshot, now = Date.now()) {
  const mapping = Object.hasOwn(CAPABILITIES, role) ? CAPABILITIES[role] : null;
  if (!mapping) throw Error('Unknown Energy role');
  const result = {
    values: Object.fromEntries(Object.values(mapping).map((c) => [c, null])),
    status: 'waiting',
  };
  const meters = snapshot?.meters;
  if (snapshot?.meterProfile !== PROFILE) {
    result.status = 'disabled';
    return result;
  }
  if (!meters) return result;
  if (!Number.isFinite(meters.readAt) || meters.readAt > now || now - meters.readAt > 180000) {
    result.status = 'stale';
    return result;
  }
  let valid = 0;
  const reasons = [];
  for (const [name, cap] of Object.entries(mapping)) {
    const value = meters.values?.[name];
    if (Number.isFinite(value) && value >= 0 && value <= Number(MAX_CENTI) / 100) {
      result.values[cap] = value;
      valid++;
    } else reasons.push(meters.errors?.[name]);
  }
  result.status =
    valid === Object.keys(mapping).length
      ? 'ok'
      : reasons.includes('source-changed')
        ? 'source-changed'
        : reasons.includes('reset-required')
          ? 'reset-required'
          : valid
            ? 'partial'
            : 'invalid';
  return result;
}
module.exports = {
  PROFILE,
  REGISTERS,
  CAPABILITIES,
  decodeEnergy,
  sourceKey,
  validateState,
  advance,
  projectMeters,
};
