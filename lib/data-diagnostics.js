'use strict';
const { energyHistory } = require('./pricing/energy-history');
const { hourlyEnergy } = require('./pricing/hourly-energy');
const { effectiveSlot } = require('./energy/gap-recovery');
const {
  energyValid,
  batteryValid,
  evEnergyValid,
  evacEnergyValid,
} = require('./pricing/comparison-data');
const { qualityReport, validSnapshot, householdCoverage } = require('./data-quality');
const { safeCache } = require('./pricing/tibber-history-prices');
const KEY = 'dataGapDiagnostics',
  Q = 900000,
  H = 3600000,
  RETENTION = 32 * 24 * H,
  LIMIT = 500,
  RANGE_LIMIT = 100;
const SOURCES = [
  'app',
  'plant',
  'grid',
  'battery',
  'solar',
  'ev',
  'evac',
  'household',
  'storage',
  'prices',
];
const REASONS = [
  'app-started',
  'app-stopped',
  'reader-started',
  'connection-changed',
  'invalid-sample',
  'sample-delay',
  'counter-reset',
  'modbus-timeout',
  'modbus-unreachable',
  'modbus-refused',
  'modbus-read-error',
  'plant-processing-error',
  'counter-gap-recovered',
  'counter-recovery-failed',
  'off-grid',
  'slow-poll',
  'history-write-failed',
  'history-write-recovered',
  'history-imported',
  'prices-updated',
  'prices-partial',
  'prices-rate-limited',
  'prices-authorization',
  'prices-request-failed',
];
const instant = (n) => Number.isSafeInteger(n) && n >= 0;
function validEvent(e) {
  return (
    e &&
    SOURCES.includes(e.source) &&
    REASONS.includes(e.reason) &&
    instant(e.from) &&
    instant(e.to) &&
    e.to >= e.from &&
    Object.keys(e).every((k) => ['source', 'reason', 'from', 'to'].includes(k))
  );
}
function readFailureReason(error) {
  if (error?.code === 'ECONNREFUSED') return 'modbus-refused';
  if (['EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'].includes(error?.code))
    return 'modbus-unreachable';
  if (error?.code === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(String(error?.message)))
    return 'modbus-timeout';
  return 'modbus-read-error';
}
function ranges(times, step, events, source) {
  const result = [];
  for (const t of times) {
    if (result.at(-1)?.to === t) result.at(-1).to += step;
    else result.push({ from: t, to: t + step });
  }
  return {
    missing: times.length,
    rangeCount: result.length,
    truncated: result.length > RANGE_LIMIT,
    ranges: result.slice(0, RANGE_LIMIT).map((r) => ({
      ...r,
      reasons: [
        ...new Set(
          events
            .filter(
              (e) =>
                [source, ...(source === 'prices' ? [] : ['app', 'plant', 'storage'])].includes(
                  e.source,
                ) &&
                e.from < r.to &&
                (e.from === e.to ? e.to >= r.from : e.to > r.from) &&
                !['prices-updated', 'history-write-recovered'].includes(e.reason),
            )
            .map((e) => e.reason),
        ),
      ],
    })),
  };
}
class DataDiagnostics {
  constructor(settings, now = () => Date.now()) {
    this.settings = settings;
    this.now = now;
    this.pending = [];
    this.healthy = true;
  }
  read() {
    const state = this.settings.get(KEY);
    if (state === null || state === undefined)
      return { schema: 1, since: this.now(), events: [], dropped: 0 };
    if (
      state.schema !== 1 ||
      !instant(state.since) ||
      !Array.isArray(state.events) ||
      state.events.length > LIMIT ||
      !state.events.every(validEvent) ||
      !Number.isSafeInteger(state.dropped) ||
      state.dropped < 0
    )
      throw Error('invalid-diagnostics');
    return structuredClone(state);
  }
  record(source, reason, from = this.now(), to = from) {
    const e = { source, reason, from, to };
    if (!validEvent(e) || to > this.now()) return;
    this.pending.push(e);
    this.pending = this.pending.slice(-LIMIT);
    this.flush();
  }
  flush() {
    try {
      const state = this.read(),
        events = state.events.filter((e) => e.to >= this.now() - RETENTION);
      if (!this.pending.length && events.length === state.events.length) {
        this.healthy = true;
        return;
      }
      for (const e of this.pending.filter((e) => e.to >= this.now() - RETENTION)) {
        const old = events.findLast(
          (r) => r.source === e.source && r.reason === e.reason && e.from <= r.to && e.to >= r.from,
        );
        if (old) {
          old.from = Math.min(old.from, e.from);
          old.to = Math.max(old.to, e.to);
        } else events.push({ ...e });
      }
      events.sort((a, b) => a.to - b.to || a.from - b.from);
      this.settings.set(KEY, {
        ...state,
        events: events.slice(-LIMIT),
        dropped: state.dropped + Math.max(0, events.length - LIMIT),
      });
      this.pending = [];
      this.healthy = true;
    } catch {
      // Diagnostic persistence must never interrupt measurement collection or price fetching.
      this.healthy = false;
    }
  }
  report(homey, input, now = this.now()) {
    if (
      !input ||
      Object.keys(input).some((k) => k !== 'hours') ||
      !Number.isInteger(input.hours) ||
      input.hours < 1 ||
      input.hours > 768
    )
      throw Error('invalid-diagnostic-window');
    const to = Math.floor(now / Q) * Q,
      from = to - input.hours * H;
    let journal;
    try {
      journal = this.read();
    } catch {
      this.healthy = false;
    }
    const allEvents = [...(journal?.events || []), ...this.pending].filter(
      (e) => e.from <= now && e.to >= from,
    );
    let slots, state;
    try {
      slots = homey.app.history.getSlots();
      state = homey.settings.get('historyState');
      if (!validSnapshot(slots, now)) throw Error('invalid-history');
    } catch {
      slots = null;
    }
    const map = new Map((slots || []).map((s) => [s.t, s]));
    const gaps = {};
    for (const [source, valid] of Object.entries({
      grid: energyValid,
      battery: batteryValid,
      solar: (s) => s?.fieldCoverageMs?.pvW === Q && Number.isFinite(s.pvWh) && s.pvWh >= 0,
      ev: evEnergyValid,
      evac: evacEnergyValid,
      household: (s) => householdCoverage(s) === Q,
    })) {
      const missing = [];
      for (let t = from; t < to; t += Q) if (!valid(map.get(t))) missing.push(t);
      gaps[source] = { ...ranges(missing, Q, allEvents, source), available: slots !== null };
    }
    const prices = homey.app.tibberHistoryPrices;
    let status = {},
      cache = null;
    try {
      status = prices.status();
      cache = safeCache(
        homey.settings.get('tibberHistoryPriceCache'),
        prices.session()?.revision,
        now,
      );
    } catch {
      /* Missing price source remains unavailable. */
    }
    const hourFrom = Math.floor(from / H) * H;
    const selectedEnergy = energyHistory(
      (slots || [])
        .filter((s) => s.t >= hourFrom && s.t < Math.floor(to / H) * H)
        .map(effectiveSlot),
      now,
    );
    const hourly = hourlyEnergy(
      {
        ...selectedEnergy,
        windowFrom: hourFrom,
        status: slots === null ? 'unavailable' : selectedEnergy.status,
      },
      cache,
      status.confirmed === true,
      now,
    );
    const priceMap = new Map((cache?.rows || []).map((r) => [r.t, r]));
    const priceGaps = {};
    for (const direction of ['consumption', 'production']) {
      const missing = [];
      for (let t = Math.floor(from / H) * H; t < Math.floor(to / H) * H; t += H)
        if (!priceMap.get(t)?.[direction]) missing.push(t);
      priceGaps[direction] = ranges(missing, H, allEvents, 'prices');
    }
    const safeStatuses = [
      'ok',
      'partial',
      'waiting-for-energy',
      'fetching',
      'network-error',
      'rate-limited',
      'authorization-required',
      'upstream-unavailable',
      'history-fetch-failed',
      'invalid-history',
    ];
    return {
      schema: 1,
      from,
      to,
      generatedAt: now,
      recordingSince: journal?.since ?? null,
      journalHealthy: this.healthy,
      events: allEvents.sort((a, b) => b.to - a.to).slice(0, LIMIT),
      droppedEvents: journal?.dropped ?? 0,
      storage: {
        readable: slots !== null,
        revision: Number.isSafeInteger(state?.revision) ? state.revision : null,
        bytes: state ? Buffer.byteLength(JSON.stringify(state)) : 0,
        limitBytes: 4 * 1024 * 1024,
        lastSavedAt: Number.isFinite(Date.parse(state?.updatedAt))
          ? Date.parse(state.updatedAt)
          : null,
        pendingQuarters: homey.app.history.pending?.size || 0,
      },
      gaps,
      quality: qualityReport(slots, from, to, hourly),
      recovery: {
        crossQuarterQuarters: (slots || []).filter(
          (s) =>
            s.t >= from &&
            s.t < to &&
            effectiveSlot(s) !== s &&
            Object.values(s.counterRecovery || {}).some((r) =>
              r.parts?.some((p) => p.allocation?.method === 'missing-time-proportional'),
            ),
        ).length,
        tibberFilledHours: hourly.tibberFilledHours || 0,
        hourlyMissing: hourly.missingHours ?? null,
        counterQuarters: (slots || [])
          .map(effectiveSlot)
          .filter((s) => s.t >= from && s.t < to && s.counterRecoveredChannels?.length).length,
        effectiveGridQuarters: (slots || [])
          .map(effectiveSlot)
          .filter((s) => s.t >= from && s.t < to && energyValid(s)).length,
      },
      prices: {
        ...priceGaps,
        from: Math.floor(from / H) * H,
        to: Math.floor(to / H) * H,
        available: !!cache,
        status: safeStatuses.includes(status.syncStatus) ? status.syncStatus : 'unavailable',
        priceHours: cache?.rows.length || 0,
        fetchedAt: instant(status.fetchedAt) ? status.fetchedAt : null,
        nextAttemptAt: instant(status.nextAttemptAt) ? status.nextAttemptAt : null,
      },
    };
  }
}
module.exports = { DataDiagnostics, readFailureReason, SOURCES, REASONS, KEY, LIMIT };
