'use strict';
const { prepareComparison, demand, priceSlots } = require('./replay-comparison');
const { replaySolarEv } = require('../optimization/coupled-solar-replay');
const { validateConfig } = require('../charging/planner');
const base = {
  advisoryOnly: true,
  controlApplied: false,
  financiallyComparable: false,
  rankingBasis: 'none',
  mode: 'coupled-solar-ev',
  priceBasis: 'historical-effective-hourly',
  scope: 'hypothetical-ev-on-observed-solar-window',
  fixedChargesIncluded: false,
  tariffVerified: false,
  inputVerification: 'user-confirmed-model-assumptions',
};
function unavailable(reason, extra = {}) {
  return { ...base, status: 'unavailable', reason, ...extra };
}
function compareSolarEv(homey, input, now = Date.now()) {
  try {
    if (
      !input ||
      input.confirmModelAssumptions !== true ||
      !Number.isInteger(input.hours) ||
      input.hours < 1 ||
      input.hours > 168 ||
      !Array.isArray(input.capsKW) ||
      !input.capsKW.length ||
      input.capsKW.length > 10 ||
      input.capsKW.some((c) => !Number.isFinite(c) || c < 0 || c > 1000) ||
      new Set(input.capsKW).size !== input.capsKW.length
    )
      return unavailable('invalid-solar-comparison-input');
    if (input.ev?.confirmNoExistingEvCharging !== true || input.ev?.confirmHistoricalTask !== true)
      return unavailable('confirm-historical-ev-baseline');
    const plants = homey.drivers?.getDriver('sigenergy').getDevices();
    if (!Array.isArray(plants) || plants.length !== 1) return unavailable('ambiguous-solar-plant');
    const context = prepareComparison(homey, input.hours, now);
    if (!context.load) return { ...context, ...base };
    const { from, to, load, sourceRows, entries, priceRows, versions, cache } = context;
    const missing = {
      solarCoverageQuarters: 0,
      solarEnergyQuarters: 0,
      knownEvChargingQuarters: 0,
      inconsistentSolarQuarters: 0,
    };
    for (let i = 0; i < sourceRows.length; i++) {
      const s = sourceRows[i];
      if (s.fieldCoverageMs?.pvW !== 900000) missing.solarCoverageQuarters++;
      if (!Number.isFinite(s.pvWh) || s.pvWh < 0) missing.solarEnergyQuarters++;
      if (
        (s.evWh !== undefined && (!Number.isFinite(s.evWh) || Math.abs(s.evWh) > 1e-6)) ||
        [s.min?.evW, s.max?.evW].some(
          (v) => v !== undefined && (!Number.isFinite(v) || Math.abs(v) > 1e-6),
        )
      )
        missing.knownEvChargingQuarters++;
      if (Number.isFinite(s.pvWh) && s.pvWh >= 0 && load[i].netLoadKWh + s.pvWh / 1000 < -1e-8)
        missing.inconsistentSolarQuarters++;
    }
    if (Object.values(missing).some((v) => v > 0))
      return unavailable('incomplete-solar-ev-window', { from, to, missing });
    const saved = validateConfig(homey.settings.get('chargingConfig'));
    if (!Number.isFinite(input.ev.targetSoc) || input.ev.targetSoc < saved.minimumSoc)
      return unavailable('ev-target-below-saved-minimum');
    const ev = {
      capacityKWh: saved.usableBatteryKWh,
      efficiency: saved.chargingEfficiency,
      maxPowerKW: Math.min(saved.maxChargingPowerKW, input.ev.maxPowerKW),
      minPowerKW: input.ev.minPowerKW,
      initialSoc: input.ev.initialSoc,
      targetSoc: input.ev.targetSoc,
      availableFromHours: input.ev.availableFromHours,
      deadlineHours: input.ev.deadlineHours,
    };
    const series = load.map((s, i) => ({ ...s, pvKWh: sourceRows[i].pvWh / 1000 }));
    const baselineReplay = replaySolarEv(series, input.battery, ev, 0, 'early'),
      baselineEnergy = priceSlots(baselineReplay.slots, priceRows, entries),
      baselineDemand = demand(baselineReplay.slots, entries, now);
    const candidates = [];
    for (const capKW of input.capsKW)
      for (const strategy of ['home-first', 'ev-first']) {
        const replay = replaySolarEv(series, input.battery, ev, capKW, strategy),
          energy = priceSlots(replay.slots, priceRows, entries),
          tariff = demand(replay.slots, entries, now);
        const eligible =
          replay.terminalMatched &&
          replay.ev.targetMet &&
          baselineReplay.ev.targetMet &&
          tariff.status === 'provisional' &&
          baselineDemand.status === 'provisional';
        const baselineTotal = eligible
            ? baselineEnergy.energySek + baselineEnergy.wearSek + baselineDemand.totalSek
            : null,
          scenarioTotal = eligible ? energy.energySek + energy.wearSek + tariff.totalSek : null;
        const row = {
          capKW,
          strategy,
          status: eligible ? 'indicative' : 'unavailable',
          reason:
            !baselineReplay.ev.targetMet || !replay.ev.targetMet
              ? 'ev-deadline-unmet'
              : !replay.terminalMatched
                ? 'terminal-energy-not-restored'
                : baselineDemand.reason || tariff.reason || null,
          initialStoredKWh: replay.initialKWh,
          finalStoredKWh: replay.finalKWh,
          terminalMatched: replay.terminalMatched,
          terminalShortfallKWh: replay.terminalShortfallKWh,
          terminalExcessKWh: replay.terminalExcessKWh,
          chargedKWh: replay.chargedKWh,
          dischargedKWh: replay.dischargedKWh,
          lossesKWh: replay.lossesKWh,
          uncoveredKWh: replay.uncoveredKWh,
          balanceResidualKWh: replay.balanceResidualKWh,
          ev: replay.ev,
          solar: replay.solar,
          conservation: replay.conservation,
          baseline: {
            ...baselineEnergy,
            demand: baselineDemand,
            totalSek: baselineTotal,
            ev: baselineReplay.ev,
            solar: baselineReplay.solar,
          },
          scenario: { ...energy, demand: tariff, totalSek: scenarioTotal },
          indicativeNetDifferenceSek: eligible ? baselineTotal - scenarioTotal : null,
        };
        if (
          [baselineEnergy, energy].some((e) => Object.values(e).some((v) => !Number.isFinite(v))) ||
          [baselineTotal, scenarioTotal, row.indicativeNetDifferenceSek].some(
            (v) => v !== null && !Number.isFinite(v),
          )
        )
          return unavailable('cost-overflow');
        candidates.push(row);
      }
    return {
      ...base,
      status: candidates.some((c) => c.status === 'indicative') ? 'indicative' : 'unavailable',
      reason: candidates.some((c) => c.status === 'indicative') ? null : 'no-comparable-candidates',
      from,
      to,
      intervals: load.length,
      contractVersions: versions,
      priceFetchedAt: cache.fetchedAt,
      candidates,
      batteryAssumptions: input.battery,
      evAssumptions: ev,
      assumptions: [
        'no-observed-ev-charging-in-selected-history-confirmed-by-owner',
        'shared-ac-boundary',
        'constant-house-and-solar-flows-per-quarter',
        'fractional-ev-finishes-at-valid-active-power',
        'manual-historical-arrival-and-departure',
        'same-ev-target-and-terminal-home-energy',
        'no-weather-or-solar-forecast',
        'no-phase-or-fuse-enforcement',
      ],
      note: 'Historisk modell med hypotetisk billaddning. Referensen laddar bilen tidigt med passivt husbatteri. Båda prioriteterna använder samma laddmål och avgång. Effektiva timpriser ger endast indikativa kostnadsskillnader; ingen ekonomisk rangordning eller styrning.',
    };
  } catch {
    return unavailable('invalid-solar-ev-assumptions');
  }
}
module.exports = { compareSolarEv };
