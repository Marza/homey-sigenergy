'use strict';
const { optimize, Q } = require('./battery-plan');
const { calendar } = require('../pricing/coverage');
const { calculateMarginalPrices } = require('../pricing/cost-model');
const { readTimeline, contractAt } = require('../pricing/contract-timeline');
const { activeAt, localParts } = require('../demand-tariff');
const { batteryValues, diagnostics, backupAdvisory } = require('../source-status');
const { upcomingHouseholdPower, median } = require('./household-forecast');
const { readComparableSlots } = require('../pricing/comparison-data');
const { calculationSlot } = require('../history');
const { validQuarter } = require('./phase-current');
const DAY = 96 * Q;

function recordSample(samples, minute, wh) {
  if (!samples.has(minute)) samples.set(minute, []);
  samples.get(minute).push(wh);
}

function profile(rows, now, config, binding, solarSince) {
  const peakAmps = new Map();
  const pv = new Map(),
    ev = new Map();
  const chargers = [
    ['evdc', 'ev'],
    ['evac', 'evac'],
  ]
    .filter(([name]) => config?.[name]?.enabled)
    .map(([, field]) => field);
  for (const row of rows) {
    if (row.t + Q > now || row.t < now - 7 * DAY) continue;
    const minute = localParts(row.t).minute;
    const phases = row.phaseCurrent?.grid;
    if (binding && phases?.binding === binding && phases.ms === Q && validQuarter(phases))
      peakAmps.set(minute, Math.max(peakAmps.get(minute) ?? 0, ...phases.peakA));
    const r = calculationSlot(row),
      coverage = r.energyFieldCoverageMs ?? r.fieldCoverageMs ?? {};
    if (row.t >= solarSince && coverage.pvW === Q && Number.isFinite(r.pvWh) && r.pvWh >= 0)
      recordSample(pv, minute, r.pvWh);
    if (
      chargers.length &&
      chargers.every((key) => coverage[key + 'W'] === Q && Number.isFinite(r[key + 'Wh']))
    )
      recordSample(
        ev,
        minute,
        chargers.reduce((sum, key) => sum + r[key + 'Wh'], 0),
      );
  }
  return { pv, ev, hasCharger: chargers.length > 0, peakAmps };
}

function getBatteryPlan(homey, now = Date.now(), slots) {
  const get = (k) => homey.settings.get(k);
  const values = Object.fromEntries(
    [
      'sourceConfig',
      'tibberToken',
      'tibberHomeId',
      'priceCache',
      'sigenergyStatus',
      'sigenergyError',
      'backupStatus',
      'batteryTelemetry',
      'batteryTelemetryError',
    ].map((k) => [k, get(k)]),
  );
  const days = calendar(new Date(now)),
    start = days.today.start,
    end = days.tomorrow.end;
  const rows = readComparableSlots(homey, { raw: true, slots }) ?? [];
  const measured = [];
  for (const row of rows) {
    if (row.t < start || row.t > now) continue;
    for (const [i, bin] of (row.minuteMeans?.soc ?? []).entries()) {
      const t = row.t + i * 300000;
      if (t <= now && Number.isFinite(bin?.mean)) measured.push({ t, soc: bin.mean });
    }
  }
  const prices = new Map();
  const status = diagnostics(values, now);
  const accepted = status.tibber.usable ? values.priceCache.prices : [];
  for (const p of accepted)
    for (let t = Date.parse(p.start); t < Date.parse(p.end); t += Q) prices.set(t, p);
  let timeline;
  try {
    timeline = readTimeline(homey);
  } catch {
    timeline = { entries: [] };
  }
  const quarters = [];
  const future = (Math.floor(now / Q) + 1) * Q;
  const house = new Map(
    upcomingHouseholdPower(homey.settings, future, future + DAY, now).map((p) => [p.t, p.kw]),
  );
  const solarForecast = homey.app.solarForecast?.planningQuarters(now, days.today.end);
  const { pv, ev, hasCharger, peakAmps } = profile(
    rows,
    now,
    values.sourceConfig,
    get('gridPhaseCurrent')?.binding,
    get('solarMeasurementSource')?.since ?? -Infinity,
  );
  const limits = get('householdImportLimits');
  const fuse = limits?.mainFuseA ?? null;
  let missingPhase = false;
  const inputs = [];
  let gap = null;
  for (let t = start; t < end; t += Q) {
    const entry = contractAt(timeline, t),
      p = prices.get(t);
    let buy = null,
      sell = null;
    if (entry && p) {
      const c = entry.contract;
      if (Number.isFinite(p.spot)) {
        const result = calculateMarginalPrices({
          settings: c,
          spotImportExVatSekPerKWh: p.spot,
          tibberImportInclVatSekPerKWh: p.price,
          tibberExportSekPerKWh: p.spot,
        });
        buy = result.importSekPerKWh;
        sell = result.exportSekPerKWh;
      } else if (c.importPriceBasis !== 'spot-ex-vat') {
        buy = calculateMarginalPrices({
          settings: c,
          tibberImportInclVatSekPerKWh: p.price,
          tibberExportSekPerKWh: 0,
        }).importSekPerKWh;
      }
    }
    quarters.push({ t, buy, sell });
    if (t < future || t >= future + DAY || gap) continue;
    const minute = localParts(t).minute;
    const load = house.get(t);
    const solar =
      solarForecast?.get(t) ??
      (pv.has(minute) ? { solarWh: median(pv.get(minute)), solarSource: 'history' } : null);
    const evWh = hasCharger ? (ev.has(minute) ? median(ev.get(minute)) : null) : 0;
    const peak = peakAmps.get(minute);
    const phaseRoomKWh =
      fuse === null
        ? Infinity
        : Number.isFinite(fuse) && Number.isFinite(peak)
          ? (Math.max(0, fuse - peak) * 3 * 0.23) / 4
          : 0;
    if (!entry) gap = 'contract';
    else if (buy === null || sell === null) gap = 'prices';
    else if (!Number.isFinite(load) || !solar || evWh === null) gap = 'load';
    else {
      if (fuse !== null && !Number.isFinite(peak)) missingPhase = true;
      inputs.push({
        t,
        buy,
        sell,
        phaseRoomKWh,
        solar,
        netKWh: -load / 4 + (evWh - solar.solarWh) / 1000,
        wear: entry.contract.batteryWearSekPerKWh,
        peakWindow: entry.tariff.rateSekPerKw > 0 && activeAt(t, entry.tariff),
      });
    }
  }
  const backup = backupAdvisory(values, now, status.sigenergy);
  const b = batteryValues(values.batteryTelemetry, status.battery);
  const importKW = limits?.importLimitKW;
  const tariffTargetKW = limits?.tariffTargetKW ?? 3;
  const battery = {
    tariffTargetKW,
    soc: backup.batterySoc,
    capacity: b.capacityKWh,
    low: b.dischargeCutoffSoc,
    high: b.chargeCutoffSoc,
    chargeKW: b.chargePowerLimitKW,
    dischargeKW: b.dischargePowerLimitKW,
    importKW,
  };
  let reason = backup.restricted
    ? 'grid'
    : !Number.isFinite(importKW) || importKW <= 0
      ? 'limit'
      : null;
  const plan = reason ? null : optimize(inputs, battery);
  if (!plan && !reason) reason = !inputs.length ? gap : 'battery';
  return {
    now,
    days,
    quarters,
    measured,
    missingPhase,
    chargeLimitKW: b.chargePowerLimitKW,
    tariffTargetKW,
    liveSoc: backup.batterySoc,
    plan: plan?.map((q, i) => ({ ...q, ...inputs[i].solar })) ?? [],
    reason: reason ?? gap,
  };
}
module.exports = { getBatteryPlan };
