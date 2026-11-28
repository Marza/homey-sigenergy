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
      return {
        first: rows[0]?.at,
        last: rows.at(-1)?.at,
        stored,
        rows: Array.isArray(stored) ? [...rows] : null,
      };
    });
    this.prune(this.now());
  }
  prune(now) {
    for (const [i, hour] of this.hours.entries()) {
      if (hour.first <= now - DAY || hour.last > now) {
        const rows =
          hour.last <= now - DAY || hour.first > now
            ? []
            : (hour.rows ?? unpack(hour.stored)).filter(
                (row) => row.at > now - DAY && row.at <= now,
              );
        hour.rows = rows;
        hour.first = rows[0]?.at;
        hour.last = rows.at(-1)?.at;
        this.dirty.add(i);
      }
    }
  }
  append(binding, data, at) {
    if (!binding || !Number.isSafeInteger(at) || !data) return;
    this.prune(at);
    const i = Math.floor(at / HOUR) % 24;
    const hour = this.hours[i];
    // Timer jitter can put two genuine polls in the same wall-clock ten-second slot.
    if (hour.last >= at) return;
    hour.rows ??= unpack(hour.stored) ?? [];
    hour.rows.push({ at, binding, data });
    hour.first ??= at;
    hour.last = at;
    this.dirty.add(i);
  }
  flush() {
    const now = this.now();
    this.prune(now);
    for (const i of this.dirty) {
      const hour = this.hours[i];
      const stored = hour.rows.length ? pack(hour.rows) : [];
      this.settings.set(key(i), stored);
      hour.stored = stored;
      this.dirty.delete(i);
    }
    // Keep only the open hour decoded between polls.
    const active = Math.floor(now / HOUR) % 24;
    for (const [i, hour] of this.hours.entries()) if (i !== active) hour.rows = null;
  }
  report(binding, metric = 'amps', phase = 0) {
    if (!METRICS.includes(metric) || !Number.isInteger(phase) || phase < 0 || phase > 2)
      throw Error('Ogiltig mätserie');
    const end = this.now(),
      start = end - DAY;
    const bins = new Map();
    const events = [];
    let previous;
    let phaseCurrentSamples = 0;
    // Traverse real hours in order. At the day boundary one partition contains two dates.
    for (let h = Math.max(0, Math.floor(start / HOUR)); h <= Math.floor(end / HOUR); h++) {
      const hour = this.hours[h % 24];
      if (hour.first === undefined || hour.last < h * HOUR || hour.first >= (h + 1) * HOUR)
        continue;
      for (const row of hour.rows ?? unpack(hour.stored)) {
        if (
          row.at <= start ||
          row.at > end ||
          Math.floor(row.at / HOUR) !== h ||
          row.binding !== binding
        )
          continue;
        if (Number.isFinite(row.data.amps?.[phase])) phaseCurrentSamples++;
        const { gridMode: mode, gridAlarms: alarms } = row.data;
        if (Number.isInteger(mode) || Number.isInteger(alarms)) {
          const resumed = !previous || row.at - previous.at > 20000;
          if (resumed || mode !== previous.mode || alarms !== previous.alarms)
            events.push({ at: row.at, mode, alarms, resumed });
          previous = { at: row.at, mode, alarms };
        }
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
    return {
      events,
      phaseCurrentSamples,
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
