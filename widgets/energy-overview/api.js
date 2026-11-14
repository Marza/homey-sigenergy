'use strict';
const { diagnostics, backupAdvisory } = require('../../lib/source-status');
const pick = (value, keys) =>
  value && typeof value === 'object'
    ? Object.fromEntries(
        keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
      )
    : null;
function coverage(value) {
  return pick(value, [
    'expectedHours',
    'elapsedHours',
    'completeHours',
    'missingHours',
    'pendingHours',
    'status',
  ]);
}
function estimate(value) {
  const result = pick(value, [
    'month',
    'tariffKey',
    'status',
    'averageKw',
    'estimatedSek',
    'fetchedAt',
  ]);
  return result && { ...result, coverage: coverage(value.coverage) };
}
function publicStatus(status) {
  return {
    ...pick(status, ['configured', 'enabled', 'status', 'usable', 'ageSeconds', 'reason']),
    error: status.error
      ? /ECONNREFUSED|connection refused/i.test(status.error)
        ? 'ECONNREFUSED'
        : /timeout|ETIMEDOUT/i.test(status.error)
          ? 'ETIMEDOUT'
          : /unreach/i.test(status.error)
            ? 'EHOSTUNREACH'
            : /illegal.*address|exception 2/i.test(status.error)
              ? 'Illegal register address'
              : 'Avläsningen misslyckades'
      : null,
    fieldErrors: {},
  };
}
// Widget-scoped, read-only snapshot. No arbitrary setting lookup or credentials.
function getOverview({ homey }, now) {
  const errors = [];
  const read = (key) => {
    try {
      return homey.settings.get(key);
    } catch {
      errors.push(key);
      return null;
    }
  };
  const sourceKeys = [
    'sourceConfig',
    'backupStatus',
    'sigenergyStatus',
    'sigenergyError',
    'nibeHost',
    'nibePort',
    'nibeUnitId',
    'nibeAddressOffset',
    'nibeStatus',
    'nibeError',
  ];
  const sourceValues = Object.fromEntries(sourceKeys.map((key) => [key, read(key)]));
  const sources = diagnostics(sourceValues, now ?? Date.now());
  if (errors.length)
    for (const key of ['sigenergy', 'nibe'])
      sources[key] = {
        ...sources[key],
        status: 'error',
        usable: false,
        error: 'Status kunde inte läsas',
      };
  const advisory = backupAdvisory(sourceValues, now ?? Date.now(), sources.sigenergy);
  const state = read('historyState');
  let slots = [];
  if (state === null || state === undefined) slots = read('historySlots') || [];
  else if (state.schema === 3 && Array.isArray(state.slots)) slots = state.slots;
  else errors.push('historyState');
  if (!Array.isArray(slots)) {
    slots = [];
    errors.push('historyState');
  }
  const latest = slots
    .filter((row) => Number.isFinite(row?.t))
    .reduce((last, row) => (!last || row.t > last.t ? row : last), null);
  const tariff = read('demandTariff'),
    optimization = read('tariffOptimization');
  const meterState = read('tibberConsumptionArchive') || read('tibberConsumptionHistory');
  const meterEstimate = read('meterDemandEstimate');
  const consumptionSync = read('tibberConsumptionSync');
  const sync =
    consumptionSync?.configRevision &&
    consumptionSync.configRevision === sourceValues.sourceConfig?.tibber?.revision
      ? pick(consumptionSync, ['status', 'lastAttemptAt', 'lastSuccessAt'])
      : null;
  const values = {
    meterDemandEstimate:
      meterState?.configRevision &&
      meterState.configRevision === sourceValues.sourceConfig?.tibber?.revision
        ? {
            ...estimate(meterEstimate),
            sync,
          }
        : sync
          ? { status: 'no-meter-history', sync }
          : null,
    historyState: {
      schema: 3,
      slots: latest
        ? [
            {
              t: latest.t,
              counts: pick(latest.counts, ['gridW', 'pvW', 'soc', 'essW']),
              sum: pick(latest.sum, ['gridW', 'pvW', 'soc', 'essW']),
            },
          ]
        : [],
      daily: [],
      events: [],
      legacyDaily: [],
    },
    nibeStatus: sourceValues.nibeStatus
      ? {
          readAt: sourceValues.nibeStatus.readAt,
          readings: pick(sourceValues.nibeStatus.readings, ['outdoorC']),
        }
      : null,
    optimizationRecommendation: advisory.restricted
      ? { ...advisory, updatedAt: new Date(now ?? Date.now()).toISOString() }
      : pick(read('optimizationRecommendation'), [
          'updatedAt',
          'status',
          'capKW',
          'reservePercent',
        ]),
    demandTariff: pick(tariff, [
      'start',
      'end',
      'weekdays',
      'months',
      'peakCount',
      'distinctDays',
      'rateSekPerKw',
      'calendar',
    ]),
    demandEstimate: estimate(read('demandEstimate')),
    tariffOptimization: optimization
      ? {
          status: optimization.status,
          backupAdvisory: advisory,
          baseline: estimate(optimization.baseline),
          best: pick(optimization.best, ['simulatedDemandSek', 'demandSavingSek']),
        }
      : null,
  };
  if (errors.includes('historySlots')) errors.push('historyState');
  return {
    schema: 1,
    sources: { sigenergy: publicStatus(sources.sigenergy), nibe: publicStatus(sources.nibe) },
    values,
    errors,
  };
}
module.exports = { getOverview };
