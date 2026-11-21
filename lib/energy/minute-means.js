'use strict';

const MINUTE_MS = 60000;
const perBin = { soc: 5, evSoc: 5, outdoorC: 15 };

function validValue(field, value) {
  return Number.isFinite(value) && value >= (field === 'outdoorC' ? -50 : 0) && value <= 100;
}

function validMinuteMeans(fields) {
  if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) return false;
  return Object.entries(fields).every(([field, bins]) => {
    const width = perBin[field];
    return (
      Object.hasOwn(perBin, field) &&
      Array.isArray(bins) &&
      bins.length === 15 / width &&
      bins.some(Boolean) &&
      bins.every(
        (bin) =>
          bin === null ||
          (bin &&
            Object.keys(bin).length === 3 &&
            validValue(field, bin.mean) &&
            Number.isInteger(bin.lastMinute) &&
            bin.lastMinute >= 0 &&
            bin.lastMinute < width &&
            Number.isInteger(bin.count) &&
            bin.count > 0 &&
            bin.count <= bin.lastMinute + 1),
      )
    );
  });
}

// Keep only the current quarter per sensor. Replacing a field's bins makes repeated
// flush attempts idempotent and preserves the last sampled minute across a restart.
class MinuteMeans {
  constructor(openRow) {
    this.latest = new Map();
    for (const [field, bins] of Object.entries(openRow?.minuteMeans ?? {}))
      this.latest.set(field, { t: openRow.t, bins });
  }
  observe(field, value, at, t) {
    if (!Object.hasOwn(perBin, field) || !validValue(field, value)) return null;
    const width = perBin[field];
    const minute = Math.floor((at - t) / MINUTE_MS);
    const index = Math.floor(minute / width);
    const lastMinute = minute % width;
    const previous = this.latest.get(field);
    if (previous && t < previous.t) return null;
    const bins = previous?.t === t ? [...previous.bins] : Array(15 / width).fill(null);
    const old = bins[index];
    if (old && old.lastMinute >= lastMinute) return null;
    const count = (old?.count ?? 0) + 1;
    bins[index] = { mean: ((old?.mean ?? 0) * (count - 1) + value) / count, count, lastMinute };
    this.latest.set(field, { t, bins });
    return bins;
  }
}

module.exports = { MinuteMeans, validMinuteMeans };
