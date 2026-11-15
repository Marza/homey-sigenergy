'use strict';
const { replayBattery } = require('../optimization/balanced-replay');
const { calculateDemandCharge, localParts } = require('../demand-tariff');
const { tariffKey } = require('../tariff-config');
const { additions } = require('./contract-timeline');
const { scanComparisonData } = require('./comparison-data');
const H = 3600000;
const base = {
  advisoryOnly: true,
  controlApplied: false,
  financiallyComparable: false,
  rankingBasis: 'none',
  tariffVerified: false,
  fixedChargesIncluded: false,
  inputVerification: 'user-confirmed-model-assumptions',
  priceBasis: 'historical-effective-hourly',
  scope: 'modelled-observed-window',
  assumptions: [
    'constant-net-load-within-quarter',
    'grid-minus-observed-battery-at-common-AC-boundary',
    'manual-battery-capability',
    'no-battery-baseline',
    'historical-hourly-prices-not-counterfactual-settlement',
  ],
};
function unavailable(reason, extra = {}) {
  return { ...base, status: 'unavailable', reason, ...extra };
}
function demand(slots, entries, now) {
  const months = new Map();
  for (let i = 0; i < slots.length; i++) {
    const month = localParts(slots[i].t).month;
    if (!months.has(month)) months.set(month, { slots: [], tariffs: new Map() });
    const m = months.get(month);
    m.slots.push(slots[i]);
    m.tariffs.set(tariffKey(entries[i].tariff), entries[i].tariff);
  }
  let total = 0;
  const coverage = [];
  for (const [month, m] of months) {
    if (m.tariffs.size !== 1)
      return { status: 'unavailable', reason: 'tariff-changed-within-month', months: coverage };
    // Price directional import, not a signed net that hides within-hour exports.
    const hours = [];
    for (let i = 0; i < m.slots.length; i += 4) {
      const group = m.slots.slice(i, i + 4);
      if (group.length !== 4 || group[0].t % H)
        return { status: 'unavailable', reason: 'incomplete-demand-hour', months: coverage };
      hours.push({ t: group[0].t, importWh: group.reduce((sum, s) => sum + s.importWh, 0) });
    }
    const tariff = [...m.tariffs.values()][0];
    const noCharge =
      tariff.rateSekPerKw === 0 ||
      (tariff.months && !tariff.months.includes(Number(month.slice(5))));
    const estimate = calculateDemandCharge([], tariff, month, {
      nowMs: now,
      meterHours: hours,
    });
    coverage.push({
      month,
      status: noCharge ? 'not-applicable' : estimate.status,
      coverage: estimate.coverage,
      selectedPeaks: estimate.selectedPeaks,
      peakCount: estimate.peakCount,
      tariffKey: estimate.tariffKey,
    });
    if (!noCharge && !Number.isFinite(estimate.estimatedSek))
      return { status: 'unavailable', reason: 'insufficient-demand-peaks', months: coverage };
    total += noCharge ? 0 : estimate.estimatedSek;
  }
  return { status: 'provisional', totalSek: total, months: coverage };
}
function priceSlots(slots, priceRows, entries) {
  let importKWh = 0,
    exportKWh = 0,
    importCostSek = 0,
    exportRevenueSek = 0,
    wearSek = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i],
      p = priceRows[i],
      a = additions(entries[i]);
    const imported = s.importWh / 1000,
      exported = s.exportWh / 1000;
    importKWh += imported;
    exportKWh += exported;
    importCostSek += imported * (p.consumption.price + a.import);
    exportRevenueSek += exported * (p.production.price + a.export);
    wearSek += s.dischargeKWh * a.wear;
  }
  return {
    importKWh,
    exportKWh,
    importCostSek,
    exportRevenueSek,
    energySek: importCostSek - exportRevenueSek,
    wearSek,
  };
}
function prepareComparison(homey, hours, now) {
  const { report, context, missing } = scanComparisonData(homey, hours, now);
  for (const gate of report.gates) {
    if (gate.state === 'complete') continue;
    if (gate.reason === 'invalid-contract-timeline' || gate.reason === 'tibber-source-unavailable')
      throw Error('Invalid comparison source');
    return unavailable(
      gate.reason,
      gate.key === 'tibberHome' ? {} : { from: context.from, to: context.to },
    );
  }
  if (Object.values(missing).some((n) => n > 0))
    return unavailable('incomplete-comparison-window', {
      from: context.from,
      to: context.to,
      missing,
    });
  return context;
}

function compareReplay(homey, input, now = Date.now()) {
  try {
    if (
      !input ||
      input.confirmModelAssumptions !== true ||
      !Number.isInteger(input.hours) ||
      input.hours < 1 ||
      input.hours > 32 * 24 ||
      !Array.isArray(input.capsKW) ||
      !input.capsKW.length ||
      input.capsKW.length > 20 ||
      new Set(input.capsKW).size !== input.capsKW.length
    )
      return unavailable('invalid-comparison-input');
    const context = prepareComparison(homey, input.hours, now);
    if (!context.load) return context;
    const { from, to, load, entries, priceRows, versions, cache } = context;
    const results = [];
    let baselineEnergy, baselineDemand;
    for (const capKW of input.capsKW) {
      const replay = replayBattery(load, input.battery, capKW);
      baselineEnergy ||= priceSlots(replay.baseline, priceRows, entries);
      baselineDemand ||= demand(replay.baseline, entries, now);
      const scenarioEnergy = priceSlots(replay.scenario, priceRows, entries);
      const scenarioDemand = demand(replay.scenario, entries, now);
      const eligible =
        replay.terminalMatched &&
        baselineDemand.status === 'provisional' &&
        scenarioDemand.status === 'provisional';
      const baselineTotal = eligible
        ? baselineEnergy.energySek + baselineEnergy.wearSek + baselineDemand.totalSek
        : null;
      const scenarioTotal = eligible
        ? scenarioEnergy.energySek + scenarioEnergy.wearSek + scenarioDemand.totalSek
        : null;
      const result = {
        capKW,
        status: eligible ? 'indicative' : 'unavailable',
        reason: !replay.terminalMatched
          ? 'terminal-energy-not-restored'
          : baselineDemand.reason || scenarioDemand.reason || null,
        initialStoredKWh: replay.initialKWh,
        finalStoredKWh: replay.finalKWh,
        terminalShortfallKWh: replay.terminalShortfallKWh,
        terminalMatched: replay.terminalMatched,
        chargedKWh: replay.chargedKWh,
        dischargedKWh: replay.dischargedKWh,
        lossesKWh: replay.lossesKWh,
        uncoveredKWh: replay.uncoveredKWh,
        balanceResidualKWh: replay.balanceResidualKWh,
        baseline: { ...baselineEnergy, demand: baselineDemand, totalSek: baselineTotal },
        scenario: { ...scenarioEnergy, demand: scenarioDemand, totalSek: scenarioTotal },
        indicativeNetDifferenceSek: eligible ? baselineTotal - scenarioTotal : null,
      };
      if (
        [baselineEnergy, scenarioEnergy].some((e) =>
          Object.values(e).some((v) => !Number.isFinite(v)),
        )
      )
        return unavailable('cost-overflow');
      if (
        [baselineTotal, scenarioTotal, result.indicativeNetDifferenceSek].some(
          (n) => n !== null && !Number.isFinite(n),
        )
      )
        return unavailable('cost-overflow');
      results.push(result);
    }
    return {
      ...base,
      status: results.some((r) => r.status === 'indicative') ? 'indicative' : 'unavailable',
      reason: results.some((r) => r.status === 'indicative') ? null : 'no-comparable-candidates',
      from,
      to,
      intervals: load.length,
      counterRecoveredQuarters: context.counterRecoveredQuarters || 0,
      contractVersions: versions,
      priceFetchedAt: cache.fetchedAt,
      batteryAssumptions: input.battery,
      candidates: results,
      note: 'Indikativ historisk modelljämförelse. Effektiva timpriser kan bero på verkliga flöden och kan inte verifiera hypotetisk kvartsavräkning. Ingen automatisk ekonomisk rangordning eller styrning.',
    };
  } catch {
    return unavailable('invalid-comparison-data');
  }
}
module.exports = { compareReplay, prepareComparison, demand, priceSlots };
