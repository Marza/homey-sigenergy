'use strict';
// Synthetic data only; this command never connects to Homey or reads live telemetry.
const { performance } = require('node:perf_hooks');
const { HistoryStore, SLOT_MS, SLOT_RETENTION } = require('../lib/history');
const { dayBounds, MAX_STATE_BYTES, FORMAT, TIMEZONE } = require('../lib/history-format');
const start = dayBounds('2026-10-01').start;
const now = start + SLOT_RETENTION * SLOT_MS - 1;
const values = { gridW: 4000, pvW: 1000, essW: -1000, soc: 50, evW: 7000, evSoc: 40 };
const slots = Array.from({ length: SLOT_RETENTION }, (_, i) => ({
  schema: 2,
  t: start + i * SLOT_MS,
  n: 180,
  counts: Object.fromEntries(Object.keys(values).map((k) => [k, 90])),
  sum: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v * 90])),
  min: values,
  max: values,
  gridWh: 1000,
  pvWh: 250,
  essWh: -250,
  evWh: 1750,
  coverageMs: SLOT_MS,
  essCoverageMs: SLOT_MS,
  importWh: 1000,
  exportWh: 0,
  directionalCoverageMs: SLOT_MS,
}));
const map = new Map();
let writes = 0;
const settings = {
  get: (key) => map.get(key),
  set(key, value) {
    writes++;
    map.set(key, structuredClone(value));
  },
};
const store = new HistoryStore(settings, () => now);
const file = {
  format: FORMAT,
  schema: 5,
  timezone: TIMEZONE,
  exportedAt: new Date(now).toISOString(),
  slots,
  daily: [],
  events: [],
  legacyDaily: [],
};
const started = performance.now();
store.import(file);
const state = map.get('historyState');
console.log(
  JSON.stringify(
    {
      synthetic: true,
      slots: state.slots.length,
      daily: state.daily.length,
      bytes: Buffer.byteLength(JSON.stringify(state)),
      budgetBytes: MAX_STATE_BYTES,
      elapsedMs: Math.round(performance.now() - started),
      writes,
    },
    null,
    2,
  ),
);
