'use strict';

// Bounded, compact persistent history. Homey settings is not a time-series DB:
// retain 30 days of quarter-hour data and 730 daily aggregates.
const SLOT_MS = 15 * 60 * 1000;
const SLOT_RETENTION = 30 * 24 * 4;
const DAY_RETENTION = 730;
const EVENT_RETENTION = 500;
const FIELDS = ['gridW', 'pvW', 'essW', 'soc', 'evW', 'evSoc'];
const round = n => Math.round(n * 100) / 100;
function dateKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function normalize(sample) {
  const values = {};
  for (const field of FIELDS) {
    if (typeof sample[field] === 'number' && Number.isFinite(sample[field])) values[field] = sample[field];
  }
  return values;
}
class HistoryStore {
  constructor(settings, now = () => Date.now()) {
    this.settings = settings;
    this.now = now;
    this.pending = new Map();
    this.lastSample = null;
    this.lastCoverageSample = null;
    this.busy = false;
  }
  append(sample, ms = this.now()) {
    if (!Number.isFinite(ms)) throw new Error('Invalid sample timestamp');
    const values = normalize(sample);
    if (!Object.keys(values).length) return;
    const slot = Math.floor(ms / SLOT_MS) * SLOT_MS;
    const entry = this.pending.get(slot) || { t: slot, n: 0, sum: {}, min: {}, max: {}, coverageMs: 0 };
    entry.n++;
    for (const [key, value] of Object.entries(values)) {
      entry.sum[key] = (entry.sum[key] || 0) + value;
      entry.min[key] = Math.min(entry.min[key] ?? value, value);
      entry.max[key] = Math.max(entry.max[key] ?? value, value);
    }
    this.pending.set(slot, entry);
    // Integrate only adjacent valid observations, cap gap to avoid inventing energy.
    if (this.lastSample && ms > this.lastSample.ms && ms - this.lastSample.ms <= 60000) {
      const sameSlot = Math.floor(this.lastSample.ms / SLOT_MS) === Math.floor(ms / SLOT_MS);
      const elapsedHours = sameSlot ? (ms - this.lastSample.ms) / 3600000 : 0;
      // Count only grid-power observations within the same quarter-hour slot.
      // Cross-slot intervals cannot be assigned wholly to one slot.
      if (Math.floor(this.lastSample.ms / SLOT_MS) === Math.floor(ms / SLOT_MS) &&
          Number.isFinite(this.lastSample.values.gridW) && Number.isFinite(values.gridW)) {
        entry.coverageMs += ms - this.lastSample.ms;
      }
      const previous = this.lastSample.values;
      for (const key of ['gridW', 'pvW', 'essW', 'evW']) {
        if (Number.isFinite(previous[key]) && Number.isFinite(values[key])) {
          const energyKey = key.replace('W', 'Wh');
          entry[energyKey] = (entry[energyKey] || 0) + (previous[key] + values[key]) / 2 * elapsedHours;
        }
      }
    }
    this.lastSample = { ms, values };
  }
  flush() {
    if (this.busy || !this.pending.size) return;
    this.busy = true;
    try {
      const slots = this.settings.get('historySlots') || [];
      const byTime = new Map(slots.map(row => [row.t, row]));
      for (const entry of this.pending.values()) {
        const old = byTime.get(entry.t);
        const merged = old ? { t: entry.t, n: old.n + entry.n, sum: { ...old.sum }, min: { ...old.min }, max: { ...old.max } } : { ...entry, sum: { ...entry.sum }, min: { ...entry.min }, max: { ...entry.max } };
        if (old) {
          for (const [key, value] of Object.entries(entry.sum)) merged.sum[key] = (merged.sum[key] || 0) + value;
          for (const [key, value] of Object.entries(entry.min)) merged.min[key] = Math.min(merged.min[key] ?? value, value);
          for (const [key, value] of Object.entries(entry.max)) merged.max[key] = Math.max(merged.max[key] ?? value, value);
          for (const key of ['gridWh', 'pvWh', 'essWh', 'evWh']) merged[key] = (old[key] || 0) + (entry[key] || 0);
          merged.coverageMs = (old.coverageMs || 0) + (entry.coverageMs || 0);
        }
        byTime.set(entry.t, merged);
      }
      const cutoff = this.now() - SLOT_RETENTION * SLOT_MS;
      const kept = [...byTime.values()].filter(row => row.t >= cutoff).sort((a, b) => a.t - b.t).slice(-SLOT_RETENTION);
      // Commit history before clearing pending; on failure samples remain queued.
      this.settings.set('historySlots', kept);
      this.pending.clear();
      this.updateDaily(kept);
    } finally { this.busy = false; }
  }
  updateDaily(slots) {
    const existing = new Map((this.settings.get('historyDaily') || []).map(row => [row.date, row]));
    const grouped = new Map();
    for (const row of slots) {
      const date = dateKey(row.t);
      const aggregate = grouped.get(date) || { date, slots: 0, gridWh: 0, pvWh: 0, essWh: 0, evWh: 0, peakGridW: null };
      aggregate.slots++;
      for (const key of ['gridWh', 'pvWh', 'essWh', 'evWh']) aggregate[key] += row[key] || 0;
      if (Number.isFinite(row.max.gridW)) aggregate.peakGridW = Math.max(aggregate.peakGridW ?? row.max.gridW, row.max.gridW);
      grouped.set(date, aggregate);
    }
    for (const [date, row] of grouped) existing.set(date, { ...row, gridWh: round(row.gridWh), pvWh: round(row.pvWh), essWh: round(row.essWh), evWh: round(row.evWh) });
    const daily = [...existing.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-DAY_RETENTION);
    this.settings.set('historyDaily', daily);
  }
  event(type, details = {}, ms = this.now()) {
    const events = this.settings.get('historyEvents') || [];
    // Keep event payload compact and avoid credentials or arbitrary sensitive fields.
    const allowed = {};
    for (const key of ['mode', 'observed', 'requested', 'reason', 'controlApplied']) {
      if (typeof details[key] === 'string' || typeof details[key] === 'boolean') allowed[key] = details[key];
    }
    events.push({ t: ms, type, ...allowed });
    this.settings.set('historyEvents', events.slice(-EVENT_RETENTION));
  }
  export() {
    this.flush();
    return { schema: 1, exportedAt: new Date(this.now()).toISOString(), slots: this.settings.get('historySlots') || [], daily: this.settings.get('historyDaily') || [], events: this.settings.get('historyEvents') || [] };
  }
}
module.exports = { HistoryStore, SLOT_MS, SLOT_RETENTION, DAY_RETENTION };
