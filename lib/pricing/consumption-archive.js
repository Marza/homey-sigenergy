'use strict';
const { calendar } = require('./coverage');
const { validateState } = require('./consumption-history');
const HOUR = 3600000,
  MAX_MONTHS = 13;
const monthKey = (now = new Date()) => calendar(now).today.date.slice(0, 7);
function shiftMonth(month, offset) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw Error('Invalid meter month');
  const date = new Date(month + '-15T12:00Z');
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
function bounds(month) {
  shiftMonth(month, 0);
  return {
    from: calendar(new Date(month + '-01T12:00Z')).today.start,
    to: calendar(new Date(shiftMonth(month, 1) + '-01T12:00Z')).today.start,
  };
}
function validateArchive(archive, now = new Date()) {
  if (
    !archive ||
    Object.keys(archive).some((k) => !['schema', 'configRevision', 'months'].includes(k)) ||
    archive.schema !== 1 ||
    typeof archive.configRevision !== 'string' ||
    !archive.configRevision ||
    !Array.isArray(archive.months) ||
    archive.months.length > MAX_MONTHS
  )
    throw Error('Invalid meter archive');
  const seen = new Set();
  for (const entry of archive.months) {
    if (!entry || Object.keys(entry).some((k) => !['month', 'state'].includes(k)))
      throw Error('Invalid meter archive month');
    const range = bounds(entry.month),
      state = validateState(entry.state);
    if (
      seen.has(entry.month) ||
      state.configRevision !== archive.configRevision ||
      state.from < range.from ||
      state.from >= range.to ||
      state.to > range.to ||
      Date.parse(state.fetchedAt) > now.getTime()
    )
      throw Error('Invalid meter archive month');
    seen.add(entry.month);
  }
  if (Buffer.byteLength(JSON.stringify(archive)) > 1024 * 1024)
    throw Error('Meter archive too large');
  return archive;
}
function retain(archive, now = new Date()) {
  validateArchive(archive, now);
  const current = monthKey(now),
    cutoff = shiftMonth(current, 1 - MAX_MONTHS);
  return {
    ...archive,
    months: archive.months
      .filter((e) => e.month >= cutoff && e.month <= current)
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}
function readArchive(settings, now = new Date()) {
  const stored = settings.get('tibberConsumptionArchive');
  if (stored) return retain(stored, now);
  const legacy = settings.get('tibberConsumptionHistory');
  if (!legacy) return null;
  validateState(legacy);
  const months = [];
  for (let start = legacy.from; start < legacy.to;) {
    const month = monthKey(new Date(start)),
      end = Math.min(bounds(month).to, legacy.to);
    months.push({
      month,
      state: {
        ...legacy,
        from: start,
        to: end,
        hours: legacy.hours.filter((h) => h.t >= start && h.t < end),
      },
    });
    start = end;
  }
  return retain({ schema: 1, configRevision: legacy.configRevision, months }, now);
}
function replaceMonth(archive, state, now = new Date()) {
  validateState(state);
  const month = monthKey(new Date(state.from));
  if (archive) validateArchive(archive, now);
  const months =
    archive?.configRevision === state.configRevision
      ? archive.months.filter((e) => e.month !== month)
      : [];
  return retain(
    {
      schema: 1,
      configRevision: state.configRevision,
      months: [...months, { month, state }]
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-MAX_MONTHS),
    },
    now,
  );
}
function mergeArchive(current, incoming, revision, now = new Date()) {
  validateArchive(incoming, now);
  if (!revision) throw Error('Configure Tibber before restoring meter references');
  let result =
    current?.configRevision === revision
      ? retain(current, now)
      : { schema: 1, configRevision: revision, months: [] };
  let conflicts = 0;
  for (const entry of incoming.months) {
    const state = { ...entry.state, configRevision: revision };
    const existing = result.months.find((e) => e.month === entry.month)?.state;
    if (existing) {
      const hours = new Map(state.hours.map((h) => [h.t, h]));
      for (const hour of existing.hours) {
        if (hours.has(hour.t)) conflicts++;
        hours.set(hour.t, hour);
      }
      state.from = Math.min(state.from, existing.from);
      state.to = Math.max(state.to, existing.to);
      state.fetchedAt =
        Date.parse(existing.fetchedAt) > Date.parse(state.fetchedAt)
          ? existing.fetchedAt
          : state.fetchedAt;
      state.hours = [...hours.values()].sort((a, b) => a.t - b.t);
    }
    result = replaceMonth(result, state, now);
  }
  return { archive: result, conflicts };
}
module.exports = {
  HOUR,
  MAX_MONTHS,
  monthKey,
  shiftMonth,
  bounds,
  validateArchive,
  retain,
  readArchive,
  replaceMonth,
  mergeArchive,
};
