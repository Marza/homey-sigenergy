'use strict';

// One canonical setting commits slots, daily totals and events together.
const {
  SLOT_MS,
  SLOT_RETENTION,
  DAY_RETENTION,
  EVENT_RETENTION,
  TIMEZONE,
  bytes,
  dailyFromSlots,
  pruneSlots,
  retainDays,
  uniqueEvents,
  bounded,
  parseExport,
  exportState,
  mergeImport,
} = require('./history-format');
const FIELDS = ['gridW', 'pvW', 'essW', 'soc', 'evW', 'evSoc'];
const POWER_FIELDS = ['gridW', 'pvW', 'essW', 'evW'];
function copySlot(row) {
  return {
    ...row,
    counts: { ...row.counts },
    sum: { ...row.sum },
    min: { ...row.min },
    max: { ...row.max },
  };
}
class HistoryStore {
  constructor(settings, now = () => Date.now()) {
    this.settings = settings;
    this.now = now;
    this.pending = new Map();
    // Each field has its own stream; EVDC-only samples must not interrupt plant reads.
    // Anchors are intentionally not persisted: never bridge an app restart.
    this.lastSamples = new Map();
    this.pendingEvents = [];
    this.busy = false;
    this.read(); // Refuse an invalid canonical state rather than overwriting it.
  }
  append(sample, ms = this.now()) {
    if (!Number.isSafeInteger(ms)) throw new Error('Invalid sample timestamp');
    const slot = Math.floor(ms / SLOT_MS) * SLOT_MS;
    let entry;
    for (const key of FIELDS) {
      if (!Object.hasOwn(sample, key)) continue;
      const previous = this.lastSamples.get(key);
      // Complementary fields at the same time are allowed; repeated/backward values
      // for an already observed field are not counted and cannot rewind its anchor.
      if (previous && ms <= previous.ms) continue;
      const value = sample[key];
      const valid = typeof value === 'number' && Number.isFinite(value);
      this.lastSamples.set(key, { ms, value: valid ? value : null });
      if (!valid) continue;
      if (!entry) {
        entry = this.getPending(slot);
        entry.n++;
      }
      entry.counts[key] = (entry.counts[key] || 0) + 1;
      entry.sum[key] = (entry.sum[key] || 0) + value;
      entry.min[key] = Math.min(entry.min[key] ?? value, value);
      entry.max[key] = Math.max(entry.max[key] ?? value, value);
      if (
        POWER_FIELDS.includes(key) &&
        previous &&
        Number.isFinite(previous.value) &&
        ms - previous.ms <= 60000
      ) {
        this.integrate(key, previous, { ms, value });
      }
    }
  }
  getPending(t) {
    if (!this.pending.has(t))
      this.pending.set(t, {
        schema: 2,
        t,
        n: 0,
        counts: {},
        sum: {},
        min: {},
        max: {},
        coverageMs: 0,
      });
    return this.pending.get(t);
  }
  integrate(key, from, to) {
    // Piecewise trapezoids preserve the complete signed energy integral when a
    // short interval crosses a quarter boundary. Every millisecond is assigned once.
    const duration = to.ms - from.ms;
    const powerAt = (t) => from.value + (to.value - from.value) * ((t - from.ms) / duration);
    for (let start = from.ms; start < to.ms;) {
      const slot = Math.floor(start / SLOT_MS) * SLOT_MS;
      const end = Math.min(to.ms, slot + SLOT_MS);
      const entry = this.getPending(slot);
      const energyKey = key.replace('W', 'Wh');
      entry[energyKey] =
        (entry[energyKey] || 0) + (((powerAt(start) + powerAt(end)) / 2) * (end - start)) / 3600000;
      if (key === 'gridW') entry.coverageMs += end - start;
      start = end;
    }
  }
  read() {
    const state = this.settings.get('historyState');
    if (state !== null && state !== undefined) {
      if (
        state.schema !== 3 ||
        state.timezone !== TIMEZONE ||
        !['slots', 'daily', 'events', 'legacyDaily'].every((key) => Array.isArray(state[key]))
      ) {
        throw new Error('Invalid stored history state');
      }
      return structuredClone(state);
    }
    const legacy = (key) => {
      const value = this.settings.get(key);
      if (value !== null && value !== undefined && !Array.isArray(value))
        throw new Error('Invalid legacy history');
      return structuredClone(value || []);
    };
    return {
      schema: 3,
      timezone: TIMEZONE,
      revision: 0,
      updatedAt: null,
      slots: legacy('historySlots'),
      daily: [],
      events: legacy('historyEvents'),
      legacyDaily: legacy('historyDaily'),
    };
  }
  getSlots() {
    return this.read().slots;
  }
  buildState() {
    const state = this.read();
    const byTime = new Map(state.slots.map((row) => [row.t, row]));
    for (const entry of this.pending.values()) {
      const old = byTime.get(entry.t);
      const compatible = old?.schema === 2;
      const merged = copySlot(compatible ? old : entry);
      if (old && !compatible) merged.legacy = old;
      if (compatible) {
        merged.n += entry.n;
        for (const [key, value] of Object.entries(entry.counts))
          merged.counts[key] = (merged.counts[key] || 0) + value;
        for (const [key, value] of Object.entries(entry.sum))
          merged.sum[key] = (merged.sum[key] || 0) + value;
        for (const [key, value] of Object.entries(entry.min))
          merged.min[key] = Math.min(merged.min[key] ?? value, value);
        for (const [key, value] of Object.entries(entry.max))
          merged.max[key] = Math.max(merged.max[key] ?? value, value);
        for (const key of ['gridWh', 'pvWh', 'essWh', 'evWh']) {
          if (Number.isFinite(entry[key])) merged[key] = (old[key] || 0) + entry[key];
        }
        merged.coverageMs = (old.coverageMs || 0) + entry.coverageMs;
      }
      byTime.set(entry.t, merged);
    }
    const allSlots = [...byTime.values()];
    const now = this.now();
    return bounded({
      ...state,
      slots: pruneSlots(allSlots, now),
      daily: dailyFromSlots(allSlots, state.daily, now),
      legacyDaily: retainDays(state.legacyDaily, now),
      events: uniqueEvents([...state.events, ...this.pendingEvents]),
    });
  }
  commit(state) {
    const next = bounded({
      ...state,
      revision: (this.read().revision || 0) + 1,
      updatedAt: new Date(this.now()).toISOString(),
    });
    this.settings.set('historyState', next);
    // Clear only after the single state write has succeeded.
    this.pending.clear();
    this.pendingEvents = [];
    return next;
  }
  flush() {
    if (this.busy || (!this.pending.size && !this.pendingEvents.length)) return;
    this.busy = true;
    try {
      this.commit(this.buildState());
    } finally {
      this.busy = false;
    }
  }
  event(type, details = {}, ms = this.now()) {
    const allowed = {};
    for (const key of ['mode', 'observed', 'requested', 'reason', 'controlApplied']) {
      if (typeof details[key] === 'string' || typeof details[key] === 'boolean')
        allowed[key] = details[key];
    }
    this.pendingEvents.push({ t: ms, type, ...allowed });
    this.pendingEvents = this.pendingEvents.slice(-EVENT_RETENTION);
    this.flush();
  }
  export() {
    this.flush();
    return exportState(this.buildState(), this.now());
  }
  importPlan(input) {
    const imported = parseExport(input, this.now());
    return mergeImport(this.buildState(), imported, this.now());
  }
  previewImport(input) {
    const { state, conflicts } = this.importPlan(input);
    return {
      slots: state.slots.length,
      daily: state.daily.length,
      events: state.events.length,
      legacyDaily: state.legacyDaily.length,
      conflictingSlots: conflicts,
      bytes: bytes(state),
      policy: 'Existing intervals win; overlapping energy is never added.',
    };
  }
  import(input) {
    const plan = this.importPlan(input);
    this.commit(plan.state);
    // Imported aggregates cannot establish live observation continuity.
    this.lastSamples.clear();
    return { ...this.previewImport(input), restored: true };
  }
}
module.exports = { HistoryStore, SLOT_MS, SLOT_RETENTION, DAY_RETENTION };
