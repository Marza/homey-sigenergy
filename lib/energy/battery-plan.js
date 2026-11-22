'use strict';

// Each action moves stored DC energy. Price and meter limits apply on the AC side.
const ETA = 0.95;
const Q = 900000;
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
  // Include exact measured and cutoff levels alongside whole percentages.
  const levels = [
    ...new Set([
      low,
      high,
      soc,
      ...Array.from({ length: 101 }, (_, i) => i).filter((x) => x > low && x < high),
    ]),
  ].sort((a, b) => a - b);
  const initial = levels.indexOf(soc);
  let costs = new Float64Array(levels.length).fill(Infinity);
  costs[initial] = 0;
  const parents = [];
  for (const s of slots) {
    const next = new Float64Array(levels.length).fill(Infinity);
    const parent = new Int16Array(levels.length).fill(-1);
    for (let i = 0; i < levels.length; i++) {
      if (!Number.isFinite(costs[i])) continue;
      for (let j = 0; j < levels.length; j++) {
        const delta = ((levels[j] - levels[i]) * capacity) / 100;
        const ac = delta > 0 ? delta / ETA : delta * ETA;
        if (ac > chargeKW / 4 + 1e-9) break;
        if (-ac > dischargeKW / 4 + 1e-9) continue;
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
        if (cost < next[j] - 1e-9 || (i === j && Math.abs(cost - next[j]) < 1e-9)) {
          next[j] = cost;
          parent[j] = i;
        }
      }
    }
    parents.push(parent);
    costs = next;
  }
  // Equal opening and closing energy makes a free final discharge impossible.
  if (!Number.isFinite(costs[initial])) return null;
  const plan = new Array(slots.length);
  let j = initial;
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
