'use strict';
const Q = 900000,
  MAX_GAP = 300000,
  MAX_SKEW = 2000,
  MAX_W = 350000;
const GROUPS = {
  grid: { power: 'gridW', counters: ['imported', 'exported'] },
  battery: { power: 'essW', counters: ['charged', 'discharged'] },
  solar: { power: 'pvW', counters: ['solar'] },
};
function area(a, b, dt) {
  if (a >= 0 && b >= 0) return [(((a + b) / 2) * dt) / 3600000, 0];
  if (a <= 0 && b <= 0) return [0, (-((a + b) / 2) * dt) / 3600000];
  const first = (dt * Math.abs(a)) / (Math.abs(a) + Math.abs(b));
  const x = (Math.abs(a) * first) / 2 / 3600000,
    y = (Math.abs(b) * (dt - first)) / 2 / 3600000;
  return a > 0 ? [x, y] : [y, x];
}
function counter(n) {
  return typeof n === 'string' && /^(0|[1-9]\d{0,14})$/.test(n) && BigInt(n) <= 100000000000000n
    ? BigInt(n)
    : null;
}
class CounterGapRecovery {
  constructor() {
    this.reset();
  }
  reset() {
    this.streams = new Map();
    this.anchors = new Map();
    this.reasons = new Map();
  }
  observe(key, previous, current, reason) {
    if (!Object.values(GROUPS).some((g) => g.power === key)) return;
    if (previous && current.ms > previous.ms) {
      const valid =
        Number.isFinite(previous.value) &&
        Number.isFinite(current.value) &&
        current.ms - previous.ms <= 60000;
      const blocked =
        ['off-grid', 'connection-changed', 'reader-started'].includes(reason) ||
        ['off-grid', 'connection-changed', 'reader-started'].includes(this.reasons.get(key));
      const rows = this.streams.get(key) || [];
      rows.push({
        from: previous.ms,
        to: current.ms,
        a: previous.value,
        b: current.value,
        valid,
        blocked,
      });
      this.streams.set(key, rows.filter((s) => s.to >= current.ms - 2 * MAX_GAP).slice(-128));
    }
    if (Number.isFinite(current.value)) this.reasons.delete(key);
    else this.reasons.set(key, reason);
  }
  accept(raw, binding, at) {
    const repairs = [];
    if (
      !Number.isSafeInteger(at) ||
      !Number.isFinite(raw?.durationMs) ||
      raw.durationMs < 0 ||
      raw.durationMs > MAX_SKEW
    ) {
      this.anchors.clear();
      return repairs;
    }
    for (const [channel, g] of Object.entries(GROUPS)) {
      const combined = channel === 'solar' && binding.solarMode === 'combined';
      const values = combined
        ? (raw.solarComponents || []).map(counter)
        : g.counters.map((k) => counter(raw.values?.[k]));
      const key = channel === 'solar' ? binding.solarKey : binding.key;
      if (
        typeof key !== 'string' ||
        !key ||
        values.length !== (combined ? 2 : g.counters.length) ||
        values.some((v) => v === null) ||
        (combined &&
          (counter(raw.values?.solar) === null ||
            counter(raw.values.solar) !== values.reduce((a, b) => a + b, 0n)))
      ) {
        this.anchors.delete(channel);
        continue;
      }
      const old = this.anchors.get(channel);
      if (old && at <= old.at) continue;
      this.anchors.set(channel, { at, values, key });
      if (
        !old ||
        old.key !== key ||
        old.values.length !== values.length ||
        at - old.at > MAX_GAP ||
        old.at >= at ||
        Math.floor(old.at / Q) !== Math.floor((at - 1) / Q) ||
        at + MAX_SKEW > (Math.floor(old.at / Q) + 1) * Q
      )
        continue;
      const differences = values.map((v, i) => Number(v - old.values[i]) * 10);
      if (
        differences.some((v) => v < 0) ||
        differences.reduce((a, b) => a + b, 0) > (MAX_W * (at - old.at)) / 3600000 + 20
      )
        continue;
      const segments = (this.streams.get(g.power) || []).filter(
        (s) => s.to > old.at && s.from < at,
      );
      let duration = 0,
        covered = 0,
        positive = 0,
        negative = 0,
        blocked = false;
      for (const s of segments) {
        const from = Math.max(s.from, old.at),
          to = Math.min(s.to, at),
          dt = to - from;
        duration += dt;
        blocked ||= s.blocked;
        if (!s.valid) continue;
        covered += dt;
        const value = (t) => s.a + ((s.b - s.a) * (t - s.from)) / (s.to - s.from);
        const [p, n] = area(value(from), value(to), dt);
        positive += p;
        negative += n;
      }
      const missing = at - old.at - covered;
      if (duration !== at - old.at || blocked || missing <= 0) continue;
      const correction =
        channel === 'grid'
          ? {
              importWh: differences[0] - positive,
              exportWh: differences[1] - negative,
              gridWh: differences[0] - differences[1] - positive + negative,
            }
          : channel === 'battery'
            ? { essWh: differences[0] - differences[1] - positive + negative }
            : { pvWh: differences.reduce((sum, v) => sum + v, 0) - positive + negative };
      repairs.push({
        channel,
        t: Math.floor(old.at / Q) * Q,
        from: old.at,
        to: at,
        coverageMs: missing,
        correctionWh: correction,
        maxCollectionSkewMs: MAX_SKEW,
      });
    }
    return repairs;
  }
}
function effectiveSlot(row) {
  if (!row?.counterRecovery) return row;
  try {
    validateRecovery(row);
  } catch {
    return row;
  }
  const result = {
    ...row,
    energyFieldCoverageMs: { ...row.fieldCoverageMs },
    counterRecoveredChannels: [],
  };
  for (const [channel, r] of Object.entries(row.counterRecovery)) {
    if (
      !GROUPS[channel] ||
      !r ||
      !Number.isFinite(r.coverageMs) ||
      r.coverageMs <= 0 ||
      r.coverageMs > Q ||
      !r.correctionWh
    )
      continue;
    result.counterRecoveredChannels.push(channel);
    for (const [key, value] of Object.entries(r.correctionWh))
      result[key] = (result[key] || 0) + value;
    if (channel === 'grid') {
      result.coverageMs = (row.coverageMs || 0) + r.coverageMs;
      result.directionalCoverageMs = (row.directionalCoverageMs || 0) + r.coverageMs;
    }
    if (channel === 'battery') result.essCoverageMs = (row.essCoverageMs || 0) + r.coverageMs;
    const power = GROUPS[channel].power;
    result.energyFieldCoverageMs[power] = (row.fieldCoverageMs?.[power] || 0) + r.coverageMs;
  }
  return result;
}

function validateRecovery(row) {
  const data = row.counterRecovery;
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).some((k) => !GROUPS[k])
  )
    throw Error('Invalid counter recovery');
  for (const [channel, r] of Object.entries(data)) {
    const keys =
      channel === 'grid'
        ? ['importWh', 'exportWh', 'gridWh']
        : channel === 'battery'
          ? ['essWh']
          : ['pvWh'];
    const raw =
      channel === 'grid'
        ? row.coverageMs
        : channel === 'battery'
          ? row.essCoverageMs
          : row.fieldCoverageMs?.pvW;
    if (
      !r ||
      Object.keys(r).some(
        (k) => !['from', 'to', 'coverageMs', 'correctionWh', 'maxCollectionSkewMs'].includes(k),
      ) ||
      !Number.isSafeInteger(r.from) ||
      !Number.isSafeInteger(r.to) ||
      r.from < row.t ||
      r.to > row.t + Q - MAX_SKEW ||
      r.to <= r.from ||
      !Number.isSafeInteger(r.coverageMs) ||
      r.coverageMs <= 0 ||
      r.coverageMs > r.to - r.from ||
      r.coverageMs + (raw || 0) > Q ||
      r.maxCollectionSkewMs !== MAX_SKEW ||
      !r.correctionWh ||
      Object.keys(r.correctionWh).length !== keys.length ||
      Object.keys(r.correctionWh).some((k) => !keys.includes(k)) ||
      keys.some((k) => !Number.isFinite(r.correctionWh[k]) || Math.abs(r.correctionWh[k]) > 1e8)
    )
      throw Error('Invalid counter recovery');
    if (
      channel === 'grid' &&
      Math.abs(r.correctionWh.importWh - r.correctionWh.exportWh - r.correctionWh.gridWh) > 1e-6
    )
      throw Error('Invalid recovered directions');
  }
  return data;
}
module.exports = { CounterGapRecovery, effectiveSlot, validateRecovery, GROUPS, MAX_GAP, MAX_SKEW };
