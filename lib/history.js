'use strict';

// One canonical setting commits slots, daily totals and events together.
const {
  SLOT_MS,
  DIRECTIONAL_FIELDS,
  FIELDS,
  POWER_FIELDS,
  ENERGIES,
  HOUSEHOLD_FIELDS,
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
const { CounterGapRecovery, effectiveSlot } = require('./energy/gap-recovery');
const { applyRepairs } = require('./energy/recovery-metadata');
const {
  SOURCES,
  validAmps,
  validBinding,
  mergeQuarter,
  recordInterval,
} = require('./energy/phase-current');
const {
  emptyFlow,
  addFlow,
  meterInterval,
  LOADS,
  SOURCES: FLOW_SOURCES,
  validFlow,
} = require('./energy/meter-flow');
const HOUSE_LOAD = LOADS.indexOf('house');

// Calculation callers share one recovery-aware view; older history providers expose only slots.
function calculationSlots(history) {
  return typeof history.getEnergySlots === 'function'
    ? history.getEnergySlots()
    : history.getSlots();
}
function calculationSlot(row) {
  const effective = effectiveSlot(row);
  const flow = row?.meterFlow;
  if (flow?.ms !== SLOT_MS || !validFlow(flow)) return effective;
  const result = { ...effective };
  // Preserve per-channel evidence requirements, including on-grid power coverage.
  // Substitute the corresponding counter energy; never add it to a power integral.
  if (row.coverageMs === SLOT_MS && row.directionalCoverageMs === SLOT_MS) {
    result.importWh = flow.input[FLOW_SOURCES.indexOf('grid')];
    result.exportWh = flow.output[LOADS.indexOf('grid')];
    result.gridWh = result.importWh - result.exportWh;
    result.meteredGrid = true;
  }
  if (row.essCoverageMs === SLOT_MS)
    result.essWh =
      flow.output[LOADS.indexOf('battery')] - flow.input[FLOW_SOURCES.indexOf('battery')];
  return result;
}
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
  constructor(settings, now = () => Date.now(), diagnostics = null) {
    this.settings = settings;
    this.diagnostics = diagnostics;
    this.gaps = new Map();
    this.writeFailed = false;
    this.counterRecovery = new CounterGapRecovery();
    this.pendingRepairs = [];
    this.now = now;
    this.pending = new Map();
    // Each field has its own stream; EVDC-only samples must not interrupt plant reads.
    // Anchors are intentionally not persisted: never bridge an app restart.
    this.lastSamples = new Map();
    this.householdAnchor = null;
    this.householdResumeAt = 0;
    this.phaseAnchors = new Map();
    this.pendingEvents = [];
    this.busy = false;
    const state = this.read(); // Refuse an invalid canonical state rather than overwriting it.
    const open = Math.floor(this.now() / SLOT_MS) * SLOT_MS;
    // A previous process or restore may have left aggregate coverage in the open quarter.
    this.flowResumeAt = state.slots.some((row) => row.t === open && row.meterFlow)
      ? open + SLOT_MS
      : 0;
    this.phaseResumeAt = state.slots.some((row) => row.t === open && row.phaseCurrent)
      ? open + SLOT_MS
      : 0;
  }
  append(sample, ms = this.now(), reason = 'invalid-sample') {
    if (['connection-changed', 'reader-started'].includes(reason)) {
      this.flowAnchor = null;
      this.counterRecovery.reset();
      this.householdAnchor = null;
    }
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
      const valid = Number.isFinite(value) && (key !== 'evacW' || value >= 0);
      const current = { ms, value: valid ? value : null };
      this.counterRecovery.observe(key, previous, current, reason);
      this.lastSamples.set(key, current);
      const source = { gridW: 'grid', pvW: 'solar', essW: 'battery', evW: 'ev', evacW: 'evac' }[
        key
      ];
      if (source) {
        const gap = this.gaps.get(key);
        if (!valid) {
          const from = gap
            ? gap.reason === reason
              ? gap.from
              : previous.ms
            : Number.isFinite(previous?.value)
              ? previous.ms
              : null;
          if (from !== null) {
            this.gaps.set(key, { from, reason });
            this.diagnostics?.record(source, reason, from, ms);
          }
        } else if (gap) {
          this.diagnostics?.record(source, gap.reason, gap.from, ms);
          this.gaps.delete(key);
        } else if (Number.isFinite(previous?.value) && ms - previous.ms > 60000)
          this.diagnostics?.record(source, 'sample-delay', previous.ms, ms);
      }
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
  observeFlowMeters(values, at, binding) {
    const old = this.flowAnchor;
    if (!Number.isSafeInteger(at) || at < this.flowResumeAt || (old && at <= old.at)) return;
    this.flowAnchor = { at, values, binding };
    if (!values || !old?.values || old.binding !== binding) return;
    const sample = meterInterval(old.values, values, at - old.at);
    if (!sample) {
      // A rebound from a spurious reading must not look like new production.
      if (at - old.at <= 90000) this.flowAnchor = null;
      return;
    }
    for (let from = old.at; from < at;) {
      const t = Math.floor(from / SLOT_MS) * SLOT_MS;
      const end = Math.min(t + SLOT_MS, at);
      const slot = this.getPending(t);
      addFlow((slot.meterFlow ||= emptyFlow()), sample, (end - from) / sample.ms);
      from = end;
    }
  }
  observePhaseCurrent(source, binding, amps, at = this.now()) {
    if (!SOURCES.includes(source) || !Number.isSafeInteger(at) || at < this.phaseResumeAt) return;
    const old = this.phaseAnchors.get(source);
    const next = { at, binding, amps: validBinding(binding) && validAmps(amps) ? [...amps] : null };
    if (old && (at < old.at || (at === old.at && next.amps))) return;
    this.phaseAnchors.set(source, next);
    recordInterval(old, next, (t) => this.getPending(t), source);
  }
  observeHouseholdCounter(raw, ms = this.now(), reason = 'invalid-sample') {
    const old = this.householdAnchor;
    if (!Number.isSafeInteger(ms) || ms < this.householdResumeAt || (old && ms <= old.ms))
      return null;
    const value =
      typeof raw === 'string' && /^(0|[1-9]\d{0,14})$/.test(raw) && Number(raw) <= 100000000000000
        ? Number(raw)
        : null;
    this.householdAnchor = { ms, value, reason };
    if (value === null) {
      this.diagnostics?.record('household', reason, old?.ms ?? ms, ms);
      return null;
    }
    if (!old) return null;
    if (old.value === null) {
      this.diagnostics?.record('household', old.reason, old.ms, ms);
      return null;
    }

    const elapsed = ms - old.ms;
    const wh = (value - old.value) * 10;
    const reset = wh < 0;
    const tooLate = elapsed > 90000;
    // Broad plausibility guard, with one 10 Wh count of quantization allowance.
    const jump = wh > (350000 * elapsed) / 3600000 + 10;
    if (reset || tooLate || jump) {
      // Re-anchor on the next successful read after a reset or implausible jump.
      // This also prevents an isolated bad reading followed by a rebound from adding energy.
      if (reset || jump) this.householdAnchor.value = null;
      const reason = reset ? 'counter-reset' : tooLate ? 'sample-delay' : 'invalid-sample';
      this.householdAnchor.reason = reason;
      this.diagnostics?.record('household', reason, old.ms, ms);
      return null;
    }

    const split = Math.floor(old.ms / SLOT_MS) !== Math.floor((ms - 1) / SLOT_MS);
    for (let start = old.ms; start < ms;) {
      const slot = Math.floor(start / SLOT_MS) * SLOT_MS;
      const end = Math.min(slot + SLOT_MS, ms);
      const duration = end - start;
      const entry = this.getPending(slot);
      entry.householdWh = (entry.householdWh ?? 0) + wh * (duration / elapsed);
      entry.householdCoverageMs = (entry.householdCoverageMs ?? 0) + duration;
      entry.householdEstimatedMs = (entry.householdEstimatedMs ?? 0) + (split ? duration : 0);
      start = end;
    }
    return (wh * 3600) / elapsed;
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
      entry.fieldCoverageMs ||= {};
      entry.fieldCoverageMs[key] = (entry.fieldCoverageMs[key] || 0) + end - start;
      if (key === 'essW') entry.essCoverageMs = (entry.essCoverageMs || 0) + end - start;
      if (key === 'gridW') {
        const a = powerAt(start),
          b = powerAt(end),
          dt = end - start;
        let imported = 0,
          exported = 0;
        if (a >= 0 && b >= 0) imported = (((a + b) / 2) * dt) / 3600000;
        else if (a <= 0 && b <= 0) exported = (-((a + b) / 2) * dt) / 3600000;
        else {
          // Split at the linearly interpolated zero crossing, not at the mean.
          const firstMs = (dt * Math.abs(a)) / (Math.abs(a) + Math.abs(b));
          const firstWh = (Math.abs(a) * firstMs) / 2 / 3600000;
          const secondWh = (Math.abs(b) * (dt - firstMs)) / 2 / 3600000;
          imported = a > 0 ? firstWh : secondWh;
          exported = a < 0 ? firstWh : secondWh;
        }
        entry.importWh = (entry.importWh || 0) + imported;
        entry.exportWh = (entry.exportWh || 0) + exported;
        entry.directionalCoverageMs = (entry.directionalCoverageMs || 0) + dt;
        entry.coverageMs += dt;
      }
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
      const restored = structuredClone(state);
      for (const row of restored.slots) {
        if (row.householdFromFlow === true) {
          if (
            !Number.isFinite(row.meterFlow?.output?.[HOUSE_LOAD]) ||
            !Number.isInteger(row.meterFlow.ms)
          )
            throw Error('Missing shared household energy');
          row.householdWh = row.meterFlow.output[HOUSE_LOAD];
          row.householdCoverageMs = row.meterFlow.ms;
          delete row.householdFromFlow;
        }
      }
      return restored;
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
  getEnergySlots() {
    return this.getSlots().map(calculationSlot);
  }
  observeCounters(raw, binding) {
    const at = this.lastSamples.get('gridW')?.ms;
    for (const repair of this.counterRecovery.accept(raw, binding, at)) {
      this.pendingRepairs.push(repair);
    }
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
        for (const key of [...ENERGIES, ...HOUSEHOLD_FIELDS]) {
          if (Number.isFinite(entry[key])) merged[key] = (old[key] || 0) + entry[key];
        }
        for (const key of DIRECTIONAL_FIELDS) {
          if (Number.isFinite(entry[key])) merged[key] = (old[key] || 0) + entry[key];
        }
        if (Number.isFinite(entry.essCoverageMs))
          merged.essCoverageMs = (old.essCoverageMs || 0) + entry.essCoverageMs;
        if (entry.fieldCoverageMs) {
          merged.fieldCoverageMs = { ...(old.fieldCoverageMs || {}) };
          for (const [key, value] of Object.entries(entry.fieldCoverageMs))
            merged.fieldCoverageMs[key] = (old.fieldCoverageMs?.[key] || 0) + value;
        }
        merged.coverageMs = (old.coverageMs || 0) + entry.coverageMs;
        if (entry.meterFlow && old.meterFlow?.links !== null)
          merged.meterFlow = addFlow(
            addFlow(emptyFlow(), old.meterFlow || emptyFlow()),
            entry.meterFlow,
          );
        if (entry.phaseCurrent) {
          merged.phaseCurrent = { ...old.phaseCurrent };
          for (const [source, next] of Object.entries(entry.phaseCurrent))
            merged.phaseCurrent[source] = mergeQuarter(old.phaseCurrent?.[source], next);
        }
      }
      byTime.set(entry.t, merged);
    }
    applyRepairs(byTime, this.pendingRepairs);
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
      // buildState and importPlan read the current revision in the same synchronous operation.
      revision: (state.revision || 0) + 1,
      updatedAt: new Date(this.now()).toISOString(),
    });
    // A valid wide read contains the very same household meter and timestamp. Preserve
    // separate values when a fallback read or independent quality check changed coverage.
    const slots = next.slots.map((row) => {
      if (
        !row.meterFlow ||
        row.householdWh !== row.meterFlow.output[HOUSE_LOAD] ||
        row.householdCoverageMs !== row.meterFlow.ms
      )
        return row;
      const shared = { ...row, householdFromFlow: true };
      delete shared.householdWh;
      delete shared.householdCoverageMs;
      return shared;
    });
    this.settings.set('historyState', { ...next, slots });
    const committedRepairs = this.pendingRepairs;
    // Clear immediately after the single state write; optional logging cannot cause a retry to add energy twice.
    this.pending.clear();
    this.pendingRepairs = [];
    this.pendingEvents = [];
    for (const repair of committedRepairs) {
      const applied = next.slots.find((s) => s.t === repair.t)?.counterRecovery?.[repair.channel];
      const included = repair.allocation
        ? applied?.parts?.some(
            (p) =>
              p.from === repair.from &&
              p.to === repair.to &&
              p.allocation?.from === repair.allocation.from &&
              p.allocation?.to === repair.allocation.to,
          )
        : applied && applied.from <= repair.from && applied.to >= repair.to;
      if (included) {
        try {
          this.diagnostics?.record(repair.channel, 'counter-gap-recovered', repair.from, repair.to);
        } catch {
          /* Logging is best effort after a committed write. */
        }
      }
    }
    return next;
  }
  flush() {
    if (
      this.busy ||
      (!this.pending.size && !this.pendingEvents.length && !this.pendingRepairs.length)
    )
      return;
    this.busy = true;
    try {
      this.commit(this.buildState());
      if (this.writeFailed) this.diagnostics?.record('storage', 'history-write-recovered');
      this.writeFailed = false;
    } catch (e) {
      if (!this.writeFailed) this.diagnostics?.record('storage', 'history-write-failed');
      this.writeFailed = true;
      throw e;
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
    this.flowAnchor = null;
    this.householdAnchor = null;
    this.phaseAnchors.clear();
    // A restored open quarter has aggregate coverage but no individual interval endpoints.
    // Wait for the next quarter to avoid overlapping it with new counter deltas.
    const open = Math.floor(this.now() / SLOT_MS) * SLOT_MS;
    if (plan.state.slots.some((row) => row.t === open && row.meterFlow))
      this.flowResumeAt = open + SLOT_MS;
    if (plan.state.slots.some((row) => row.t === open && row.householdCoverageMs > 0))
      this.householdResumeAt = Math.max(this.householdResumeAt, open + SLOT_MS);
    if (plan.state.slots.some((row) => row.t === open && row.phaseCurrent))
      this.phaseResumeAt = Math.max(this.phaseResumeAt, open + SLOT_MS);
    this.gaps.clear();
    this.counterRecovery.reset();
    this.diagnostics?.record('storage', 'history-imported');
    return { ...this.previewImport(input), restored: true };
  }
}
module.exports = {
  HistoryStore,
  calculationSlot,
  calculationSlots,
  SLOT_MS,
  SLOT_RETENTION,
  DAY_RETENTION,
};
