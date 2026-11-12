'use strict';
const MAX_AGE_MS = Object.freeze({ sigenergy: 30000, battery: 10 * 60000, nibe: 90000, tibber: 26 * 3600000, evdc: 90000 });
function sourceStatus({ enabled = true, readAt, error, now = Date.now(), maxAgeMs }) {
  if (!enabled) return { status: 'disabled', ageSeconds: null };
  const timestamp = Date.parse(readAt || '');
  if (!Number.isFinite(timestamp) || timestamp > now + 60000) return { status: error ? 'error' : 'no-data', ageSeconds: null, error: error || null };
  const ageSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  return { status: error ? 'error' : now - timestamp > maxAgeMs ? 'stale' : 'ok', ageSeconds, error: error || null };
}
function diagnostics(settings, now = Date.now()) {
  const get = key => settings.get(key);
  return {
    sigenergy: sourceStatus({ readAt: get('sigenergyStatus')?.readAt, error: get('sigenergyError'), now, maxAgeMs: MAX_AGE_MS.sigenergy }),
    battery: sourceStatus({ readAt: get('batteryTelemetry')?.readAt, error: get('batteryTelemetryError'), now, maxAgeMs: MAX_AGE_MS.battery }),
    nibe: sourceStatus({ enabled: !!get('nibeHost'), readAt: get('nibeStatus')?.readAt, error: get('nibeError'), now, maxAgeMs: MAX_AGE_MS.nibe }),
    tibber: sourceStatus({ enabled: !!get('tibberToken'), readAt: get('priceCache')?.fetchedAt, error: get('priceError'), now, maxAgeMs: MAX_AGE_MS.tibber }),
    evdc: sourceStatus({ enabled: !!get('evdcEnabled'), readAt: get('lastEvdc')?.readAt, error: get('evdcError'), now, maxAgeMs: MAX_AGE_MS.evdc }),
    controlEnabled: false,
  };
}
module.exports = { MAX_AGE_MS, sourceStatus, diagnostics };
