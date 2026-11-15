'use strict';
const { getEnergyHistory } = require('./energy-history');
const { validNetworkRows } = require('./network-energy');
const H = 3600000,
  Q = 900000;
function hourlyEnergy(energy, cache, confirmed, now = Date.now()) {
  if (energy.status === 'unavailable')
    return { status: 'unavailable', hours: [], sigenergyHours: 0, tibberFilledHours: 0 };
  const from = energy.windowFrom === null ? null : Math.floor(energy.windowFrom / H) * H,
    to = Math.floor(now / H) * H;
  if (from === null)
    return { status: 'collecting', hours: [], sigenergyHours: 0, tibberFilledHours: 0 };
  const byQuarter = new Map(energy.slots.map((s) => [s.t, s]));
  const meter =
    confirmed && validNetworkRows(cache?.networkEnergy, cache?.fetchedAt)
      ? new Map(cache.networkEnergy.map((r) => [r.t, r]))
      : new Map();
  const hours = [];
  let sigenergyHours = 0,
    tibberFilledHours = 0,
    counterRecoveredHours = 0;
  for (let t = from; t < to; t += H) {
    const quarters = Array.from({ length: 4 }, (_, i) => byQuarter.get(t + i * Q));
    if (quarters.every(Boolean)) {
      const recovered = quarters.some((s) => s.counterRecoveredChannels?.includes('grid'));
      hours.push({
        t,
        importWh: quarters.reduce((n, s) => n + s.importWh, 0),
        exportWh: quarters.reduce((n, s) => n + s.exportWh, 0),
        source: recovered ? 'sigenergy-counter-gap-estimate' : 'sigenergy-sampled',
      });
      sigenergyHours++;
      if (recovered) counterRecoveredHours++;
    } else {
      const row = meter.get(t);
      if (Number.isFinite(row?.importWh) && Number.isFinite(row?.exportWh)) {
        hours.push({ ...row, source: 'tibber-meter-hourly' });
        tibberFilledHours++;
      }
    }
  }
  return {
    status: hours.length ? (hours.length === (to - from) / H ? 'ready' : 'partial') : 'collecting',
    from,
    to,
    hours,
    sigenergyHours,
    tibberFilledHours,
    counterRecoveredHours,
    missingHours: (to - from) / H - hours.length,
  };
}
function getHourlyEnergy(homey, cache, session, now = Date.now()) {
  const energy = getEnergyHistory(homey, now);
  const confirmed =
    !!session?.homeId &&
    cache?.revision === session.revision &&
    Number.isFinite(cache.fetchedAt) &&
    cache.fetchedAt <= now &&
    homey.app.tibberHistoryPrices?.session?.()?.revision === session.revision &&
    homey.app.tibberHistoryPrices?.status().confirmed === true;
  return hourlyEnergy(energy, cache, confirmed, now);
}
module.exports = { hourlyEnergy, getHourlyEnergy };
