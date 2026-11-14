'use strict';
const { createHash } = require('node:crypto');
const { validateCostContract } = require('./cost-model');
const { validateTariff } = require('../tariff-config');
const { dateKey } = require('../history-format');
const KEY = 'costContractTimeline';
function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
function tariffSnapshot(value) {
  validateTariff(value);
  return JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        [
          'start',
          'end',
          'weekdays',
          'months',
          'peakCount',
          'distinctDays',
          'rateSekPerKw',
          'calendar',
        ]
          .filter((k) => value[k] !== undefined)
          .map((k) => [k, value[k]]),
      ),
    ),
  );
}
function validateTimeline(value) {
  if (
    !value ||
    Object.keys(value).some((k) => !['schema', 'entries'].includes(k)) ||
    value.schema !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 100 ||
    Buffer.byteLength(JSON.stringify(value)) > 262144
  )
    throw Error('invalid-contract-timeline');
  let previous = '';
  for (const e of value.entries) {
    if (
      !e ||
      Object.keys(e).some(
        (k) =>
          ![
            'from',
            'contract',
            'tariff',
            'includeNetwork',
            'tradeComponentsConfirmed',
            'savedAt',
            'id',
          ].includes(k),
      ) ||
      !validDate(e?.from) ||
      e.from <= previous ||
      !Number.isFinite(Date.parse(e.savedAt)) ||
      typeof e.includeNetwork !== 'boolean' ||
      e.tradeComponentsConfirmed !== true
    )
      throw Error('invalid-contract-period');
    const c = validateCostContract(e.contract),
      tariff = tariffSnapshot(e.tariff);
    if (Object.keys(e.tariff).some((k) => !Object.hasOwn(tariff, k)))
      throw Error('invalid-contract-fields');
    if (Object.keys(e.contract).some((k) => !Object.hasOwn(c, k)))
      throw Error('invalid-contract-fields');
    if (e.includeNetwork && (c.importPriceBasis !== 'spot-ex-vat' || c.importIncludesEnergyTax))
      throw Error('incompatible-network-components');
    if (
      e.id !==
      hash({
        from: e.from,
        contract: c,
        tariff,
        includeNetwork: e.includeNetwork,
        tradeComponentsConfirmed: true,
        savedAt: e.savedAt,
      })
    )
      throw Error('invalid-contract-hash');
    previous = e.from;
  }
  return value;
}
function readTimeline(homey) {
  const value = homey.settings.get(KEY);
  return value === null || value === undefined
    ? { schema: 1, entries: [] }
    : validateTimeline(value);
}
function contractAt(timeline, t) {
  const date = dateKey(t);
  return timeline.entries.findLast((e) => e.from <= date) || null;
}
function timelineStatus(homey) {
  const timeline = readTimeline(homey);
  return {
    timeline,
    revision: hash(timeline),
    draftHash: hash({
      contract: homey.settings.get('costContract'),
      tariff: homey.settings.get('demandTariff'),
    }),
    timezone: 'Europe/Stockholm',
  };
}
function publishContract(homey, input, now = Date.now()) {
  const current = timelineStatus(homey);
  if (input?.expectedRevision !== current.revision || input.draftHash !== current.draftHash)
    throw Error('contract-inputs-changed');
  if (
    input.confirmEffectiveDate !== true ||
    input.confirmTradeComponents !== true ||
    typeof input.includeNetwork !== 'boolean'
  )
    throw Error('confirm-contract-provenance');
  if (
    !validDate(input.from) ||
    (current.timeline.entries.length && input.from <= current.timeline.entries.at(-1).from)
  )
    throw Error('contract-dates-must-increase');
  const contract = validateCostContract(homey.settings.get('costContract')),
    tariff = tariffSnapshot(homey.settings.get('demandTariff'));
  const entry = {
    from: input.from,
    contract,
    tariff,
    includeNetwork: input.includeNetwork,
    tradeComponentsConfirmed: true,
    savedAt: new Date(now).toISOString(),
  };
  entry.id = hash(entry);
  const next = validateTimeline({ schema: 1, entries: [...current.timeline.entries, entry] });
  homey.settings.set(KEY, next);
  if (hash(readTimeline(homey)) !== hash(next)) throw Error('contract-save-unverified');
  return timelineStatus(homey);
}
function restoreTimeline(homey, input) {
  const current = timelineStatus(homey);
  if (input?.confirmSamePlant !== true || input.expectedRevision !== current.revision)
    throw Error('confirm-contract-restore');
  const incoming = validateTimeline(input.timeline),
    entries = new Map(current.timeline.entries.map((e) => [e.from, e]));
  for (const e of incoming.entries) {
    if (entries.has(e.from) && entries.get(e.from).id !== e.id)
      throw Error('contract-restore-conflict');
    entries.set(e.from, e);
  }
  const next = validateTimeline({
    schema: 1,
    entries: [...entries.values()].sort((a, b) => a.from.localeCompare(b.from)),
  });
  // Restoring an older boundary must not shorten an already published interval.
  if (
    current.timeline.entries.length &&
    next.entries.some(
      (e) =>
        !current.timeline.entries.some((old) => old.id === e.id) &&
        e.from <= current.timeline.entries.at(-1).from,
    )
  )
    throw Error('contract-restore-would-rewrite-period');
  homey.settings.set(KEY, next);
  if (hash(readTimeline(homey)) !== hash(next)) throw Error('contract-save-unverified');
  return timelineStatus(homey);
}
function additions(entry) {
  const c = entry.contract;
  return {
    import: entry.includeNetwork
      ? (c.energyTaxExVatSekPerKWh + c.gridImportExVatSekPerKWh) * (1 + c.vatRate)
      : 0,
    export: entry.includeNetwork ? c.gridExportBenefitSekPerKWh - c.gridExportFeeSekPerKWh : 0,
    wear: c.batteryWearSekPerKWh,
  };
}
module.exports = {
  hash,
  readTimeline,
  validateTimeline,
  contractAt,
  timelineStatus,
  publishContract,
  restoreTimeline,
  additions,
};
