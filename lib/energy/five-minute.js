'use strict';

const FIVE_MS = 300000;
const fields = {
  gridW: 'grid',
  pvW: 'solar',
  essW: 'battery',
  evW: 'dc',
  evacW: 'ac',
  household: 'house',
};

// The quarter already stores total energy and covered time. Keep only the first two
// components; the third is their remainder. This is one additive measurement series.
function recordPart(row, key, start, end, wh, split = false) {
  row.fiveMinute ||= {};
  const parts = (row.fiveMinute[key] ||= [0, 0, 0, 0]);
  const index = Math.floor((start - row.t) / FIVE_MS) * 2;
  if (split) parts[4] = (parts[4] ?? 0) | (1 << (index / 2));
  if (index < 4) {
    parts[index] += wh;
    parts[index + 1] += end - start;
  }
}
function mergeParts(before = {}, after = {}) {
  const merged = { ...before };
  for (const [key, parts] of Object.entries(after)) {
    merged[key] = parts.slice(0, 4).map((n, i) => n + (before[key]?.[i] ?? 0));
    const mask = (parts[4] ?? 0) | (before[key]?.[4] ?? 0);
    if (mask) merged[key][4] = mask;
  }
  return merged;
}
function component(row, key, index) {
  const parts = row.fiveMinute?.[key];
  if (!parts) return [0, 0];
  if (index < 2) return parts.slice(index * 2, index * 2 + 2);
  const wh = key === 'household' ? row.householdWh : row[key.replace('W', 'Wh')];
  const ms = key === 'household' ? row.householdCoverageMs : row.fieldCoverageMs?.[key];
  return [wh - parts[0] - parts[2], ms - parts[1] - parts[3]];
}
function validParts(row) {
  const detail = row.fiveMinute;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail) || !Object.keys(detail).length)
    return false;
  return Object.entries(detail).every(([key, parts]) => {
    if (
      !Object.hasOwn(fields, key) ||
      !Array.isArray(parts) ||
      !(
        parts.length === 4 ||
        (key === 'household' &&
          parts.length === 5 &&
          Number.isInteger(parts[4]) &&
          parts[4] > 0 &&
          parts[4] <= 7)
      )
    )
      return false;
    for (let i = 0; i < 3; i++) {
      const [wh, ms] = component(row, key, i);
      if (
        !Number.isFinite(wh) ||
        !Number.isInteger(ms) ||
        ms < 0 ||
        ms > FIVE_MS ||
        (!ms && Math.abs(wh) > 1e-6) ||
        (['evacW', 'household'].includes(key) && wh < -1e-6)
      )
        return false;
    }
    return true;
  });
}
function point(row, index, effective) {
  let estimated = false;
  const kw = {};
  for (const [key, series] of Object.entries(fields)) {
    let [wh, ms] = component(row, key, index);
    const recovery =
      row.counterRecovery?.[
        { grid: 'grid', battery: 'battery', solar: 'solar', dc: 'ev', ac: 'evac' }[series]
      ];
    if (effective?.counterRecoveredChannels && recovery?.parts && ms < FIVE_MS) {
      for (const part of recovery.parts) {
        const missing = part.bins?.[index];
        if (!missing) continue;
        wh += (part.correctionWh[key.replace('W', 'Wh')] * missing) / part.coverageMs;
        ms += missing;
        if (ms === FIVE_MS) estimated = true;
      }
    }
    const sign = key === 'gridW' || key === 'pvW' ? 1 : -1;
    kw[series] =
      ms === FIVE_MS && Number.isFinite(wh) && (key !== 'pvW' || wh >= -1e-6)
        ? (sign * wh * 3600) / FIVE_MS
        : null;
  }
  return {
    t: row.t + index * FIVE_MS,
    durationMs: FIVE_MS,
    kw,
    estimated:
      estimated || (kw.house !== null && !!((row.fiveMinute.household?.[4] ?? 0) & (1 << index))),
  };
}
module.exports = { FIVE_MS, recordPart, mergeParts, validParts, component, point };
