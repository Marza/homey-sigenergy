'use strict';
const { calculationSlots } = require('../history');
const { readTimeline, contractAt } = require('./contract-timeline');
const { safeCache } = require('./tibber-history-prices');
const Q = 900000,
  H = 3600000,
  MAX_RANGES = 24;
function energyValid(s) {
  return (
    s?.schema === 2 &&
    s.coverageMs === Q &&
    s.directionalCoverageMs === Q &&
    Number.isFinite(s.gridWh) &&
    Number.isFinite(s.importWh) &&
    s.importWh >= 0 &&
    Number.isFinite(s.exportWh) &&
    s.exportWh >= 0 &&
    Math.abs(s.importWh - s.exportWh - s.gridWh) <= 1e-6
  );
}
function batteryValid(s) {
  return s?.essCoverageMs === Q && Number.isFinite(s?.essWh);
}
function evEnergyValid(s) {
  return s?.schema === 2 && s.fieldCoverageMs?.evW === Q && Number.isFinite(s.evWh);
}
function evacEnergyValid(s) {
  return (
    s?.schema === 2 && s.fieldCoverageMs?.evacW === Q && Number.isFinite(s.evacWh) && s.evacWh >= 0
  );
}
function requiredEvCoverage(homey) {
  const config = homey.settings.get('sourceConfig');
  const ac = config?.evac?.enabled === true;
  return { dc: !ac || config?.evdc?.enabled === true, ac };
}
function evActivity(s, powerField, energyField) {
  return [s?.[energyField], s?.min?.[powerField], s?.max?.[powerField]].some(
    (value) => value !== undefined && (!Number.isFinite(value) || Math.abs(value) > 1e-6),
  );
}
function solarIssues(s, netLoadKWh, coverage) {
  return {
    solarCoverageQuarters: (s?.energyFieldCoverageMs?.pvW ?? s?.fieldCoverageMs?.pvW) !== Q,
    solarEnergyQuarters: !Number.isFinite(s?.pvWh) || s.pvWh < 0,
    evCoverageQuarters: (coverage.dc && !evEnergyValid(s)) || (coverage.ac && !evacEnergyValid(s)),
    knownEvChargingQuarters: evActivity(s, 'evW', 'evWh') || evActivity(s, 'evacW', 'evacWh'),
    inconsistentSolarQuarters:
      Number.isFinite(s?.pvWh) && s.pvWh >= 0 && netLoadKWh + s.pvWh / 1000 < -1e-8,
  };
}
function category(times, expectedQuarters, available = true) {
  if (!available)
    return {
      state: 'unavailable',
      expectedQuarters,
      missingQuarters: null,
      affectedHours: null,
      ranges: [],
      rangeCount: 0,
      rangesTruncated: false,
    };
  const ranges = [];
  for (const t of times) {
    if (ranges.at(-1)?.to === t) ranges.at(-1).to += Q;
    else ranges.push({ from: t, to: t + Q });
  }
  return {
    state: times.length ? 'missing' : 'complete',
    expectedQuarters,
    missingQuarters: times.length,
    affectedHours: new Set(times.map((t) => Math.floor(t / H))).size,
    ranges: ranges.slice(0, MAX_RANGES),
    rangeCount: ranges.length,
    rangesTruncated: ranges.length > MAX_RANGES,
  };
}
function readComparableSlots(homey) {
  try {
    const rows = calculationSlots(homey.app.history);
    const seen = new Set();
    if (!Array.isArray(rows) || rows.length > 3072) return null;
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.t) || row.t < 0 || row.t % Q || seen.has(row.t)) return null;
      seen.add(row.t);
    }
    return rows;
  } catch {
    return null;
  }
}
// One local snapshot and one set of eligibility predicates for both inspection and replay.
// The API report deliberately excludes all raw readings, prices, terms, IDs and fingerprints.
function scanComparisonData(
  homey,
  hours,
  now,
  solar = false,
  { to = Math.floor(now / H) * H, history = readComparableSlots(homey) } = {},
) {
  const from = to - hours * H;
  const gates = [];
  let session,
    confirmed = false,
    sourceRead = true;
  try {
    const source = homey.app.tibberHistoryPrices;
    session = source.session();
    confirmed = !!session?.homeId && source.status().confirmed === true;
  } catch {
    sourceRead = false;
  }
  gates.push({
    key: 'tibberHome',
    state: confirmed ? 'complete' : 'unavailable',
    reason: sourceRead
      ? confirmed
        ? null
        : 'tibber-home-not-confirmed'
      : 'tibber-source-unavailable',
  });
  let cache = null,
    pricesAvailable = sourceRead && !!session?.revision;
  try {
    const raw = homey.settings.get('tibberHistoryPriceCache');
    cache = session?.revision ? safeCache(raw, session.revision, now) : null;
    if (raw && !cache) pricesAvailable = false;
  } catch {
    pricesAvailable = false;
  }
  gates.push({
    key: 'priceCache',
    state: cache ? 'complete' : 'unavailable',
    reason: cache ? null : 'historical-prices-unavailable',
  });
  let timeline = null;
  try {
    timeline = readTimeline(homey);
  } catch {
    /* Invalid or unreadable terms remain unknown. */
  }
  gates.push({
    key: 'datedTerms',
    state: timeline?.entries.length ? 'complete' : 'unavailable',
    reason: timeline
      ? timeline.entries.length
        ? null
        : 'dated-contract-required'
      : 'invalid-contract-timeline',
  });
  gates.push({
    key: 'history',
    state: history ? 'complete' : 'unavailable',
    reason: history ? null : 'invalid-history',
  });
  const byTime = new Map((history || []).map((s) => [s.t, s]));
  const prices = new Map((cache?.rows || []).map((r) => [r.t, r]));
  const times = Object.fromEntries(
    [
      'energyQuarters',
      'batteryCoverageQuarters',
      'contractQuarters',
      'purchasePriceQuarters',
      'productionPriceQuarters',
      ...(solar
        ? [
            'solarCoverageQuarters',
            'solarEnergyQuarters',
            'evCoverageQuarters',
            'knownEvChargingQuarters',
            'inconsistentSolarQuarters',
          ]
        : []),
    ].map((key) => [key, []]),
  );
  const load = [],
    entries = [],
    priceRows = [],
    sourceRows = [];
  let balanceKnown = !!history;
  const evCoverage = solar ? requiredEvCoverage(homey) : null;
  for (let t = from; t < to; t += Q) {
    const s = byTime.get(t),
      entry = timeline ? contractAt(timeline, t) : null,
      price = prices.get(Math.floor(t / H) * H);
    const validEnergy = energyValid(s),
      validBattery = batteryValid(s);
    if (!validEnergy) times.energyQuarters.push(t);
    if (!validBattery) times.batteryCoverageQuarters.push(t);
    if (!entry) times.contractQuarters.push(t);
    if (!Number.isFinite(price?.consumption?.price)) times.purchasePriceQuarters.push(t);
    if (!Number.isFinite(price?.production?.price)) times.productionPriceQuarters.push(t);
    const netLoadKWh = validEnergy && Number.isFinite(s?.essWh) ? (s.gridWh - s.essWh) / 1000 : NaN;
    if (Number.isFinite(netLoadKWh)) {
      load.push({ t, netLoadKWh });
      sourceRows.push(s);
    }
    if (solar) {
      if (!validEnergy || !validBattery || !Number.isFinite(s?.pvWh) || s.pvWh < 0)
        balanceKnown = false;
      for (const [key, missing] of Object.entries(solarIssues(s, netLoadKWh, evCoverage)))
        if (missing) times[key].push(t);
    }
    entries.push(entry);
    priceRows.push(price);
  }
  const checks = {};
  for (const [key, missing] of Object.entries(times)) {
    const available =
      key === 'contractQuarters'
        ? !!timeline
        : key === 'purchasePriceQuarters' || key === 'productionPriceQuarters'
          ? pricesAvailable
          : key === 'inconsistentSolarQuarters'
            ? balanceKnown
            : !!history;
    checks[key] = category(missing, hours * 4, available);
  }
  const dataComplete =
    gates.every((g) => g.state === 'complete') &&
    Object.values(checks).every((c) => c.state === 'complete');
  const report = {
    status: dataComplete ? 'complete' : 'incomplete',
    dataComplete,
    from,
    to,
    checkedAt: now,
    mode: solar ? 'solar-ev' : 'battery',
    timezone: 'Europe/Stockholm',
    intervalMinutes: 15,
    counterRecoveredQuarters: sourceRows.filter((s) => s.counterRecoveredChannels?.length).length,
    gates,
    checks,
    advisoryOnly: true,
    controlApplied: false,
    financiallyComparable: false,
    rankingBasis: 'none',
    modelValidated: false,
    demandEvaluated: false,
    priceBasis: 'historical-effective-hourly',
  };
  return {
    report,
    context: {
      from,
      to,
      load,
      entries,
      priceRows,
      sourceRows,
      counterRecoveredQuarters: report.counterRecoveredQuarters,
      cache,
      versions: [...new Set(entries.filter(Boolean).map((e) => e.id))],
    },
    missing: Object.fromEntries(Object.entries(times).map(([key, t]) => [key, t.length])),
  };
}
module.exports = {
  energyValid,
  batteryValid,
  evEnergyValid,
  evacEnergyValid,
  requiredEvCoverage,
  solarIssues,
  scanComparisonData,
  readComparableSlots,
};
