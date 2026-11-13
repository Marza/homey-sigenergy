'use strict';

// Bounded, compact persistent history. Homey settings is not a time-series DB:
// retain 30 days of quarter-hour data and 730 daily aggregates.
const SLOT_MS = 15 * 60 * 1000;
const SLOT_RETENTION = 30 * 24 * 4;
const DAY_RETENTION = 730;
const EVENT_RETENTION = 500;
const FIELDS = ['gridW', 'pvW', 'essW', 'soc', 'evW', 'evSoc'];
const POWER_FIELDS = ['gridW', 'pvW', 'essW', 'evW'];
const round = n => Math.round(n * 100) / 100;
function dateKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function copySlot(row) {
  return { ...row, counts: { ...row.counts }, sum: { ...row.sum }, min: { ...row.min }, max: { ...row.max } };
}
class HistoryStore {
  constructor(settings, now = () => Date.now()) {
    this.settings = settings;
    this.now = now;
    this.pending = new Map();
    // Each field has its own stream; EVDC-only samples must not interrupt plant reads.
    // Anchors are intentionally not persisted: never bridge an app restart.
    this.lastSamples = new Map();
    this.busy = false;
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
      if (POWER_FIELDS.includes(key) && previous && Number.isFinite(previous.value) && ms - previous.ms <= 60000) {
        this.integrate(key, previous, { ms, value });
      }
    }
  }
  getPending(t) {
    if (!this.pending.has(t)) this.pending.set(t, {
      schema: 2, t, n: 0, counts: {}, sum: {}, min: {}, max: {}, coverageMs: 0,
    });
    return this.pending.get(t);
  }
  integrate(key, from, to) {
    // Piecewise trapezoids preserve the complete signed energy integral when a
    // short interval crosses a quarter boundary. Every millisecond is assigned once.
    const duration = to.ms - from.ms;
    const powerAt = t => from.value + (to.value - from.value) * ((t - from.ms) / duration);
    for (let start = from.ms; start < to.ms;) {
      const slot = Math.floor(start / SLOT_MS) * SLOT_MS;
      const end = Math.min(to.ms, slot + SLOT_MS);
      const entry = this.getPending(slot);
      const energyKey = key.replace('W', 'Wh');
      entry[energyKey] = (entry[energyKey] || 0) + (powerAt(start) + powerAt(end)) / 2 * (end - start) / 3600000;
      if (key === 'gridW') entry.coverageMs += end - start;
      start = end;
    }
  }
  flush() {
    if (this.busy || !this.pending.size) return;
    this.busy = true;
    try {
      const slots = this.settings.get('historySlots') || [];
      const byTime = new Map(slots.map(row => [row.t, row]));
      for (const entry of this.pending.values()) {
        const old = byTime.get(entry.t);
        const compatible = old?.schema === 2;
        const merged = copySlot(compatible ? old : entry);
        if (old && !compatible) {
          // Legacy mixed-stream counts/coverage cannot be reconstructed. Preserve
          // the original for export, but start a separate trustworthy active slot.
          merged.legacy = old;
        }
        if (compatible) {
          merged.n += entry.n;
          for (const [key, value] of Object.entries(entry.counts)) merged.counts[key] = (merged.counts[key] || 0) + value;
          for (const [key, value] of Object.entries(entry.sum)) merged.sum[key] = (merged.sum[key] || 0) + value;
          for (const [key, value] of Object.entries(entry.min)) merged.min[key] = Math.min(merged.min[key] ?? value, value);
          for (const [key, value] of Object.entries(entry.max)) merged.max[key] = Math.max(merged.max[key] ?? value, value);
          for (const key of ['gridWh', 'pvWh', 'essWh', 'evWh']) {
            if (Number.isFinite(entry[key])) merged[key] = (old[key] || 0) + entry[key];
          }
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
    return { schema: 2, exportedAt: new Date(this.now()).toISOString(), slots: this.settings.get('historySlots') || [], daily: this.settings.get('historyDaily') || [], events: this.settings.get('historyEvents') || [] };
  }
}
module.exports = { HistoryStore, SLOT_MS, SLOT_RETENTION, DAY_RETENTION };
