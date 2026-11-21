'use strict';

const SOURCES = ['grid', 'inverter'];
const PHASES = ['L1', 'L2', 'L3'];
const MAX_AMPS = 10000;
const SLOT_MS = 900000;
const MAX_GAP_MS = 60000;

const validAmps = (values) =>
  Array.isArray(values) &&
  values.length === PHASES.length &&
  [...values].every((value) => Number.isFinite(value) && value >= 0 && value <= MAX_AMPS);
const validBinding = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);

function validQuarter(row) {
  return (
    row &&
    Object.keys(row).sort().join(',') === 'ampMs,binding,ms,peakA' &&
    validBinding(row.binding) &&
    Number.isInteger(row.ms) &&
    row.ms > 0 &&
    row.ms <= SLOT_MS &&
    validAmps(row.peakA) &&
    Array.isArray(row.ampMs) &&
    row.ampMs.length === PHASES.length &&
    [...row.ampMs].every(
      (sum, i) => Number.isFinite(sum) && sum >= 0 && sum <= row.peakA[i] * row.ms + 1e-4,
    )
  );
}

function mergeQuarter(old, next) {
  if (!old) return next;
  // Keep the earlier source's observations, without using them to complete a quarter for the new one.
  if (old.binding !== next.binding || old.ms + next.ms > SLOT_MS) return old;
  return {
    binding: old.binding,
    ms: old.ms + next.ms,
    ampMs: old.ampMs.map((sum, i) => sum + next.ampMs[i]),
    peakA: old.peakA.map((peak, i) => Math.max(peak, next.peakA[i])),
  };
}

function recordInterval(old, next, getSlot, source) {
  if (!old?.amps || !next.amps || old.binding !== next.binding || next.at - old.at > MAX_GAP_MS)
    return;
  const length = next.at - old.at;
  for (let start = old.at; start < next.at;) {
    const t = Math.floor(start / SLOT_MS) * SLOT_MS;
    const end = Math.min(t + SLOT_MS, next.at);
    const at = (i, ms) => old.amps[i] + (next.amps[i] - old.amps[i]) * ((ms - old.at) / length);
    const entry = getSlot(t);
    entry.phaseCurrent ||= {};
    entry.phaseCurrent[source] = mergeQuarter(entry.phaseCurrent[source], {
      binding: next.binding,
      ms: end - start,
      ampMs: old.amps.map((_, i) => Math.max(0, (at(i, start) + at(i, end)) / 2) * (end - start)),
      // Keep the larger bracketing measurement in both quarters when a sample interval splits.
      peakA: old.amps.map((value, i) => Math.max(value, next.amps[i])),
    });
    start = end;
  }
}

function historySummary(slots, from, to) {
  if (!slots) return null;
  const rows = slots
    .filter((row) => row.t >= from && row.t < to)
    .map((row) => row.phaseCurrent?.grid)
    .filter(validQuarter);
  const coveredMs = rows.reduce((sum, row) => sum + row.ms, 0);
  return {
    grid: {
      coveredMs,
      fullQuarters: rows.filter((row) => row.ms === SLOT_MS).length,
      phases: coveredMs
        ? PHASES.map((phase, i) => ({
            phase,
            meanA: rows.reduce((sum, row) => sum + row.ampMs[i], 0) / coveredMs,
            peakA: rows.reduce((peak, row) => Math.max(peak, row.peakA[i]), 0),
          }))
        : null,
    },
  };
}

module.exports = {
  SOURCES,
  PHASES,
  validAmps,
  validBinding,
  validQuarter,
  mergeQuarter,
  recordInterval,
  historySummary,
};
