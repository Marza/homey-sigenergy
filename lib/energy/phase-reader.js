'use strict';

const { createHash } = require('node:crypto');
const { SigenergyReader } = require('../modbus');
const { validateUnitId } = require('../charging/modbus-telemetry');

function phaseReaders(settings, seconds) {
  const options = {
    host: String(settings.phaseMeterHost || '').trim(),
    port: Number(settings.phaseMeterPort ?? 502),
    unitId: validateUnitId(settings.phaseMeterUnitId ?? 1),
    addressOffset: 0,
  };
  const validPort = Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535;
  const enabled = options.host && options.unitId !== null && validPort;
  return {
    grid: {
      binding: enabled
        ? createHash('sha256')
            .update(JSON.stringify(['grid', options]))
            .digest('hex')
            .slice(0, 24)
        : null,
      reader: enabled ? new SigenergyReader(options) : null,
      state: enabled ? 'waiting' : options.host ? 'invalid-settings' : 'not-configured',
      maxAgeMs: Math.max(30000, seconds * 3000),
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
