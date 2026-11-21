'use strict';

const { createHash } = require('node:crypto');
const { SigenergyReader } = require('../modbus');
const { validateUnitId } = require('../charging/modbus-telemetry');

function phaseReaders(settings) {
  const automatic = !settings.phaseMeterSource || settings.phaseMeterSource === 'auto';
  const profile = automatic
    ? String(settings.phaseMeterHost || '').trim()
      ? 'sdm630'
      : 'gateway'
    : settings.phaseMeterSource;
  const gateway = profile === 'gateway';
  const options = {
    host: String((gateway ? settings.host : settings.phaseMeterHost) || '').trim(),
    port: Number((gateway ? settings.port : settings.phaseMeterPort) ?? 502),
    unitId: gateway ? 247 : validateUnitId(settings.phaseMeterUnitId ?? 1),
    addressOffset: gateway ? Number(settings.addressOffset || 0) : 0,
  };
  const validPort = Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535;
  const enabled =
    (gateway || profile === 'sdm630') && options.host && options.unitId !== null && validPort;
  const binding = enabled
    ? createHash('sha256')
        .update(JSON.stringify([gateway ? profile : 'grid', options]))
        .digest('hex')
        .slice(0, 24)
    : null;
  return {
    grid: {
      binding,
      profile,
      reader: enabled ? new SigenergyReader(options) : null,
      state: enabled
        ? 'waiting'
        : options.host && profile !== 'off'
          ? 'invalid-settings'
          : 'not-configured',
      maxAgeMs: 30000,
      busy: false,
    },
  };
}
function closePhaseReaders(readers, homey) {
  for (const [source, entry] of Object.entries(readers || {})) {
    entry.reader?.close();
    homey.app?.history?.observePhaseCurrent?.(source, entry.binding, null);
  }
}

function publishPhaseCurrent(homey, source, entry, state, amps = null, at = Date.now()) {
  if (source !== 'grid') return;
  const key = 'gridPhaseCurrent';
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
    let amps, data;
    try {
      if (entry.profile === 'gateway') {
        data = await entry.reader.gatewayPhases();
        amps = data.amps?.every(Number.isFinite) ? data.amps : null;
      } else {
        amps = await entry.reader.phaseCurrents(source);
        data = { amps };
      }
    } catch {
      amps = null;
    }
    if (!current()) return;
    const at = Date.now();
    homey.app?.gridDay?.append(entry.binding, data, at);
    homey.app?.history?.observePhaseCurrent?.(source, entry.binding, amps, at);
    publishPhaseCurrent(homey, source, entry, amps ? 'ok' : 'read-error', amps, at);
  } finally {
    entry.busy = false;
    if (!current()) {
      entry.reader.close();
    }
  }
}

module.exports = { phaseReaders, closePhaseReaders, publishPhaseCurrent, pollPhaseCurrent };
