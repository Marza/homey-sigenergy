'use strict';
const { isDeepStrictEqual } = require('node:util');
const SLOT_MS = 900000;
const SLOT_RETENTION = 32 * 24 * 4;
const DAY_RETENTION = 730;
const EVENT_RETENTION = 500;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const FORMAT = 'com.local.sigenergy.history';
const TIMEZONE = 'Europe/Stockholm';
const FIELDS = ['gridW', 'pvW', 'essW', 'soc', 'evW', 'evSoc'];
const ENERGIES = ['gridWh', 'pvWh', 'essWh', 'evWh'];
const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const hourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  hourCycle: 'h23',
});
const dateKey = (ms) => dateFormatter.format(new Date(ms));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const round = (value) => Math.round(value * 100) / 100;
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  check(
    Object.keys(value).every((key) => keys.includes(key)),
    `Unknown field in ${label}`,
  );
}
function number(value, label, min = -Infinity, max = Infinity) {
  check(Number.isFinite(value) && value >= min && value <= max, `Invalid ${label}`);
}
function timestamp(value) {
  check(
    Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000,
    'Invalid timestamp',
  );
}
function date(value) {
  check(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value,
    'Invalid date',
  );
}
function dayBounds(key) {
  date(key);
  const midnight = Date.parse(key + 'T00:00:00Z');
  // Stockholm changes DST at 01:00 UTC, after local midnight. At UTC midnight
  // the local hour therefore gives the correct offset for that day's midnight.
  const start = midnight - Number(hourFormatter.format(new Date(midnight))) * 3600000;
  const tomorrow = midnight + 86400000;
  const end = tomorrow - Number(hourFormatter.format(new Date(tomorrow))) * 3600000;
  return { start, end, durationMs: end - start };
}
function retainDays(rows, now) {
  const today = dateKey(now);
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - (DAY_RETENTION - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  return rows
    .filter((row) => row.date >= cutoff && row.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-DAY_RETENTION);
}
function dailyFromSlots(slots, previous, now) {
  const grouped = new Map();
  for (const row of slots) {
    const key = dateKey(row.t);
    const bounds = dayBounds(key);
    const aggregate = grouped.get(key) || {
      schema: 3,
      date: key,
      timezone: TIMEZONE,
      slots: 0,
      gridWh: 0,
      pvWh: 0,
      essWh: 0,
      evWh: 0,
      peakGridW: null,
      coverageMs: 0,
      expectedCoverageMs: bounds.durationMs,
      sourceFrom: row.t,
      sourceTo: row.t + SLOT_MS,
      status: 'partial',
      legacySlots: 0,
    };
    aggregate.slots++;
    for (const name of ENERGIES) aggregate[name] += row[name] || 0;
    if (Number.isFinite(row.max?.gridW))
      aggregate.peakGridW = Math.max(aggregate.peakGridW ?? row.max.gridW, row.max.gridW);
    aggregate.coverageMs += row.coverageMs || 0;
    aggregate.sourceFrom = Math.min(aggregate.sourceFrom, row.t);
    aggregate.sourceTo = Math.max(aggregate.sourceTo, row.t + SLOT_MS);
    if (row.schema !== 2) aggregate.legacySlots++;
    grouped.set(key, aggregate);
  }
  const result = new Map(previous.map((row) => [row.date, row]));
  for (const [key, row] of grouped) {
    const old = result.get(key);
    // Never replace an archived day's totals with a truncated retained suffix.
    if (
      old &&
      (row.sourceFrom > old.sourceFrom ||
        row.sourceTo < old.sourceTo ||
        row.slots < old.slots ||
        row.coverageMs < old.coverageMs)
    )
      continue;
    row.status =
      row.legacySlots === 0 &&
      row.coverageMs === row.expectedCoverageMs &&
      row.slots === row.expectedCoverageMs / SLOT_MS
        ? 'complete'
        : 'partial';
    for (const name of ENERGIES) row[name] = round(row[name]);
    result.set(key, row);
  }
  return retainDays([...result.values()], now);
}
function pruneSlots(slots, now) {
  return slots
    .filter((row) => row.t >= now - SLOT_RETENTION * SLOT_MS)
    .sort((a, b) => a.t - b.t)
    .slice(-SLOT_RETENTION);
}
function uniqueEvents(events) {
  const key = (row) =>
    JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
  const byKey = new Map(events.map((row) => [key(row), row]));
  return [...byKey.values()].sort((a, b) => a.t - b.t).slice(-EVENT_RETENTION);
}
function bounded(state) {
  check(bytes(state) <= MAX_STATE_BYTES, 'History exceeds the 4 MiB storage budget');
  return state;
}
function validateSlot(row, now, depth = 0) {
  object(
    row,
    ['schema', 't', 'n', 'counts', 'sum', 'min', 'max', 'coverageMs', ...ENERGIES, 'legacy'],
    'history slot',
  );
  timestamp(row.t);
  check(
    row.t % SLOT_MS === 0 && row.t <= Math.floor(now / SLOT_MS) * SLOT_MS,
    'Invalid slot alignment or future date',
  );
  check(
    row.schema === undefined || row.schema === 1 || row.schema === 2,
    'Unsupported slot schema',
  );
  check(Number.isSafeInteger(row.n) && row.n >= 0, 'Invalid sample count');
  for (const group of ['sum', 'min', 'max']) {
    object(row[group], FIELDS, group);
    for (const value of Object.values(row[group])) number(value, group);
  }
  check(
    ['min', 'max'].every((group) =>
      isDeepStrictEqual(Object.keys(row[group]).sort(), Object.keys(row.sum).sort()),
    ),
    'Observation fields must match',
  );
  for (const field of Object.keys(row.sum)) {
    number(row.min[field], 'minimum');
    number(row.max[field], 'maximum');
    check(row.min[field] <= row.max[field], 'Invalid observation range');
  }
  if (row.schema === 2) {
    object(row.counts, FIELDS, 'field counts');
    check(
      isDeepStrictEqual(Object.keys(row.counts).sort(), Object.keys(row.sum).sort()),
      'Counts and sums must match',
    );
    for (const [field, count] of Object.entries(row.counts)) {
      check(Number.isSafeInteger(count) && count > 0 && count <= row.n, 'Invalid field count');
      const mean = row.sum[field] / count;
      check(mean >= row.min[field] - 1e-8 && mean <= row.max[field] + 1e-8, 'Invalid field sum');
    }
  } else check(row.counts === undefined, 'Legacy counts are ambiguous');
  if (row.coverageMs !== undefined) number(row.coverageMs, 'coverage', 0, SLOT_MS);
  for (const name of ENERGIES) if (row[name] !== undefined) number(row[name], name);
  if (row.legacy !== undefined) {
    check(depth === 0 && row.legacy.t === row.t, 'Invalid nested legacy record');
    validateSlot(row.legacy, now, depth + 1);
  }
  return structuredClone(row);
}
function validateDaily(row, legacy = false) {
  const basic = ['date', 'slots', ...ENERGIES, 'peakGridW'];
  object(
    row,
    legacy
      ? basic
      : [
          ...basic,
          'schema',
          'timezone',
          'coverageMs',
          'expectedCoverageMs',
          'sourceFrom',
          'sourceTo',
          'status',
          'legacySlots',
        ],
    'daily history',
  );
  date(row.date);
  check(
    Number.isSafeInteger(row.slots) && row.slots >= 0 && row.slots <= 100,
    'Invalid daily slot count',
  );
  for (const name of ENERGIES) number(row[name], name);
  if (row.peakGridW !== null) number(row.peakGridW, 'daily peak');
  if (!legacy) {
    const bounds = dayBounds(row.date);
    check(row.schema === 3 && row.timezone === TIMEZONE, 'Invalid daily timezone or schema');
    check(row.expectedCoverageMs === bounds.durationMs, 'Invalid day duration');
    number(row.coverageMs, 'daily coverage', 0, bounds.durationMs);
    timestamp(row.sourceFrom);
    timestamp(row.sourceTo);
    check(
      row.sourceFrom >= bounds.start && row.sourceTo <= bounds.end && row.sourceFrom < row.sourceTo,
      'Invalid daily source range',
    );
    check(
      Number.isInteger(row.legacySlots) && row.legacySlots >= 0 && row.legacySlots <= row.slots,
      'Invalid legacy slot count',
    );
    const complete =
      row.legacySlots === 0 &&
      row.coverageMs === bounds.durationMs &&
      row.slots === bounds.durationMs / SLOT_MS;
    check(row.status === (complete ? 'complete' : 'partial'), 'Invalid daily completeness');
  }
  return structuredClone(row);
}
function validateEvent(row) {
  object(
    row,
    ['t', 'type', 'mode', 'observed', 'requested', 'reason', 'controlApplied'],
    'history event',
  );
  timestamp(row.t);
  check(
    typeof row.type === 'string' && row.type.length > 0 && row.type.length <= 100,
    'Invalid event type',
  );
  for (const [key, value] of Object.entries(row)) {
    if (key === 't' || key === 'type') continue;
    check(
      typeof value === 'boolean' || (typeof value === 'string' && value.length <= 500),
      'Invalid event detail',
    );
  }
  return structuredClone(row);
}
function parseExport(input, now = Date.now()) {
  if (typeof input === 'string') {
    check(Buffer.byteLength(input) <= MAX_IMPORT_BYTES, 'History file is too large');
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error('History file is not valid JSON');
    }
  }
  check(bytes(input) <= MAX_IMPORT_BYTES, 'History file is too large');
  object(
    input,
    [
      'format',
      'schema',
      'timezone',
      'exportedAt',
      'slots',
      'daily',
      'events',
      'legacyDaily',
      'historySlots',
      'historyDaily',
      'historyEvents',
    ],
    'history export',
  );
  check([1, 2, 3].includes(input.schema), 'Unsupported history export version');
  if (input.schema === 3)
    check(
      input.format === FORMAT && input.timezone === TIMEZONE,
      'Invalid history format or timezone',
    );
  check(
    typeof input.exportedAt === 'string' && Number.isFinite(Date.parse(input.exportedAt)),
    'Invalid export date',
  );
  const aliases = input.historySlots !== undefined;
  if (input.schema === 3)
    check(!aliases && Array.isArray(input.legacyDaily), 'Version 3 requires canonical keys');
  check(
    !aliases ||
      (input.slots === undefined && input.daily === undefined && input.events === undefined),
    'Conflicting history keys',
  );
  check(
    aliases || (input.historyDaily === undefined && input.historyEvents === undefined),
    'Conflicting history keys',
  );
  const slots = aliases ? input.historySlots : input.slots;
  const daily = aliases ? input.historyDaily : input.daily;
  const events = aliases ? input.historyEvents : input.events;
  check(Array.isArray(slots) && slots.length <= SLOT_RETENTION, 'Invalid history slots');
  check(Array.isArray(daily) && daily.length <= DAY_RETENTION, 'Invalid daily history');
  check(Array.isArray(events) && events.length <= EVENT_RETENTION, 'Invalid history events');
  const legacyDaily = input.schema === 3 ? input.legacyDaily || [] : daily;
  check(
    Array.isArray(legacyDaily) && legacyDaily.length <= DAY_RETENTION,
    'Invalid legacy daily history',
  );
  const parsed = {
    slots: slots.map((row) => validateSlot(row, now)),
    daily: input.schema === 3 ? daily.map((row) => validateDaily(row)) : [],
    legacyDaily: legacyDaily.map((row) => validateDaily(row, true)),
    events: events.map(validateEvent),
  };
  check(
    [...parsed.daily, ...parsed.legacyDaily].every((row) => row.date <= dateKey(now)),
    'Future daily history',
  );
  check(
    parsed.events.every((row) => row.t <= now + 60000),
    'Future history event',
  );
  for (const [rows, key] of [
    [parsed.slots, 't'],
    [parsed.daily, 'date'],
    [parsed.legacyDaily, 'date'],
  ]) {
    check(new Set(rows.map((row) => row[key])).size === rows.length, 'Duplicate history records');
  }
  return parsed;
}
function exportState(state, now = Date.now()) {
  return {
    format: FORMAT,
    schema: 3,
    timezone: TIMEZONE,
    exportedAt: new Date(now).toISOString(),
    slots: structuredClone(state.slots),
    daily: structuredClone(state.daily),
    events: structuredClone(state.events),
    legacyDaily: structuredClone(state.legacyDaily),
  };
}
function mergeImport(current, imported, now) {
  const slots = new Map(imported.slots.map((row) => [row.t, row]));
  let conflicts = 0;
  for (const row of current.slots) {
    if (slots.has(row.t) && !isDeepStrictEqual(row, slots.get(row.t))) conflicts++;
    slots.set(row.t, row); // Never add or overwrite energy for overlapping intervals.
  }
  const days = new Map(imported.daily.map((row) => [row.date, row]));
  for (const row of current.daily) days.set(row.date, row);
  const oldDays = new Map(imported.legacyDaily.map((row) => [row.date, row]));
  for (const row of current.legacyDaily) oldDays.set(row.date, row);
  const allSlots = [...slots.values()];
  const currentDates = new Set(current.slots.map((row) => dateKey(row.t)));
  const currentDays = new Map(current.daily.map((row) => [row.date, row]));
  const daily = dailyFromSlots(allSlots, [...days.values()], now).map((row) => {
    const existing = currentDays.get(row.date);
    // Imported raw files must not revise an existing complete/archived total
    // merely because its original raw quarters have already aged out.
    return existing && (existing.status === 'complete' || !currentDates.has(row.date))
      ? existing
      : row;
  });
  const state = bounded({
    ...current,
    slots: pruneSlots(allSlots, now),
    daily,
    legacyDaily: retainDays([...oldDays.values()], now),
    events: uniqueEvents([...imported.events, ...current.events]),
  });
  return { state, conflicts };
}
module.exports = {
  SLOT_MS,
  SLOT_RETENTION,
  DAY_RETENTION,
  EVENT_RETENTION,
  MAX_STATE_BYTES,
  MAX_IMPORT_BYTES,
  TIMEZONE,
  bytes,
  dateKey,
  dayBounds,
  dailyFromSlots,
  pruneSlots,
  retainDays,
  uniqueEvents,
  bounded,
  parseExport,
  exportState,
  mergeImport,
};
