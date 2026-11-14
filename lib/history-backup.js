'use strict';
const { readArchive, validateArchive, mergeArchive } = require('./pricing/consumption-archive');
const { MAX_IMPORT_BYTES, bytes } = require('./history-format');
const FORMAT = 'com.local.sigenergy.backup';
function exportBackup(homey) {
  const now = new Date(homey.app.history.now());
  return structuredClone({
    format: FORMAT,
    schema: 1,
    exportedAt: now.toISOString(),
    history: homey.app.history.export(),
    meter: readArchive(homey.settings, now),
  });
}
function unpack(input, now) {
  if (bytes(input) > MAX_IMPORT_BYTES) throw Error('Backup exceeds 8 MiB');
  let file = input,
    confirmed = false;
  if (input?.backup) {
    if (
      Object.keys(input).some((k) => !['backup', 'confirmMeterBinding'].includes(k)) ||
      typeof input.confirmMeterBinding !== 'boolean'
    )
      throw Error('Invalid backup request');
    file = input.backup;
    confirmed = input.confirmMeterBinding;
  }
  if (file?.format !== FORMAT) return { history: file, meter: null, confirmed };
  if (
    Object.keys(file).some(
      (k) => !['format', 'schema', 'exportedAt', 'history', 'meter'].includes(k),
    ) ||
    file.schema !== 1 ||
    !Number.isFinite(Date.parse(file.exportedAt)) ||
    Date.parse(file.exportedAt) > now.getTime()
  )
    throw Error('Invalid backup');
  if (file.meter !== null) validateArchive(file.meter, now);
  return { history: file.history, meter: file.meter, confirmed };
}
function planBackup(homey, input) {
  const now = new Date(homey.app.history.now());
  const { history, meter, confirmed } = unpack(input, now);
  // Validate both parts before either settings write.
  const preview = homey.app.history.previewImport(history);
  const revision = homey.settings.get('sourceConfig')?.tibber?.revision;
  const token = homey.settings.get('tibberToken');
  const hasMeter = !!meter?.months.length;
  if (hasMeter && (!revision || typeof token !== 'string' || !token.trim()))
    throw Error('Configure Tibber before restoring meter references');
  const bindingRequired = hasMeter && meter.configRevision !== revision;
  const current = hasMeter ? readArchive(homey.settings, now) : null;
  const merged = hasMeter ? mergeArchive(current, meter, revision, now) : null;
  return {
    history,
    merged,
    confirmed,
    bindingRequired,
    preview: {
      ...preview,
      meterMonths: merged?.archive.months.length || 0,
      meterHours: merged?.archive.months.reduce((n, e) => n + e.state.hours.length, 0) || 0,
      meterConflicts: merged?.conflicts || 0,
      meterBindingRequired: bindingRequired,
    },
  };
}
function previewBackup(homey, input) {
  return planBackup(homey, input).preview;
}
function restoreBackup(homey, input) {
  const plan = planBackup(homey, input);
  if (plan.bindingRequired && !plan.confirmed)
    throw Error('Confirm that meter references belong to the currently configured Tibber home');
  // Separate idempotent stores: never report complete if either write fails.
  // Meter first, so a history failure can be retried safely without losing live pending samples.
  if (plan.merged) homey.settings.set('tibberConsumptionArchive', plan.merged.archive);
  let result;
  try {
    result = homey.app.history.import(plan.history);
  } catch {
    throw Error(
      plan.merged
        ? 'Meter references saved but inverter history restore failed; retry the same backup'
        : 'History restore failed; retry the same backup',
    );
  }
  homey.app.refreshDemandEstimate?.();
  return { ...plan.preview, ...result, restored: true };
}
module.exports = { FORMAT, exportBackup, previewBackup, restoreBackup };
