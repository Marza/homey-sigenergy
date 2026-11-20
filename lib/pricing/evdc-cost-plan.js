'use strict';
const { additions } = require('./contract-timeline');
const { activeAt } = require('../demand-tariff');
const HOUR = 3600000;
const EPSILON_WH = 1e-6;

function eligibleForFee({ t, entry }) {
  return entry.tariff.rateSekPerKw > 0 && activeAt(Math.floor(t / HOUR) * HOUR, entry.tariff);
}

// Each quarter has at most two marginal prices. The first segment uses
// electricity that would otherwise be exported. The remaining segment imports.
function planEvdcCost({ quarters, efficiency, limitKW, maxDcW, tailWh }) {
  const tail = quarters.findLast((row) => row.originalWh > 0);
  const totalWh = quarters.reduce((sum, row) => sum + row.originalWh, 0);
  if (quarters.some((row) => row.originalWh > 0 && eligibleForFee(row)))
    return { reason: 'evdc-original-in-tariff' };

  const segments = [];
  const allocation = new Map([[tail.t, tailWh]]);
  const importWhLimit = limitKW * 250;
  for (const row of quarters) {
    if (row.base.importWh >= importWhLimit)
      return { reason: 'evdc-household-over-limit', at: row.t };
    const maxWh = Math.min(
      maxDcW / 4,
      // Leave one watt of numerical margin so a planned quarter stays below the limit.
      (importWhLimit - 0.25 - row.base.importWh + row.base.exportWh) * efficiency,
    );
    if (row.t === tail.t) {
      // Keep the observed energy in the last charging quarter, so optimisation
      // cannot move completion earlier or leave a token charge at the finish.
      if (tailWh > maxWh + EPSILON_WH) return { reason: 'evdc-tail-over-limit', at: row.t };
      continue;
    }
    if (!row.available || eligibleForFee(row) || maxWh <= 0) continue;
    const extra = additions(row.entry);
    const buy = row.price.consumption.price + extra.import;
    const sell = row.price.production.price + extra.export;
    const exportWh = Math.min(maxWh, row.base.exportWh * efficiency);
    const importedWh = maxWh - exportWh;
    // A falling marginal price inside a quarter needs a different optimiser.
    if (exportWh > EPSILON_WH && importedWh > EPSILON_WH && sell > buy)
      return { reason: 'evdc-inverted-prices', at: row.t };
    if (exportWh > 0) segments.push({ t: row.t, wh: exportWh, cost: sell });
    if (importedWh > 0) segments.push({ t: row.t, wh: importedWh, cost: buy });
  }
  // Identical efficiency converts all marginal SEK/kWh prices by the same factor.
  segments.sort((a, b) => a.cost - b.cost || b.t - a.t);
  let remaining = totalWh - tailWh;
  for (const { t, wh } of segments) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, wh);
    allocation.set(t, (allocation.get(t) || 0) + taken);
    remaining -= taken;
  }
  if (remaining > EPSILON_WH)
    return { reason: 'evdc-insufficient-headroom', missingKWh: remaining / 1000 };
  return { allocation };
}

module.exports = { planEvdcCost };
