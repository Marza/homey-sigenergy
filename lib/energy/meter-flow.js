'use strict';
// Sigenergy V2.9 table 5-1. Block 30228..30271, one U64 per channel (10 Wh/count).
const METERS = [
  'house',
  'ac',
  'selfSolar',
  'thirdPartySolar',
  'batteryIn',
  'batteryOut',
  'dcIn',
  'dcOut',
  'gridIn',
  'gridOut',
  'generator',
];
const SOURCES = ['solar', 'battery', 'dc', 'grid', 'generator'];
const LOADS = ['battery', 'dc', 'house', 'ac', 'grid'];
const Q = 900000;
const sum = (values) => values.reduce((n, v) => n + v, 0);
function emptyFlow() {
  return {
    ms: 0,
    input: Array(SOURCES.length).fill(0),
    output: Array(LOADS.length).fill(0),
    links: Array(SOURCES.length * LOADS.length).fill(0),
  };
}
function addFlow(target, sample, fraction = 1) {
  target.ms += Math.round(sample.ms * fraction);
  if (sample.recoveredMs)
    target.recoveredMs = (target.recoveredMs ?? 0) + Math.round(sample.recoveredMs * fraction);
  for (const field of ['input', 'output', 'links'])
    sample[field].forEach((n, i) => {
      target[field][i] += n * fraction;
    });
  return target;
}
function validFlow(flow) {
  if (
    !flow ||
    !['input,links,ms,output', 'input,links,ms,output,recoveredMs'].includes(
      Object.keys(flow).sort().join(','),
    ) ||
    (flow.recoveredMs !== undefined &&
      (!Number.isSafeInteger(flow.recoveredMs) ||
        flow.recoveredMs < 0 ||
        flow.recoveredMs > flow.ms)) ||
    !Number.isSafeInteger(flow.ms) ||
    flow.ms <= 0 ||
    flow.ms > Q
  )
    return false;
  for (const [key, length] of [
    ['input', SOURCES.length],
    ['output', LOADS.length],
    ...(flow.links === null && flow.ms === Q ? [] : [['links', SOURCES.length * LOADS.length]]),
  ]) {
    if (
      !Array.isArray(flow[key]) ||
      flow[key].length !== length ||
      ![...flow[key]].every((v) => Number.isFinite(v) && v >= 0 && v <= 1e7)
    )
      return false;
  }
  if (flow.links === null) return true;
  return (
    flow.input.every(
      (n, i) => sum(flow.links.slice(i * LOADS.length, (i + 1) * LOADS.length)) <= n + 1e-6,
    ) &&
    flow.output.every(
      (n, j) => sum(flow.input.map((_, i) => flow.links[i * LOADS.length + j])) <= n + 1e-6,
    )
  );
}
function meterInterval(before, after, ms, interrupted = false) {
  if (!before || !after || ms <= 0 || ms > Q) return null;
  const delta = {};
  for (const key of METERS) {
    const a = before[key],
      b = after[key];
    if (![a, b].every((v) => Number.isSafeInteger(v) && v >= 0)) return null;
    delta[key] = (b - a) * 10;
    if (delta[key] < 0 || delta[key] > (350000 * ms) / 3600000 + 10) return null;
  }
  const input = [
    delta.selfSolar + delta.thirdPartySolar,
    delta.batteryOut,
    delta.dcOut,
    delta.gridIn,
    delta.generator,
  ];
  const output = [delta.batteryIn, delta.dcIn, delta.house, delta.ac, delta.gridOut];
  // Reversals within one meter interval have no reliable ordering. Keep both meter deltas unallocated.
  const reversal =
    (delta.batteryIn && delta.batteryOut) ||
    (delta.dcIn && delta.dcOut) ||
    (delta.gridIn && delta.gridOut);
  const denominator = Math.max(sum(input), sum(output));
  const links = input.flatMap((source) =>
    output.map((load) =>
      !interrupted && ms <= 90000 && !reversal && denominator ? (source * load) / denominator : 0,
    ),
  );
  return { ms, input, output, links, ...(interrupted || ms > 90000 ? { recoveredMs: ms } : {}) };
}
module.exports = { METERS, SOURCES, LOADS, emptyFlow, addFlow, validFlow, meterInterval };
