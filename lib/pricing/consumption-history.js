'use strict';
const HOUR = 3600000,
  MAX_HOURS = 768;
function validateState(state) {
  if (
    !state ||
    Object.keys(state).some(
      (key) =>
        ![
          'schema',
          'source',
          'resolution',
          'configRevision',
          'fetchedAt',
          'from',
          'to',
          'hours',
        ].includes(key),
    ) ||
    state.schema !== 1 ||
    state.source !== 'tibber-consumption' ||
    state.resolution !== 'HOURLY' ||
    typeof state.configRevision !== 'string' ||
    !state.configRevision ||
    !Number.isFinite(Date.parse(state.fetchedAt)) ||
    !Number.isSafeInteger(state.from) ||
    !Number.isSafeInteger(state.to) ||
    state.from % HOUR ||
    state.to % HOUR ||
    state.from < 0 ||
    state.to <= state.from ||
    state.to > Date.parse(state.fetchedAt) ||
    state.to - state.from > MAX_HOURS * HOUR ||
    !Array.isArray(state.hours) ||
    state.hours.length > MAX_HOURS
  )
    throw new Error('Invalid meter history');
  const times = new Set();
  for (const row of state.hours) {
    if (
      !row ||
      Object.keys(row).some((key) => !['t', 'importWh'].includes(key)) ||
      !Number.isSafeInteger(row?.t) ||
      row.t % HOUR ||
      row.t < state.from ||
      row.t + HOUR > state.to ||
      row.t + HOUR > Date.parse(state.fetchedAt) ||
      !Number.isFinite(row.importWh) ||
      row.importWh < 0 ||
      row.importWh > 1e9 ||
      times.has(row.t)
    )
      throw new Error('Invalid or duplicate meter hour');
    times.add(row.t);
  }
  return state;
}
function normalizeConsumption(rows, metadata) {
  if (!Array.isArray(rows) || rows.length > MAX_HOURS) throw new Error('Invalid consumption rows');
  const byTime = new Map();
  let unavailableRows = 0,
    duplicateRows = 0;
  for (const row of rows) {
    const t = typeof row?.from === 'string' ? Date.parse(row.from) : NaN,
      end = typeof row?.to === 'string' ? Date.parse(row.to) : NaN;
    if (!Number.isSafeInteger(t) || t % HOUR || end - t !== HOUR)
      throw new Error('Invalid consumption interval');
    if (row.consumption === null || row.consumption === undefined) {
      unavailableRows++;
      continue;
    }
    if (row.consumptionUnit !== 'kWh' || !Number.isFinite(row.consumption) || row.consumption < 0)
      throw new Error('Invalid consumption unit or value');
    const hour = { t, importWh: row.consumption * 1000 };
    if (byTime.has(t)) {
      if (byTime.get(t).importWh !== hour.importWh) throw new Error('Conflicting meter hours');
      duplicateRows++;
    }
    byTime.set(t, hour);
  }
  const state = validateState({
    ...metadata,
    schema: 1,
    source: 'tibber-consumption',
    resolution: 'HOURLY',
    hours: [...byTime.values()].sort((a, b) => a.t - b.t),
  });
  return {
    state,
    unavailableRows,
    duplicateRows,
    missingHours: (state.to - state.from) / HOUR - state.hours.length,
  };
}
function mergeHistory(current, incoming) {
  validateState(incoming);
  if (!current) return incoming;
  validateState(current);
  if (current.configRevision !== incoming.configRevision)
    throw new Error('Meter history configuration mismatch');
  const hours = new Map(current.hours.map((row) => [row.t, row]));
  for (const row of incoming.hours) {
    if (hours.has(row.t) && hours.get(row.t).importWh !== row.importWh)
      throw new Error('Conflicting stored meter hour');
    hours.set(row.t, row);
  }
  return validateState({
    ...incoming,
    from: Math.min(current.from, incoming.from),
    to: Math.max(current.to, incoming.to),
    fetchedAt:
      Date.parse(current.fetchedAt) > Date.parse(incoming.fetchedAt)
        ? current.fetchedAt
        : incoming.fetchedAt,
    hours: [...hours.values()].sort((a, b) => a.t - b.t),
  });
}
module.exports = { validateState, normalizeConsumption, mergeHistory };
