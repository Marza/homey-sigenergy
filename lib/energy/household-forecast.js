'use strict';
const { SLOT_MS: Q } = require('../history-format');
const DAY = 96 * Q;
const KEY = 'householdForecastV1';
const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function local(t) {
  const [date, time] = clock.format(t).split(' ');
  const day = Date.parse(date + 'T00:00:00Z') / DAY;
  const weekday = new Date(day * DAY).getUTCDay();
  return { day, time, weekend: weekday === 0 || weekday === 6 };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function observations(slots, now) {
  const actual = new Map(),
    seen = new Set();
  for (const row of slots) {
    const t = row?.t;
    if (!Number.isSafeInteger(t) || t % Q !== 0 || t + Q > now || t < now - 32 * DAY) continue;
    if (seen.has(t)) {
      actual.delete(t);
      continue;
    }
    seen.add(t);
    if (row.householdCoverageMs === Q && Number.isFinite(row.householdWh) && row.householdWh >= 0)
      actual.set(t, row.householdWh);
  }
  return actual;
}
function issue(actual, now, start) {
  const profiles = new Map();
  for (const [t, wh] of actual) {
    const { time, day, weekend } = local(t);
    if (!profiles.has(time)) profiles.set(time, new Map());
    const days = profiles.get(time);
    // Both occurrences of a clock time in autumn contribute one daily observation.
    const entry = days.get(day) ?? { weekend, values: [] };
    entry.values.push(wh);
    days.set(day, entry);
  }
  const wh = [],
    yesterday = [];
  let comparable = 0;
  for (let t = start; t < start + DAY; t += Q) {
    const { time, day, weekend } = local(t);
    const history = profiles.get(time) ?? new Map();
    const previous = history.get(day - 1);
    const baseline = previous ? median(previous.values) : null;
    const peers = [...history]
      .filter(([d, p]) => d < day && p.weekend === weekend)
      .map(([, p]) => median(p.values));
    if (peers.length >= 3) comparable++;
    // For the last forecast quarter, yesterday's counterpart may still be in progress at issuance.
    const value =
      peers.length && (peers.length >= 3 || baseline === null) ? median(peers) : baseline;
    wh.push(value === null ? null : Math.round(value));
    yesterday.push(baseline === null ? null : Math.round(baseline));
  }
  return { at: now, start, wh, yesterday, comparable };
}
function accuracy(references, actual, now) {
  const errors = [];
  let absoluteWh = 0,
    baselineWh = 0,
    pairs = 0;
  for (const f of references) {
    if (f.start + DAY > now) continue;
    let signedWh = 0,
      count = 0;
    f.wh.forEach((v, i) => {
      const measured = actual.get(f.start + i * Q);
      if (v === null || measured === undefined) return;
      signedWh += measured - v;
      count++;
      if (f.yesterday[i] !== null) {
        absoluteWh += Math.abs(measured - v);
        baselineWh += Math.abs(measured - f.yesterday[i]);
        pairs++;
      }
    });
    if (count === 96) errors.push(signedWh / 1000);
  }
  const sorted = [...errors].sort((a, b) => a - b);
  return {
    days: errors.length,
    lastErrorKWh: errors.at(-1) ?? null,
    pairs,
    maeKW: pairs ? absoluteWh / pairs / 250 : null,
    yesterdayMaeKW: pairs ? baselineWh / pairs / 250 : null,
    // Empirical 10th and 90th percentiles of non-overlapping, fully measured daily errors.
    offsets:
      errors.length >= 14
        ? [
            sorted[Math.floor((sorted.length - 1) * 0.1)],
            sorted[Math.ceil((sorted.length - 1) * 0.9)],
          ]
        : null,
  };
}
// Read the already issued forecast without refreshing the engine from a widget request.
function upcomingHouseholdPower(settings, start, end, now) {
  if (end <= now) return [];
  const first = Math.max(start, Math.ceil(now / Q) * Q);
  let latest;
  try {
    latest = settings?.get(KEY)?.issues?.at(-1);
  } catch {
    return [];
  }
  if (
    !Number.isSafeInteger(latest?.at) ||
    latest.at > now ||
    latest.start !== (Math.floor(latest.at / Q) + 1) * Q ||
    !Array.isArray(latest.wh) ||
    latest.wh.length !== 96
  )
    return [];
  const points = [];
  for (let t = Math.max(first, latest.start); t < Math.min(end, latest.start + DAY); t += Q) {
    const wh = latest.wh[(t - latest.start) / Q];
    // Consumption is below zero on the dashboard's power axis.
    points.push({ t, kw: Number.isFinite(wh) && wh >= 0 ? -(wh / 250) || 0 : null });
  }
  return points;
}

class HouseholdForecast {
  constructor(settings, history) {
    this.settings = settings;
    this.history = history;
  }
  refresh(now = Date.now(), slots) {
    const start = (Math.floor(now / Q) + 1) * Q;
    const state = this.settings.get(KEY) ?? { issues: [], references: [] };
    const last = state.issues.at(-1);
    if (last && last.at > now) throw new Error('Clock precedes the last issued forecast');
    if (last?.start === start) return;
    const forecast = issue(observations(slots ?? this.history.getSlots(), now), now, start);
    const issues = state.issues.filter((f) => f.start > start - 2 * DAY && f.start < start);
    const references = state.references.filter(
      (f) => f.start >= start - 30 * DAY && f.start < start,
    );
    const prior = references.at(-1);
    if (!prior || start >= prior.start + DAY) references.push(forecast);
    this.settings.set(KEY, { issues: [...issues, forecast], references });
  }
  report(now = Date.now()) {
    this.refresh(now);
    const { issues, references } = this.settings.get(KEY);
    const forecast = issues.at(-1);
    const actual = observations(this.history.getSlots(), now);
    const score = accuracy(references, actual, now);
    const known = forecast.wh.filter((v) => v !== null);
    const total = known.length === 96 ? known.reduce((a, b) => a + b, 0) / 1000 : null;
    const peak = known.length ? Math.max(...known) : null;
    const completed = issues.filter((f) => f.start + DAY <= now);
    const previous = completed.at(-1) ?? references.filter((f) => f.start + Q <= now).at(-1);
    const recentScore = accuracy(completed, actual, now);
    return {
      issuedAt: forecast.at,
      start: forecast.start,
      known: known.length,
      comparable: forecast.comparable,
      totalKWh: total,
      peakKW: peak === null ? null : peak / 250,
      peakAt: peak === null ? null : forecast.start + forecast.wh.indexOf(peak) * Q,
      rangeKWh:
        total !== null && score.offsets ? score.offsets.map((d) => Math.max(0, total + d)) : null,
      score,
      completedRuns: completed.length,
      fullyScoredRuns: recentScore.days,
      recentErrorKWh: recentScore.lastErrorKWh,
      forecastKW: forecast.wh.map((v) => (v === null ? null : v / 250)),
      comparison: previous
        ? {
            start: previous.start,
            forecastKW: previous.wh.map((v) => (v === null ? null : v / 250)),
            actualKW: previous.wh.map((_, i) => {
              const v = actual.get(previous.start + i * Q);
              return v === undefined ? null : v / 250;
            }),
          }
        : null,
    };
  }
}
module.exports = { HouseholdForecast, upcomingHouseholdPower, median };
