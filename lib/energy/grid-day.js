'use strict';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const BIN = 300000;
const METRICS = ['amps', 'volts', 'inverterVolts', 'activeKW', 'reactiveKvar', 'frequencyHz'];
const key = (hour) => 'gridDayHour' + hour;

// Fixed hourly partitions keep a single settings write small. Around midnight a
// partition can contain the unexpired tail of yesterday and today's new samples.
class GridDay {
  constructor(settings, now = Date.now) {
    this.settings = settings;
    this.now = now;
    this.hours = Array.from({ length: 24 }, (_, i) => [...(settings.get(key(i)) ?? [])]);
    this.dirty = new Set();
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
      this.settings.set(key(i), this.hours[i].slice());
      this.dirty.delete(i);
    }
  }
  report(binding, metric = 'amps', phase = 0, frequencyUnit = null) {
    if (!METRICS.includes(metric) || !Number.isInteger(phase) || phase < 0 || phase > 2)
      throw Error('Ogiltig mätserie');
    const end = this.now(),
      start = end - DAY;
    const bins = new Map();
    for (const rows of this.hours) {
      for (const row of rows) {
        if (row.at <= start || row.at > end || row.binding !== binding) continue;
        if (
          (metric === 'frequencyHz' || metric === 'inverterVolts') &&
          row.data.frequencyUnit !== frequencyUnit
        )
          continue;
        const value = metric === 'frequencyHz' ? row.data[metric] : row.data[metric]?.[phase];
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
