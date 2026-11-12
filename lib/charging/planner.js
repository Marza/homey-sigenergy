'use strict';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULTS = Object.freeze({
  minimumSoc: 30,
  minimumDeadline: '07:00',
  usableBatteryKWh: 75,
  chargingEfficiency: 0.92,
  maxChargingPowerKW: 10,
  timezone: 'Europe/Stockholm',
  dailyTargets: {
    mon: { enabled: false, time: '07:00', soc: 80 },
    tue: { enabled: false, time: '07:00', soc: 80 },
    wed: { enabled: false, time: '07:00', soc: 80 },
    thu: { enabled: false, time: '07:00', soc: 80 },
    fri: { enabled: false, time: '07:00', soc: 80 },
    sat: { enabled: false, time: '09:00', soc: 80 },
    sun: { enabled: false, time: '09:00', soc: 80 },
  },
});

function validTime(time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`Invalid time: ${time}`);
  return time;
}
function validateConfig(config) {
  if (!Number.isFinite(config.minimumSoc) || config.minimumSoc < 0 || config.minimumSoc > 100) throw new Error('Invalid minimum SoC');
  validTime(config.minimumDeadline);
  if (!(config.usableBatteryKWh > 0) || !(config.chargingEfficiency > 0 && config.chargingEfficiency <= 1) || !(config.maxChargingPowerKW > 0)) throw new Error('Invalid charging parameters');
  for (const day of DAYS) {
    const target = config.dailyTargets[day];
    if (!target || typeof target.enabled !== 'boolean' || !Number.isFinite(target.soc) || target.soc < 0 || target.soc > 100) throw new Error(`Invalid target for ${day}`);
    validTime(target.time);
  }
  return config;
}
function partsAt(date, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { day: p.weekday.toLowerCase(), date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
// Enumerate UTC minutes so local daylight-saving gaps and repeated times are handled.
function upcomingDeadlines(config, now, horizonHours = 48) {
  const events = [];
  const start = Math.ceil(now.getTime() / 60000) * 60000;
  const end = now.getTime() + horizonHours * 3600000;
  for (let ms = start; ms <= end; ms += 60000) {
    const local = partsAt(new Date(ms), config.timezone);
    if (local.time === config.minimumDeadline) events.push({ at: new Date(ms), soc: config.minimumSoc, type: 'minimum' });
    const daily = config.dailyTargets[local.day];
    if (daily.enabled && local.time === daily.time) events.push({ at: new Date(ms), soc: daily.soc, type: 'daily' });
  }
  return events.sort((a, b) => a.at - b.at || a.soc - b.soc);
}

/**
 * Read-only, price-driven charging plan. Each slot: {start, end, price} in ISO/Date.
 * Splits work across cheapest available slots, subject to all SoC deadlines.
 * Assumes fixed charging power and constant efficiency; no battery/grid dispatch.
 */
function planCharging({ now = new Date(), currentSoc, config, prices, maxPowerKW }) {
  validateConfig(config);
  if (!Number.isFinite(currentSoc) || currentSoc < 0 || currentSoc > 100) throw new Error('Invalid vehicle SoC');
  const power = Math.min(config.maxChargingPowerKW, maxPowerKW ?? config.maxChargingPowerKW);
  if (!(power > 0)) throw new Error('Invalid available charging power');
  const deadlines = upcomingDeadlines(config, now);
  const slots = prices.map((p, index) => ({
    index, start: new Date(p.start).getTime(), end: new Date(p.end).getTime(), price: Number(p.price),
  })).filter(s => s.end > now.getTime() && s.start < now.getTime() + 48 * 3600000)
    .map(s => ({ ...s, start: Math.max(s.start, now.getTime()), allocatedKWh: 0 }))
    .filter(s => s.end > s.start);
  for (const slot of slots) {
    if (!Number.isFinite(slot.price) || !(slot.end > slot.start)) throw new Error('Invalid price slot');
  }
  slots.sort((a, b) => a.start - b.start);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].start < slots[i - 1].end) throw new Error('Overlapping price slots');
  }
  const unmet = [];
  let committedBatteryKWh = 0;
  const batteryKWh = config.usableBatteryKWh;
  for (const deadline of deadlines) {
    const requiredBatteryKWh = Math.max(0, (deadline.soc - currentSoc) / 100 * batteryKWh);
    let remainingInputKWh = Math.max(0, (requiredBatteryKWh - committedBatteryKWh) / config.chargingEfficiency);
    const candidates = slots.filter(s => s.start < deadline.at.getTime()).sort((a, b) => a.price - b.price || a.start - b.start);
    for (const slot of candidates) {
      const durationHours = (Math.min(slot.end, deadline.at.getTime()) - slot.start) / 3600000;
      const freeKWh = Math.max(0, durationHours * power - slot.allocatedKWh);
      const allocated = Math.min(remainingInputKWh, freeKWh);
      slot.allocatedKWh += allocated;
      remainingInputKWh -= allocated;
      if (remainingInputKWh < 1e-8) break;
    }
    const delivered = requiredBatteryKWh - remainingInputKWh * config.chargingEfficiency;
    committedBatteryKWh = Math.max(committedBatteryKWh, delivered);
    if (remainingInputKWh > 1e-6) unmet.push({ type: deadline.type, at: deadline.at.toISOString(), missingBatteryKWh: Number((remainingInputKWh * config.chargingEfficiency).toFixed(3)) });
  }
  return {
    createdAt: now.toISOString(), currentSoc, deadlines: deadlines.map(d => ({ ...d, at: d.at.toISOString() })),
    slots: slots.filter(s => s.allocatedKWh > 1e-8).map(s => ({
      start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(),
      inputKWh: Number(s.allocatedKWh.toFixed(4)), price: s.price,
    })),
    unmet, estimatedCost: Number(slots.reduce((sum, s) => sum + s.allocatedKWh * s.price, 0).toFixed(2)),
    status: unmet.length ? 'unreachable' : 'planned',
  };
}
module.exports = { DEFAULTS, DAYS, validateConfig, upcomingDeadlines, planCharging };
