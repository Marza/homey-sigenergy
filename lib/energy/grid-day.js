'use strict';

const { pack, unpack } = require('../packed-history');
const HOUR = 3600000;
const DAY = 24 * HOUR;
const BIN = 300000;
const METRICS = ['amps', 'volts', 'activeKW', 'reactiveKvar'];
const key = (hour) => 'gridDayHour' + hour;

// Fixed hourly partitions keep a single settings write small. Around midnight a
// partition can contain the unexpired tail of yesterday and today's new samples.
class GridDay {
  constructor(settings, now = Date.now) {
    this.settings = settings;
    this.now = now;
    this.dirty = new Set();
    this.hours = Array.from({ length: 24 }, (_, i) => {
      const stored = settings.get(key(i));
      const rows = unpack(stored) ?? [];
      if (!Array.isArray(rows)) throw Error('Invalid grid history partition');
      if (Array.isArray(stored) && rows.length) this.dirty.add(i);
      return [...rows];
    });
    this.prune(this.now());
  }
  prune(now) {
    for (const [i, rows] of this.hours.entries()) {
      if (rows.length && (rows[0].at <= now - DAY || rows.at(-1).at > now)) {
        this.hours[i] = rows.filter((row) => row.at > now - DAY && row.at <= now);
        this.dirty.add(i);
      }
    }
  }
  append(binding, data, at) {
    if (!binding || !Number.isSafeInteger(at) || !data) return;
    this.prune(at);
    const i = Math.floor(at / HOUR) % 24;
    const rows = this.hours[i];
    const last = rows.at(-1);
    // Timer jitter can put two genuine polls in the same wall-clock ten-second slot.
    if (last && last.at >= at) return;
    rows.push({ at, binding, data });
    this.dirty.add(i);
  }
  flush() {
    this.prune(this.now());
    for (const i of this.dirty) {
      this.settings.set(key(i), this.hours[i].length ? pack(this.hours[i]) : []);
      this.dirty.delete(i);
    }
  }
  report(binding, metric = 'amps', phase = 0) {
    if (!METRICS.includes(metric) || !Number.isInteger(phase) || phase < 0 || phase > 2)
      throw Error('Ogiltig mätserie');
    const end = this.now(),
      start = end - DAY;
    const bins = new Map();
    const observations = [];
    for (const rows of this.hours) {
      for (const row of rows) {
        if (row.at <= start || row.at > end || row.binding !== binding) continue;
        if (Number.isInteger(row.data.gridMode) || Number.isInteger(row.data.gridAlarms))
          observations.push(row);
        const value = row.data[metric]?.[phase];
        if (!Number.isFinite(value)) continue;
        const t = Math.floor(row.at / BIN) * BIN;
        const bin = bins.get(t) ?? { t, count: 0, min: value, max: value, sum: 0 };
        bin.min = Math.min(bin.min, value);
        bin.max = Math.max(bin.max, value);
        bin.sum += value;
        bin.count++;
        bins.set(t, bin);
      }
    }
    const events = [];
    let previous;
    for (const { at, data } of observations.sort((a, b) => a.at - b.at)) {
      const resumed = !previous || at - previous.at > 20000;
      if (resumed || data.gridMode !== previous.mode || data.gridAlarms !== previous.alarms)
        events.push({ at, mode: data.gridMode, alarms: data.gridAlarms, resumed });
      previous = { at, mode: data.gridMode, alarms: data.gridAlarms };
    }
    return {
      events,
      start,
      end,
      binMs: BIN,
      bins: [...bins.values()]
        .sort((a, b) => a.t - b.t)
        .map(({ sum, ...bin }) => ({ ...bin, mean: sum / bin.count })),
    };
  }
}
module.exports = { GridDay };
