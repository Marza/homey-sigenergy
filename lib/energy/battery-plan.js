'use strict';

// Each action moves stored DC energy. Price and meter limits apply on the AC side.
const ETA = 0.95;
const Q = 900000;
// Ignore floating-point noise when comparing cumulative kWh or SEK.
function compare(a, b) {
  if (a < b - 1e-9) return -1;
  if (a > b + 1e-9) return 1;
  return 0;
}
function optimize(slots, battery) {
  const { soc, low, high, capacity, chargeKW, dischargeKW, importKW } = battery;
  if (
    ![soc, low, high, capacity, chargeKW, dischargeKW, importKW].every(Number.isFinite) ||
    low < 0 ||
    high > 100 ||
    low > soc ||
    high < soc ||
    high <= low ||
    capacity <= 0 ||
    importKW <= 0 ||
    chargeKW < 0 ||
    dischargeKW < 0 ||
    !slots.length
  )
    return null;
  // Align the grid with a full charging quarter where practical and bound the work per request.
  const fullChargePct = (chargeKW * ETA * 25) / capacity;
  const step =
    chargeKW === 0 ? 1 : Math.max(0.25, fullChargePct / Math.max(1, Math.ceil(fullChargePct)));
  const steps = Math.ceil((high - low) / step);
  const targetKW = battery.tariffTargetKW;
  const peakPlanning = Number.isFinite(targetKW) && targetKW > 0 && slots.some((s) => s.peakWindow);
  // Value a closing deficit at the cheapest modeled grid refill opportunity, including charging loss.
  const refillPrices = slots
    .filter(
      (s) =>
        !s.peakWindow &&
        chargeKW > 0 &&
        s.netKWh + chargeKW / 4 > 0 &&
        s.phaseRoomKWh !== 0 &&
        Math.max(0, s.netKWh) < importKW / 4,
    )
    .map((s) => s.buy);
  const refill = Math.max(0, Math.min(...refillPrices));

  const levels = [
    ...new Set([
      low,
      high,
      soc,
      ...Array.from({ length: steps * 2 + 1 }, (_, i) => soc + (i - steps) * step).filter(
        (x) => x > low && x < high,
      ),
    ]),
  ].sort((a, b) => a - b);
  // Precompute the feasible discharge side of the SoC grid once for all quarters.
  let first = 0;
  const firstReachable = levels.map((level) => {
    while (((level - levels[first]) * capacity * ETA) / 100 > dischargeKW / 4 + 1e-9) first++;
    return first;
  });
  const initial = levels.indexOf(soc);
  let costs = new Float64Array(levels.length).fill(Infinity);
  costs[initial] = 0;
  let excess = new Float64Array(levels.length);
  let chargeQuarters = new Uint16Array(levels.length);
  const parents = [];
  for (const s of slots) {
    const next = new Float64Array(levels.length).fill(Infinity);
    const nextExcess = new Float64Array(levels.length).fill(Infinity);
    const nextChargeQuarters = new Uint16Array(levels.length);
    const parent = new Int16Array(levels.length).fill(-1);
    for (let i = 0; i < levels.length; i++) {
      if (!Number.isFinite(costs[i])) continue;
      for (let j = firstReachable[i]; j < levels.length; j++) {
        const delta = ((levels[j] - levels[i]) * capacity) / 100;
        const ac = delta > 0 ? delta / ETA : delta * ETA;
        if (ac > chargeKW / 4 + 1e-9) break;
        const net = s.netKWh + ac;
        const room = s.phaseRoomKWh ?? Infinity;
        if (net > Math.max(0, s.netKWh) + room + 1e-9 || net < Math.min(0, s.netKWh) - room - 1e-9)
          continue;
        if (net > importKW / 4 + 1e-9 || (s.peakWindow && ac > 0 && net > 1e-9)) continue;
        const cost =
          costs[i] +
          Math.max(0, net) * s.buy +
          Math.min(0, net) * s.sell +
          Math.max(0, -ac) * s.wear;
        const over =
          excess[i] + (peakPlanning && s.peakWindow ? Math.max(0, net - targetKW / 4) : 0);
        const charges = chargeQuarters[i] + (ac > 1e-9 && net > 1e-9 ? 1 : 0);
        // First protect the tariff target, then minimize cost, then concentrate equal-cost charging.
        const rank =
          compare(over, nextExcess[j]) || compare(cost, next[j]) || charges - nextChargeQuarters[j];
        if (rank < 0 || (rank === 0 && i === j)) {
          nextExcess[j] = over;
          nextChargeQuarters[j] = charges;
          next[j] = cost;
          parent[j] = i;
        }
      }
    }
    parents.push(parent);
    costs = next;
    excess = nextExcess;
    chargeQuarters = nextChargeQuarters;
  }
  let j = initial;
  if (peakPlanning) {
    // Without an observable refill price, preserve as much opening energy as feasible at the best target coverage.
    let bestOver = Infinity,
      bestDeficit = Infinity,
      bestCost = Infinity,
      bestCharges = Infinity;
    for (let i = 0; i < levels.length; i++) {
      if (!Number.isFinite(costs[i])) continue;
      const deficit = Math.max(0, ((soc - levels[i]) * capacity) / (100 * ETA));
      const unpriced = Number.isFinite(refill) ? 0 : deficit;
      const cost = costs[i] + (Number.isFinite(refill) ? deficit * refill : 0);
      const rank =
        compare(excess[i], bestOver) ||
        compare(unpriced, bestDeficit) ||
        compare(cost, bestCost) ||
        chargeQuarters[i] - bestCharges;
      if (rank < 0) {
        j = i;
        bestOver = excess[i];
        bestCost = cost;
        bestCharges = chargeQuarters[i];
        bestDeficit = unpriced;
      }
    }
  }
  if (!Number.isFinite(costs[j])) return null;
  const plan = new Array(slots.length);
  for (let k = slots.length - 1; k >= 0; k--) {
    const i = parents[k][j],
      s = slots[k];
    const delta = ((levels[j] - levels[i]) * capacity) / 100;
    const ac = delta > 0 ? delta / ETA : delta * ETA;
    const net = s.netKWh + ac;
    const buyKWh = Math.max(0, Math.max(0, net) - Math.max(0, s.netKWh));
    const sellKWh = Math.max(0, Math.max(0, -net) - Math.max(0, -s.netKWh));
    plan[k] = {
      t: s.t,
      soc: levels[i],
      endSoc: levels[j],
      peakWindow: !!s.peakWindow,
      gridImportKW: Math.max(0, net) * 4,
      chargeKW: Math.max(0, ac) * 4,
      buyKWh,
      sellKWh,
      action:
        buyKWh > 1e-8
          ? 'buy'
          : sellKWh > 1e-8
            ? 'sell'
            : delta > 0
              ? 'solar'
              : delta < 0
                ? 'house'
                : 'hold',
    };
    j = i;
  }
  return plan;
}
module.exports = { optimize, Q };
