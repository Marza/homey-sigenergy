'use strict';

const { SLOT_MS, SLOT_RETENTION, dateKey, dayBounds } = require('../history-format');
const {
  readComparableSlots,
  energyValid,
  batteryValid,
  evEnergyValid,
  evacEnergyValid,
} = require('../pricing/comparison-data');

const DAY_MS = 86400000;
const dayString = (value) => new Date(value).toISOString().slice(0, 10);
const dayNumber = (value) => Date.parse(value + 'T00:00:00Z');

function periodBounds(date, period) {
  const day = new Date(dayNumber(date));
  if (period === 'week') {
    const monday = day.valueOf() - ((day.getUTCDay() + 6) % 7) * DAY_MS;
    return [dayString(monday), dayString(monday + 7 * DAY_MS)];
  }
  if (period === 'month') {
    const start = date.slice(0, 7) + '-01';
    day.setUTCDate(1);
    day.setUTCMonth(day.getUTCMonth() + 1);
    return [start, dayString(day.valueOf())];
  }
  return [date, dayString(day.valueOf() + DAY_MS)];
}

function windowFor(date, period, now) {
  if (!Number.isSafeInteger(now) || !['day', 'week', 'month'].includes(period)) return null;
  const today = dateKey(now);
  const oldestTime = Math.ceil((now - SLOT_RETENTION * SLOT_MS) / SLOT_MS) * SLOT_MS;
  const earliest = dateKey(oldestTime);
  if (date === 'today') date = today;
  if (
    typeof date !== 'string' ||
    date < earliest ||
    date > today ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  )
    return null;
  const calendarTime = dayNumber(date);
  if (!Number.isFinite(calendarTime) || dayString(calendarTime) !== date) return null;
  const [first, last] = periodBounds(date, period);
  const { start } = dayBounds(first);
  const { start: end } = dayBounds(last);
  const elapsedEnd = Math.min(end, Math.floor(now / SLOT_MS) * SLOT_MS);
  return {
    date,
    today,
    earliest,
    period,
    start,
    end,
    elapsedEnd,
    expectedQuarters: (elapsedEnd - start) / SLOT_MS,
    previous: first > earliest ? dayString(dayNumber(first) - DAY_MS) : null,
    next: last <= today ? last : null,
    oldestTime,
  };
}

function readWindow(homey, date, period, now) {
  const window = windowFor(date, period, now);
  if (!window) return { schema: 1, status: 'invalid-period' };
  const { oldestTime, ...range } = window;
  const stored = readComparableSlots(homey);
  if (!stored) return { schema: 1, status: 'unavailable', range };
  const rows = stored.filter(
    (row) => row.t >= Math.max(range.start, oldestTime) && row.t < range.elapsedEnd,
  );
  return { schema: 1, status: 'ok', range, rows };
}

function channels(row) {
  const solar =
    (row.energyFieldCoverageMs?.pvW ?? row.fieldCoverageMs?.pvW) === SLOT_MS &&
    Number.isFinite(row.pvWh) &&
    row.pvWh >= 0;
  const house =
    row.householdCoverageMs === SLOT_MS && Number.isFinite(row.householdWh) && row.householdWh >= 0;
  return {
    grid: energyValid(row) ? row.gridWh : null,
    solar: solar ? row.pvWh : null,
    battery: batteryValid(row) ? -row.essWh : null,
    dc: evEnergyValid(row) ? -row.evWh : null,
    ac: evacEnergyValid(row) ? -row.evacWh : null,
    house: house ? -row.householdWh : null,
  };
}

function estimated(row, values) {
  const recovered = row.counterRecoveredChannels || [];
  return (
    (values.grid !== null && recovered.includes('grid')) ||
    (values.solar !== null && recovered.includes('solar')) ||
    (values.battery !== null && recovered.includes('battery')) ||
    (values.house !== null && row.householdEstimatedMs > 0)
  );
}

function getEnergyFlow(homey, { date, period } = {}, now = Date.now()) {
  const { rows, ...result } = readWindow(homey, date, period, now);
  if (!rows) return result;
  const wattHours = Object.fromEntries(
    ['grid', 'solar', 'battery', 'dc', 'ac', 'house'].map((key) => [
      key,
      { input: 0, output: 0, quarters: 0 },
    ]),
  );
  let estimatedQuarters = 0;
  for (const row of rows) {
    const values = channels(row);
    if (estimated(row, values)) estimatedQuarters++;
    for (const [key, value] of Object.entries(values)) {
      if (value === null) continue;
      const total = wattHours[key];
      total.quarters++;
      if (key === 'grid') {
        total.input += row.importWh;
        total.output += row.exportWh;
      } else {
        total.input += Math.max(0, value);
        total.output += Math.max(0, -value);
      }
    }
  }
  const totals = Object.fromEntries(
    Object.entries(wattHours).map(([key, { input, output, quarters }]) => [
      key,
      { inKWh: quarters ? input / 1000 : null, outKWh: quarters ? output / 1000 : null, quarters },
    ]),
  );
  return { ...result, totals, estimatedQuarters };
}

function getPowerHistory(homey, { date } = {}, now = Date.now()) {
  const { rows, ...result } = readWindow(homey, date, 'day', now);
  if (!rows) return result;
  const byTime = new Map(rows.map((row) => [row.t, row]));
  const points = Array.from({ length: result.range.expectedQuarters }, (_, index) => {
    const t = result.range.start + index * SLOT_MS;
    const row = byTime.get(t);
    const values = channels(row || {});
    const kw = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value === null ? null : value / 250]),
    );
    return { t, kw, estimated: row ? estimated(row, values) : false };
  });
  return { ...result, points };
}

module.exports = { getEnergyFlow, getPowerHistory };
