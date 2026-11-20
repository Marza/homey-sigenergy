'use strict';

const { createHash } = require('node:crypto');
const { SigenergyReader } = require('../modbus');
const { validateUnitId } = require('../charging/modbus-telemetry');
const { SOURCES } = require('./phase-current');

function phaseReaders(settings, seconds) {
  const inverterId = Number(settings.phaseInverterUnitId || 0);
  const ports = {
    grid: Number(settings.phaseMeterPort ?? 502),
    inverter: Number(settings.port ?? 502),
  };
  const ids = {
    grid: validateUnitId(settings.phaseMeterUnitId ?? 1),
    inverter: validateUnitId(inverterId || (settings.evdcEnabled ? settings.evdcUnitId : null)),
  };
  return Object.fromEntries(
    SOURCES.map((source) => {
      const grid = source === 'grid';
      const options = {
        host: String((grid ? settings.phaseMeterHost : settings.host) || '').trim(),
        port: ports[source],
        unitId: ids[source],
        addressOffset: grid ? 0 : Number(settings.addressOffset || 0),
      };
      const validPort =
        Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535;
      const requested = grid ? !!options.host : !!inverterId || settings.evdcEnabled === true;
      const enabled = requested && options.host && options.unitId !== null && validPort;
      return [
        source,
        {
          binding: enabled
            ? createHash('sha256')
                .update(JSON.stringify([source, options]))
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
  homey.settings.set(key, { binding: entry.binding, state, amps, at, maxAgeMs: entry.maxAgeMs });
}

async function pollPhaseCurrent(homey, source, entry, current) {
  if (!entry.reader || entry.busy || !current()) return;
  entry.busy = true;
  try {
    let amps;
    try {
      amps = await entry.reader.phaseCurrents(source);
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
