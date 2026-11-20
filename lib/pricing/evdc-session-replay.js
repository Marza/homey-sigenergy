'use strict';
const {
  energyValid,
  evEnergyValid,
  readComparableSlots,
  scanComparisonData,
} = require('./comparison-data');
const { priceSlots } = require('./replay-comparison');
const { activeAt } = require('../demand-tariff');
const { KEY, readImportLimits } = require('../energy/import-limits');

const Q = 900000;
const H = 3600000;
const MAX_SESSION_QUARTERS = 96;
const SEARCH_MS = 7 * 24 * H;
const EPSILON_WH = 1e-6;
const base = {
  advisoryOnly: true,
  controlApplied: false,
  financiallyComparable: false,
  priceBasis: 'historical-effective-hourly',
};
const unavailable = (reason, extra = {}) => ({ ...base, status: 'unavailable', reason, ...extra });
const hasCharge = (row) => row?.evWh > EPSILON_WH || row?.max?.evW > 0;
const idle = (row) =>
  evEnergyValid(row) && Math.abs(row.evWh) <= EPSILON_WH && !(row.min?.evW < 0) && !hasCharge(row);

function latestCompletedSession(byTime, now) {
  const closed = Math.floor(now / Q) * Q;
  // Require an observed idle quarter after the active interval and both boundaries
  // of the pass. A missing boundary cannot establish that the car finished.
  let lastActive;
  for (const row of byTime.values()) {
    if (
      row.t >= now - SEARCH_MS &&
      row.t <= closed &&
      hasCharge(row) &&
      (!lastActive || row.t > lastActive.t)
    )
      lastActive = row;
  }
  if (!lastActive) return unavailable('no-evdc-session');
  const end = lastActive.t + Q;
  if (end >= closed || !idle(byTime.get(end))) return unavailable('evdc-session-end-unconfirmed');

  const profile = [];
  let start = end;
  while (hasCharge(byTime.get(start - Q))) {
    start -= Q;
    const row = byTime.get(start);
    if (
      profile.length === MAX_SESSION_QUARTERS ||
      !evEnergyValid(row) ||
      row.evWh <= EPSILON_WH ||
      row.min?.evW < 0
    )
      return unavailable('incomplete-evdc-session');
    profile.push(row.evWh);
  }
  if (!idle(byTime.get(start - Q))) return unavailable('evdc-session-start-unconfirmed');
  const energyKWh = profile.reduce((sum, wh) => sum + wh, 0) / 1000;
  if (!Number.isFinite(energyKWh)) return unavailable('invalid-evdc-data');
  return { session: { start, end, energyKWh }, profile: profile.reverse() };
}

// Stretch the measured profile over the earlier start and the same end. Map
// each target quarter onto the original profile and conserve its DC energy.
function stretchProfile(profile, quarters) {
  const factor = profile.length / quarters;
  return Array.from({ length: quarters }, (_, index) => {
    const from = index * factor;
    const to = Math.min(profile.length, (index + 1) * factor);
    let wh = 0;
    for (let i = Math.floor(from); i < to; i++)
      wh += profile[i] * (Math.min(i + 1, to) - Math.max(i, from));
    return wh;
  });
}

// On an hourly/quarter energy boundary, a DC-load increase first consumes
// observed export before adding import. A reduction first frees observed import.
// Both preserve the signed energy balance without inventing a sub-quarter profile.
function shiftFlow(row, changeWh) {
  if (changeWh >= 0) {
    const exportLeft = row.exportWh - changeWh;
    return { importWh: row.importWh + Math.max(0, -exportLeft), exportWh: Math.max(0, exportLeft) };
  }
  const importLeft = row.importWh + changeWh;
  return { importWh: Math.max(0, importLeft), exportWh: row.exportWh + Math.max(0, -importLeft) };
}

function peak(hours, eligible) {
  let best = null;
  for (const hour of hours) {
    if (eligible && !hour.tariffEligible) continue;
    if (!best || hour.kw > best.kw) best = { t: hour.t, kw: hour.kw };
  }
  return best;
}
function flows(slots, entries, importLimitKW) {
  let imported = 0;
  let exported = 0;
  const hours = [];
  for (let i = 0; i < slots.length; i += 4) {
    const hour = slots.slice(i, i + 4);
    const wh = hour.reduce((sum, row) => sum + row.importWh, 0);
    const t = hour[0].t;
    hours.push({ t, kw: wh / 1000, tariffEligible: entries[i] && activeAt(t, entries[i].tariff) });
    imported += wh;
    exported += hour.reduce((sum, row) => sum + row.exportWh, 0);
  }
  const aboveLimit =
    importLimitKW === null
      ? null
      : slots
          .map((row) => ({ t: row.t, kw: row.importWh / 250 }))
          .filter((row) => row.kw > importLimitKW + EPSILON_WH);
  return {
    importLimit:
      aboveLimit === null
        ? null
        : {
            peak: peak(aboveLimit),
            quarters: aboveLimit.length,
          },
    importKWh: imported / 1000,
    exportKWh: exported / 1000,
    peak: peak(hours),
    tariffPeak: entries.every(Boolean) ? peak(hours, true) : null,
  };
}
function summary(body) {
  return body && !Array.isArray(body) && typeof body === 'object' && !Object.keys(body).length;
}
function validRequest(body) {
  return (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 4 &&
    Number.isSafeInteger(body.sessionStart) &&
    Number.isSafeInteger(body.sessionEnd) &&
    Number.isInteger(body.minutesEarlier) &&
    body.minutesEarlier >= 15 &&
    body.minutesEarlier <= 1440 &&
    body.minutesEarlier % 15 === 0 &&
    Number.isFinite(body.efficiency) &&
    body.efficiency >= 0.5 &&
    body.efficiency <= 1
  );
}
function compareEvdcSession(homey, body, now = Date.now()) {
  if (!summary(body) && !validRequest(body)) return unavailable('invalid-evdc-request');
  try {
    const history = readComparableSlots(homey);
    if (!history) return unavailable('invalid-history');
    const byTime = new Map(history.map((row) => [row.t, row]));
    const detected = latestCompletedSession(byTime, now);
    if (!detected.session) return detected;
    const { session, profile } = detected;
    if (summary(body)) return { ...base, status: 'session', session };
    if (body.sessionStart !== session.start || body.sessionEnd !== session.end)
      return unavailable('evdc-session-changed');
    const start = session.start - body.minutesEarlier * 60000;
    const end = session.end;
    const extendedProfile = stretchProfile(profile, (end - start) / Q);
    const from = Math.floor(start / H) * H;
    const to = Math.ceil(session.end / H) * H;
    const missing = [];
    const overlaps = [];
    let mixedDirectionQuarters = 0;
    const baseline = [];
    const shifted = [];
    for (let t = from; t < to; t += Q) {
      const row = byTime.get(t);
      const old = profile[(t - session.start) / Q] ?? 0;
      const next = extendedProfile[(t - start) / Q] ?? 0;
      if (!energyValid(row)) {
        missing.push(t);
        continue;
      }
      if (next > 0 && old === 0 && !idle(row)) {
        overlaps.push(t);
        continue;
      }
      if (next !== old && row.importWh > EPSILON_WH && row.exportWh > EPSILON_WH)
        mixedDirectionQuarters++;
      baseline.push({ t, importWh: row.importWh, exportWh: row.exportWh, dischargeKWh: 0 });
      shifted.push({ t, ...shiftFlow(row, (next - old) / body.efficiency), dischargeKWh: 0 });
    }
    if (missing.length || overlaps.length)
      return unavailable('evdc-window-blocked', { missing, overlaps });

    const { report, context } = scanComparisonData(homey, (to - from) / H, now, false, {
      to,
      history,
    });
    let limits;
    try {
      limits = readImportLimits(homey.settings.get(KEY));
    } catch {
      return unavailable('invalid-household-import-limits');
    }
    const importLimitKW = limits.limitKW;
    const before = flows(baseline, context.entries, importLimitKW);
    const after = flows(shifted, context.entries, importLimitKW);
    const priceGaps = report.gates
      .filter((g) => g.key !== 'history' && g.state !== 'complete')
      .map((g) => g.reason);
    for (const key of ['contractQuarters', 'purchasePriceQuarters', 'productionPriceQuarters'])
      if (report.checks[key].state !== 'complete') priceGaps.push(key);
    const cost = (rows) =>
      priceGaps.length ? null : priceSlots(rows, context.priceRows, context.entries).energySek;
    before.energyCostSek = cost(baseline);
    after.energyCostSek = cost(shifted);
    for (const result of [before, after]) {
      if (
        ![result.importKWh, result.exportKWh, result.peak.kw].every(Number.isFinite) ||
        (result.energyCostSek !== null && !Number.isFinite(result.energyCostSek))
      )
        return unavailable('invalid-evdc-data');
    }
    return {
      ...base,
      status: 'indicative',
      session,
      shifted: { start, end, energyKWh: session.energyKWh },
      from,
      to,
      deadline: session.end,
      efficiency: body.efficiency,
      limits,
      baseline: before,
      scenario: after,
      priceGaps,
      mixedDirectionQuarters,
      estimatedGridQuarters: baseline.filter((row) =>
        byTime.get(row.t).counterRecoveredChannels?.includes('grid'),
      ).length,
    };
  } catch {
    return unavailable('invalid-evdc-data');
  }
}
module.exports = { compareEvdcSession };
