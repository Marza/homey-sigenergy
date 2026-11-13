'use strict';
const { validateConfig, upcomingDeadlines, planCharging } = require('./planner');
const MANUAL_MAX_AGE_MS = 15 * 60000;
function createChargingPreview({ input, config, pricing, prices, now = new Date() }) {
  validateConfig(config);
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.source !== 'manual')
    throw new Error('Ange manuellt avläst bil-SoC. EVDC är ännu inte verifierad.');
  if (!Number.isFinite(input.currentSoc) || input.currentSoc < 0 || input.currentSoc > 100)
    throw new Error('Bil-SoC måste vara 0–100 %.');
  const observedAt =
    typeof input.observedAt === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(input.observedAt)
      ? Date.parse(input.observedAt)
      : NaN;
  const age = now.getTime() - observedAt;
  if (!Number.isFinite(age) || age < 0 || age > MANUAL_MAX_AGE_MS)
    throw new Error(
      'SoC-avläsningen måste vara högst 15 minuter gammal och får inte ligga i framtiden.',
    );
  if (
    typeof input.connected !== 'boolean' ||
    !Number.isFinite(input.availablePowerKW) ||
    input.availablePowerKW < 0 ||
    input.availablePowerKW > 350
  )
    throw new Error('Bekräfta anslutning och ange tillgänglig laddningseffekt (0–350 kW).');
  const power = Math.min(config.maxChargingPowerKW, input.availablePowerKW);
  const deadlines = upcomingDeadlines(config, now);
  const base = {
    createdAt: now.toISOString(),
    advisoryOnly: true,
    controlApplied: false,
    soc: {
      source: 'manual',
      percent: input.currentSoc,
      observedAt: new Date(observedAt).toISOString(),
      ageSeconds: Math.floor(age / 1000),
    },
    assumptions: {
      connected: input.connected,
      powerKW: power,
      configuredMaxPowerKW: config.maxChargingPowerKW,
      usableBatteryKWh: config.usableBatteryKWh,
      chargingEfficiency: config.chargingEfficiency,
      timezone: config.timezone,
      horizonHours: 48,
      continuousConnection: input.connected,
      noDrivingOrDischarge: true,
    },
    pricing: {
      usable: !!pricing?.usable,
      currency: pricing?.currency || null,
      fetchedAt: pricing?.fetchedAt || null,
      availableFrom: pricing?.availableFrom || null,
      availableTo: pricing?.availableTo || null,
    },
    deadlines: deadlines.map((d) => ({ ...d, at: d.at.toISOString() })),
    horizon: { from: now.toISOString(), to: new Date(now.getTime() + 48 * 3600000).toISOString() },
    costBasis:
      'Tibbers konsumtionspris total, inte full elkostnad eller besparing. Nätavgifter, export, slitage och hemmabatteri ingår inte.',
  };
  if (!input.connected) return { ...base, status: 'not-connected', slots: [] };
  if (power === 0) return { ...base, status: 'no-power', slots: [] };
  const alreadyMet = deadlines.every((d) => d.soc <= input.currentSoc);
  if (!pricing?.usable && !alreadyMet) return { ...base, status: 'no-prices', slots: [] };
  const result = planCharging({
    now,
    currentSoc: input.currentSoc,
    config,
    prices: pricing?.usable ? prices : [],
    maxPowerKW: power,
  });
  const inputKWh = result.slots.reduce((sum, s) => sum + s.inputKWh, 0);
  return {
    ...base,
    ...result,
    advisoryOnly: true,
    controlApplied: false,
    status: alreadyMet ? 'already-met' : result.status,
    plannedInputKWh: Number(inputKWh.toFixed(4)),
    plannedBatteryKWh: Number((inputKWh * config.chargingEfficiency).toFixed(4)),
    horizon: { from: now.toISOString(), to: new Date(now.getTime() + 48 * 3600000).toISOString() },
  };
}
module.exports = { createChargingPreview, MANUAL_MAX_AGE_MS };
