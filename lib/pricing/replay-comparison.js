'use strict';
const { replayBattery } = require('../optimization/balanced-replay');
const { calculateDemandCharge, localParts } = require('../demand-tariff');
const { tariffKey } = require('../tariff-config');
const { readTimeline, contractAt, additions } = require('./contract-timeline');
const Q = 900000,
  H = 3600000;
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
  const to = Math.floor(now / H) * H,
    from = to - hours * H;
  const source = homey.app.tibberHistoryPrices;
  const session = source.session();
  if (!session?.homeId || !source.status().confirmed)
    return unavailable('tibber-home-not-confirmed');
  const { safeCache } = require('./tibber-history-prices');
  const cache = safeCache(homey.settings.get('tibberHistoryPriceCache'), session.revision, now);
  if (!cache) return unavailable('historical-prices-unavailable', { from, to });
  const timeline = readTimeline(homey);
  if (!timeline.entries.length) return unavailable('dated-contract-required', { from, to });
  const history = homey.app.history.getSlots();
  if (!Array.isArray(history) || history.length > 3072) return unavailable('invalid-history');
  const seen = new Set();
  for (const s of history) {
    if (!Number.isSafeInteger(s?.t) || seen.has(s.t)) return unavailable('invalid-history');
    seen.add(s.t);
  }
  const byTime = new Map(history.map((s) => [s.t, s])),
    prices = new Map(cache.rows.map((r) => [r.t, r]));
  const load = [],
    entries = [],
    priceRows = [];
  const missing = {
    energyQuarters: 0,
    batteryCoverageQuarters: 0,
    contractQuarters: 0,
    purchasePriceQuarters: 0,
    productionPriceQuarters: 0,
  };
  for (let t = from; t < to; t += Q) {
    const s = byTime.get(t),
      entry = contractAt(timeline, t),
      p = prices.get(Math.floor(t / H) * H);
    const valid =
      s?.schema === 2 &&
      s.coverageMs === Q &&
      s.directionalCoverageMs === Q &&
      Number.isFinite(s.gridWh) &&
      Number.isFinite(s.importWh) &&
      s.importWh >= 0 &&
      Number.isFinite(s.exportWh) &&
      s.exportWh >= 0 &&
      Math.abs(s.importWh - s.exportWh - s.gridWh) <= 1e-6;
    if (!valid) missing.energyQuarters++;
    if (s?.essCoverageMs !== Q || !Number.isFinite(s?.essWh)) missing.batteryCoverageQuarters++;
    if (!entry) missing.contractQuarters++;
    if (!Number.isFinite(p?.consumption?.price)) missing.purchasePriceQuarters++;
    if (!Number.isFinite(p?.production?.price)) missing.productionPriceQuarters++;
    if (valid && Number.isFinite(s.essWh))
      load.push({ t, netLoadKWh: (s.gridWh - s.essWh) / 1000 });
    entries.push(entry);
    priceRows.push(p);
  }
  if (Object.values(missing).some((n) => n > 0))
    return unavailable('incomplete-comparison-window', { from, to, missing });
  const versions = [...new Set(entries.map((e) => e.id))];
  return {
    from,
    to,
    load,
    entries,
    priceRows,
    versions,
    cache,
    sourceRows: load.map((s) => byTime.get(s.t)),
  };
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
