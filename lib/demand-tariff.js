'use strict';

// Advisory tariff calculation. A quarter-hour record is an energy integral,
// not a demand peak. Only complete, contiguous local clock hours are eligible.
const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});
const WEEKDAYS = { 'mån': 1, 'tis': 2, 'ons': 3, 'tor': 4, 'tors': 4, 'fre': 5, 'lör': 6, 'sön': 0 };
function localParts(ms) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`, monthNumber: Number(parts.month),
    minute: Number(parts.hour) * 60 + Number(parts.minute), weekday: WEEKDAYS[parts.weekday] };
}
function minutes(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')) throw new Error('Invalid tariff time');
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
function validateTariff(tariff) {
  if (!tariff || typeof tariff !== 'object') throw new Error('Tariff configuration required');
  const from = minutes(tariff.start), to = minutes(tariff.end);
  if (from >= to || from % 60 || to % 60) throw new Error('Tariff hours must be full hours within one day');
  if (!Array.isArray(tariff.weekdays) || !tariff.weekdays.length || tariff.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Invalid weekdays');
  if (!Number.isFinite(tariff.rateSekPerKw) || tariff.rateSekPerKw < 0) throw new Error('Invalid demand rate');
  if (!Number.isInteger(tariff.peakCount) || tariff.peakCount < 1 || tariff.peakCount > 31) throw new Error('Invalid peak count');
  if (typeof tariff.distinctDays !== 'boolean') throw new Error('Invalid distinctDays');
  if (tariff.months !== undefined && (!Array.isArray(tariff.months) || !tariff.months.length || tariff.months.some(m => !Number.isInteger(m) || m < 1 || m > 12))) throw new Error('Invalid months');
  return { from, to };
}
function activeAt(ms, tariff) {
  const { from, to } = validateTariff(tariff), p = localParts(ms);
  return (!tariff.months || tariff.months.includes(p.monthNumber)) && tariff.weekdays.includes(p.weekday) && p.minute >= from && p.minute < to;
}
function calculateDemandCharge(slots, tariff, month) {
  validateTariff(tariff);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid month');
  const hours = new Map();
  let excludedIncomplete = 0;
  for (const slot of slots || []) {
    if (!Number.isFinite(slot?.t) || localParts(slot.t).month !== month || !activeAt(slot.t, tariff)) continue;
    if (slot.t % 900000 !== 0 || !Number.isFinite(slot.gridWh) || !Number.isFinite(slot.coverageMs) || slot.coverageMs < 14 * 60000) {
      excludedIncomplete++;
      continue;
    }
    const start = Math.floor(slot.t / 3600000) * 3600000;
    const index = (slot.t - start) / 900000;
    if (!hours.has(start)) hours.set(start, new Map());
    hours.get(start).set(index, slot);
  }
  const candidates = [];
  for (const [start, quarters] of hours) {
    if (quarters.size !== 4 || ![0, 1, 2, 3].every(i => quarters.has(i))) {
      excludedIncomplete += 4 - quarters.size;
      continue;
    }
    const local = localParts(start);
    candidates.push({ t: start, date: local.date,
      kw: Math.max(0, [...quarters.values()].reduce((sum, slot) => sum + slot.gridWh, 0) / 1000) });
  }
  candidates.sort((a, b) => b.kw - a.kw || a.t - b.t);
  const selected = [], days = new Set();
  for (const peak of candidates) {
    if (tariff.distinctDays && days.has(peak.date)) continue;
    selected.push(peak);
    days.add(peak.date);
    if (selected.length === tariff.peakCount) break;
  }
  const averageKw = selected.length === tariff.peakCount ? selected.reduce((sum, p) => sum + p.kw, 0) / selected.length : null;
  return { month, status: averageKw === null ? 'insufficient-data' : 'provisional',
    averageKw, estimatedSek: averageKw === null ? null : averageKw * tariff.rateSekPerKw,
    selectedPeaks: selected, eligibleHours: candidates.length, excludedIncomplete,
    note: 'Preliminär beräkning. Tariffvillkor, helgdagar, månadstäckning och pris måste verifieras.' };
}
module.exports = { localParts, activeAt, calculateDemandCharge, validateTariff };
