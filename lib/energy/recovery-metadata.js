'use strict';
const { isDeepStrictEqual } = require('node:util');
const { component } = require('./five-minute');
const POWER = { grid: 'gridW', battery: 'essW', solar: 'pvW', ev: 'evW', evac: 'evacW' };
const Q = 900000,
  MAX_GAP = Q,
  MAX_SKEW = 2000;
const FIELDS = {
  grid: ['importWh', 'exportWh', 'gridWh'],
  battery: ['essWh'],
  solar: ['pvWh'],
  ev: ['evWh'],
  evac: ['evacWh'],
};
const BASE_KEYS = ['from', 'to', 'coverageMs', 'correctionWh', 'maxCollectionSkewMs'];
const fail = () => {
  throw Error('Invalid counter recovery');
};
const close = (a, b) => Math.abs(a - b) <= 1e-6;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
function shape(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((k) => keys.includes(k))
  );
}
function energy(value, keys) {
  return (
    shape(value, keys) && keys.every((k) => Number.isFinite(value[k]) && Math.abs(value[k]) <= 1e8)
  );
}
function allocationValid(part, t, channel) {
  const a = part.allocation,
    keys = FIELDS[channel];
  if (
    !shape(a, ['method', 'from', 'to', 'missingMs', 'correctionWh']) ||
    a.method !== 'missing-time-proportional' ||
    !integer(a.from) ||
    !integer(a.to) ||
    a.to <= a.from ||
    a.to - a.from > MAX_GAP ||
    a.to % Q === 0 ||
    a.to % Q > Q - MAX_SKEW ||
    a.from % Q > Q - MAX_SKEW ||
    Math.floor(a.to / Q) !== Math.floor(a.from / Q) + 1 ||
    !Array.isArray(a.missingMs) ||
    a.missingMs.length !== 2 ||
    !energy(a.correctionWh, keys)
  )
    return false;
  const first = Math.floor(a.from / Q) * Q,
    index = (t - first) / Q;
  if (![0, 1].includes(index)) return false;
  const overlap = (i) => Math.min(a.to, first + (i + 1) * Q) - Math.max(a.from, first + i * Q);
  if (!a.missingMs.every((n, i) => integer(n) && n <= overlap(i))) return false;
  const total = a.missingMs[0] + a.missingMs[1];
  return (
    total > 0 &&
    (channel === 'grid'
      ? a.correctionWh.importWh + a.correctionWh.exportWh
      : Math.abs(a.correctionWh[keys[0]])) <=
      (350000 * total) / 3600000 + 20 &&
    a.missingMs[index] === part.coverageMs &&
    part.from === Math.max(a.from, t) &&
    part.to === Math.min(a.to, t + Q) &&
    keys.every((k) => close(part.correctionWh[k], (a.correctionWh[k] * part.coverageMs) / total)) &&
    (channel !== 'grid' ||
      (a.correctionWh.importWh >= 0 &&
        a.correctionWh.exportWh >= 0 &&
        close(a.correctionWh.importWh - a.correctionWh.exportWh, a.correctionWh.gridWh))) &&
    (!['solar', 'evac'].includes(channel) || a.correctionWh[keys[0]] >= 0)
  );
}
function validatePart(r, t, channel) {
  const keys = FIELDS[channel];
  if (
    !shape(r, [
      ...BASE_KEYS,
      ...(r?.bins ? ['bins'] : []),
      ...(r?.allocation ? ['allocation'] : []),
    ]) ||
    !integer(r.from) ||
    !integer(r.to) ||
    r.from < t ||
    r.to <= r.from ||
    r.to > t + Q - (r.allocation || (r.bins && r.to === t + Q) ? 0 : MAX_SKEW) ||
    !integer(r.coverageMs) ||
    r.coverageMs <= 0 ||
    r.coverageMs > r.to - r.from ||
    r.maxCollectionSkewMs !== MAX_SKEW ||
    !energy(r.correctionWh, keys) ||
    (r.allocation && !allocationValid(r, t, channel))
  )
    fail();
  if (
    r.bins &&
    (!Array.isArray(r.bins) ||
      r.bins.length !== 3 ||
      !r.bins.every(
        (ms, i) =>
          integer(ms) &&
          ms <=
            Math.max(0, Math.min(r.to, t + ((i + 1) * Q) / 3) - Math.max(r.from, t + (i * Q) / 3)),
      ) ||
      r.bins.reduce((a, b) => a + b, 0) !== r.coverageMs)
  )
    fail();
  if (
    channel === 'grid' &&
    !close(r.correctionWh.importWh - r.correctionWh.exportWh, r.correctionWh.gridWh)
  )
    fail();
}
function validateRecovery(row) {
  const data = row.counterRecovery;
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).some((k) => !Object.hasOwn(FIELDS, k))
  )
    fail();
  for (const [channel, r] of Object.entries(data)) {
    const raw =
      channel === 'grid'
        ? row.coverageMs
        : channel === 'battery'
          ? row.essCoverageMs
          : row.fieldCoverageMs?.[POWER[channel]];
    if (
      !r ||
      !integer(raw ?? 0) ||
      (raw ?? 0) > Q ||
      !integer(r.coverageMs) ||
      r.coverageMs + (raw ?? 0) > Q
    )
      fail();
    if (r.parts === undefined) {
      // New allocation evidence is only valid inside the versioned parts format.
      if (!shape(r, BASE_KEYS)) fail();
      validatePart(r, row.t, channel);
    } else {
      if (
        !shape(r, [...BASE_KEYS, 'parts']) ||
        !Array.isArray(r.parts) ||
        r.parts.length < 1 ||
        r.parts.length > 128
      )
        fail();
      let previous;
      for (const part of r.parts) {
        validatePart(part, row.t, channel);
        if (previous && previous.to > part.from) fail();
        previous = part;
      }
      for (let i = 0; i < 3; i++) {
        const measured = component(row, POWER[channel], i)[1];
        const repaired = r.parts.reduce((ms, p) => ms + (p.bins?.[i] ?? 0), 0);
        if (measured + repaired > Q / 3) fail();
      }
      if (
        r.from !== r.parts[0].from ||
        r.to !== r.parts.at(-1).to ||
        r.maxCollectionSkewMs !== MAX_SKEW ||
        r.coverageMs !== r.parts.reduce((n, p) => n + p.coverageMs, 0) ||
        !energy(r.correctionWh, FIELDS[channel]) ||
        !FIELDS[channel].every((k) =>
          close(
            r.correctionWh[k],
            r.parts.reduce((n, p) => n + p.correctionWh[k], 0),
          ),
        )
      )
        fail();
    }
  }
  return data;
}
function mergeRecovery(old, part) {
  if (old && part.from < old.to) fail();
  const correctionWh = { ...old?.correctionWh };
  for (const [k, v] of Object.entries(part.correctionWh))
    correctionWh[k] = (correctionWh[k] || 0) + v;
  return {
    from: old?.from ?? part.from,
    to: part.to,
    coverageMs: (old?.coverageMs || 0) + part.coverageMs,
    correctionWh,
    maxCollectionSkewMs: MAX_SKEW,
    ...(part.bins || part.allocation || old?.parts
      ? { parts: [...(old ? old.parts || [old] : []), part] }
      : {}),
  };
}
function repairPart({ from, to, coverageMs, correctionWh, maxCollectionSkewMs, allocation, bins }) {
  return {
    from,
    to,
    coverageMs,
    correctionWh,
    maxCollectionSkewMs,
    ...(allocation ? { allocation } : {}),
    ...(bins ? { bins } : {}),
  };
}
// Each cross-quarter counter interval is accepted or rejected as one batch.
function applyRepairs(byTime, repairs) {
  const groups = new Map();
  for (const [i, r] of repairs.entries()) {
    const key = r.allocation
      ? `${r.channel}:${r.allocation.from}:${r.allocation.to}`
      : `single:${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const batch of groups.values()) {
    const first = batch[0],
      a = first.allocation;
    if (a) {
      if (
        !integer(a.from) ||
        !integer(a.to) ||
        !Array.isArray(a.missingMs) ||
        a.missingMs.length !== 2 ||
        !a.missingMs.every(integer)
      )
        continue;
      const ts = a.missingMs.flatMap((ms, i) =>
        ms > 0 ? [Math.floor(a.from / Q) * Q + i * Q] : [],
      );
      if (
        batch.length !== ts.length ||
        new Set(batch.map((r) => r.t)).size !== ts.length ||
        !batch.every((r) => ts.includes(r.t) && isDeepStrictEqual(r.allocation, a))
      )
        continue;
    }
    const proposed = [];
    try {
      for (const r of batch) {
        const row = byTime.get(r.t);
        if (row?.schema !== 2) fail();
        const counterRecovery = {
          ...row.counterRecovery,
          [r.channel]: mergeRecovery(row.counterRecovery?.[r.channel], repairPart(r)),
        };
        const next = { ...row, counterRecovery };
        validateRecovery(next);
        if (a) {
          // A nonnegative directional residual must not produce negative per-quarter totals.
          for (const k of r.channel === 'grid'
            ? ['importWh', 'exportWh']
            : r.channel === 'solar'
              ? ['pvWh']
              : [])
            if (
              !Number.isFinite((row[k] || 0) + counterRecovery[r.channel].correctionWh[k]) ||
              (row[k] || 0) + counterRecovery[r.channel].correctionWh[k] < 0
            )
              fail();
        }
        proposed.push(next);
      }
    } catch {
      continue;
    }
    for (const row of proposed) byTime.set(row.t, row);
  }
}
module.exports = { validateRecovery, mergeRecovery, applyRepairs };
