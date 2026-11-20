'use strict';

const { createHash } = require('node:crypto');
const { SigenergyReader } = require('../modbus');
const { validateUnitId } = require('../charging/modbus-telemetry');
const { SOURCES } = require('./phase-current');

function phaseReaders(settings, seconds) {
  const inverterId = Number(settings.phaseInverterUnitId || 0);
  const meter = settings.phaseMeterSource ?? 'sdm630';
  const validMeter = meter === 'sdm630' || meter === 'gateway';
  return Object.fromEntries(
    SOURCES.map((source) => {
      const grid = source === 'grid';
      const external = grid && meter === 'sdm630';
      const profile = grid && meter === 'gateway' ? 'gateway' : source;
      const inverterUnit = inverterId || (settings.evdcEnabled ? settings.evdcUnitId : null);
      const options = {
        host: String((external ? settings.phaseMeterHost : settings.host) || '').trim(),
        port: Number((external ? settings.phaseMeterPort : settings.port) ?? 502),
        unitId:
          profile === 'gateway'
            ? 247
            : validateUnitId(external ? (settings.phaseMeterUnitId ?? 1) : inverterUnit),
        addressOffset: external ? 0 : Number(settings.addressOffset || 0),
      };
      const validPort =
        Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535;
      const requested = grid
        ? !external || !!options.host
        : !!inverterId || settings.evdcEnabled === true;
      const enabled =
        requested && options.host && options.unitId !== null && validPort && (!grid || validMeter);
      return [
        source,
        {
          profile,
          binding: enabled
            ? createHash('sha256')
                .update(JSON.stringify([profile, options]))
                .digest('hex')
                .slice(0, 24)
            : null,
          reader: enabled ? new SigenergyReader(options) : null,
          state: enabled ? 'waiting' : requested ? 'invalid-settings' : 'not-configured',
          maxAgeMs: Math.max(30000, seconds * 3000),
          busy: false,
        },
      ];
    }),
  );
}

function closePhaseReaders(readers, homey) {
  for (const [source, entry] of Object.entries(readers || {})) {
    entry.reader?.close();
    homey.app?.history?.observePhaseCurrent?.(source, entry.binding, null);
  }
}

function publishPhaseCurrent(homey, source, entry, state, amps = null, at = Date.now()) {
  const key = source === 'grid' ? 'gridPhaseCurrent' : 'inverterPhaseCurrent';
  homey.settings.set(key, {
    binding: entry.binding,
    profile: entry.profile,
    state,
    amps,
    at,
    maxAgeMs: entry.maxAgeMs,
  });
}

async function pollPhaseCurrent(homey, source, entry, current) {
  if (!entry.reader || entry.busy || !current()) return;
  entry.busy = true;
  try {
    let amps;
    try {
      amps = await entry.reader.phaseCurrents(entry.profile);
    } catch {
      amps = null;
    }
    if (!current()) return;
    const at = Date.now();
    homey.app?.history?.observePhaseCurrent?.(source, entry.binding, amps, at);
    publishPhaseCurrent(homey, source, entry, amps ? 'ok' : 'read-error', amps, at);
  } finally {
    entry.busy = false;
    if (!current()) entry.reader.close();
  }
}

module.exports = { phaseReaders, closePhaseReaders, publishPhaseCurrent, pollPhaseCurrent };
