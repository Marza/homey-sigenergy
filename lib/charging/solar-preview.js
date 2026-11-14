'use strict';
// Incremental, read-only snapshot scenario. No forecast, economic ranking or controls.
const { project } = require('../energy/reporting');
const { SOLAR_SOURCES } = require('../energy/meters');
const MANUAL_MAX_AGE_MS = 15 * 60000;
function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw Error(`Ogiltigt värde: ${label}.`);
  return value;
}
function createSolarPreview({ snapshot, input, evConfig, advisory, now = Date.now() }) {
  if (!Number.isFinite(now)) throw Error('Ogiltig tid.');
  const base = {
    createdAt: new Date(now).toISOString(),
    advisoryOnly: true,
    controlApplied: false,
  };
  const unavailable = (status) => ({ ...base, status, allocations: [] });
  if (!advisory || advisory.restricted !== false)
    return { ...unavailable('backup-restricted'), reason: advisory?.reason || 'Nätläge saknas.' };
  if (
    !project('grid', snapshot, now) ||
    !project('solar', snapshot, now) ||
    !project('battery', snapshot, now)
  )
    return unavailable('unavailable-source');
  if (
    !SOLAR_SOURCES.includes(snapshot.solarSource) ||
    !Number.isFinite(snapshot.soc) ||
    snapshot.soc < 0 ||
    snapshot.soc > 100
  )
    return unavailable('unavailable-source');
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !['home-first', 'ev-first'].includes(input.priority)
  )
    throw Error('Välj batteri först eller bil först.');
  const minutes = number(input.durationMinutes, 1, 15, 'scenariolängd 1–15 minuter');
  const hours = minutes / 60;
  if (
    !input.home ||
    typeof input.home.enabled !== 'boolean' ||
    !input.ev ||
    typeof input.ev.connected !== 'boolean'
  )
    throw Error('Ange om hemmabatteri och bil ska ingå.');
  const observed = {
    readAt: new Date(snapshot.readAt).toISOString(),
    solarSource: snapshot.solarSource,
    pvKW: snapshot.pvW / 1000,
    gridKW: snapshot.gridW / 1000,
    homeBatteryKW: snapshot.essW / 1000,
    homeSoc: snapshot.soc,
  };
  // Export may be supplied by the home battery. Subtract ALL observed discharge,
  // cap by PV, and never add existing battery/EV charging to the new power budget.
  const exportKW = Math.max(0, -observed.gridKW);
  const dischargeKW = Math.max(0, -observed.homeBatteryKW);
  const surplusKW = Math.min(observed.pvKW, Math.max(0, exportKW - dischargeKW));
  const consumers = {};
  let manualExpires = Infinity;
  if (input.home.enabled) {
    const capacity = number(snapshot.capacityKWh, 0.01, 10000, 'avläst hemmabatterikapacitet');
    const target = number(input.home.targetSoc, 0, 100, 'hemmabatteriets mål-SoC');
    const maxKW = number(input.home.maxPowerKW, 0, 350, 'hemmabatteriets totala laddeffekt');
    const efficiency = number(input.home.efficiency, 0.01, 1, 'hemmabatteriets laddverkningsgrad');
    const currentKW = Math.max(0, observed.homeBatteryKW);
    const roomKWh = Math.max(0, (capacity * (target - observed.homeSoc)) / 100);
    const extraRoomKWh = Math.max(0, roomKWh - currentKW * hours * efficiency);
    consumers.home = {
      capacityKWh: capacity,
      targetSoc: target,
      efficiency,
      currentKW,
      maxKW,
      // Preserve the observed discharge flow; do not claim simultaneous storage.
      dischargeBlocked: observed.homeBatteryKW < 0,
      additionalLimitKW:
        observed.homeBatteryKW < 0
          ? 0
          : Math.min(Math.max(0, maxKW - currentKW), extraRoomKWh / (hours * efficiency)),
      minAdditionalKW: 0,
    };
  }
  if (input.ev.connected) {
    const soc = number(input.ev.soc, 0, 100, 'manuellt avläst bil-SoC');
    const target = number(input.ev.targetSoc, 0, 100, 'bilens mål-SoC');
    const date =
      typeof input.ev.observedAt === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(input.ev.observedAt)
        ? Date.parse(input.ev.observedAt)
        : NaN;
    if (!Number.isFinite(date) || date > now || now - date >= MANUAL_MAX_AGE_MS)
      throw Error('Bil-SoC måste vara yngre än 15 minuter och får inte ligga i framtiden.');
    manualExpires = date + MANUAL_MAX_AGE_MS;
    const capacity = number(evConfig?.usableBatteryKWh, 0.01, 1000, 'sparad bilbatterikapacitet');
    const efficiency = number(evConfig?.chargingEfficiency, 0.01, 1, 'sparad billaddverkningsgrad');
    const configuredMax = number(
      evConfig?.maxChargingPowerKW,
      0,
      350,
      'sparad maximal billaddeffekt',
    );
    const maxKW = Math.min(
      configuredMax,
      number(input.ev.maxPowerKW, 0, 350, 'bilens totala laddeffekt'),
    );
    const minKW = number(input.ev.minPowerKW, 0, 350, 'bilens minsta sammanhängande laddeffekt');
    if (minKW > maxKW) throw Error('Bilens minsta effekt överstiger maximal effekt.');
    const currentKW = number(input.ev.currentPowerKW, 0, 350, 'bilens pågående laddeffekt');
    const roomKWh = Math.max(0, (capacity * (target - soc)) / 100);
    consumers.ev = {
      soc,
      observedAt: new Date(date).toISOString(),
      capacityKWh: capacity,
      targetSoc: target,
      efficiency,
      currentKW,
      maxKW,
      minKW,
      additionalLimitKW: Math.min(
        Math.max(0, maxKW - currentKW),
        Math.max(0, roomKWh - currentKW * hours * efficiency) / (hours * efficiency),
      ),
      minAdditionalKW: Math.max(0, minKW - currentKW),
    };
  }
  const order = input.priority === 'home-first' ? ['home', 'ev'] : ['ev', 'home'];
  let remaining = surplusKW;
  const allocation = { home: 0, ev: 0 };
  for (const key of order) {
    const c = consumers[key];
    if (!c) continue;
    const candidate = Math.min(remaining, c.additionalLimitKW);
    if (candidate > 0 && candidate >= c.minAdditionalKW) {
      allocation[key] = candidate;
      remaining = Math.max(0, remaining - candidate);
    }
  }
  const expiresAt = Math.min(snapshot.readAt + snapshot.maxAgeMs, now + 30000, manualExpires);
  if (expiresAt <= now) return unavailable('unavailable-source');
  const round = (value) => Number(value.toFixed(6));
  return {
    ...base,
    status: surplusKW > 0 ? 'preview' : 'no-surplus',
    validUntil: new Date(expiresAt).toISOString(),
    observed,
    budget: {
      exportKW,
      batteryDischargeKW: dischargeKW,
      availableSolarKW: surplusKW,
      excludedExportKW: exportKW - surplusKW,
    },
    assumptions: {
      durationMinutes: minutes,
      priority: input.priority,
      consumers,
      constantFlows: true,
      incrementalOnly: true,
      economicRanking: false,
    },
    allocations: ['home', 'ev', 'export'].map((destination) => {
      const power = destination === 'export' ? remaining : allocation[destination];
      const eta = consumers[destination]?.efficiency || 1;
      return {
        destination,
        additionalKW: round(power),
        inputKWh: round(power * hours),
        storedKWh: destination === 'export' ? null : round(power * hours * eta),
      };
    }),
  };
}
function previewSolar(homey, input, now = Date.now()) {
  const advisory = homey.app.getBackupAdvisory(now);
  const devices = homey.drivers.getDriver('sigenergy').getDevices();
  return createSolarPreview({
    snapshot: devices.length === 1 ? devices[0].getEnergySnapshot?.() : null,
    input,
    evConfig: homey.settings.get('chargingConfig'),
    advisory,
    now,
  });
}
module.exports = { createSolarPreview, previewSolar };
