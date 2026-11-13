/* Shared by Node and both browser views. Run node scripts/sync-source-status.js after editing. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SourceStatus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const MAX_AGE_MS = Object.freeze({ sigenergy: 30000, battery: 600000, nibe: 90000, tibber: 93600000, evdc: 90000, history: 1800000 });
  const SOURCE_KEYS = ['sourceConfig','sigenergyStatus','sigenergyError','batteryTelemetry','batteryTelemetryError','nibeHost','nibePort','nibeUnitId','nibeAddressOffset','nibeStatus','nibeError','tibberToken','priceCache','priceError','lastEvdc','evdcError'];
  const time = value => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  function isFresh(readAt, maxAgeMs, now = Date.now()) {
    const t = typeof readAt === 'number' ? readAt : time(readAt);
    return Number.isFinite(t) && t <= now && now - t <= maxAgeMs;
  }
  function sourceStatus({ configured = true, enabled = true, readAt, error, errors = {}, availableFields = 0, since, now = Date.now(), maxAgeMs }) {
    const fields = Object.fromEntries(Object.entries(errors || {}).filter(([,v]) => v));
    const result = { configured: !!configured, enabled: !!enabled, status: 'no-data', usable: false, ageSeconds: null, error: error || null, fieldErrors: fields };
    if (!configured || !enabled) return { ...result, status: 'disabled', error: null, fieldErrors: {} };
    const t = time(readAt), start = time(since);
    if (Number.isFinite(t) && t <= now) result.ageSeconds = Math.floor((now - t) / 1000);
    if (error) return { ...result, status: 'error' };
    if (Number.isFinite(start) && (!Number.isFinite(t) || t < start)) return result;
    if (!Number.isFinite(t)) return { ...result, reason: readAt ? 'invalid-time' : 'missing' };
    if (!isFresh(readAt, maxAgeMs, now)) return { ...result, status: 'stale', reason: t > now ? 'future-time' : 'expired' };
    if (Object.keys(fields).length) return { ...result, status: availableFields > 0 ? 'partial' : 'error', usable: availableFields > 0 };
    return { ...result, status: 'ok', usable: true };
  }
  function nibeKey(values) {
    return JSON.stringify([String(values.nibeHost || '').trim(), Number(values.nibePort) || 502, Number(values.nibeUnitId) || 1, Number(values.nibeAddressOffset) || 0]);
  }
  function diagnostics(values, now = Date.now()) {
    const config = values.sourceConfig || {};
    const plant = config.sigenergy || { configured: false, enabled: false };
    const evdc = config.evdc || { configured: false, enabled: false };
    const nibe = config.nibe || {};
    const nibeConfigured = !!String(values.nibeHost || '').trim();
    const nibeMatches = nibe.connectionKey === nibeKey(values);
    const battery = values.batteryTelemetry;
    return {
      sigenergy: sourceStatus({ ...plant, readAt: values.sigenergyStatus?.readAt, error: values.sigenergyError, now, maxAgeMs: plant.maxAgeMs || MAX_AGE_MS.sigenergy }),
      battery: sourceStatus({ ...plant, readAt: battery?.readAt, error: values.batteryTelemetryError || values.sigenergyError, errors: battery?.errors,
        availableFields: Object.keys(battery?.values || {}).filter(k => !['soc','capacityKWh'].includes(k) && !battery?.errors?.[k]).length, now, maxAgeMs: MAX_AGE_MS.battery }),
      nibe: sourceStatus({ configured: nibeConfigured, enabled: nibeConfigured, since: nibe.since,
        readAt: nibeMatches ? values.nibeStatus?.readAt : null, error: nibeMatches ? values.nibeError : null, now, maxAgeMs: MAX_AGE_MS.nibe }),
      tibber: sourceStatus({ configured: !!values.tibberToken, enabled: !!values.tibberToken, readAt: values.priceCache?.fetchedAt, error: values.priceError, now, maxAgeMs: MAX_AGE_MS.tibber }),
      evdc: sourceStatus({ ...evdc, readAt: values.lastEvdc?.readAt, error: values.evdcError || (evdc.enabled ? values.sigenergyError : null), now, maxAgeMs: evdc.maxAgeMs || MAX_AGE_MS.evdc }),
      controlEnabled: false,
    };
  }
  function batteryValues(telemetry, status) {
    if (!status?.usable) return {};
    return Object.fromEntries(Object.entries(telemetry?.values || {}).filter(([k,v]) => Number.isFinite(v) && !status.fieldErrors?.[k]));
  }
  function describe(status) {
    if (!status) return 'Status kunde inte läsas';
    const labels = { disabled: status.configured ? 'Avstängd' : 'Ej konfigurerad', 'no-data': 'Väntar på data', stale: 'Inaktuella data', ok: 'OK', partial: 'Delvis tillgänglig', error: 'Fel' };
    let text = labels[status.status] || 'Okänd status';
    if (status.reason === 'future-time' || status.reason === 'invalid-time') text += ' · Ogiltig tidsstämpel';
    if (status.error) {
      const error = String(status.error);
      if (/ECONNREFUSED|connection refused/i.test(error)) text += ' · Anslutningen nekades. Kontrollera Modbus TCP och port.';
      else if (/ETIMEDOUT|timeout|timed out/i.test(error)) text += ' · Tidsgränsen överskreds. Kontrollera nätverk och enhet.';
      else if (/EHOSTUNREACH|ENETUNREACH/i.test(error)) text += ' · Enheten kan inte nås på nätverket.';
      else if (/illegal.*address|modbus exception 2/i.test(error)) text += ' · Registeradressen stöds inte. Kontrollera registerprofil och offset.';
      else text += ' · ' + error;
    }
    if (status.ageSeconds !== null && status.ageSeconds !== undefined && status.status !== 'disabled') text += ' · Senaste lyckade avläsning ' + status.ageSeconds + ' s sedan';
    return text;
  }
  function readSources(Homey, callback) {
    const values = {}, failures = []; let remaining = SOURCE_KEYS.length;
    SOURCE_KEYS.forEach(key => Homey.get(key, (error, value) => {
      values[key] = error ? null : value;
      if (error) failures.push(key);
      if (--remaining) return;
      const statuses = diagnostics(values);
      // A partial settings read must never make cached values appear healthy.
      if (failures.length) for (const key of ['sigenergy','battery','nibe','tibber','evdc']) statuses[key] = { ...statuses[key], status: 'error', usable: false, error: 'Status kunde inte läsas' };
      callback(statuses, values);
    }));
  }
  return { MAX_AGE_MS, SOURCE_KEYS, isFresh, sourceStatus, nibeKey, diagnostics, batteryValues, describe, readSources };
});
