'use strict';
const H = 3600000,
  MAX = 768;
function normalizeNetworkEnergy(home, id, from, to) {
  if (home?.id !== id) throw Error('invalid-home');
  const rows = new Map();
  for (const [direction, field, unit] of [
    ['consumption', 'importWh', 'consumptionUnit'],
    ['production', 'exportWh', 'productionUnit'],
  ]) {
    const nodes = home[direction]?.nodes;
    if ((nodes === null || nodes === undefined) && direction === 'production') continue;
    if (!Array.isArray(nodes) || nodes.length > (to - from) / H)
      throw Error('invalid-network-energy');
    const seen = new Map();
    for (const r of nodes) {
      const t = Date.parse(r?.from),
        end = Date.parse(r?.to),
        value = r?.[direction];
      if (!Number.isSafeInteger(t) || t % H || t < from || end - t !== H || end > to)
        throw Error('invalid-network-energy');
      if (value === null || value === undefined) continue;
      if (!Number.isFinite(value) || value < 0 || value > 1e6 || r[unit] !== 'kWh')
        throw Error('invalid-network-energy');
      if (seen.has(t) && seen.get(t) !== value) throw Error('conflicting-network-energy');
      seen.set(t, value);
      if (!rows.has(t)) rows.set(t, { t });
      rows.get(t)[field] = value * 1000;
    }
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}
function validNetworkRows(rows, fetchedAt) {
  if (!Array.isArray(rows) || rows.length > MAX || !Number.isFinite(fetchedAt)) return false;
  const seen = new Set();
  return rows.every((r) => {
    if (
      !r ||
      Object.keys(r).some((k) => !['t', 'importWh', 'exportWh'].includes(k)) ||
      !Number.isSafeInteger(r.t) ||
      r.t < 0 ||
      r.t % H ||
      r.t + H > fetchedAt ||
      seen.has(r.t)
    )
      return false;
    seen.add(r.t);
    return (
      ['importWh', 'exportWh'].some((k) => r[k] !== undefined) &&
      ['importWh', 'exportWh'].every(
        (k) => r[k] === undefined || (Number.isFinite(r[k]) && r[k] >= 0 && r[k] <= 1e9),
      )
    );
  });
}
function mergeNetworkRows(previous, rows, from, to) {
  const map = new Map(previous.filter((r) => r.t >= from && r.t < to).map((r) => [r.t, { ...r }]));
  for (const r of rows) map.set(r.t, { ...map.get(r.t), ...r });
  return [...map.values()].sort((a, b) => a.t - b.t);
}
module.exports = { normalizeNetworkEnergy, validNetworkRows, mergeNetworkRows };
