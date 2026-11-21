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
const { validAmps, validBinding, mergeQuarter, recordInterval } = require('./energy/phase-current');
const {
  METERS,
  emptyFlow,
  addFlow,
  meterInterval,
  LOADS,
  SOURCES: FLOW_SOURCES,
  validFlow,
} = require('./energy/meter-flow');
const { FIVE_MS, recordPart, mergeParts } = require('./energy/five-minute');
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
    // Instantaneous power samples never bridge an app restart.
    this.lastSamples = new Map();
    this.householdAnchor = null;
    this.householdBinding = null;
    this.checkpointDirty = false;
    this.householdAttemptMs = -1;
    this.householdInterrupted = false;
    this.householdRecoveries = [];
    this.householdFailureReason = null;
    this.phaseAnchors = new Map();
    this.pendingEvents = [];
    this.busy = false;
    const state = this.read(); // Refuse an invalid canonical state rather than overwriting it.
    const open = Math.floor(this.now() / SLOT_MS) * SLOT_MS;
    // A previous process or restore may have left aggregate coverage in the open quarter.
    // Only a local checkpoint committed together with its energy can continue the same meter.
    this.counterRecovery.restore(state.counterCheckpoint, this.now());
    const saved = state.householdCheckpoint;
    if (
      saved &&
      typeof saved.binding === 'string' &&
      saved.binding &&
      Number.isSafeInteger(saved.ms) &&
      saved.ms >= 0 &&
      Number.isSafeInteger(saved.value) &&
      saved.value >= 0 &&
      saved.value <= 100000000000000
    ) {
      this.householdAnchor = saved;
      this.householdBinding = saved.binding;
      this.householdAttemptMs = saved.ms;
      this.householdInterrupted = true;
    }
    this.householdResumeAt =
      !this.householdAnchor &&
      state.slots.some((row) => row.t === open && row.householdCoverageMs > 0)
        ? open + SLOT_MS
        : 0;
    const flow = state.flowCheckpoint;
    this.flowInterrupted = true;
    if (
      Number.isSafeInteger(flow?.at) &&
      typeof flow.binding === 'string' &&
      flow.binding &&
      flow.at <= this.now() &&
      this.now() - flow.at <= SLOT_MS &&
      METERS.every((k) => Number.isSafeInteger(flow.values?.[k]) && flow.values[k] >= 0)
    )
      this.flowAnchor = flow;
    this.flowResumeAt =
      !this.flowAnchor && state.slots.some((row) => row.t === open && row.meterFlow)
        ? open + SLOT_MS
        : 0;
    this.phaseResumeAt = state.slots.some((row) => row.t === open && row.phaseCurrent)
      ? open + SLOT_MS
      : 0;
  }
  append(sample, ms = this.now(), reason = 'invalid-sample') {
    if (['connection-changed', 'reader-started'].includes(reason)) {
      this.flowInterrupted = true;
      if (reason === 'connection-changed') this.flowAnchor = null;
      if (reason === 'connection-changed') this.counterRecovery.reset();
      if (!this.householdBinding) this.householdAnchor = null;
      this.householdInterrupted = true;
    }
    if (reason === 'connection-changed') this.checkpointDirty = true;
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
    if (!values) {
      this.flowInterrupted = true;
      return;
    }
    this.checkpointDirty = true;
    const interrupted = this.flowInterrupted;
    this.flowInterrupted = false;
    this.flowAnchor = { at, values, binding };
    if (!old?.values || old.binding !== binding) return;
    const sample = meterInterval(old.values, values, at - old.at, interrupted);
    if (!sample) {
      // A rebound from a spurious reading must not look like new production.
      if (at - old.at <= SLOT_MS) this.flowAnchor = null;
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
    if (source !== 'grid' || !Number.isSafeInteger(at) || at < this.phaseResumeAt) return;
    const old = this.phaseAnchors.get(source);
    const next = { at, binding, amps: validBinding(binding) && validAmps(amps) ? [...amps] : null };
    if (old && (at < old.at || (at === old.at && next.amps))) return;
    this.phaseAnchors.set(source, next);
    recordInterval(old, next, (t) => this.getPending(t), source);
  }
  setHouseholdSource(binding) {
    if (binding === this.householdBinding) return;
    const invalidate = !!this.householdAnchor;
    this.householdAnchor = null;
    this.householdBinding = binding;
    this.householdInterrupted = false;
    this.householdFailureReason = null;
    if (invalidate) {
      this.checkpointDirty = true;
      // A failed write keeps pending energy and the invalidation for the periodic retry.
      try {
        this.flush();
      } catch {
        /* flush records the storage failure */
      }
    }
  }
  observeHouseholdCounter(raw, ms = this.now(), reason = 'invalid-sample') {
    const old = this.householdAnchor;
    if (!Number.isSafeInteger(ms) || ms < this.householdResumeAt || ms <= this.householdAttemptMs)
      return null;
    const value =
      typeof raw === 'string' && /^(0|[1-9]\d{0,14})$/.test(raw) && Number(raw) <= 100000000000000
        ? Number(raw)
        : null;
    const lastAttempt = this.householdAttemptMs;
    this.householdAttemptMs = ms;
    if (value === null) {
      this.diagnostics?.record('household', reason, lastAttempt >= 0 ? lastAttempt : ms, ms);
      this.householdInterrupted = true;
      this.householdFailureReason = reason;
      if (!this.householdBinding || raw !== null || reason === 'invalid-sample') {
        this.householdAnchor = null;
        this.checkpointDirty = true;
      }
      return null;
    }
    if (this.householdFailureReason && lastAttempt >= 0)
      this.diagnostics?.record('household', this.householdFailureReason, lastAttempt, ms);
    this.householdFailureReason = null;
    const interrupted = this.householdInterrupted;
    this.householdInterrupted = false;
    this.householdAnchor = { ms, value, binding: this.householdBinding };
    this.checkpointDirty = true;
    if (!old) return null;

    const elapsed = ms - old.ms;
    const wh = (value - old.value) * 10;
    const reset = wh < 0;
    // A bounded outage can touch at most two quarter-hour buckets.
    const tooLate = elapsed > (this.householdBinding ? SLOT_MS : 90000);
    // Broad plausibility guard, with one 10 Wh count of quantization allowance.
    const jump = wh > (350000 * elapsed) / 3600000 + 10;
    if (reset || tooLate || jump) {
      // Re-anchor on the next successful read after a reset or implausible jump.
      // This also prevents an isolated bad reading followed by a rebound from adding energy.
      if (reset || jump) this.householdAnchor = null;
      const reason = reset ? 'counter-reset' : tooLate ? 'sample-delay' : 'invalid-sample';
      this.diagnostics?.record('household', reason, old.ms, ms);
      return null;
    }

    if (!interrupted && elapsed > 90000)
      this.diagnostics?.record('household', 'sample-delay', old.ms, ms);
    const recovered = !!this.householdBinding && (interrupted || elapsed > 90000);
    const split = Math.floor(old.ms / SLOT_MS) !== Math.floor((ms - 1) / SLOT_MS);
    for (let start = old.ms; start < ms;) {
      const slot = Math.floor(start / SLOT_MS) * SLOT_MS;
      const end = Math.min((Math.floor(start / FIVE_MS) + 1) * FIVE_MS, ms);
      const duration = end - start;
      const entry = this.getPending(slot);
      const partWh = wh * (duration / elapsed);
      recordPart(
        entry,
        'household',
        start,
        end,
        partWh,
        Math.floor(old.ms / FIVE_MS) !== Math.floor((ms - 1) / FIVE_MS),
      );
      if (recovered) entry.householdRecoveredMs = (entry.householdRecoveredMs ?? 0) + duration;
      entry.householdWh = (entry.householdWh ?? 0) + partWh;
      entry.householdCoverageMs = (entry.householdCoverageMs ?? 0) + duration;
      entry.householdEstimatedMs = (entry.householdEstimatedMs ?? 0) + (split ? duration : 0);
      start = end;
    }
    if (recovered) this.householdRecoveries.push({ from: old.ms, to: ms });
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
    // short interval crosses a five-minute or quarter boundary. Each millisecond is assigned once.
    const duration = to.ms - from.ms;
    const powerAt = (t) => from.value + (to.value - from.value) * ((t - from.ms) / duration);
    for (let start = from.ms; start < to.ms;) {
      const slot = Math.floor(start / SLOT_MS) * SLOT_MS;
      const end = Math.min(to.ms, (Math.floor(start / FIVE_MS) + 1) * FIVE_MS);
      const entry = this.getPending(slot);
      const energyKey = key.replace('W', 'Wh');
      const wh = (((powerAt(start) + powerAt(end)) / 2) * (end - start)) / 3600000;
      recordPart(entry, key, start, end, wh);
      entry[energyKey] = (entry[energyKey] || 0) + wh;
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
  observeCounters(raw, binding, charger) {
    const power = charger === 'ev' ? 'evW' : charger === 'evac' ? 'evacW' : 'gridW';
    const at = this.lastSamples.get(power)?.ms;
    this.checkpointDirty = true;
    for (const repair of this.counterRecovery.accept(
      raw,
      binding,
      at,
      charger ? [charger] : undefined,
    )) {
      this.getPending(repair.t);
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
        // Complete an existing coarse quarter at its original resolution. A slot with
        // only endpoint observations has no older energy to account for.
        if (
          entry.fiveMinute &&
          (old.fiveMinute || ![...ENERGIES, 'householdWh'].some((key) => old[key] !== undefined))
        )
          merged.fiveMinute = mergeParts(old.fiveMinute, entry.fiveMinute);
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
      flowCheckpoint: this.flowAnchor ?? null,
      counterCheckpoint: this.counterRecovery.checkpoint(now),
      householdCheckpoint: this.householdBinding ? this.householdAnchor : null,
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
    this.checkpointDirty = false;
    const recoveries = this.householdRecoveries;
    this.householdRecoveries = [];
    const committedRepairs = this.pendingRepairs;
    // Clear immediately after the single state write; optional logging cannot cause a retry to add energy twice.
    this.pending.clear();
    this.pendingRepairs = [];
    this.pendingEvents = [];
    for (const { from, to } of recoveries) {
      try {
        this.diagnostics?.record('household', 'counter-gap-recovered', from, to);
      } catch {
        /* Already committed. */
      }
    }
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
      (!this.pending.size &&
        !this.pendingEvents.length &&
        !this.pendingRepairs.length &&
        !this.checkpointDirty)
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
    this.commit({
      ...plan.state,
      counterCheckpoint: null,
      flowCheckpoint: null,
      householdCheckpoint: null,
    });
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
